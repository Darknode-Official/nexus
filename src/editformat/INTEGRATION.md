# Integration notes -- `src/editformat`

This subsystem adds only new files under `src/editformat/` and `test/editformat/`.
It modifies nothing existing. The items below are the wiring another owner needs to
perform in files this worktree intentionally did not touch (to keep the merge
conflict-free).

## 1. `package.json` test script

The new tests are **not** yet in the `npm test` script (that file was intentionally
not modified). Add `test/editformat/` to both `test` and `test:verbose`:

```jsonc
"test": "node --test test/run.js test/ui.test.js test/tokensave/ test/codegraph/ ... test/editformat/",
"test:verbose": "node --test --test-reporter=spec ... test/editformat/",
```

Until then, run them directly:

```
node --test test/editformat/
```

Result at time of writing: **92 tests, 92 pass, 0 fail.**

## 2. Top-level package export (`index.js`)

To expose the layer from the package root, add alongside the other subsystem
requires:

```js
editformat: require("./src/editformat"),
```

The subsystem's own entrypoint is `src/editformat/index.js`; nothing else needs to
be required directly.

## 3. CLI / engine wiring -- `nexus apply-edits`

A runnable CLI already exists at `src/editformat/cli.js` with a `main(argv)` export
and a shebang. Wire it into the Nexus command dispatcher (wherever subcommands are
registered -- e.g. the `bin`/engine router):

```js
// in the command table
"apply-edits": (argv) => require("./src/editformat/cli").main(argv),
```

Suggested `bin` entry / help text:

```
nexus apply-edits <file-with-model-output> [--dry-run] [--verify <cmd>]
                  [--cwd <dir>] [--fuzzy] [--fuzz <n>] [--json]
```

Exit codes: `0` applied / dry-run ok, `2` edits could not be placed, `1` usage/IO.

## 4. Agent loop integration (programmatic)

The intended use inside the Nexus agent turn:

```js
const ef = require("./src/editformat");

// After the model replies with edits:
const result = ef.applyModelOutput(modelReply, { cwd: repoRoot });

if (!result.ok) {
  // Feed result.diagnoses back to the model for a bounded retry. Each diagnosis
  // carries { path, line, reason, message, candidates[] } -- enough for the model
  // to re-emit a corrected block. NOTHING was written, so a retry is safe.
  return retryWith(result.diagnoses);
}
// result.written is the list of changed files.
```

For a test-gated edit (recommended for autonomous runs):

```js
const det = ef.parseEdits(modelReply);
const r = ef.applyEditsVerified(det.edits, {
  verify: "npm test",                 // or a predicate
  opts: { cwd: repoRoot, onDirty: "snapshot" },
});
// r.reverted === true means the edit was applied, failed the gate, and rolled back.
```

## 5. Relationship to `src/patch`

This layer **depends on** `src/patch` (`apply`, `transaction`, `verify`, `diff`) and
delegates all disk mutation, atomicity, rollback, preview and verify->revert to it.
No duplicate diff/transaction logic is introduced. If `src/patch`'s public API
changes, the touch points are:

- `src/patch/apply.applyPatch` + `apply.hunkImages`
- `src/patch/transaction.begin` (`stageWrite`, `stageDelete`, `commit`, `preview`)
- `src/patch/verify.applyVerifyRevert`
- `src/patch/diff.createUnifiedDiff` / `parseUnifiedDiff` / `diffStat` / `splitLines`

## 6. No dependency / config changes

No `package.json` dependencies were added or changed. Node stdlib only.
