# Nexus Performance & Concurrency Runtime (`src/perf`)

Primitives that make Nexus fast and efficient: a bounded concurrent executor, request
coalescing/batching, HTTP connection pooling, a layered cache, an incremental file layer,
streaming parsers, and low-overhead metrics.

- **Zero third-party dependencies** — Node.js stdlib only (`events`, `http`/`https`,
  `fs`, `crypto`, `stream`, `string_decoder`, `url`).
- **Independently usable** — every factory stands alone; import only what you need.
- **Tested** — `test/perf/` (run with `node --test test/perf/`), including concurrency,
  cancellation, timeout, eviction, SWR, and partial-chunk edge cases.

```js
const perf = require("./src/perf");            // or require("./src/perf/index")
const { createScheduler, createLRU } = perf;   // flat re-exports
const scheduler = require("./src/perf/scheduler"); // or a single submodule
```

---

## 1. Scheduler — `scheduler.js`

Bounded worker-pool executor with priorities, timeouts, cancellation, and backpressure.

```js
const { createScheduler, mapLimit } = require("./src/perf/scheduler");

const sched = createScheduler({ concurrency: 4, maxQueue: 1000, defaultTimeout: 30000 });

const result = await sched.submit(
  (signal) => fetchSomething(url, { signal }),   // task receives an AbortSignal
  { priority: 10, timeout: 5000, signal: userAbort.signal, name: "fetch" }
);

await sched.onIdle();        // resolves when queue drains and all running tasks settle
sched.setConcurrency(8);     // adjust live
sched.pause(); sched.resume();
sched.clear("shutdown");     // reject all queued (not-yet-started) tasks
console.log(sched.stats());  // { submitted, completed, failed, timedOut, cancelled, running, pending, maxConcurrent }
```

- **Priorities**: higher `priority` runs first; ties break FIFO (submission order). Backed
  by a binary min-heap (`O(log n)` push/pop), so deep queues stay cheap.
- **Cancellation**: pass an `AbortSignal`. If it aborts while queued, the task is removed
  and rejected immediately; if running, the task's own signal aborts so cooperative tasks
  stop promptly. An already-aborted signal rejects synchronously.
- **Timeouts**: `timeout` (or `defaultTimeout`) aborts the task's signal and rejects with a
  `TimeoutError`. Tasks that ignore the signal keep running in the background; the scheduler
  stops waiting and frees the slot once they settle (it cannot force-stop opaque work).
- **Backpressure**: `maxQueue` makes `submit` reject with `code: "EQUEUEFULL"` when full.
- **`mapLimit(items, limit, worker, opts)`**: bounded parallel map, order-preserving, rejects
  on first error and cancels the rest.

Events (it is an `EventEmitter`): `start`, `settle`, `reject`, `idle`.

## 2. Coalesce — `coalesce.js`

Cut redundant work: never do the same thing twice at once.

```js
const { singleFlight, createBatcher, debounce, throttle } = require("./src/perf/coalesce");

// De-duplicate concurrent identical calls (single-flight). Slot frees on settle — no stale cache.
const getProfile = singleFlight((id) => api.profile(id));
await Promise.all([getProfile(7), getProfile(7)]); // api.profile called once

// Collect many calls into one batched round-trip; results fan back out by index.
const lookup = createBatcher((keys, items) => api.bulkLookup(items), { maxBatch: 50, maxWait: 10 });
const [a, b] = await Promise.all([lookup("x"), lookup("y")]); // one bulkLookup call

const onChange = debounce(rescan, 100);  // .cancel() / .flush(); returns a promise
const onScroll = throttle(update, 50);   // leading/trailing edges; .cancel() / .flush()
```

The batcher de-dupes identical items within a batch and validates that the executor returns
an array aligned to the keys.

## 3. Connection pool — `pool.js`

Keep-alive HTTP(S) pooling for engine/tool API calls. Reusing warm TCP+TLS sockets removes
handshake latency from every call after the first.

```js
const { createPool } = require("./src/perf/pool");
const pool = createPool({ maxSockets: 16, maxFreeSockets: 8, timeout: 30000 });

const res = await pool.request(url, { method: "POST", body, headers, signal, timeout });
// → { status, headers, body, url }  (does NOT throw on non-2xx — inspect status)

const { status, data } = await pool.json(url, { json: { q: "hi" } }); // encode/decode JSON

// Retry an idempotent op with exponential backoff + jitter (never retries AbortError):
const out = await pool.withRetry(() => pool.request(url), { retries: 3, baseDelay: 100 });

console.log(pool.stats()); // { requests, reused, created, reuseRate, errors, retries, bytesIn/Out, sockets }
pool.destroy();            // close idle sockets
```

Uses LIFO socket scheduling for better keep-alive locality. Pass `signal` for cancellation
and `timeout` for inactivity timeouts.

## 4. Cache — `cache.js`

Composable LRU + TTL + stale-while-revalidate, plus a persistent disk cache.

```js
const { createLRU, createDiskCache, memoizeAsync } = require("./src/perf/cache");

const lru = createLRU({ max: 500, maxBytes: 8 << 20, ttl: 60000, staleTtl: 300000 });
lru.set("k", value); lru.get("k");
// SWR: fresh → cached; stale → serve now + refresh in background; miss → await loader.
const v = await lru.getOrLoad("k", () => loadExpensive(), /*ttl*/ 60000);
console.log(lru.stats()); // { hits, misses, stale, evictions, expirations, size, bytes, hitRate }

const disk = createDiskCache(".nexus/cache/http", { ttl: 86400000 }); // survives restarts
disk.set("key", obj); disk.get("key"); disk.prune(); // remove expired

const compute = memoizeAsync(expensiveAsyncFn, { max: 1000, ttl: 60000 }); // LRU + single-flight
```

