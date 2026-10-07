# Code Graph — Integration notes for the main Nexus agent

This subsystem is **self-contained** under `src/codegraph/` and `test/codegraph/`.
It creates no new third-party dependencies and modifies no existing file. The main
agent decides how (and whether) to wire it into the public API and the CLI. Nothing
here is wired yet — these are the suggested, conflict-free hooks.

## 1. Public API export (optional, `index.js`)

To expose it from the package root alongside the other modules, add:

```js
// in index.js — with the other require()s
const codegraph = require("./src/codegraph");
// ...and in module.exports, under a suitable group:
//   codegraph,
```

`src/codegraph/index.js` is the single documented entrypoint. It re-exports the
high-level functions (`indexDirectory`, `indexFiles`, `parseSource`, `detectLang`)
and all building-block modules.

## 2. Test runner

The repo's `npm test` runs `node --test test/run.js` only, so the Code Graph tests
are **not** picked up automatically. Options (pick one):

- Run them with their own command: `node --test test/codegraph/` (62 tests).
- Or update the `test` script to `node --test test/run.js test/codegraph/` (both
  suites) — this is the only change that would touch `package.json`, so it is left
  to the main agent.

Suggested `package.json` script (additive, no dep changes):

```json
"test:codegraph": "node --test test/codegraph/"
```

## 3. CLI wiring (`darknode nexus`)

A ready-to-run CLI lives at `src/codegraph/cli.js`. To surface it as a Nexus
subcommand, route e.g. `nexus codegraph <dir> [--dupes|--cycles|--find <q>|--bench]`
to `require("./src/codegraph/cli").main()` (it reads `process.argv`), or call the
API directly:

```js
const codegraph = require("./src/codegraph");
const idx = codegraph.indexDirectory(root, { cacheFile: ".nexus/codegraph.json" });
```

Recommended cache location: `.nexus/codegraph.json` (the `.nexus` dir is already in
the repo's skip list used by `deps.js` / `codestats.js`, so the cache won't be
indexed as source). `.nexus/` should be git-ignored by the host project.

## 4. Suggested agent use points

- **Before writing a new function**: call `idx.findImplementation(description)` and,
  if a strong match exists, reuse it (DRY).
- **Before editing a symbol**: call `idx.impact({ file, name })` to warn about the
  blast radius and to pull the direct call sites into context.
- **On repo onboarding**: `idx.stats()` + `idx.cycles()` for a fast situational
  summary; `idx.duplicates()` to flag refactor opportunities.
- **For planning multi-file changes**: `idx.topo()` gives a dependency-safe order.

## 5. Residual risks / limits (so callers set expectations)

- Heuristic parsing (no full type system). Dynamic/computed imports and exports,
  macro/`eval` constructs, and TS type-only graph edges are not resolved.
- Go/package imports that aren't relative are treated as external (no module-path
  resolution against `go.mod`).
- Duplication reports structural (Type-2) clones; it does not do fuzzy Type-3
  alignment across edits beyond splitting at the edit point.
- The incremental cache trusts `(mtime, size)` on the fast path; `cache.verify()`
  with the stored SHA-1 is available if a caller wants content-level certainty.
