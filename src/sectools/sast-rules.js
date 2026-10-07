"use strict";
// ================= sectools/sast-rules — data-driven SAST ruleset =================
// The detection catalogue for the SAST-lite engine (./sast.js). Rules are PURE
// DATA so they can be extended, overridden or shipped separately without touching
// engine logic. Each rule is:
//
//   {
//     id,            // stable, unique identifier
//     langs,         // array of language ids: "js", "py", "sh" (or ["*"])
//     severity,      // "critical" | "high" | "medium" | "low"
//     cwe,           // CWE identifier string
//     title,         // short human title
//     message,       // what the pattern indicates
//     pattern,       // RegExp matched against a source line (code portion)
//     remediation,   // concrete guidance
//     exclude,       // optional RegExp; if it matches the line the hit is dropped
//     confidence,    // 0..1 prior confidence (tuned per rule)
//     fixHint,       // optional id consumed by explain.js to craft a patch
//   }
//
// Language ids: js = JavaScript/TypeScript, py = Python, sh = shell/bash.

const RULES = [
  // ---------------------------------------------------------------- Command injection
  {
    id: "js-child-process-exec",
    langs: ["js"], severity: "high", cwe: "CWE-78",
    title: "Command injection via child_process.exec",
    message: "exec()/execSync() runs a string through a shell; interpolated input enables command injection.",
    pattern: /\b(?:cp|child_process)?\.?\bexec(?:Sync)?\s*\(\s*(?:`[^`]*\$\{|[^)]*\+)/,
    exclude: /execFile/,
    remediation: "Use execFile/spawn with an argument array and shell:false, and validate inputs against an allowlist.",
    confidence: 0.8, fixHint: "js-exec-to-execFile",
  },
  {
    id: "py-os-system",
    langs: ["py"], severity: "high", cwe: "CWE-78",
    title: "Command injection via os.system/os.popen",
    message: "os.system / os.popen pass a string to the shell; concatenated input is injectable.",
    pattern: /\bos\.(?:system|popen)\s*\(\s*(?:f?["'][^"']*\{|[^)]*\+|[^)]*%)/,
    remediation: "Use subprocess.run([...], shell=False) with an argument list and validate inputs.",
    confidence: 0.8, fixHint: "py-system-to-subprocess",
  },
  {
    id: "py-subprocess-shell-true",
    langs: ["py"], severity: "high", cwe: "CWE-78",
    title: "subprocess called with shell=True",
    message: "shell=True runs the command via /bin/sh, exposing it to shell metacharacter injection.",
    pattern: /\bsubprocess\.(?:run|call|Popen|check_output|check_call)\s*\([^)]*shell\s*=\s*True/,
    remediation: "Set shell=False and pass the command as a list of arguments.",
    confidence: 0.75, fixHint: "py-shell-false",
  },
  {
    id: "sh-eval-untrusted",
    langs: ["sh"], severity: "high", cwe: "CWE-78",
    title: "Shell eval of a variable",
    message: "eval on a variable executes attacker-controlled data as shell commands.",
    pattern: /\beval\s+["']?\$(?:\{?\w+)/,
    remediation: "Avoid eval; use arrays and proper quoting, or case statements for dispatch.",
    confidence: 0.7,
  },
  {
    id: "sh-unquoted-command-sub",
    langs: ["sh"], severity: "medium", cwe: "CWE-78",
    title: "Command executed from unquoted expansion",
    message: "Running $(...) or a bare variable as a command can execute injected input.",
    pattern: /^\s*(?:sh|bash|-c)\s+\$\(/,
    remediation: "Validate and quote inputs; prefer explicit argument lists over dynamic command strings.",
    confidence: 0.55,
  },

  // ---------------------------------------------------------------- SQL injection
  {
    id: "js-sql-string-concat",
    langs: ["js"], severity: "high", cwe: "CWE-89",
    title: "SQL built by string concatenation / template",
    message: "A SQL statement interpolates variables directly, enabling SQL injection.",
    pattern: /\b(?:query|execute|raw)\s*\(\s*(?:`[^`]*(?:SELECT|INSERT|UPDATE|DELETE|DROP|UNION)[^`]*\$\{|["'][^"']*(?:SELECT|INSERT|UPDATE|DELETE|DROP)[^"']*["']\s*\+)/i,
    remediation: "Use parameterised queries / prepared statements ($1, ? placeholders); never concatenate input into SQL.",
    confidence: 0.75, fixHint: "parameterise-sql",
  },
  {
    id: "py-sql-format",
    langs: ["py"], severity: "high", cwe: "CWE-89",
    title: "SQL built with f-string / % / .format()",
    message: "SQL assembled via f-strings or string formatting is vulnerable to injection.",
    pattern: /\b(?:execute|executemany|executescript)\s*\(\s*(?:f["'][^"']*(?:SELECT|INSERT|UPDATE|DELETE|DROP)|["'][^"']*(?:SELECT|INSERT|UPDATE|DELETE)[^"']*["']\s*(?:%|\.format|\+))/i,
    remediation: "Pass parameters as the second argument to execute() using %s / ? placeholders.",
    confidence: 0.75, fixHint: "parameterise-sql",
  },

  // ---------------------------------------------------------------- SSRF
  {
    id: "js-ssrf-request",
    langs: ["js"], severity: "high", cwe: "CWE-918",
    title: "Potential SSRF: HTTP request to a dynamic URL",
    message: "An outbound request uses an interpolated/variable URL; without validation this enables SSRF.",
    pattern: /\b(?:fetch|axios(?:\.get|\.post)?|http\.get|https\.get|request|got|superagent\.get)\s*\(\s*(?:`[^`]*\$\{|[A-Za-z_$][\w$]*\s*[,)])/,
    exclude: /["'`]https?:\/\/[^"'`$]+["'`]\s*[,)]/,
    remediation: "Validate the URL host against an allowlist, block internal/link-local ranges, and disable redirects you do not control.",
    confidence: 0.55,
  },
  {
    id: "py-ssrf-request",
    langs: ["py"], severity: "high", cwe: "CWE-918",
    title: "Potential SSRF: requests/urlopen to a dynamic URL",
    message: "requests.get / urlopen called with a variable or formatted URL may allow SSRF.",
    pattern: /\b(?:requests\.(?:get|post|put|delete|head)|urllib\.request\.urlopen|urlopen)\s*\(\s*(?:f["']|[A-Za-z_]\w*\s*[,)]|[^)]*\+)/,
    exclude: /\(\s*["']https?:\/\/[^"']+["']\s*[,)]/,
    remediation: "Resolve and validate the target host against an allowlist and reject private/loopback addresses.",
    confidence: 0.5,
  },

  // ---------------------------------------------------------------- Path traversal
  {
    id: "js-path-traversal",
    langs: ["js"], severity: "high", cwe: "CWE-22",
    title: "Path traversal in filesystem call",
    message: "A filesystem path is built from interpolated input without normalisation, allowing ../ traversal.",
    pattern: /\bfs\.(?:readFile|readFileSync|writeFile|writeFileSync|createReadStream|createWriteStream|unlink|unlinkSync|readdir|readdirSync|open|openSync)\s*\(\s*(?:`[^`]*\$\{|[^)]*\+\s*(?:req\.|request\.|params|query|body|input|userInput))/,
    remediation: "Resolve against a fixed base dir and verify the result stays within it (path.resolve + startsWith check); strip ../ sequences.",
    confidence: 0.6, fixHint: "path-contain",
  },
  {
    id: "py-path-traversal",
    langs: ["py"], severity: "high", cwe: "CWE-22",
    title: "Path traversal in open()/os.path.join",
    message: "A file path derives from request/user input without containment, allowing directory traversal.",
    pattern: /\b(?:open|os\.path\.join|os\.remove|os\.unlink|shutil\.(?:copy|move|rmtree))\s*\([^)]*(?:request\.|args\.|form\.|params|user_input|userinput)/i,
    remediation: "Canonicalise with os.path.realpath and assert it is inside the intended base directory.",
    confidence: 0.6, fixHint: "path-contain",
  },

  // ---------------------------------------------------------------- Unsafe eval / deserialization
  {
    id: "js-eval",
    langs: ["js"], severity: "high", cwe: "CWE-95",
    title: "Use of eval()",
    message: "eval() executes arbitrary code; with any untrusted input this is remote code execution.",
    pattern: /(^|[^.\w])eval\s*\(/,
    exclude: /\.eval|safeEval|google|sequelize/,
    remediation: "Remove eval(). Use JSON.parse for data, a function map for dispatch, or a sandboxed interpreter.",
    confidence: 0.8, fixHint: "remove-eval",
  },
  {
    id: "js-function-constructor",
    langs: ["js"], severity: "high", cwe: "CWE-95",
    title: "Dynamic code via new Function()",
    message: "new Function(string) compiles arbitrary code at runtime, equivalent to eval.",
    pattern: /\bnew\s+Function\s*\(/,
    remediation: "Avoid runtime code generation; use a static function or a vetted expression library.",
    confidence: 0.75,
  },
  {
    id: "py-eval-exec",
    langs: ["py"], severity: "high", cwe: "CWE-95",
    title: "Use of eval()/exec()",
    message: "eval/exec run arbitrary Python; untrusted input leads to code execution.",
    pattern: /(^|[^.\w])(?:eval|exec)\s*\(/,
    exclude: /ast\.literal_eval/,
    remediation: "Use ast.literal_eval for data, or a dispatch dict; never eval/exec untrusted strings.",
    confidence: 0.8, fixHint: "py-literal-eval",
  },
  {
    id: "py-pickle-loads",
    langs: ["py"], severity: "critical", cwe: "CWE-502",
    title: "Insecure deserialization via pickle",
    message: "pickle.load/loads executes arbitrary code when deserialising untrusted data.",
    pattern: /\b(?:pickle|cPickle|_pickle)\.(?:load|loads)\s*\(/,
    remediation: "Do not unpickle untrusted data; use JSON or a schema-validated format (e.g. protobuf).",
    confidence: 0.7, fixHint: "avoid-pickle",
  },
  {
    id: "py-yaml-load",
    langs: ["py"], severity: "high", cwe: "CWE-502",
    title: "yaml.load without SafeLoader",
    message: "yaml.load with the default loader can instantiate arbitrary Python objects.",
    pattern: /\byaml\.load\s*\((?![^)]*Safe)/,
    remediation: "Use yaml.safe_load(), or pass Loader=yaml.SafeLoader.",
    confidence: 0.8, fixHint: "yaml-safe-load",
  },
  {
    id: "js-vm-runincontext",
    langs: ["js"], severity: "medium", cwe: "CWE-95",
    title: "node vm used as a sandbox",
    message: "The vm module is not a security boundary; code can escape to the host.",
    pattern: /\bvm\.(?:runInNewContext|runInThisContext|runInContext|compileFunction)\s*\(/,
    remediation: "Do not rely on vm for isolating untrusted code; run it in a separate, locked-down process.",
    confidence: 0.6,
  },

  // ---------------------------------------------------------------- Weak crypto
  {
    id: "js-weak-hash",
    langs: ["js"], severity: "medium", cwe: "CWE-327",
    title: "Weak hash algorithm (MD5/SHA1)",
    message: "MD5 and SHA-1 are broken for integrity/signatures and must not be used for security.",
    pattern: /createHash\s*\(\s*["'](?:md5|sha1)["']/i,
    remediation: "Use SHA-256+ for integrity, and a password hash (bcrypt/scrypt/argon2) for passwords.",
    confidence: 0.85, fixHint: "upgrade-hash",
  },
  {
    id: "py-weak-hash",
    langs: ["py"], severity: "medium", cwe: "CWE-327",
    title: "Weak hash algorithm (MD5/SHA1)",
    message: "hashlib.md5 / hashlib.sha1 are unsuitable for security purposes.",
    pattern: /\bhashlib\.(?:md5|sha1)\s*\(/,
    exclude: /usedforsecurity\s*=\s*False/,
    remediation: "Use hashlib.sha256+, and passlib/argon2 for passwords.",
    confidence: 0.8, fixHint: "upgrade-hash",
  },
  {
    id: "js-weak-cipher",
    langs: ["js"], severity: "high", cwe: "CWE-327",
    title: "Weak/ECB cipher",
    message: "DES/RC4/ECB-mode ciphers are insecure.",
    pattern: /createCipheriv?\s*\(\s*["'](?:des|des-ecb|rc4|aes-128-ecb|aes-256-ecb)["']/i,
    remediation: "Use AES-256-GCM (authenticated encryption) with a random IV.",
    confidence: 0.85,
  },

  // ---------------------------------------------------------------- Insecure randomness
  {
    id: "js-math-random-security",
    langs: ["js"], severity: "medium", cwe: "CWE-338",
    title: "Math.random() for security value",
    message: "Math.random() is not cryptographically secure; unsafe for tokens/keys/passwords/IDs.",
    pattern: /\bMath\.random\s*\(\s*\)/,
    exclude: /test|spec|mock|jitter|color|animation/i,
    remediation: "Use crypto.randomBytes / crypto.randomUUID / crypto.getRandomValues for security-sensitive values.",
    confidence: 0.45, fixHint: "secure-random",
  },
  {
    id: "py-random-security",
    langs: ["py"], severity: "medium", cwe: "CWE-338",
    title: "random module used for security value",
    message: "The random module is deterministic/predictable; unsafe for secrets or tokens.",
    pattern: /\brandom\.(?:random|randint|choice|randrange|getrandbits|sample)\s*\(/,
    exclude: /SystemRandom|import secrets/,
    remediation: "Use the secrets module (secrets.token_hex, secrets.choice) for security-sensitive randomness.",
    confidence: 0.4, fixHint: "secure-random",
  },

  // ---------------------------------------------------------------- Hardcoded creds (code-level)
  {
    id: "generic-hardcoded-password",
    langs: ["*"], severity: "medium", cwe: "CWE-798",
    title: "Hardcoded password/credential literal",
    message: "A password or credential is assigned a literal value in source.",
    pattern: /\b(?:password|passwd|pwd|secret|api_key|apikey|token)\b\s*[:=]\s*["'][^"'\s]{6,}["']/i,
    exclude: /process\.env|os\.environ|getenv|["'][^"']*\$\{|["']<|example|changeme|placeholder|getpass|prompt|input\(/i,
    remediation: "Load credentials from environment variables or a secrets manager, never from source.",
    confidence: 0.5,
  },

  // ---------------------------------------------------------------- Unsafe file permissions
  {
    id: "js-chmod-777",
    langs: ["js"], severity: "medium", cwe: "CWE-732",
    title: "World-writable file permissions (chmod 0777)",
    message: "chmod 0777 grants everyone read/write/execute, exposing the file to tampering.",
    pattern: /\bchmod(?:Sync)?\s*\([^,]+,\s*0o?777/,
    remediation: "Grant the minimum needed permissions (e.g. 0o600 for secrets, 0o755 for executables).",
    confidence: 0.8, fixHint: "tighten-perms",
  },
  {
    id: "py-chmod-777",
    langs: ["py"], severity: "medium", cwe: "CWE-732",
    title: "World-writable file permissions (chmod 0o777)",
    message: "os.chmod(..., 0o777) makes the file world-writable.",
    pattern: /\bos\.chmod\s*\([^,]+,\s*0o?777/,
    remediation: "Use least-privilege modes such as 0o600 or 0o640.",
    confidence: 0.8, fixHint: "tighten-perms",
  },
  {
    id: "sh-chmod-777",
    langs: ["sh"], severity: "medium", cwe: "CWE-732",
    title: "World-writable file permissions (chmod 777)",
    message: "chmod 777 grants full access to everyone.",
    pattern: /\bchmod\s+(?:-R\s+)?0?777\b/,
    remediation: "Set the least-privilege mode required, e.g. chmod 750 or 600.",
    confidence: 0.8, fixHint: "tighten-perms",
  },

  // ---------------------------------------------------------------- TLS verification disabled
  {
    id: "js-tls-reject-unauthorized",
    langs: ["js"], severity: "high", cwe: "CWE-295",
    title: "TLS certificate verification disabled",
    message: "rejectUnauthorized:false disables TLS validation, enabling man-in-the-middle attacks.",
    pattern: /rejectUnauthorized\s*:\s*false/,
    remediation: "Keep certificate validation on; pin or add the proper CA instead of disabling checks.",
    confidence: 0.85,
  },
  {
    id: "py-verify-false",
    langs: ["py"], severity: "high", cwe: "CWE-295",
    title: "TLS verification disabled (verify=False)",
    message: "requests(..., verify=False) disables certificate validation.",
    pattern: /\bverify\s*=\s*False\b/,
    remediation: "Leave verify=True; supply the CA bundle path if needed.",
    confidence: 0.8,
  },
  {
    id: "sh-curl-insecure",
    langs: ["sh"], severity: "medium", cwe: "CWE-295",
    title: "curl/wget with disabled TLS checks",
    message: "curl -k / --insecure and wget --no-check-certificate skip certificate validation.",
    pattern: /\b(?:curl\b[^\n]*\s(?:-k|--insecure)|wget\b[^\n]*--no-check-certificate)\b/,
    remediation: "Remove the insecure flag and trust the proper CA.",
    confidence: 0.7,
  },
];

module.exports = { RULES };