LRU order is maintained with a `Map` (insertion order; "touch" = delete+re-set). Size
accounting is an estimate (UTF-8 byte length) unless you pass a custom `sizeOf`.

## 5. Incremental file layer — `incremental.js`

Make re-scanning a large repo cheap.

```js
const { createFileCache, createWatcher } = require("./src/perf/incremental");

const files = createFileCache({ hashCheck: true });
// Unchanged file → one stat(), returns cached value. Changed → read + recompute.
// Identical content with a new mtime (editor rewrite) → reuses the cached value.
const ast = files.getOrCompute("src/app.js", (content, path) => parse(content));
files.changed("src/app.js"); // boolean
console.log(files.stats());  // { hits, misses, recomputes, statCalls, hashCalls, reads, hitRate }

const watcher = createWatcher(".", { debounce: 50 }).on("change", (paths) => rescan(paths)).start();
// Debounced + de-duplicated change sets; ignores node_modules/.git/dotdirs by default.
watcher.close();
```

**Honesty note**: `fs.watch` is best-effort (can miss events under heavy churn, fires
duplicates, OS-dependent). The file cache's stat/hash check is the source of truth; the
watcher tells you *when* to re-check, not *whether* a file truly changed.

## 6. Streaming parsers — `streams.js`

Incremental SSE and NDJSON parsers for streaming engine responses — no full-buffering.

```js
const { createNDJSONParser, createSSEParser, sseDataEvents, streamToParser } = require("./src/perf/streams");

const nd = createNDJSONParser((obj, raw) => handle(obj)); // Ollama / Claude Code driver
nd.feed(chunk); /* ...more chunks... */ nd.end();

const sse = createSSEParser((ev) => handle(ev)); // { event, data, id, retry }
// Common case: SSE whose data is JSON, with the [DONE] sentinel:
const stream = sseDataEvents((delta) => render(delta), { onDone: () => finish() });

await streamToParser(httpResponse, nd); // pump a Node Readable through a parser
```

Handles chunk boundaries anywhere — mid-line, mid-record, and inside a multi-byte UTF-8
character (via `StringDecoder`). Memory is one partial line/record, not the whole stream.

## 7. Metrics — `metrics.js`

Low-overhead counters/gauges/histograms and a flame-friendly span recorder.

```js
const { createMetrics, createSpanRecorder } = require("./src/perf/metrics");

const m = createMetrics(); // or { enabled: false } → every method is a no-op
m.inc("engine.calls"); m.gauge("queue.depth", sched.pending());
const out = await m.timeAsync("engine.latency", () => callEngine()); // records ms
console.log(m.report());   // human summary; m.snapshot() for structured counters/gauges/timers

const rec = createSpanRecorder();
const turn = rec.span("turn");
const step = turn.child("plan"); /* ... */ step.end();
turn.end();
console.log(rec.tree());                              // indented timing tree
fs.writeFileSync("trace.json", JSON.stringify(rec.chrome())); // chrome://tracing / speedscope
```

Timers use `process.hrtime.bigint()` (monotonic nanoseconds). Histograms keep
count/sum/min/max and percentiles (p50/p90/p99) via a bounded reservoir sample (Vitter's
Algorithm R), so a long run doesn't retain every sample.

---

## Benchmarks

Runnable microbenchmarks live in `bench.js`:

```
node src/perf/bench.js            # all groups
node src/perf/bench.js cache      # one group: scheduler|coalesce|cache|streams|metrics
```

**Methodology & honesty.** The benchmarks measure the **overhead of the primitives
themselves** — per-task scheduling cost, cache get/set throughput, parser bytes/sec, metric
record cost — **not** the latency of real engine or network calls. The whole point of these
primitives is to *hide and amortize* I/O latency (keep-alive reuse, caching, coalescing),
not to replace it, so benchmarking them against fake I/O would be dishonest. Each group
warms up, then loops for a fixed wall-clock budget and reports ops/sec and ns/op via
`process.hrtime.bigint()`. Numbers are machine-dependent; use them relatively (before/after
a change) to catch regressions, not as absolute guarantees.

Sample run (Node v20, linux/x64 — your numbers will differ):

| Benchmark                               | Throughput        | Per op     |
|-----------------------------------------|-------------------|------------|
| scheduler: submit+run trivial task      | ~560k ops/s       | ~1.8 µs    |
| scheduler: mapLimit(1000, limit=16)     | ~15 ms total      | —          |
| coalesce: singleFlight (100 concurrent) | ~99% calls avoided| —          |
| coalesce: batcher 10k adds              | → ~40 executor calls | —       |
| cache: LRU.get (hit)                    | ~4.9M ops/s       | ~205 ns    |
| cache: LRU.set (with eviction)          | ~197k ops/s       | ~5.1 µs    |
| cache: memoizeAsync (cached hit)        | ~7.3M ops/s       | ~138 ns    |
| streams: NDJSON parse                   | ~170 MB/s         | —          |
| streams: SSE parse                      | ~140 MB/s         | —          |
| metrics: counter inc                    | ~20M ops/s        | ~48 ns     |
| metrics: span start+end                 | ~3.5M ops/s       | ~281 ns    |

The `submit+run` figure is sequential (one task awaited at a time), so it reflects per-task
overhead, not pool throughput — real parallelism is bounded only by `concurrency` and the
work itself.

## Testing

```
node --test test/perf/            # the perf suite
node --test test/perf/cache.test.js   # a single module
```
