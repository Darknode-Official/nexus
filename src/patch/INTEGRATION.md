# Patch engine — CLI / core wiring

This subsystem is the **engine**; it ships as new files under `src/patch/` and
touches no existing file. Wiring it into the running agent is a small, additive
change owned by whoever integrates (kept here so the merge stays conflict-free).

## 1. Export from the package root

`index.js` currently builds the public `module.exports`. Add one line to the
require block and one key to the exports object:

```js
// index.js — Execution section
const patch = require("./src/patch");   // add near codemod/codeActions

module.exports = {
  // ...
  sandbox, codemod, codeActions, verification, nxp,
  patch,                                // <-- add here
  // ...
};
```

No existing module is renamed or removed. `require("nexus").patch` then exposes
`{ diff, apply, transaction, codemod, verify, preview, applyDiffToFile, begin, ... }`.

> Note: there is an existing `src/codemod.js` (project-wide regex codemods). This
> engine's `patch.codemod` is a **separate, scanner-based** module and does not
> replace it. Keep both; they serve different needs.

## 2. How the agent should apply model-produced edits

When the model returns a unified diff:

```js
const patch = require("nexus").patch;
const res = patch.applyDiffToFile(absPath, unifiedDiff, { cwd, fuzz: 2 });
if (!res.ok) { /* surface res.errors to the steerability UX */ }
```

For a multi-file change set, build one transaction so it is atomic:

```js
const tx = patch.begin({ cwd });
for (const edit of edits) {
  if (edit.diff)   tx.stagePatch(edit.file, edit.diff);
  if (edit.write)  tx.stageWrite(edit.file, edit.content);
  if (edit.remove) tx.stageDelete(edit.file);
}
const preview = tx.preview();        // feed to the undo/preview UX before committing
const result  = tx.commit();         // atomic; rolls back fully on any failure
```

## 3. Apply-with-verification (recommended default for autonomous edits)

```js
const result = patch.applyVerifyRevert({
  transaction: tx,
  verify: "npm test",                 // or the project's build/lint command
  opts: { cwd, onDirty: "refuse" },   // refuse to edit a dirty tree by default
});
// result.reverted === true means the change was undone because verify failed.
```

## 4. Boundary with the steerability / undo / budget subsystem

That subsystem (built separately) owns the UX; this engine provides the
primitives it should call:

- **Preview before confirm:** `tx.preview()` / `patch.preview.renderTransaction(...)`.
- **Undo:** keep the `checkpoint` returned by `tx.commit()` (`result.checkpoint`),
  or capture one yourself via `patch.transaction.checkpoint(files)`; undo with
  `patch.transaction.restore(cp)`.
- **Budget hooks:** the engine is synchronous and side-effect-light; wrap
  `commit` / `applyVerifyRevert` calls with the budget accounting layer. The
  engine imposes no budget policy of its own.

## 5. Suggested CLI surface (for the UX owner to implement)

- `darknode nexus patch apply <file> <diff>` → `applyDiffToFile`
- `darknode nexus patch preview <...>` → `tx.preview()`
- `darknode nexus codemod rename <old> <new> [globs]` → `codemod.runOnFiles`
- `darknode nexus edit --verify "<cmd>"` → `applyVerifyRevert`

## 6. Tests

The engine's tests live in `test/patch/` and run independently of the main suite:

```sh
node --test test/patch/
```

They are not added to `test/run.js` (that file is owned elsewhere and must not be
modified here). If the integrator wants them in `npm test`, add
`node --test test/run.js test/patch/` to the `test` script, or `require` the
patch tests from `test/run.js`.
