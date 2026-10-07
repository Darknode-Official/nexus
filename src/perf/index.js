"use strict";
// ============================= Nexus Performance & Concurrency Runtime =============================
// Single entrypoint for the perf subsystem. Everything here is Node.js stdlib only — no
// third-party dependencies — and each piece is independently usable. See ./README.md for
// the API and benchmark methodology, and ./INTEGRATION.md for how the Nexus CLI wires it in.
//
//   scheduler    bounded concurrent task executor (priorities, timeouts, cancellation, backpressure)
//   coalesce     single-flight, request batching, debounce/throttle
//   pool         keep-alive HTTP(S) connection pool + retry/backoff for engine API calls
//   cache        LRU + TTL + stale-while-revalidate + disk cache, with hit/miss metrics
//   incremental  mtime/hash file cache + debounced directory watcher for cheap re-scans
//   streams      incremental SSE and NDJSON parsers for streaming engine responses
//   metrics      low-overhead counters/timers/histograms + a flame-friendly span recorder

const scheduler   = require("./scheduler");
const coalesce    = require("./coalesce");
const pool         = require("./pool");
const cache        = require("./cache");
const incremental  = require("./incremental");
const streams      = require("./streams");
const metrics      = require("./metrics");

module.exports = {
  // namespaced submodules
  scheduler, coalesce, pool, cache, incremental, streams, metrics,

  // flat re-exports of the primary factories for ergonomic use
  createScheduler:    scheduler.createScheduler,
  mapLimit:           scheduler.mapLimit,
  singleFlight:       coalesce.singleFlight,
  createBatcher:      coalesce.createBatcher,
  debounce:           coalesce.debounce,
  throttle:           coalesce.throttle,
  createPool:         pool.createPool,
  createLRU:          cache.createLRU,
  createDiskCache:    cache.createDiskCache,
  memoizeAsync:       cache.memoizeAsync,
  createFileCache:    incremental.createFileCache,
  createWatcher:      incremental.createWatcher,
  createNDJSONParser: streams.createNDJSONParser,
  createSSEParser:    streams.createSSEParser,
  sseDataEvents:      streams.sseDataEvents,
  streamToParser:     streams.streamToParser,
  createMetrics:      metrics.createMetrics,
  createSpanRecorder: metrics.createSpanRecorder,
};
