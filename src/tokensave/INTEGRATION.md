# Token-Saving Engine — Integration notes

This subsystem is self-contained under `src/tokensave/` and `test/tokensave/`. It
adds **no** changes to existing files, to guarantee a conflict-free merge. The
small wiring below is for the main agent to apply at merge time.

## 1. Export from the public API (`index.js`) — required

Add the require alongside the other `src/` requires (e.g. in the "Ops" group):

```js
const tokensave = require("./src/tokensave");
```

Add `tokensave` to the `module.exports` object (e.g. in the "Ops" line):

```js
// Ops
telemetry, plugins, bgjobs, pricing, costsave, gitIntel, tokensave,
```

That is the only change needed for `nexus.tokensave` to be available to the CLI
and the engine. The module exports:

- `tokensave.register(ctx, opts)` — attaches `ctx.tokensave` and returns the API.
- `tokensave.createEngine(opts)` — an instance with a shared savings `ledger`.
- Namespaces: `compressor`, `semanticCache`, `contextPacker`, `diffContext`,
  `cachePlanner`, `estimator`.
- Convenience: `compress`, `pack`, `planCache`, `buildDiffContext`,
  `estimateTokens`, `SemanticCache`, `Ledger`.

## 2. Include the tests in `npm test` — recommended

The existing `test/run.js` is unchanged. To run the new tests under the same
harness, update the `scripts.test` / `scripts.test:verbose` in `package.json` to
add the directory (Node's test runner discovers `*.test.js` there):

```json
"test": "node --test test/run.js test/tokensave/",
"test:verbose": "node --test --test-reporter=spec test/run.js test/tokensave/",
```

Alternatively, the tests can be run standalone without any change:

```bash
node --test test/tokensave/
```

They are self-contained (no fixtures, no network, no temp files left behind) and
add 94 passing tests across 24 suites.

## 3. Optional — wire into the agent turn (engine-side, likely in darknode-cli)

The engine already ships a lighter `src/costsave.js` (exact-match cache +
whitespace squeeze). This subsystem is a superset; suggested hook points for the
turn pipeline (no file here needs changing — this is guidance for the caller):

1. **Before building the request** — if this is a file-edit turn, replace whole
   files with `tokensave.diffContext.fromEdit(oldText, newText, { neighbors: 3, model })`.
2. **When selecting context** — feed candidate chunks + their relevance scores to
   `tokensave.contextPacker.pack(chunks, budget, { model })` instead of ad-hoc
   truncation.
3. **Before sending** — run the assembled prompt through
   `tokensave.compressor.compress(prompt, { level: 2, model })` (level 2 is a safe
   default; it never touches code/paths/URLs/strings/identifiers).
4. **Prompt-cache structuring** — pass the message segments through
   `tokensave.cachePlanner.plan(segments, { provider, model })` and send the
   returned `messages` (which carry Anthropic `cache_control` breakpoints, or are
   ordered stable-first for OpenAI auto-caching).
5. **Response caching** — on each read-only turn, `cacheGet(requestText)` before
   calling the model; on a miss, call the model then `cacheSet(requestText, answer,
   { tokens })`. Use one `createEngine(...)` per session so `engine.ledger` and
   `engine.cache` accumulate, and surface `engine.summary()` in the cost meter.

`register(ctx)` exists for a one-liner setup if the engine passes a context object
around: `tokensave.register(ctx, { model, provider })` then use `ctx.tokensave.engine`.

## Notes

- `package.json` `files` already includes `src/`, so the subsystem ships with the
  package. `src/tokensave/README.md`, `INTEGRATION.md`, and `benchmark.js` ship
  with it (harmless; benchmark is runnable documentation).
- Zero runtime dependencies were added; nothing in `package.json#dependencies`
  changes.
