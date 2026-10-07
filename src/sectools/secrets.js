"use strict";
// ================= sectools/secrets — secret scanner + redaction =================
// Finds credentials that should never live in source: provider API keys, tokens,
// private keys and connection strings. Two complementary strategies are used:
//
//   1. Curated, high-precision rules keyed to known provider formats (AWS, GitHub,
//      Google, Stripe, Slack, …). These have near-zero false positives because
//      the formats are distinctive.
//   2. Shannon-entropy analysis of assignment values and quoted strings, to catch
//      generic/unknown secrets. Entropy is paired with placeholder filtering so
//      that `password = "changeme"` or `token: "<your-token>"` are NOT flagged.
//
// A `redact()` helper masks every finding in arbitrary text so secrets can be
// stripped from prompts and logs before they are sent to an AI engine.
//
// Each finding: { id, type:"secret", provider, severity, cwe, title, file, line,
//                 column, match (redacted), snippet (redacted), entropy, confidence,
//                 remediation }.

const { walk, readText } = require("./walk");

// ---------------------------------------------------------------------------
// Entropy
// ---------------------------------------------------------------------------

/**
 * Shannon entropy in bits-per-character for a string.
 * @param {string} str
 * @returns {number}
 */
function shannonEntropy(str) {
  if (!str) return 0;
  const freq = Object.create(null);
  for (const ch of str) freq[ch] = (freq[ch] || 0) + 1;
  const len = str.length;
  let e = 0;
  for (const k in freq) {
    const p = freq[k] / len;
    e -= p * Math.log2(p);
  }
  return e;
}

// ---------------------------------------------------------------------------
// Placeholder / noise filtering (keeps false positives low)
// ---------------------------------------------------------------------------

const PLACEHOLDER_WORDS = [
  "example", "placeholder", "changeme", "change_me", "yourkey", "your_key",
  "your-key", "yourtoken", "your_token", "youraccount", "dummy", "sample",
  "test", "testing", "fake", "foobar", "redacted", "xxxxxx", "todo", "none",
  "null", "undefined", "insert", "replace", "notasecret", "secret_here",
  "apikeyhere", "my_secret", "mysecret", "password123", "s3cr3t",
];

/**
 * Decide whether a candidate string is obviously NOT a real secret.
 * @param {string} val
 * @returns {boolean}
 */
