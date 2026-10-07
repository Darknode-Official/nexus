# Integrating the Perf Runtime into Nexus

This subsystem lives entirely under `src/perf/` and adds **no** third-party dependencies.
Nothing outside `src/perf/` and `test/perf/` was modified, so it merges cleanly. To make it
reachable from the engine and the `darknode nexus` CLI, apply the small edits below. Each is
additive; none changes existing behavior until a call site opts in.

## 1. Export it from the public API (`index.js`)

Add alongside the other `require`s and in `module.exports`:

```js
// Performance & concurrency runtime
const perf = require("./src/perf");
// ...
module.exports = {
  // ...existing exports...
  perf,
};
```

Then `require("nexus").perf.createScheduler(...)` (or any submodule) is available. The perf
suite already imports directly from `src/perf/`, so this export is only for public consumers.

## 2. Add it to the test runner (optional)

`test/run.js` can't be modified in this branch. The perf suite is run separately:

```
node --test test/perf/           # 102 tests
```

To fold it into `npm test`, change the `test` script in `package.json` to a glob, or have
`test/run.js` `require()` the files in `test/perf/`. (Left to the owner — `package.json` and
`test/run.js` are outside this subsystem's file scope.)

## 3. Concrete wiring points (highest value first)

### a) Connection pooling for engine HTTP calls — `src/ollama.js`
`ollama.js` opens a fresh `http`/`https` request per call (chat, Claude API, model list) with
no shared keep-alive agent. Give each outbound call a pooled agent to drop TCP+TLS handshake
latency on every request after the first:

```js
const { createPool } = require("./perf/pool");
const enginePool = createPool({ maxSockets: 8, timeout: +(process.env.OLLAMA_TIMEOUT || 300000) });
// in each lib.request({...}) options object, add:  agent: enginePool.agentFor(url.protocol)
// or replace the hand-rolled request with: await enginePool.json(endpoint, { method:"POST", json: payload, signal });
```
`enginePool.stats().reuseRate` then shows socket reuse. Keep one pool per process.

### b) Bounded concurrency for multi-agent / batch work — `src/multi-agent.js`, `src/pipelines.js`
Anywhere Nexus fans out N sub-agents, tool calls, or file analyses, replace ad-hoc
`Promise.all` with the scheduler or `mapLimit` to cap concurrency, honor a user `AbortSignal`,
and apply per-task timeouts:

```js
const { mapLimit } = require("./perf/scheduler");
const results = await mapLimit(tasks, maxParallel, (task, i, signal) => runTask(task, signal), { signal: userAbort });
```

### c) Single-flight + cache for repeated engine/tool calls — `src/engines.js`, `src/mcp-bridge.js`
Wrap idempotent lookups (model lists, MCP `listTools`, repeated identical prompts) so
duplicate concurrent calls collapse and recent results are reused:

```js
const { memoizeAsync } = require("./perf/cache");
const listTools = memoizeAsync(rawListTools, { ttl: 30000, max: 100 }); // LRU + single-flight
```
This complements the existing exact-repeat response cache in `src/costsave.js` (that one is a
disk cache keyed on the full prompt; `memoizeAsync` is the in-memory, concurrent-collapse layer).

### d) Streaming parsers for live engine output — `src/engines.js` (stream kind), `src/ollama.js`
The engine registry marks `claude` as NDJSON (`kind: "stream"`) and `gemini`/`codex` as JSON
CLIs. For true token-by-token streaming (and to stop buffering whole responses), feed the child
stdout / HTTP response through the incremental parsers:

```js
const { createNDJSONParser, sseDataEvents } = require("./perf/streams");
const parser = createNDJSONParser((evt) => onToken(evt));   // Claude Code / Ollama NDJSON
proc.stdout.on("data", (c) => parser.feed(c));
proc.stdout.on("end", () => parser.end());
```
For a streaming Ollama endpoint set `stream: true` and parse the NDJSON; for OpenAI-style SSE
use `sseDataEvents`. (`src/parsers.js` stays the parser for the *non-streaming* JSON CLIs.)

### e) Incremental file layer for repo scans — `src/context.js`, `src/knowledge-graph.js`, `src/code-radar.js`
Scanners that re-read the repo every turn should cache per-file work and re-run only on real
change:

```js
const { createFileCache, createWatcher } = require("./perf/incremental");
const fileCache = createFileCache();              // reuse across turns
const analysis = fileCache.getOrCompute(path, (content) => analyze(content));
createWatcher(repoRoot, { debounce: 100 }).on("change", (paths) => invalidate(paths)).start();
```

### f) Metrics — `src/telemetry.js`
`telemetry.js` already persists per-action events to disk. The perf `createMetrics` /
`createSpanRecorder` are the in-process, low-overhead layer for live timing and flame traces
within a single turn; emit a span tree per turn and roll its summary into a telemetry event.

## 4. CLI surface (`darknode nexus`, in the darknode-cli repo)

Suggested commands, all backed by the stats objects these modules already return:

- `nexus perf stats` — print `scheduler.stats()`, `pool.stats()`, cache `hitRate`s.
- `nexus perf bench [group]` — shell out to `node src/perf/bench.js [group]`.
- A `--concurrency N` global flag → `scheduler.setConcurrency(N)` / `mapLimit` limit.
- A `--trace out.json` flag → write `spanRecorder.chrome()` for `chrome://tracing`/speedscope.

## 5. Residual risks / caveats

- **`fs.watch` is best-effort** (misses under heavy churn, duplicate events, OS-dependent
  recursion). Treat the watcher as a "when to re-check" hint; the file cache's stat/hash check
  is the source of truth. The watcher attaches one watch per directory (portable), so very
  large trees cost many watchers — scope it or rely on the file cache alone for huge repos.
- **Timeouts can't force-stop opaque work.** A task that ignores its `AbortSignal` keeps
  running after a timeout/cancel; the scheduler stops awaiting it and frees the slot. Pass the
  signal into `fetch`/child spawns for real cancellation.
- **Pool does not throw on non-2xx** — call sites must inspect `res.status`.
- **Cache size accounting is an estimate** (UTF-8 byte length) unless a custom `sizeOf` is
  given; it bounds memory, it is not exact.
- **No persistence for in-memory caches/metrics** across process restarts (by design); use
  `createDiskCache` or `src/telemetry.js` for durability.
