# Nexus measurement harnesses

Every quantitative claim Nexus publishes must map to a harness here that a third
party can run. Harnesses split into two kinds:

- **Deterministic** (no credentials): measurable now, on any machine. These prove
  the *additive* behaviour of the wrapper.
- **Live-engine** (credentials required): the full round-trip cost/quality. These
  need an authenticated engine (`claude`, `gemini`, or `codex` CLI, or an
  `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`). Not yet run — see "Live runs" below.

## NX-101 — token economics

### `node bench/nx101-overhead.js [targetDir]`  (deterministic)

Measures the input tokens Nexus adds per turn over a bare `engine -p "<task>"`
call, using the repo's real modules (`context`, `prompt-engine`, `costsave`,
`knowledge-graph`). Writes `bench/results/nx101-overhead.json`.

Result against this repo (12k LOC target), avg over 8 tasks:

| path | avg input tokens | multiple of bare |
|------|-----------------:|-----------------:|
| bare direct engine call | 27 | 1x |
| full Nexus path | 3,939 | ~153x |
| lean path (`--lean`) | 164 | ~6.3x |

**Headline:** on 0/8 tasks is the full Nexus input at or below a bare call. The
wrapper's input is additive — ~3,900 tokens/turn of auto-gathered context +
template + CoT. The lean path removes ~96% of that overhead. Net dollar savings,
if any, must come from (a) context the engine would otherwise have gathered itself
(unmeasured here), (b) `cowork` delegation to cheaper models, or (c) cache hits on
exact repeats. None of those are credited by this deterministic run.

> The ratio (153x) is inflated by tiny task strings; the **absolute** overhead
> (~3,900 tokens/turn) is the figure to quote. Token unit is the repo's own
> `ceil(chars/4)` estimator, so absolute numbers are approximate but ratios hold.

### `node bench/nx101-costsaver.js`  (deterministic)

Tests the README "Cost Saver = 10-30%" claim. Result:

| input class | squeeze saving |
|-------------|---------------:|
| same file inlined 3x (best case) | 63.5% |
| whitespace-only | 28.6% |
| realistic assembled Nexus prompt | **0%** |

**The flat 10-30% claim is not supported for a typical turn.** It holds only when
context contains duplicated file blocks, plus 100% on exact read-only cache hits
(a hit-rate, not a per-turn saving). The README has been qualified accordingly.

## Live runs (NX-101 full dollar comparison, NX-110 correctness) — NOT YET RUN

A true "Nexus vs direct engine" dollar figure requires the engine's own gathering,
output tokens, and real billing. That needs:

1. An authenticated engine CLI on PATH (`claude`, `gemini`, or `codex`), or
   `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` in the environment.
2. For each task in `bench/tasks.js`, run it twice — once via the Nexus runner
   (which lives in `darknode-cli`, not this engine repo) and once as a bare
   `engine -p "<task>"` — and diff the reported token/dollar totals.
3. Multiple seeds per configuration; report variance, not just the mean.

This harness is **not yet run against live engines** because this environment has
no engine credentials. The deterministic harnesses above bound the input side; the
output side and real billing remain unverified. Do not quote a net-dollar
"Nexus is cheaper" number until the live harness has been run and committed here.

## NX-110 — evaluation harness

### `node bench/nx110-eval.js [--seeds N] [--engines a,b] [--held-out]`

Runs the task set per engine, per seed, recording cost + latency + tokens
alongside correctness, reporting variance across seeds (not just the mean), and
checking which engine wins each class vs what `cowork` routes. A contamination
gate excludes tasks of unknown provenance. The held-out set (`--held-out`) is
reserved for a single final run.

Correctness needs a LIVE engine, supplied as an adapter:

```
NEXUS_EVAL_ADAPTER=./bench/adapters/my-adapter.js node bench/nx110-eval.js
```

An adapter implements `run({task,engine,seed}) -> {output,tokensIn,tokensOut,
latencyMs,cost}` and `score(task,output) -> true|false|null`. See
`bench/adapters/null-adapter.js` for the reference (no-engine) implementation.

**Status: NOT YET RUN against live engines.** This environment has no engine
credentials, so the committed run uses the null adapter: tokens and latency are
recorded, correctness is reported as `unscored` (null), and dollars require live
billing. The harness is runnable by a third party from this file alone. This is
the baseline NX-101..108 are measured against once an authenticated adapter is
provided (credentials: an authed `claude`/`gemini`/`codex` CLI, or
`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`).

## NX-106 — duplication detection

`node bench/nx106-duplication.js` — knowledge-graph recall for existing code.

## NX-107 — local-model tiers

`node bench/nx107-tiertable.js` — tier table from installed-model measurement.

## Provenance / contamination (NX-110)

`bench/tasks.js` tags each task `synthetic` (written here, never published) or
`repo-local` (references this private repo). A task of unknown contamination status
is excluded from any live correctness run.