function isPlaceholder(val) {
  if (!val) return true;
  const low = val.toLowerCase();
  // Template markers: ${VAR}, {{var}}, <your-token>, %VAR%, $VAR, process.env.X
  if (/[${}<>%]/.test(val)) return true;
  if (/process\.env|os\.environ|getenv|import\.meta\.env/i.test(val)) return true;
  // Repeated single char (xxxxxxxx, 00000000, ********).
  if (/^(.)\1{5,}$/.test(val)) return true;
  if (/^[*x.\-_ ]+$/i.test(val)) return true;
  for (const w of PLACEHOLDER_WORDS) if (low.includes(w)) return true;
  // Looks like a word-ish phrase rather than a token (has spaces).
  if (/\s/.test(val.trim())) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Curated provider rules
// ---------------------------------------------------------------------------
// Each rule: { id, provider, severity, cwe, title, regex, remediation,
//              group (capture index of the secret portion, default 0) }.
// Regexes are authored with word-boundary-ish anchors to avoid partial matches
// inside longer hex blobs.

const RULES = [
  {
    id: "aws-access-key-id", provider: "AWS", severity: "critical", cwe: "CWE-798",
    title: "AWS Access Key ID",
    regex: /\b((?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[0-9A-Z]{16})\b/g,
    remediation: "Revoke the key in IAM, rotate credentials, and load them from the environment or a secrets manager.",
  },
  {
    id: "aws-secret-access-key", provider: "AWS", severity: "critical", cwe: "CWE-798",
    title: "AWS Secret Access Key",
    // Only flag when near an aws secret context to avoid matching random base64.
    regex: /aws(.{0,20})?(secret|private)(.{0,20})?['"]?\s*[:=]\s*['"]([A-Za-z0-9/+=]{40})['"]/gi,
    group: 4,
    remediation: "Rotate the secret access key immediately and never commit it; use IAM roles or environment variables.",
  },
  {
    id: "github-token", provider: "GitHub", severity: "critical", cwe: "CWE-798",
    title: "GitHub personal access / app token",
    regex: /\b((?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{36,255})\b/g,
    remediation: "Revoke the token in GitHub settings and issue a fine-grained token stored outside source control.",
  },
  {
    id: "gitlab-token", provider: "GitLab", severity: "high", cwe: "CWE-798",
    title: "GitLab personal access token",
    regex: /\b(glpat-[A-Za-z0-9_-]{20,})\b/g,
    remediation: "Revoke the token in GitLab and store replacement credentials in CI/CD masked variables.",
  },
  {
    id: "google-api-key", provider: "Google", severity: "high", cwe: "CWE-798",
    title: "Google API key",
    regex: /\b(AIza[0-9A-Za-z_-]{35})\b/g,
    remediation: "Restrict and rotate the key in Google Cloud Console; apply application/API restrictions.",
  },
  {
    id: "google-oauth-id", provider: "Google", severity: "low", cwe: "CWE-200",
    title: "Google OAuth client ID",
    regex: /\b([0-9]+-[0-9a-z_]{32}\.apps\.googleusercontent\.com)\b/g,
    remediation: "Client IDs are public-ish, but confirm the matching client secret was not committed.",
  },
  {
    id: "slack-token", provider: "Slack", severity: "high", cwe: "CWE-798",
    title: "Slack token",
    regex: /\b(xox[baprs]-[0-9A-Za-z-]{10,})\b/g,
    remediation: "Revoke the token in the Slack app admin and rotate; restrict scopes.",
  },
  {
    id: "slack-webhook", provider: "Slack", severity: "medium", cwe: "CWE-798",
    title: "Slack incoming webhook URL",
    regex: /(https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9_]+\/B[A-Za-z0-9_]+\/[A-Za-z0-9]+)/g,
    remediation: "Delete the webhook in Slack and generate a new one; treat the URL as a secret.",
  },
  {
    id: "stripe-secret-key", provider: "Stripe", severity: "critical", cwe: "CWE-798",
    title: "Stripe secret / restricted key",
    regex: /\b((?:sk|rk)_(?:live|test)_[0-9A-Za-z]{20,})\b/g,
    remediation: "Roll the key in the Stripe dashboard immediately; live keys grant full account access.",
  },
  {
    id: "sendgrid-key", provider: "SendGrid", severity: "high", cwe: "CWE-798",
    title: "SendGrid API key",
    regex: /\b(SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43})\b/g,
    remediation: "Delete the key in SendGrid settings and issue a scoped replacement.",
  },
  {
    id: "twilio-key", provider: "Twilio", severity: "high", cwe: "CWE-798",
    title: "Twilio API key / account SID",
    regex: /\b((?:SK|AC)[0-9a-fA-F]{32})\b/g,
    remediation: "Rotate Twilio credentials in the console and scope API keys narrowly.",
  },
  {
    id: "npm-token", provider: "npm", severity: "high", cwe: "CWE-798",
    title: "npm access token",
    regex: /\b(npm_[A-Za-z0-9]{36})\b/g,
    remediation: "Revoke the token with `npm token revoke` and use automation tokens scoped per CI job.",
  },
  {
    id: "openai-key", provider: "OpenAI", severity: "high", cwe: "CWE-798",
    title: "OpenAI API key",
    regex: /\b(sk-(?:proj-)?[A-Za-z0-9_-]{20,})\b/g,
    remediation: "Revoke the key in the OpenAI dashboard and load it from the environment instead.",
  },
  {
    id: "private-key-block", provider: "PEM", severity: "critical", cwe: "CWE-321",
    title: "Private key material (PEM block)",
    regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/g,
    remediation: "Remove the private key from source, rotate the keypair, and store keys in a vault or KMS.",
  },
  {
    id: "jwt", provider: "JWT", severity: "medium", cwe: "CWE-522",
    title: "JSON Web Token",
    regex: /\b(eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g,
    remediation: "If this token is long-lived or a signing secret, rotate it; prefer short-lived tokens minted at runtime.",
  },
  {
    id: "db-connection-string", provider: "Database", severity: "high", cwe: "CWE-798",
    title: "Database connection string with credentials",
    regex: /\b((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp|mssql):\/\/[^\s:@/]+:[^\s:@/]+@[^\s/'"]+)/gi,
    remediation: "Move the DSN to an environment variable and rotate the embedded password.",
  },
  {
    id: "basic-auth-url", provider: "URL", severity: "medium", cwe: "CWE-522",
    title: "Credentials embedded in URL",
    regex: /\b(https?:\/\/[^\s:@/]+:[^\s:@/]+@[^\s/'"]+)/gi,
    remediation: "Remove inline user:password from URLs; pass credentials via headers or environment.",
  },
  {
    id: "generic-assignment", provider: "Generic", severity: "medium", cwe: "CWE-798",
    title: "Hardcoded secret in a key/value assignment",
    // key names that imply a secret, assigned a quoted value we then entropy-check.
    regex: /\b((?:api[_-]?key|secret|token|passwd|password|passphrase|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token))\b\s*[:=]\s*['"]([^'"\n]{8,})['"]/gi,
    group: 2,
    entropyGated: true,
    remediation: "Replace the literal with a reference to an environment variable or secrets manager.",
  },
];

// Entropy thresholds used by the generic assignment rule and the standalone
// high-entropy string scan.
const ENTROPY = {
  // bits/char over the whole candidate; base64-ish secrets sit around 4.5–6.
  base64Min: 4.0,
  hexMin: 3.0,
  minLen: 16,
};

/**
 * Compute the redacted form of a secret: keep up to 4 leading characters and the
 * last 2, replace the middle with asterisks. Short secrets are fully masked.
 * @param {string} s
 * @returns {string}
 */
function maskValue(s) {
  s = String(s);
  if (s.length <= 8) return "*".repeat(s.length);
  const head = s.slice(0, 4);
  const tail = s.slice(-2);
  return head + "*".repeat(Math.max(4, s.length - 6)) + tail;
}

/**
 * Redact a matched secret inside its source line for safe display.
 * @param {string} line
 * @param {string} secret
 */
function redactLine(line, secret) {
  if (!secret) return line;
  return line.split(secret).join(maskValue(secret));
}

/**
 * Whether a candidate string clears the entropy bar for its character class.
 * @param {string} val
 */
function hasHighEntropy(val) {
  if (!val || val.length < ENTROPY.minLen) return false;
  if (isPlaceholder(val)) return false;
  const e = shannonEntropy(val);
  if (/^[0-9a-fA-F]+$/.test(val)) return e >= ENTROPY.hexMin;
  if (/^[A-Za-z0-9/+_=-]+$/.test(val)) return e >= ENTROPY.base64Min;
  return false;
}

/**
 * Scan a single block of text for secrets.
 * @param {string} text
 * @param {object} [opts]
 * @param {string} [opts.file="<text>"] label used in findings
 * @param {boolean} [opts.entropy=true] enable standalone high-entropy scan
 * @returns {Array<object>} findings
 */
function scanText(text, opts) {
  opts = opts || {};
  const file = opts.file || "<text>";
  const entropyOn = opts.entropy !== false;
  text = String(text == null ? "" : text);
  const lines = text.split(/\r?\n/);
  const findings = [];
  const seen = new Set(); // dedupe by line+id+value

  const push = (f) => {
    const key = f.line + "|" + f.id + "|" + f.match;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(f);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;
    if (line.length > 4000) continue; // minified blob — skip to avoid noise

    for (const rule of RULES) {
      rule.regex.lastIndex = 0;
      let m;
      while ((m = rule.regex.exec(line)) !== null) {
        const value = rule.group ? m[rule.group] : m[0];
        if (!value) { if (m.index === rule.regex.lastIndex) rule.regex.lastIndex++; continue; }
        if (rule.entropyGated) {
          if (isPlaceholder(value)) continue;
          const e = shannonEntropy(value);
          const okB64 = /^[A-Za-z0-9/+_=.@-]+$/.test(value) && e >= ENTROPY.base64Min;
          const okHex = /^[0-9a-fA-F]+$/.test(value) && e >= ENTROPY.hexMin;
          if (!okB64 && !okHex && value.length < 20) continue;
        }
        const column = m.index + (rule.group ? Math.max(0, m[0].indexOf(value)) : 0) + 1;
        push({
          id: rule.id,
          type: "secret",
          provider: rule.provider,
          severity: rule.severity,
          cwe: rule.cwe,
          title: rule.title,
          file,
          line: lineNo,
          column,
          match: maskValue(value),
          snippet: redactLine(line.trim(), value).slice(0, 200),
          entropy: Number(shannonEntropy(value).toFixed(2)),
          confidence: rule.entropyGated ? 0.7 : 0.95,
          remediation: rule.remediation,
        });
        if (m.index === rule.regex.lastIndex) rule.regex.lastIndex++;
      }
    }

    // Standalone high-entropy token scan — catches unknown secret formats that
    // are not in any provider rule. Gated hard on placeholder + entropy so that
    // ordinary code (identifiers, hashes in comments) is not swept up.
    if (entropyOn) {
      const tokenRe = /['"`]?([A-Za-z0-9/+_=-]{20,100})['"`]?/g;
      let tm;
      while ((tm = tokenRe.exec(line)) !== null) {
        const val = tm[1];
        if (!hasHighEntropy(val)) continue;
        // Avoid double-reporting things a precise rule already caught.
        if (findings.some((f) => f.line === lineNo && f.match === maskValue(val))) continue;
        // Require a secret-ish context nearby to keep precision high.
        const ctx = line.toLowerCase();
        if (!/(key|secret|token|pass|cred|auth|signature|sign|private|bearer|apikey)/.test(ctx)) continue;
        push({
          id: "high-entropy-string",
          type: "secret",
          provider: "Generic",
          severity: "medium",
          cwe: "CWE-798",
          title: "High-entropy string in a secret-like context",
          file,
          line: lineNo,
          column: tm.index + 1,
          match: maskValue(val),
          snippet: redactLine(line.trim(), val).slice(0, 200),
          entropy: Number(shannonEntropy(val).toFixed(2)),
          confidence: 0.55,
          remediation: "Confirm whether this is a credential; if so move it to a secrets manager and rotate it.",
        });
      }
    }
  }

  return findings;
}

/**
 * Scan every text file under a directory (or a single file).
 * @param {string} root
 * @param {object} [opts] forwarded to walk() and scanText()
 * @returns {{findings:Array<object>, filesScanned:number, truncated:boolean}}
 */
function scanDir(root, opts) {
  opts = opts || {};
  const res = walk(root, opts);
  const findings = [];
  for (const f of res.files) {
    const text = readText(f.path, opts);
    if (text == null) continue;
    findings.push(...scanText(text, Object.assign({}, opts, { file: f.rel })));
  }
  return { findings, filesScanned: res.files.length, truncated: res.truncated };
}

/**
 * Redact every detectable secret in arbitrary text. Used to sanitise prompts and
 * logs before they are sent to an AI engine.
 * @param {string} text
 * @param {object} [opts]
 * @returns {{text:string, redactions:number}}
 */
function redact(text, opts) {
  text = String(text == null ? "" : text);
  const findings = scanText(text, Object.assign({ entropy: true }, opts, { file: "<redact>" }));
  if (!findings.length) return { text, redactions: 0 };

  // Rebuild unmasked values by re-running the rules over the raw text so we know
  // exactly what substring to replace (findings store the masked form).
  let out = text;
  let count = 0;
  const lines = out.split(/\r?\n/);

  for (const rule of RULES) {
    for (let i = 0; i < lines.length; i++) {
      rule.regex.lastIndex = 0;
      lines[i] = lines[i].replace(rule.regex, (full, ...groups) => {
        // groups minus (offset, string) tail
        const captured = rule.group ? groups[rule.group - 1] : full;
        if (!captured) return full;
        if (rule.entropyGated && isPlaceholder(captured)) return full;
        count++;
        return full.split(captured).join(maskValue(captured));
      });
    }
  }

  // Also mask standalone high-entropy tokens in secret-like contexts.
  for (let i = 0; i < lines.length; i++) {
    const ctx = lines[i].toLowerCase();
    if (!/(key|secret|token|pass|cred|auth|signature|private|bearer|apikey)/.test(ctx)) continue;
    lines[i] = lines[i].replace(/([A-Za-z0-9/+_=-]{20,100})/g, (v) => {
      if (!hasHighEntropy(v)) return v;
      count++;
      return maskValue(v);
    });
  }

  return { text: lines.join("\n"), redactions: count };
}

module.exports = {
  shannonEntropy,
  isPlaceholder,
  hasHighEntropy,
  maskValue,
  redactLine,
  scanText,
  scanDir,
  redact,
  RULES,
  ENTROPY,
  PLACEHOLDER_WORDS,
};
