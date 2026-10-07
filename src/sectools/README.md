# Nexus sectools — security-aware code tools

Code-security analysis built into the Nexus coding agent. `sectools` scans the
**user's code** for leaked secrets, insecure patterns and known-vulnerable
dependencies, explains each finding, suggests deterministic fixes, and exposes
guard hooks that block risky prompts and commits.

Pure Node.js standard library. **Zero third-party dependencies.** Everything runs
offline — no network, no telemetry.

> Scope note: this subsystem analyses and secures *code you are working on*. It is
> **not** the agent process sandbox / capability model (that is a separate
> subsystem). sectools never executes target code; it only reads and pattern-matches.

## Modules

| Module | Responsibility |
| --- | --- |
| `secrets.js` | Secret scanner (curated provider rules + Shannon-entropy analysis) and a `redact()` utility that masks secrets in text/logs before anything is sent to an engine. |
| `sast.js` + `sast-rules.js` | SAST-lite static analysis for JS/TS, Python and shell. Engine is generic; rules are pure data. |
| `advisories.js` + `advisory-db.js` | Offline dependency advisory checker. Parses `package.json` / `package-lock.json` / `requirements.txt` and matches versions against a bundled seed advisory DB. |
| `explain.js` | Finding explainer (what / why / impact, from a CWE knowledge base) and a deterministic autofix suggester. No LLM required. |
| `guards.js` | `preSendGuard` (sanitise prompts) and `preCommitGuard` (gate commits). Decide + report only; the host wires the UX. |
| `walk.js` | Shared, dependency-free directory walker with ignore list, size caps and binary sniffing. |
| `index.js` | Single entrypoint: re-exports every module plus an aggregate `audit()` and `formatReport()`. |
| `audit.js` | Runnable CLI that audits a directory and prints findings. |

## Quick start

```js
const sectools = require("./src/sectools");

// Audit a directory with every scanner
const report = sectools.audit("/path/to/project", { explain: true });
console.log(sectools.formatReport(report));

// Sanitise text before sending to an AI engine
const { redacted, blocked } = sectools.guards.preSendGuard(promptText);

// Gate a commit (pass git staged files, or a root dir)
const result = sectools.guards.preCommitGuard(repoRoot, { threshold: "high" });
if (result.blocked) { /* host aborts the commit and shows result.findings */ }
```

### CLI

```
node src/sectools/audit.js [path] [options]

  --json            emit findings as JSON
  --explain         include explanation + suggested fix per finding
  --no-secrets      skip the secret scanner
  --no-sast         skip the SAST engine
  --no-deps         skip the dependency advisory checker
  --no-entropy      disable entropy-based secret detection
  --fail-on <sev>   exit code 2 when a finding >= <sev> exists (default: high)
```

Exit codes: `0` clean / below threshold, `2` findings at/above `--fail-on`,
`1` usage error. Suitable for a CI gate.

## Finding shape

All scanners emit a common finding object:

```js
{
  id,            // rule / advisory id
  type,          // "secret" | "sast" | "dependency"
  severity,      // "critical" | "high" | "medium" | "low"
  cwe,           // "CWE-###"
  title,
  file, line, column,   // location (dependency findings use package/version)
  snippet,       // source line, with any secret redacted
  confidence,    // 0..1 prior confidence
  remediation,   // concrete guidance
}
```

## Secret detection

Two complementary strategies:

1. **Curated provider rules** (`secrets.RULES`) — distinctive formats with near-zero
   false positives: AWS access keys, GitHub/GitLab tokens, Google API keys, Slack
   tokens/webhooks, Stripe, SendGrid, Twilio, npm, OpenAI, PEM private keys, JWTs,
   and database / basic-auth connection strings.
2. **Shannon-entropy analysis** — flags high-entropy base64/hex values *in a
   secret-like context* (nearby `key`/`token`/`secret`/… keyword), catching unknown
   formats. Gated by a placeholder filter so `password = "changeme"`,
   `token = "${ENV}"`, `key = process.env.X` and repeated/sample values are ignored.

Every reported secret value is **masked** in the finding (`match`, `snippet`), so
findings and reports never leak the credential. `redact(text)` returns a copy of
arbitrary text with all detectable secrets masked and a redaction count.

## SAST ruleset

Rules live in `sast-rules.js` as pure data (`id`, `langs`, `severity`, `cwe`,
`title`, `message`, `pattern`, `remediation`, optional `exclude`, `confidence`,
`fixHint`). Categories covered across **JS/TS, Python, shell**:

