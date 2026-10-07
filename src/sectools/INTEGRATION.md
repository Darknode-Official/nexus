# sectools — integration notes for the Nexus core

This subsystem is **self-contained** under `src/sectools/` and touches **no existing
file**. To merge conflict-free, the wiring below must be added by the Nexus core
maintainer in existing files (listed per change). Nothing here runs automatically;
sectools only decides and reports.

## 1. Expose the subsystem from the package root

`index.js` (repo root) — add alongside the other `require`s and in `module.exports`:

```js
// Security
const sectools = require("./src/sectools");   // code-security analysis tools
// ...
module.exports = {
  // ... existing exports ...
  sectools,
};
```

That single export surfaces `sectools.secrets`, `.sast`, `.advisories`, `.explain`,
`.guards`, `.walk`, and the aggregate `.audit()` / `.formatReport()`.

Optionally add it to the module-loading assertion list in `test/run.js` (a new
`"sectools"` entry in `requiredModules`). This is additive and not required.

## 2. CLI subcommand

Wherever the `nexus`/`darknode nexus` CLI dispatches subcommands, add a `sec`
(or `audit`) command that delegates to the bundled script:

```js
// pseudo-wiring in the CLI dispatcher
if (cmd === "sec" || cmd === "audit") {
  const { main } = require("./src/sectools/audit");
  process.exit(main(argv.slice(1)));   // supports [path] --json --explain --fail-on <sev> ...
}
```

The script already parses its own flags, prints text or `--json`, and returns a
CI-friendly exit code (0 clean, 2 findings at/above `--fail-on`, 1 usage error).

## 3. Pre-send guard (before any engine call)

In the engine/transport layer that sends prompts to a model
(e.g. `src/engines.js` / `src/ollama.js` / the AI dispatch path), call the guard and
send the **redacted** text:

```js
const { preSendGuard } = require("./src/sectools/guards");

const guard = preSendGuard(outgoingText, { threshold: "medium" });
if (guard.findings.length) {
  // Recommended UX: warn the user, show guard.findings (values are masked),
  // and send guard.redacted instead of outgoingText.
  outgoingText = guard.redacted;           // never ship raw secrets off-box
  if (guard.blocked) {/* optionally require explicit user confirmation */}
}
```

Decision only — the guard never blocks the send by itself. The core chooses whether
to hard-block or warn based on `guard.blocked` and user settings.

## 4. Pre-commit guard (git hook or commit flow)

Where Nexus performs/assists commits (e.g. `src/git-intelligence.js`), run the
commit guard over staged files:

```js
const { preCommitGuard } = require("./src/sectools/guards");

// stagedFiles: array of absolute paths from `git diff --cached --name-only`
const res = preCommitGuard(repoRoot, { files: stagedFiles, threshold: "high", explain: true });
if (res.blocked) {
  // Print res.reason + res.findings; abort unless the user overrides.
}
```

Pass `files` to scan only staged paths (fast); omit it to scan the whole tree.

## 5. Suggested defaults

| Choke point | Default threshold | Rationale |
| --- | --- | --- |
| `preSendGuard` | `medium` | Any plausible secret should be redacted before leaving the machine. |
| `preCommitGuard` | `high` | Block commits on high/critical; surface medium/low as warnings. |
| CLI `--fail-on` | `high` | CI gate fails the build on high/critical findings. |

## Contract / guarantees

- **No existing files modified** by this subsystem; all code is under `src/sectools/`.
- **Zero third-party dependencies**; Node stdlib only (`fs`, `path`). Safe for the
  existing `package.json` with no changes.
- **No code execution** of the scanned target; read + pattern-match only.
- **No network**; the advisory DB is bundled. (`loadDatabase` lets the core refresh
  it from a trusted feed if desired.)
- All returned snippets are secret-redacted, so logging findings is safe.

## Tests

`node --test test/sectools/` — isolated from the existing `test/run.js` suite.
Both suites pass independently.
