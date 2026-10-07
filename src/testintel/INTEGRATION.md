# Test Intelligence — Integration notes for the main Nexus agent

This subsystem is **self-contained** under `src/testintel/` and `test/testintel/`. It
adds no third-party dependency and modifies no existing file. Nothing here is wired yet —
these are the suggested, conflict-free hooks. The single documented entrypoint is
`src/testintel/index.js`.

## 1. Public API export (optional, `index.js`)

To expose it from the package root alongside the other expansion subsystems:

```js
// in index.js — with the other expansion-subsystem require()s
const testintel = require("./src/testintel");
// ...and in module.exports, in the "Expansion subsystems" group:
//   testintel,
```

It re-exports the high-level functions (`detectRunners`, `selectAffected`, `run`,
`triage`, `parseCoverage`, `runRepeated`, `untestedFunctions`, `suggestSkeleton`, …) plus
every submodule namespaced (`testintel.parsers`, `testintel.model`, etc.).

Note: `src/testintel` requires `src/codegraph` (for `affected` and `skeleton`). That
wave-1 subsystem is already present in the repo; no new coupling beyond it.

## 2. Test runner

The repo's `npm test` does not yet include this suite. Options (pick one):

- Run standalone: `node --test test/testintel/` (94 tests).
- Or append `test/testintel/` to the `test` / `test:verbose` scripts in `package.json`
  (the same pattern already used for `test/codegraph/`, `test/perf/`, etc.). This is the
  only change that would touch `package.json`, so it's left to the main agent:

```
"test": "node --test test/run.js test/ui.test.js test/tokensave/ test/codegraph/ test/sectools/ test/perf/ test/patch/ test/testintel/"
```

A standalone script (no dep changes):

```json
"test:testintel": "node --test test/testintel/"
```

## 3. CLI wiring (`darknode nexus`)

A ready-to-run CLI lives at `src/testintel/cli.js` and reads `process.argv`. Suggested
routing so it surfaces as `nexus test <sub>`:

```js
// where the CLI dispatches subcommands:
if (argv[0] === "test") {
  const code = await require("./src/testintel/cli").main(argv.slice(1));
  process.exit(code);
}
```

Subcommands: `detect | discover | affected | run | triage | flaky | coverage | skeleton`
(all support `--json`). See the header of `cli.js` for flags.

## 4. Suggested agent use points

- **Before running tests after an edit**: index with codegraph, call
  `testintel.selectAffected(index, { changed, changedSymbols })`, then
  `testintel.run(runner, { files: sel.selected })`. Log `sel.skippedFraction` so the
  user sees the saving. Fall back to the full suite when `sel.selected` is empty *and*
  the change isn't provably isolated (the report tells you).
- **After a failing run**: `testintel.triage(res)` — put `diag.clusters[].headline` +
  `location` into the diagnosis prompt instead of raw logs.
- **When a failure looks non-deterministic**: `testintel.runRepeated(runFn, 5)` before
  concluding it's a regression.
- **On a "done" check**: parse coverage and call `uncoveredChangedLines(cov, changed)` —
  if the agent's new lines are uncovered, prompt it to add a test (use
  `suggestSkeleton`).
- **On repo onboarding / "add tests" tasks**: `untestedFunctions(index)` →
  `suggestSkeleton(fn)` to scaffold.

## 5. Interop with other wave subsystems

- **codegraph** (required): `affected` uses `index.impact()` reverse-reachability and
  `symbolImpact`; `skeleton` uses `index.impact()` to decide whether a function is
  referenced by any test file. It consumes the `Index` object returned by
  `codegraph.indexDirectory()` / `indexFiles()` — pass the one you already built to avoid
  re-indexing.
- **perf** (optional): for large affected sets the agent can run files concurrently with
  `require("./src/perf").mapLimit(files, n, f => testintel.run(runner, { files:[f] }))`,
  then `testintel.model.mergeResults(results)`. Flaky re-runs are intentionally kept
  sequential (see README limits).
- **patch**: after `uncoveredChangedLines` flags a gap, a generated skeleton can be
  written via the patch subsystem's transactional apply.

## 6. Residual risks / limits (so callers set expectations)

- Affected selection is static import-graph + name-convention fallback, not execution
  tracing; it over-selects rather than under-selects, and always reports the skip
  fraction. Dynamic/reflective test→source links rely on the name convention.
- Runners other than node:test must be installed; `run()` reports `available:false`
  with a reason instead of failing opaquely.
- pytest counts in non-verbose mode come from the summary footer (per-test pass names
  aren't printed); the adapter uses `-v` to avoid this.
- Skeletons are stubs with `TODO`s, not correct tests; parameter recovery needs source
  (present for disk indexes).
- Coverage parsing covers lcov, node's coverage table, and coverage.py `report -m`.
  Cobertura/Clover XML are not parsed (convert to lcov first).
