# Retrieval — Integration notes for the main Nexus agent

This subsystem is **self-contained** under `src/retrieval/` and `test/retrieval/`.
It adds **no** third-party dependencies and modifies **no** existing file. Nothing
below is wired yet — these are the suggested, conflict-free hooks for the main
agent to apply.

Single documented entrypoint: `src/retrieval/index.js`.

## 1. Public API export (`index.js`)

To expose it from the package root alongside the other wave-1 subsystems:

```js
// in index.js — with the other expansion-subsystem require()s
const retrieval = require("./src/retrieval");
// ...and in module.exports, under "Expansion subsystems":
//   tokensave, codegraph, sectools, perf, patch, retrieval,
```

## 2. Test runner (`package.json`)

The repo's `test` script enumerates test dirs explicitly, so `test/retrieval/`
is **not** picked up automatically. Add it (additive; no dependency changes):

```jsonc
// scripts.test and scripts.test:verbose — append " test/retrieval/"
"test": "node --test test/run.js test/ui.test.js test/tokensave/ test/codegraph/ test/sectools/ test/perf/ test/patch/ test/retrieval/",
```

Or run standalone: `node --test test/retrieval/` (78 tests).

## 3. CLI wiring (`nexus retrieve`)

A ready-to-run CLI lives at `src/retrieval/cli.js`. To surface it as the
`nexus retrieve "<query>" --budget N` subcommand, route to it (it reads
`process.argv`):

```js
// in the nexus command dispatcher
if (cmd === "retrieve") return require("./src/retrieval/cli").main();
```

Or call the API directly from an engine:

```js
const retrieval = require("./src/retrieval");
const idx = retrieval.indexDirectory(root, { cacheFile: ".nexus/retrieval.json" });
const res = idx.retrieve(userQuery, { budget: ctx.contextBudgetTokens, model: ctx.model });
promptBuilder.addContext(res.context);   // only the relevant spans, within budget
```

Recommended cache location: `.nexus/retrieval.json` (the `.nexus` dir is already
in every skip list in the repo, and should be git-ignored by the host project).

## 4. Suggested agent use points

- **Before answering a question about the codebase**: `idx.retrieve(question,
  { budget })` and feed `res.context` to the engine instead of whole files. This
  is the primary token-saving win.
- **Before editing**: retrieve around the target symbol to pull just the relevant
  call sites / helpers into context.
- **In the planner**: use `res.chunks[].why` to show the user *why* each span was
  included (matched terms, structural reasons).
- **Pair with `tokensave.ledger`**: attribute the whole-file-minus-retrieved
  delta as saved tokens for honest reporting.

## 5. Relationship to sibling subsystems

- **codegraph** (required): used for symbol-aware chunking and the hybrid
  structural signals. If codegraph is absent at runtime, chunking degrades to
  sliding windows and the hybrid signal is skipped — retrieval still works
  (lexical only). `hybrid: false` disables the structural fusion explicitly.
- **tokensave** (required for budgeting): the token estimator and knapsack
  context-packer. If absent, a crude `chars/4` estimator and a top-N fallback are
  used.
- **perf**: this subsystem implements its own store-level incremental cache in the
  same spirit as `perf/incremental.js` (mtime fast path + hash confirm). A future
  refactor could back the store with `perf.createFileCache` directly; kept
  independent for now to avoid a hard coupling.

## 6. Residual risks / limits (so callers set expectations)

- **Lexical + structural, not semantic.** No embeddings: a query must share terms
  (after identifier splitting) with the code, or name a symbol, to match.
  Synonyms without lexical overlap are missed. This is the deliberate cost of zero
  dependencies and full determinism.
- **Token counts are estimates** (tokensave heuristic, ~±15%), so budgets are
  conservative rather than exact. Leave headroom if a hard provider limit matters.
- **Chunk spans are heuristic**: a top-level symbol chunk runs to the next
  top-level symbol, so trailing blank lines/comments attach to the preceding
  chunk. Oversized symbols are window-split and may cut mid-logic (overlap
  mitigates this).
- **Persisted index can grow**: with `storeContent: true` (default) the
  `.nexus/retrieval.json` stores chunk text. Set `storeContent: false` to keep
  only metadata + postings (retrieval then re-reads files for content).
- **In-memory codegraph index for `indexDirectory`**: the hybrid signal rebuilds a
  codegraph index over the read files each call. For very large repos, build the
  codegraph index once and pass it via `retrieve(store, q, { cgIndex })`.
