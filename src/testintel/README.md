# Test Intelligence (`src/testintel`)

A Nexus subsystem that makes the agent's test loop **fast and smart**: run only the
tests a change can affect, read failures as a short diagnosis instead of a log wall,
tell flakes from real regressions, see which changed lines aren't covered, and
scaffold tests for untested code.

Zero third-party dependencies — Node.js stdlib only. Builds on the wave-1 subsystems:
`src/codegraph` (impact / blast-radius + symbol graph) for affected-test selection and
untested-function detection, and `src/perf` is available where concurrent execution
helps. Modifies no existing file; one entrypoint: `require("./src/testintel")`.

## Why it saves tokens / time

The agent's single most expensive habit is re-running the whole suite after a one-file
edit and then pasting a wall of output back into context. This subsystem attacks both:

- **Affected selection** turns "run 500 tests" into "run the 6 that can break" (the
  live Nexus repo: changing `model.js` selects 6/50 tests, skipping 88%).
- **Triage** turns 47 raw failures into "2 distinct problems" with the one salient line
  each — a fraction of the tokens.
- **Flaky detection** stops the agent from burning a debugging loop on a ghost.

## Modules

| Module | Responsibility |
|---|---|
| `model` | Unified result model: `pass/fail/skip/todo`, durations, failures, counts. Every runner normalizes to this. |
| `parsers` | Parse node:test (TAP 13), jest `--json`, mocha `--reporter json`, pytest text, `go test -json` into the model. |
| `discovery` | Detect runner(s) by convention with ranked, evidence-based confidence; enumerate test files. |
| `runner` | Build each runner's command, execute (async `run` / sync `runSync`), parse, annotate. `isAvailable` probes without running. |
| `affected` | Minimal affected-test selection via codegraph impact + convention fallback. |
| `coverage` | Parse lcov / node coverage table / coverage.py report; compute uncovered **changed** lines. |
| `flaky` | Run N times, classify `stable-pass` / `flaky` / `consistently-failing` with evidence. |
| `triage` | Cluster failures, extract the salient error/stack, summarize by kind. |
| `skeleton` | Suggest arrange/act/assert test stubs for untested functions (via codegraph). |

## Quick start

```js
const testintel = require("./src/testintel");
const codegraph = require("./src/codegraph");

// 1. Which runner?
const det = testintel.detectPrimaryRunner(process.cwd());   // { runner, confidence, ... }

// 2. Run only what a change can affect.
const index = codegraph.indexDirectory(process.cwd());
const sel = testintel.selectAffected(index, { changed: ["src/x.js"] });
//   -> { selected, skipped, reasons, skippedFraction }

// 3. Execute and normalize.
const res = await testintel.run(det.runner, { files: sel.selected });
//   -> unified Result { ok, counts, tests, durationMs, ... }

// 4. Diagnose.
const diag = testintel.triage(res);          // { clusters, byKind, summary }

// 5. Find flakes.
const { classification } = await testintel.runRepeated(
  () => testintel.run(det.runner, { files: sel.selected }), 5);

// 6. Coverage of the change.
const cov = testintel.parseCoverage(fs.readFileSync("lcov.info", "utf8"));
const gaps = testintel.uncoveredChangedLines(cov, { "src/x.js": [12, 13, 14] });

// 7. Scaffold a test for an untested function.
const [first] = testintel.untestedFunctions(index);
if (first) console.log(testintel.suggestSkeleton(first).code);
```

## CLI

`node src/testintel/cli.js <command>` (wired as `nexus test <command>` — see
INTEGRATION.md). Every command supports `--json`.

```
detect   [dir]                                 detect runner(s)
discover [dir] [--runner R]                     list test files
affected [dir] --changed a,b [--symbol f:name]  minimal set to run (+ why)
run      [dir] [--runner R] [--files a,b] [--coverage] [--grep P]
triage   [dir] [--runner R]                     run + cluster failures
flaky    [dir] --times N [--runner R] [--grep P]
coverage <file> [--changed-lines f:1-10;g:3]
skeleton [dir] [--file F] [--framework FW] [--exported]
```

## Runner & format coverage (honest)

| Runner | Discovery | Output parsing | Coverage | Executes |
|---|---|---|---|---|
| node:test | yes | TAP 13 (full: YAML diag, expected/actual, stack, SKIP/TODO) | node `--experimental-test-coverage` table | yes |
| jest | yes | `--json` | lcov (via jest) | yes (`npx`) |
| mocha | yes | `--reporter json` | — (pair with nyc lcov) | yes (`npx`) |
| pytest | yes | `-v` + FAILURES + summary footer | `coverage.py report -m`, lcov | yes |
| go test | yes | `-json` NDJSON (+ text build-fail fallback) | — (parse via lcov if converted) | yes |

Coverage parsers: **lcov** (`lcov.info` from c8/nyc/jest/coverage.py), **node table**,
**coverage.py `report -m`**. Auto-detected by `coverage.parse(text)`.

## Limits / residual risk

- **Affected selection is import-graph + heuristics, not execution tracing.** It is
  designed to *over*-select slightly (safe) rather than miss a test: dynamic
  `require(var)`, reflection, string-path loads and cross-language links are caught by
  the **name-convention fallback**, not by static resolution. When in doubt, run the
  full suite — the report always states the skip fraction so you can decide.
- **pytest non-verbose output names only failing tests**, so per-test pass names aren't
  recovered; counts are reconciled from the summary footer and kept in `meta.footer`.
  Run with `-v` (the adapter does) for full per-test fidelity.
- **Runner availability**: jest/mocha run via `npx`, pytest/go via their binaries. If a
  runner isn't installed, `run()` returns `{ available:false, reason }` — never a
  cryptic spawn error and never a false "0 failures".
- **Skeletons are stubs, not correct tests.** They wire up import + arrange/act/assert
  with `TODO` placeholders and signature-derived edge-case prompts. Parameter names are
  recovered from source for disk indexes; in-memory indexes without source yield
  empty param lists.
- **Flaky verdicts need ≥2 runs** to mean anything; a single pass is reported as
  `inconclusive`, and confidence is labelled (`none/low/medium/high`) by run count.
  Re-runs are sequential by default (shared fixtures/ports can induce false flakes).
- **Triage is deterministic/local** (no LLM). Clustering normalizes volatile parts
  (numbers, quoted literals, line numbers) so cosmetic variants merge; genuinely
  different root causes stay separate.
