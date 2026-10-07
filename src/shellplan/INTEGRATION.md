# Integrating Shellplan into Nexus

This subsystem lives entirely under `src/shellplan/` and `test/shellplan/` and adds
**no** third-party dependencies. Nothing outside that scope was modified, so it merges
cleanly. The edits below are all **additive** — nothing changes existing behavior until
a call site opts in. `src/sandbox.js` and `src/capability.js` were **read, not changed**;
shellplan references their models but never duplicates their enforcement.

## 1. Export it from the public API (`index.js`)

Add alongside the other `require`s and in `module.exports`:

```js
// Shell/command intelligence & safe-execution planning
const shellplan = require("./src/shellplan");
// ...
module.exports = {
  // ...existing exports...
  shellplan,
};
```

Then `require("nexus").shellplan.analyze(cmd, { policy })` is available to consumers.
The shellplan suite imports directly from `src/shellplan/`, so this export is only for
public consumers.

## 2. Add it to the test runner

`package.json` and `test/run.js` are outside this subsystem's file scope, so the suite
runs separately for now:

```
node --test test/shellplan/        # 238 tests
```

To fold it into `npm test`, append `test/shellplan/` to the `test` / `test:verbose`
globs in `package.json` (they already list `test/perf/`, `test/lsp/`, etc.), or have
`test/run.js` `require()` the files in `test/shellplan/`. (Left to the owner.)

## 3. Concrete wiring points (highest value first)

### a) Pre-flight every command the agent proposes — `src/sandbox.js` call sites
Before `sandbox.execute(cmd)` / `sandbox.validateWithin(cmd, cap)`, run shellplan to get
an explanation + risk the agent can show, and to **predict** the verdict:

```js
const shellplan = require("./shellplan");
const a = shellplan.analyze(cmd, { policy: capabilityToPolicy(cap), cwd });
// a.explanation.text  -> show the user what it does, step by step
// a.recommendation    -> "proceed" | "confirm: ..." | "deny: ..."
// a.files.deletes     -> impact preview ("this deletes 3 paths")
if (a.recommendation.startsWith("deny")) refuse(a);
else if (a.recommendation.startsWith("confirm")) askUser(a);
// then the AUTHORITATIVE gate still runs:
const verdict = sandbox.validateWithin(cmd, cap, { confirmed });
```

`capabilityToPolicy(cap)` is a trivial shape map — the policy shellplan expects is the
same fields `capability.createCapabilities` produces:

```js
function capabilityToPolicy(cap, confirmed) {
  return { roots: cap.roots, commands: cap.commands, network: cap.network,
           allowDestructive: cap.allowDestructive, confirmed: !!confirmed };
}
```

`shellplan.wouldSandboxAllow` deliberately mirrors `capability.commandAllowed` +
`capability.containPath` + `capability.classifyDestructive`, so its prediction matches
what enforcement will actually decide. It is a **predictor for UX**, not a replacement
for the real gate — always still call `sandbox`/`capability` to enforce.

### b) Impact-aware diffs/plans — `src/planner.js`, `src/pipelines.js`
When Nexus builds a plan that includes shell steps, attach `shellplan.dryRun(step).effects`
so the plan can show "writes X, deletes Y" per step and the modeled `cwd` after each `cd`.

### c) Risk gating for autonomous runs — `src/multi-agent.js`, `src/ghost-agents.js`
For unattended/batch execution, gate each command with `shellplan.safeRun(cmd, { riskThreshold })`
to auto-run the obviously-safe ones (ls, git status, cat project files) and bubble up
anything medium+ for confirmation — without a round-trip to the enforcement layer for the
trivial majority.

### d) Explanations in the UI — `src/ui/`, `src/thought-stream.js`
`shellplan.explainCommand(cmd).text` is a ready-to-render block; `explainCommand(cmd)`
also returns structured `steps`/`files`/`risk` for a richer component.

### e) Secret/exfiltration awareness — `src/capability.js` redaction pipeline
The `secret` and `network` risk categories (`read-secret-file`, `print-env`,
`shadow-access`, `pipe-to-shell`, `scp-remote-out`, …) flag commands that would expose or
exfiltrate credentials *before* they run, complementing `capability.redactSecrets`, which
scrubs them *after* they appear in output.

## 4. CLI surface (`darknode nexus`, in the darknode-cli repo)

Route a `shell` command group to `src/shellplan/cli.js` (its `main(argv)` is exported and
returns an exit code):

- `nexus shell explain "<cmd>"` — plain step-by-step account + file impact + risk
- `nexus shell risk    "<cmd>"` — risk findings; exit code non-zero at/above `--threshold`
- `nexus shell files   "<cmd>"` — read/write/delete targets with confidence
- `nexus shell plan    "<cmd>"` — ordered dry-run effect plan (JSON)
- `nexus shell parse   "<cmd>"` — the AST (JSON), for debugging
- `nexus shell check   "<cmd>" --root <d> --allow <cmd> --net <host> [--allow-destructive] [--confirmed]`
  — predicted sandbox verdict

All subcommands accept `--json` for machine output and `--cwd <dir>` for path resolution.

## 5. Residual risks / caveats

- **Static only.** Shellplan never expands `$VAR`, `$(...)`, or globs. Such targets are
  marked `dynamic`; `wouldSandboxAllow` treats a dynamic path as uncontainable (predicted
  deny), which is conservative but can over-warn. Real containment is still done by
  `capability.containPath`, which resolves symlinks/traversal against the live filesystem.
- **Prediction ≠ enforcement.** `wouldSandboxAllow` approximates `containPath` lexically
  (no `fs.realpathSync`), so a symlink escape it cannot see is caught only by the real
  `capability.containPath` at enforcement time. Always enforce with the real modules.
- **Parser is a POSIX subset.** Control-flow keywords (`if`, `for`, `case`, function defs)
  are treated as words, not structure. See the "Honest parser limits" section of
  `README.md`. Decomposition still finds the commands inside them.
- **Risk rules are a denylist of *patterns*, like `sandbox.BLOCKED`.** They explain known
  dangerous shapes; they cannot flag a novel destructive command no rule describes. The
  allowlist (`capability.js`) remains the defense for "anything not explicitly permitted".
- **`safeRun` uses `/bin/sh -c`.** It is for low-risk commands only and refuses anything
  above its threshold, but it is still real execution — do not raise its threshold to run
  destructive commands; route those through `capability` + `sandbox` with explicit confirm.
