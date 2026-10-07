"use strict";
// ================= sectools/explain — finding explainer + autofix suggester =================
// Turns a raw finding (from secrets.js, sast.js or advisories.js) into:
//   • a clear, local explanation: what it is, why it matters, the impact; and
//   • where safe and deterministic, a concrete suggested fix (a line rewrite or a
//     snippet patch).
//
// No LLM call is required. Explanations are derived from a CWE knowledge base plus
// the finding's own remediation text; fixes are deterministic string transforms
// keyed by the rule's `fixHint`. When no safe automatic rewrite exists, a
// guidance-only snippet is returned and `autofixable` is false — we never emit a
// speculative patch that could change behaviour.

// CWE knowledge base: short, accurate descriptions for the "why / impact".
const CWE_INFO = {
  "CWE-78": { name: "OS Command Injection", why: "Untrusted input is incorporated into a command run by a shell, so an attacker can append their own commands.", impact: "Full remote code execution on the host, data theft, and lateral movement." },
  "CWE-89": { name: "SQL Injection", why: "Untrusted input is concatenated into a SQL statement instead of being bound as a parameter.", impact: "Attackers can read, modify or destroy database contents and sometimes execute OS commands." },
  "CWE-918": { name: "Server-Side Request Forgery", why: "The server makes a request to a URL it does not fully control, letting an attacker target internal services.", impact: "Access to cloud metadata endpoints, internal admin panels, and port scanning from inside the network." },
  "CWE-22": { name: "Path Traversal", why: "A filesystem path is built from input without confining it to an intended directory.", impact: "Reading or writing arbitrary files such as /etc/passwd, config, or keys." },
  "CWE-95": { name: "Eval Injection", why: "Code is generated and executed at runtime from a string that may contain input.", impact: "Arbitrary code execution within the application's privileges." },
  "CWE-94": { name: "Code Injection", why: "Attacker-influenced data is interpreted as code by the application or a template engine.", impact: "Remote code execution." },
  "CWE-502": { name: "Deserialization of Untrusted Data", why: "A serializer that can instantiate arbitrary objects is fed untrusted bytes.", impact: "Remote code execution during deserialization." },
  "CWE-327": { name: "Use of a Broken/Risky Cryptographic Algorithm", why: "A weak or outdated algorithm is used where collision/forgery resistance matters.", impact: "Forged signatures, collisions, or feasible brute-force of protected data." },
  "CWE-338": { name: "Use of Cryptographically Weak PRNG", why: "A non-cryptographic random source is used for a security value.", impact: "Predictable tokens/keys that an attacker can guess or reproduce." },
  "CWE-798": { name: "Use of Hard-coded Credentials", why: "A credential is embedded in source where anyone with the code can read it.", impact: "Account/service takeover; secrets in git history persist after deletion." },
  "CWE-732": { name: "Incorrect Permission Assignment", why: "A resource is granted broader access than required.", impact: "Other local users or processes can read or tamper with the resource." },
  "CWE-295": { name: "Improper Certificate Validation", why: "TLS certificate verification is disabled or bypassed.", impact: "Man-in-the-middle attackers can intercept and modify traffic." },
  "CWE-321": { name: "Hard-coded Cryptographic Key", why: "Private key material is committed to source.", impact: "Anyone with the repo can impersonate the service or decrypt traffic." },
  "CWE-522": { name: "Insufficiently Protected Credentials", why: "Credentials are transmitted or stored without adequate protection.", impact: "Credential capture and reuse." },
  "CWE-200": { name: "Exposure of Sensitive Information", why: "Sensitive data is made available to an actor that should not have it.", impact: "Information leakage that aids further attacks." },
  "CWE-601": { name: "Open Redirect", why: "A redirect target is taken from input without validation.", impact: "Phishing and OAuth token theft via trusted-looking links." },
  "CWE-1321": { name: "Prototype Pollution", why: "Untrusted keys are merged into object prototypes.", impact: "Denial of service, property injection, and sometimes RCE." },
  "CWE-1333": { name: "Inefficient Regular Expression (ReDoS)", why: "A regex with catastrophic backtracking is applied to input.", impact: "A short crafted string can hang the process, causing denial of service." },
  "CWE-539": { name: "Use of Persistent Cookies Containing Sensitive Information", why: "Sensitive data persists in cookies longer than it should.", impact: "Session/credential disclosure." },
};