- Command injection (`child_process.exec`, `os.system`, `subprocess(shell=True)`, shell `eval`)
- SQL injection (string-concatenated / f-string / `.format()` queries)
- SSRF (requests to dynamic/interpolated URLs)
- Path traversal (filesystem calls built from request/user input)
- Unsafe eval / dynamic code (`eval`, `new Function`, `vm`, `exec`)
- Insecure deserialization (`pickle`, `yaml.load` without SafeLoader)
- Weak crypto (MD5/SHA-1, DES/RC4/ECB)
- Insecure randomness (`Math.random`, `random.*` for security values)
- Hardcoded credentials (code-level literals)
- Unsafe file permissions (chmod 0777)
- Disabled TLS verification (`rejectUnauthorized:false`, `verify=False`, `curl -k`)

**Extending:** append a rule object to `sast-rules.js`, or pass your own array via
`sast.scanText(text, { rules })` / the `rules` option. Each rule is validated in
the test suite for shape and uniqueness.

Comment bodies are stripped before matching (URLs preserved); Python docstrings are
skipped. `exclude` is tested against the full original line, so an inline hint such
as `// used for animation jitter` suppresses the finding.

## Advisory database

`advisory-db.js` ships a **seed** set — a curated subset of well-known CVEs, not an
exhaustive mirror. Record format (schema 1):

```js
{
  id,           // internal id, "DN-<year>-<n>"
  ecosystem,    // "npm" | "pip"
  package,      // canonical name
  severity,     // "critical" | "high" | "medium" | "low"
  cwe,          // "CWE-###"
  title,
  vulnerable,   // range string(s): "<4.17.21", ">=3.0,<3.2.13", "A || B"
  patched,      // first fixed version (upgrade target)
  aliases,      // ["CVE-...", "GHSA-..."]
  references,   // [url]
}
```

Range syntax (`advisories.satisfies`): comparators `<, <=, >, >=, =`; space/comma
separate an AND group; `||` separates OR groups. Versions compare by numeric
release components, with a pre-release ranked below its release.

**Version resolution:** a `package-lock.json` gives exact resolved versions
(`resolvedFrom: "lockfile"`, confidence 0.95). Without a lockfile, a manifest spec
(`^1.2.0`, `>=1.0`, `~=1.4`) is coerced to the **lowest** version it allows
(`resolvedFrom: "manifest-spec"`, confidence 0.75) — the conservative "could this
project be running a vulnerable version?" choice.

**Updating the DB:** this is data only. Append/modify records (keep ids stable), or
load an external JSON array of the same shape at runtime:

```js
const db = advisories.loadDatabase(fs.readFileSync("advisories.json", "utf8"));
advisories.checkDependencies(deps, { db });
```

A production deployment would refresh `advisories.json` from a trusted feed
(OSV/GHSA export) on a schedule; `loadDatabase` drops malformed records. Keeping the
seed in-repo means Nexus always has a baseline offline.

## Detection limits (read this)

sectools is a fast, high-signal **pattern** scanner, not a sound analyzer. It is
honest about what it does **not** catch:

- **No data-flow / taint analysis.** It cannot tell whether a value is actually
  attacker-controlled. Rules are tuned for precision, so they key on obvious
  sinks (interpolation, concatenation, request objects) and will **miss** injection
  that is laundered through variables, helper functions, or across files.
- **Single-line, regex-based.** Multi-line constructs, unusual formatting, and
  heavy metaprogramming can evade rules. Minified / very long lines are skipped.
- **Secret entropy scan is context-gated** to keep false positives low, so a
  high-entropy secret with no nearby keyword and no known format may be missed.
  Conversely, a long high-entropy *non*-secret in a secret-like context can be a
  false positive.
- **Dependency check is seed-only.** It flags *only* packages present in the
  bundled DB; absence of a finding is **not** proof a dependency is safe. Transitive
  dependencies are only assessed when a lockfile is present. Manifest-only resolution
  is conservative and may over- or under-report versus the installed tree.
- **Language coverage** is JS/TS, Python and shell. Other languages are not scanned
  by SAST (secrets/entropy still apply to any text file).
- **It scans its own rule strings.** Running the SAST engine over sectools' source
  reports the detection patterns themselves (e.g. the literal `eval` in a rule) as
  findings — a self-reference, not a vulnerability.

Treat findings as leads to review, not a proof of (in)security. Use alongside a
compiler, type checker, linter, and a maintained SCA tool for defence in depth.

## Tests

```
node --test test/sectools/
```

Every module has positive detections and negative (no-false-positive) fixtures,
including end-to-end directory audits and CLI exit-code checks.
