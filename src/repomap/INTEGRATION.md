# Repo Map — Integration notes for the main Nexus agent

This subsystem is **self-contained** under `src/repomap/` and `test/repomap/`. It
adds **no** third-party dependencies and modifies **no** existing file. Nothing
below is wired yet — these are the suggested, conflict-free hooks for the main
agent to apply.

Single documented entrypoint: `src/repomap/index.js`.

## 1. Public API export (`index.js`)

To expose it from the package root alongside the other expansion subsystems:

```js
// in index.js — with the other expansion-subsystem require()s
const repomap = require("./src/repomap");
// ...and in module.exports, under "Expansion subsystems":
//   tokensave, codegraph, sectools, perf, patch, retrieval, repomap,
```

## 2. Test runner (`package.json`)

The repo's `test` script enumerates test dirs explicitly, so `test/repomap/` is
**not** picked up automatically. Add it (additive; no dependency changes):

```jsonc
// scripts.test and scripts.test:verbose — append " test/repomap/"
"test": "node --test test/run.js test/ui.test.js test/tokensave/ test/codegraph/ test/sectools/ test/perf/ test/patch/ test/lsp/ test/retrieval/ test/refactor/ test/testintel/ test/repomap/",
```

Or run standalone: `node --test test/repomap/` (54 tests).

## 3. CLI wiring (`nexus repomap`)

A ready-to-run CLI lives at `src/repomap/cli.js`. To surface it as the
`nexus repomap --budget N --focus <file>` subcommand, route to it (it reads
`process.argv`):

```js
// in the nexus command dispatcher
if (cmd === "repomap") return require("./src/repomap/cli").main();
```

Or call the API directly from an engine:

```js
const repomap = require("./src/repomap");
const r = repomap.repomap(root, {
  budget: ctx.repoMapBudgetTokens || 2000,
  model: ctx.model,
  focus: ctx.openFiles,                 // bias toward what the agent is editing
  cacheFile: ".nexus/repomap.json",
});
systemPrompt.addSection("Repository map", r.map);   // always-on orientation, <= budget
```

Recommended cache location: `.nexus/repomap.json` (the `.nexus` dir is already in
every skip list in the repo, and should be git-ignored by the host project).

## 4. Suggested agent use points

- **Always-on context primer.** Put `repomap(root, { budget }).map` in the system
  prompt at the start of a session so the agent knows the shape of the project
  without reading files. This is the primary token-saving win vs. dumping source.
- **Task focus.** Pass the files the agent is currently editing as `focus`; the map
  then re-ranks around that task (seeds + their dependencies + dependents).
- **Pair with retrieval.** Repo Map answers "what is this project"; retrieval
  answers "what's relevant to this query". Use the map for orientation and
  retrieval for the specific spans to edit.
- **Pair with `tokensave.ledger`.** Attribute `fullSourceTokens(root).sourceTokens
  − r.tokens` to a `repo-map` technique for honest savings reporting; the CLI
  `--savings` flag prints exactly this.

## 5. Relationship to sibling subsystems

- **codegraph** (required): `src/codegraph/parse` (symbols/imports/exports),
  `tokenizer` (string/comment masking for robust reference counting and signature
  extraction), and `depgraph` (resolved import backbone). Repo Map does not require
  a full codegraph `Index` — it parses files itself and builds only the dependency
  graph it needs, so the two subsystems share code without a runtime coupling.
- **tokensave** (required for budgeting): `estimator.estimateTokens` is the single
  source of truth for the token budget, so the map's accounting is consistent with
  the context packer and diff builder.
- **perf**: the incremental cache (`cache.js`) follows the same mtime-fast-path +
  hash-confirm convention as `perf/incremental.js` and `codegraph/cache.js`. Kept
  independent to avoid a hard coupling; a future refactor could back it with
  `perf.createFileCache`.

## 6. Residual risks / limits (so callers set expectations)

- **Heuristic references, not a full resolver.** Reference edges come from
  identifier frequency over masked source matched against the global definer set.
  This is the deliberate, dependency-free design (the aider repo-map approach). It
  does not do scope/type resolution, so an identifier shared by an unrelated local
  variable and a distant function creates a (down-weighted, ambiguity-damped) edge.
  Common names are heavily damped; descriptive names dominate, which is what the
  ranking wants.
- **Token counts are estimates** (tokensave heuristic, ~±15%). The render's final
  verification trims against that *same* estimate, so the map never exceeds the
  budget *as measured by the estimator* — leave headroom if a hard provider limit
  matters and the real tokenizer runs denser.
- **Incremental caches extraction, not PageRank.** PageRank is recomputed each
  build (it is cheap: milliseconds for thousands of nodes). The warm-build speedup
  (~20–25× on this repo) comes from skipping per-file extraction, not from
  incremental ranking. See README "What incremental does and does not cover".
- **Signature extraction is heuristic per language.** It relies on codegraph's
  parse (functions, classes, methods for JS/TS/Python/Go/Ruby). Exotic syntax that
  codegraph does not model (e.g. decorators-as-definitions, some TS overload
  forms) may yield a synthetic `name()` fallback rather than a full signature.
- **Very large repos.** The walk honors `maxFiles` (20k) / `maxBytes` (2MB). For
  monorepos, point `repomap()` at the relevant package root or raise the limits.