// Deterministic fix transforms keyed by fixHint. Each returns either
// { autofixable:true, original, suggested, note } for a safe line rewrite, or
// { autofixable:false, snippet, note } for guidance-only.
const FIXERS = {
  "upgrade-hash": (snippet) => {
    const suggested = snippet.replace(/(['"])(md5|sha1)\1/i, "$1sha256$1");
    return { autofixable: suggested !== snippet, original: snippet, suggested,
      note: "SHA-256 is a drop-in replacement for integrity hashing. For passwords, switch to bcrypt/scrypt/argon2 instead." };
  },
  "py-shell-false": (snippet) => {
    const suggested = snippet.replace(/shell\s*=\s*True/, "shell=False");
    return { autofixable: suggested !== snippet, original: snippet, suggested,
      note: "With shell=False you must pass the command as a list, e.g. subprocess.run([\"ls\", \"-l\", path])." };
  },
  "yaml-safe-load": (snippet) => {
    const suggested = snippet.replace(/yaml\.load\s*\(/, "yaml.safe_load(");
    return { autofixable: suggested !== snippet, original: snippet, suggested,
      note: "safe_load refuses to construct arbitrary Python objects." };
  },
  "py-literal-eval": (snippet) => {
    const suggested = snippet.replace(/\beval\s*\(/, "ast.literal_eval(");
    return { autofixable: /\beval\s*\(/.test(snippet), original: snippet, suggested,
      note: "ast.literal_eval only parses literals (requires `import ast`). Use a dispatch dict if you need to select behaviour." };
  },
  "secure-random": (snippet, finding) => {
    if (finding.lang === "py") {
      return { autofixable: false,
        snippet: "import secrets\ntoken = secrets.token_hex(16)        # instead of random.*\nchoice = secrets.choice(seq)",
        note: "Use the `secrets` module for tokens, passwords and keys." };
    }
    return { autofixable: false,
      snippet: "const { randomBytes, randomInt, randomUUID } = require(\"crypto\");\nconst token = randomBytes(32).toString(\"hex\"); // instead of Math.random()",
      note: "Use node:crypto (or getRandomValues in browsers) for security-sensitive randomness." };
  },
  "tighten-perms": (snippet) => {
    const suggested = snippet.replace(/0o?777/, "0o600");
    return { autofixable: suggested !== snippet, original: snippet, suggested,
      note: "0o600 (owner read/write) suits secrets; use 0o755/0o750 for directories or executables." };
  },
  "js-exec-to-execFile": () => ({ autofixable: false,
    snippet: "const { execFile } = require(\"child_process\");\nexecFile(\"git\", [\"log\", \"--oneline\", branch], (err, stdout) => { /* ... */ });",
    note: "execFile with an argument array never invokes a shell, so metacharacters are inert. Validate `branch` against an allowlist." }),
  "py-system-to-subprocess": () => ({ autofixable: false,
    snippet: "import subprocess\nsubprocess.run([\"git\", \"log\", \"--oneline\", branch], shell=False, check=True)",
    note: "Pass arguments as a list and keep shell=False." }),
  "parameterise-sql": (snippet, finding) => ({ autofixable: false,
    snippet: finding.lang === "py"
      ? "cur.execute(\"SELECT * FROM users WHERE id = %s\", (user_id,))"
      : "db.query(\"SELECT * FROM users WHERE id = $1\", [userId]);",
    note: "Bind values as parameters; the driver escapes them safely. Never concatenate input into SQL." }),
  "path-contain": (snippet, finding) => ({ autofixable: false,
    snippet: finding.lang === "py"
      ? "import os\nbase = os.path.realpath(BASE_DIR)\ntarget = os.path.realpath(os.path.join(base, user_path))\nif not target.startswith(base + os.sep):\n    raise ValueError(\"path traversal\")"
      : "const path = require(\"path\");\nconst base = path.resolve(BASE_DIR);\nconst target = path.resolve(base, userPath);\nif (!target.startsWith(base + path.sep)) throw new Error(\"path traversal\");",
    note: "Resolve the path and assert it stays within the intended base directory." }),
  "remove-eval": () => ({ autofixable: false,
    snippet: "// data:        const data = JSON.parse(text);\n// dispatch:    const fn = ({ add, remove })[action]; fn && fn();",
    note: "Replace eval with JSON.parse for data or an explicit function map for dispatch." }),
  "avoid-pickle": () => ({ autofixable: false,
    snippet: "import json\ndata = json.loads(raw)   # instead of pickle.loads(raw)",
    note: "Use JSON or a schema-validated format for untrusted data; never unpickle it." }),
};

/**
 * Build a human explanation of a finding.
 * @param {object} finding
 * @returns {{ title:string, what:string, why:string, impact:string, remediation:string, cwe:string|null, references:string[] }}
 */
function explain(finding) {
  const cwe = finding.cwe || null;
  const info = cwe && CWE_INFO[cwe];
  let what;
  if (finding.type === "secret") {
    what = `A ${finding.provider || "credential"} secret appears in ${finding.file} at line ${finding.line}.`;
  } else if (finding.type === "dependency") {
    what = `${finding.package}@${finding.version} is affected by ${finding.title} (${(finding.aliases || []).join(", ") || finding.id}).`;
  } else {
    what = `${finding.title} at ${finding.file}:${finding.line}. ${finding.message || ""}`.trim();
  }
  return {
    title: finding.title || finding.id,
    what,
    why: info ? info.why : (finding.message || "This pattern is a known security weakness."),
    impact: info ? info.impact : "May be exploitable depending on context.",
    remediation: finding.remediation || "Review and remediate per secure-coding guidance.",
    cwe: cwe ? `${cwe}${info ? " — " + info.name : ""}` : null,
    references: finding.references || [],
  };
}

/**
 * Produce a suggested fix for a finding. Returns null when no fixer is registered.
 * @param {object} finding
 * @param {string} [sourceLine] the exact source line (defaults to finding.snippet)
 * @returns {null | { autofixable:boolean, original?:string, suggested?:string, snippet?:string, note:string }}
 */
function suggestFix(finding, sourceLine) {
  // Secrets: deterministic, safe rewrite to an env lookup reference.
  if (finding.type === "secret") {
    const envName = (finding.id || "SECRET").toUpperCase().replace(/[^A-Z0-9]+/g, "_");
    return {
      autofixable: false,
      snippet: finding.lang === "py" || /\.py/.test(finding.file || "")
        ? `import os\nvalue = os.environ["${envName}"]   # load from env, not source`
        : `const value = process.env.${envName}; // load from env, not source`,
      note: "Move the secret to an environment variable or secrets manager and rotate the exposed value (git history still contains it).",
    };
  }
  // Dependencies: the fix is an upgrade.
  if (finding.type === "dependency") {
    return {
      autofixable: false,
      snippet: finding.ecosystem === "pip"
        ? `${finding.package}>=${finding.patched}`
        : `npm install ${finding.package}@^${finding.patched}`,
      note: `Upgrade to ${finding.patched} or later, then re-run the audit.`,
    };
  }
  // SAST: dispatch on fixHint.
  const fixer = finding.fixHint && FIXERS[finding.fixHint];
  if (!fixer) return null;
  const snippet = sourceLine != null ? sourceLine : (finding.snippet || "");
  return fixer(snippet, finding);
}

/**
 * Explain + fix a whole list of findings.
 * @param {Array<object>} findings
 * @returns {Array<object>} enriched findings with `.explanation` and `.fix`
 */
function explainAll(findings) {
  return (findings || []).map((f) => ({
    ...f,
    explanation: explain(f),
    fix: suggestFix(f),
  }));
}

module.exports = { CWE_INFO, FIXERS, explain, suggestFix, explainAll };
