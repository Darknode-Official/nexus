# Nexus Patch / Codemod Engine

The engine by which Nexus edits code **reliably and reversibly**. It turns a
proposed change (a unified diff, a full-file write, a structured codemod, or a
mix) into a safe, atomic, auto-verifiable, fully reversible operation on disk.

Zero third-party dependencies — Node.js stdlib only. CommonJS, `node >= 18`.

> Scope: this is the underlying *engine*. The user-facing steerability / undo UX
> and budget controls are built by a separate subsystem. See `INTEGRATION.md`.

```js
const patch = require("./src/patch"); // or require("nexus").patch once wired
```

## Modules

| Module        | Responsibility |
|---------------|----------------|
| `diff`        | Line diff (Myers O(ND)), unified-diff generate + parse, diff stats. |
| `apply`       | Fuzzy hunk apply with drift/offset + fuzz tolerance and clean rejection. |
| `transaction` | Stage edits across many files; commit atomically or roll back fully. |
| `codemod`     | Identifier-aware scoped transforms (rename, wrap calls, replace). |
| `verify`      | Apply → run a verify command → auto-revert on failure; dirty-tree aware. |
| `preview`     | Dry-run renderings for all of the above. |

## 1. Diff — `patch.diff`

```js
const ud = patch.createUnifiedDiff(oldText, newText, { oldPath, newPath, context: 3 });
const files = patch.parseUnifiedDiff(ud);        // [{ oldPath, newPath, hunks: [...] }]
const stat  = patch.diff.diffStat(ud);           // { additions, deletions, hunks, files }
```

- Minimal edit script via the Myers algorithm.
- Trailing-newline fidelity: a missing final newline round-trips via the standard
  `\ No newline at end of file` marker.
- `createUnifiedDiff` → `parseUnifiedDiff` → `applyPatch` round-trips exactly.

## 2. Apply — `patch.apply`

```js
const res = patch.applyPatch(originalText, parsedFilePatch, { fuzz: 2, maxOffset, partial: false });
// res = { ok, text, applied, rejected, hunks: [{ index, applied, offset, fuzz, reason? }] }
```

- **Drift tolerance:** searches outward from the expected line, reporting the
  `offset` (lines of drift) actually used.
- **Fuzz:** relaxes up to `fuzz` lines of leading/trailing context per edge
  (default 2), reporting the `fuzz` level used — exactly like GNU `patch`.
- **No silent half-apply:** by default a single rejected hunk aborts the file
  apply and returns the **original text unchanged** plus a per-hunk rejection
  report. Opt into partial application with `{ partial: true }`.
- `patch.apply.formatRejects(res)` renders a `.rej`-style report.

## 3. Transaction — `patch.transaction`

```js
const tx = patch.begin({ cwd });
tx.stageWrite(file, content);
tx.stageDelete(file);
tx.stagePatch(file, unifiedDiffOrParsed, { fuzz, maxOffset });

tx.preview();            // unified diffs + add/delete counts, writes nothing
const r = tx.commit({ dryRun: false });
// r = { ok, committed, written?, errors?, rolledBack? }
```

Commit is two-phase:

1. **Validate** — every op is computed in memory (patches must apply). Any error
   aborts the whole set **before anything is written**.
2. **Write** — a checkpoint of every touched file is taken, then all writes flush.
   If any write throws, the checkpoint is **fully restored**.

Multiple ops on the same file are threaded in order. `checkpoint(files)` /
`restore(cp)` are exported for external use (the verify harness builds on them).

## 4. Codemod — `patch.codemod`

```js
patch.codemod.renameIdentifier(text, "old", "new");      // whole-word, code-only
patch.codemod.wrapCalls(text, "fetch", "traced");        // balances nested parens
patch.codemod.replaceLiteral(text, "A", "B", { wholeWord, codeOnly });
patch.codemod.runOnFiles(files, fn, { cwd, dryRun });    // atomic via a Transaction
```

All string transforms are built on `codeMask(text)`, a zero-dependency lexical
scanner that tracks strings, template literals, and line/block comments, so an
identifier rename never corrupts a string or comment that merely contains the
word. Each transform returns `{ text, changes }` for previewing.

## 5. Verify → auto-revert — `patch.verify`

```js
const r = patch.applyVerifyRevert({
  transaction: tx,
  verify: "npm test",          // shell command, or a () => boolean | { passed }
  opts: { cwd, onDirty: "refuse", timeout: 120000 },
});
// passes  -> { ok:true,  verified:true,  reverted:false, written }
// fails   -> { ok:false, verified:false, reverted:true,  verify, rollbackActions }
```

- Snapshots the change set, applies it, runs the verifier, and **auto-reverts**
  to the snapshot if verification fails.
- **Dirty-tree safety** (`onDirty`):
  - `"refuse"` (default) — if any target file has uncommitted git changes, the
    harness refuses and touches nothing (`reason: "dirty-tree"`).
  - `"snapshot"` — proceed using a deterministic checkpoint for isolation (no git
    dependency); a revert returns to the pre-apply state.
- `dryRun: true` previews and runs nothing.

## 6. Dry-run & preview

Every mutating entrypoint accepts `dryRun` / supports `.preview()`:
`tx.commit({ dryRun:true })`, `tx.preview()`, `codemod.runOnFiles(..., { dryRun:true })`,
`applyVerifyRevert({ ..., opts:{ dryRun:true } })`, and `applyPatch` is pure (never
writes — the caller decides when to persist `res.text`).

`patch.preview` renders human-readable summaries: `diffPreview`,
`renderTransaction`, `renderApply`.

## Safety guarantees (honest)

- **No silent half-apply.** A rejected hunk aborts the file apply by default; the
  original text is returned untouched with reasons.
- **Atomic multi-file commits.** All files change or none do; a mid-write failure
  triggers a full rollback from checkpoint.
- **Reversible.** Every on-disk mutation is backed by a checkpoint that restores
  content, re-creates deleted files, and removes newly created ones.
- **Dirty-tree aware.** The verify harness refuses (or deterministically
  snapshots) a dirty working tree before applying.

### Known limits (not hidden)

- The codemod scanner is **lexical, not a full parser** — it correctly ignores
  strings/comments but does not do scope/semantic analysis (it will rename a
  shadowing local of the same name). Use it for mechanical, reviewable edits and
  preview before committing.
- Fuzzy apply, like GNU `patch`, can in principle match relocated-but-identical
  context at the wrong site under high fuzz; defaults are conservative (`fuzz: 2`)
  and the chosen `offset`/`fuzz` are always reported for review.
- Checkpoints are in-memory/process-local; they protect a single operation, not a
  crash across process restarts (that is the job of the git layer above).

## Demo & tests

```sh
node src/patch/demo.js        # end-to-end walkthrough in a temp dir
node --test test/patch/       # unit tests (temp dirs under the OS temp dir)
```
