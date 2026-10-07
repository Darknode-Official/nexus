# Refactor — wiring requests

This subsystem ships as new files under `src/refactor/` and `test/refactor/` and
touches **no existing file**. Everything below is an additive change owned by whoever
integrates (kept here so the merge stays conflict-free). It depends on two wave-1
subsystems that must be present: `src/codegraph` and `src/patch`.

## 1. Export from the package root

`index.js` builds the public `module.exports`. Add one line to the require block and
one key to the exports object (next to the other expansion subsystems):

```js
// index.js — "Expansion subsystems" section
const refactor = require("./src/refactor");   // add near patch/codegraph

module.exports = {
  // ...
  tokensave, codegraph, sectools, perf, patch,
  refactor,                                   // <-- add here
  // ...
};
```

`require("nexus").refactor` then exposes `{ Refactorer, fromDir, planRename,
planExtract, planInlineVariable, planInlineFunction, planMove, planOrganizeImports,
preview, apply, applyVerify, plan }`.

> Naming note: there is an existing `src/codemod.js` and `src/patch/codemod.js`.
> This subsystem is a **separate, higher-level** layer (semantic refactorings built
> on both codegraph and patch) and replaces neither. Keep all three.

## 2. How the agent should call it

```js
const refactor = require("nexus").refactor;
const r = refactor.fromDir(cwd);                 // reads JS/TS, skips vendored dirs

const plan = r.rename({ oldName, newName });     // pure; writes nothing
if (!plan.ok) surface(plan.safety.reasons);      // refused with reasons
else {
  showDiffs(r.preview(plan).files);              // dry-run preview for the UX
  r.apply(plan);                                 // atomic multi-file commit
}
```

For autonomous edits, prefer the verify wrapper (reverts byte-for-byte on failure):

```js
const res = r.applyVerify(plan, "npm test", { onDirty: "refuse" });
// res.reverted === true  -> the change was undone because verification failed
```

All six refactorings follow the same RefactorPlan contract, so one UX path (preview →
confirm → apply/verify) serves them all.

## 3. CLI surface

A runnable CLI already exists at `src/refactor/cli.js`. Wire it under the `nexus`
binary's `refactor` subcommand (the dispatcher is owned elsewhere):

```
nexus refactor rename <old> <new> [--file F] [--line N]
nexus refactor extract <file> <start> <end> <newName>
nexus refactor inline-var <file> <name> [--force]
nexus refactor inline-fn  <file> <name>
nexus refactor move <name> <fromFile> <toFile>
nexus refactor imports <file>
   flags: --dir --apply --verify "cmd" --json --force
```

Suggested wiring: route `argv[0] === "refactor"` to
`require("./src/refactor/cli").main()`.

## 4. Boundary with the patch / steerability subsystems

This subsystem produces full new file contents per RefactorPlan and hands them to the
patch engine through `src/refactor/plan.js`:

- **Preview before confirm:** `refactor.preview(plan)` (unified diffs, no disk I/O).
- **Atomic apply / rollback:** `refactor.apply(plan)` builds a `patch` Transaction;
  the commit is all-or-nothing and self-rolls-back on a write error.
- **Verify + auto-revert:** `refactor.applyVerify(plan, cmd)` delegates to
  `patch.verify.applyVerifyRevert`, including its dirty-tree guard.

No budget/telemetry policy is imposed here; wrap `apply`/`applyVerify` with those
layers as the integrator sees fit.

## 5. Tests

Tests live in `test/refactor/` and run independently:

```sh
node --test test/refactor/
```

They are **not** in the `npm test` script (`package.json` is owned elsewhere and was
not modified). To include them, append `test/refactor/` to the `test` and
`test:verbose` scripts in `package.json`:

```json
"test": "node --test test/run.js test/ui.test.js test/tokensave/ test/codegraph/ test/sectools/ test/perf/ test/patch/ test/refactor/"
```

Fixture projects are created in OS temp dirs; nothing is written inside the repo.
