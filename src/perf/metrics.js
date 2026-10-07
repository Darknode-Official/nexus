"use strict";
// ============================= Metrics / profiling helpers =============================
// Low-overhead measurement so Nexus performance is a number, not a guess.
//   • createMetrics — counters, gauges, and histograms (timers). Histograms keep count,
//     sum, min, max and streaming percentiles (p50/p90/p99 via a reservoir sample), so a
//     long run doesn't retain every sample. time()/timeAsync() wrap a function and record
//     its duration with high-resolution process.hrtime.bigint (nanosecond, monotonic —
//     immune to wall-clock jumps).
//   • createSpanRecorder — nested spans with start/stop, producing a flat event list that
//     renders as an indented tree or Chrome-trace JSON (chrome://tracing / Perfetto /
//     speedscope), so a slow turn can be flame-graphed. Spans carry parent links so true
//     wall-time nesting is preserved even when async work interleaves.
// Overhead is a couple of object writes and one hrtime read per measurement — safe to
// leave on in production; pass { enabled:false } to make every method a no-op.

function nowNs() { return process.hrtime.bigint(); }
function nsToMs(ns) { return Number(ns) / 1e6; }

// ---- Streaming histogram with a bounded reservoir for percentiles. ----
// Reservoir (Vitter's Algorithm R) gives an unbiased uniform sample of all values seen,
// so percentiles stay representative without storing every sample.
class Histogram {
  constructor(reservoirSize) {
    this.count = 0; this.sum = 0; this.min = Infinity; this.max = -Infinity;
    this.cap = reservoirSize || 1000; this.sample = [];
  }
  record(v) {
    v = +v; if (!Number.isFinite(v)) return;
    this.count++; this.sum += v;
    if (v < this.min) this.min = v;
    if (v > this.max) this.max = v;
    if (this.sample.length < this.cap) this.sample.push(v);
    else { const j = Math.floor(Math.random() * this.count); if (j < this.cap) this.sample[j] = v; }
  }
  percentile(p) {
    if (!this.sample.length) return 0;
    const sorted = this.sample.slice().sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[idx];
  }
  summary() {
    return {
      count: this.count,
      sum: +this.sum.toFixed(3),
      mean: this.count ? +(this.sum / this.count).toFixed(3) : 0,
      min: this.count ? +this.min.toFixed(3) : 0,
      max: this.count ? +this.max.toFixed(3) : 0,
      p50: +this.percentile(50).toFixed(3),
      p90: +this.percentile(90).toFixed(3),
      p99: +this.percentile(99).toFixed(3),
    };
  }
}

/**
 * createMetrics(options)
 *   options.enabled   false → every method is a cheap no-op (default true)
 *   options.reservoir histogram reservoir size (default 1000)
 * Methods: inc/dec (counters), gauge (set a value), observe (histogram), time (sync),
 * timeAsync (async/promise), startTimer (manual stop), snapshot, reset.
 */
function createMetrics(options) {
  const o = options || {};
  const enabled = o.enabled !== false;
  const reservoir = o.reservoir || 1000;
  const counters = new Map(), gauges = new Map(), histos = new Map();

  function histo(name) { let h = histos.get(name); if (!h) { h = new Histogram(reservoir); histos.set(name, h); } return h; }

  if (!enabled) {
    const noop = () => {};
    const passSync = (_n, fn) => fn();
    const passAsync = (_n, fn) => Promise.resolve().then(fn);
    return {
      enabled: false,
      inc: noop, dec: noop, gauge: noop, observe: noop,
      time: passSync, timeAsync: passAsync, startTimer: () => noop,
      snapshot: () => ({ counters: {}, gauges: {}, timers: {} }), reset: noop, report: () => "(metrics disabled)",
    };
  }

  function inc(name, by) { counters.set(name, (counters.get(name) || 0) + (by == null ? 1 : by)); }
  function dec(name, by) { inc(name, -(by == null ? 1 : by)); }
  function gauge(name, value) { gauges.set(name, value); }
  function observe(name, value) { histo(name).record(value); }

  // startTimer(name) → stop() records elapsed ms into the histogram and returns it.
  function startTimer(name) { const t0 = nowNs(); return () => { const ms = nsToMs(nowNs() - t0); histo(name).record(ms); return ms; }; }

  function time(name, fn) {
    const t0 = nowNs();
    try { return fn(); }
    finally { histo(name).record(nsToMs(nowNs() - t0)); }
  }
  function timeAsync(name, fn) {
    const t0 = nowNs();
    return Promise.resolve().then(fn).finally(() => { histo(name).record(nsToMs(nowNs() - t0)); });
  }

  function snapshot() {
    const c = {}; for (const [k, v] of counters) c[k] = v;
    const g = {}; for (const [k, v] of gauges) g[k] = v;
    const t = {}; for (const [k, h] of histos) t[k] = h.summary();
    return { counters: c, gauges: g, timers: t };
  }
  function reset() { counters.clear(); gauges.clear(); histos.clear(); }

  function report() {
    const s = snapshot(); const lines = ["=== Metrics ==="];
    const ck = Object.keys(s.counters); if (ck.length) { lines.push("Counters:"); for (const k of ck.sort()) lines.push("  " + k + " = " + s.counters[k]); }
    const gk = Object.keys(s.gauges); if (gk.length) { lines.push("Gauges:"); for (const k of gk.sort()) lines.push("  " + k + " = " + s.gauges[k]); }
    const tk = Object.keys(s.timers); if (tk.length) {
      lines.push("Timers (ms):");
      for (const k of tk.sort()) { const h = s.timers[k]; lines.push("  " + k + ": n=" + h.count + " mean=" + h.mean + " p50=" + h.p50 + " p90=" + h.p90 + " p99=" + h.p99 + " max=" + h.max); }
    }
    return lines.join("\n");
  }

  return { enabled: true, inc, dec, gauge, observe, time, timeAsync, startTimer, snapshot, reset, report };
}

/**
 * createSpanRecorder(options)
 *   options.enabled   false → no-op recorder (default true)
 *   options.clock     () => ns timestamp (default process.hrtime.bigint; injectable for tests)
 * span(name, attrs) → a span handle with .end(extraAttrs) and .child(name, attrs). Spans
 * nest by explicit parent (from .child) so interleaved async work keeps correct structure.
 * tree() renders an indented timing tree; chrome() emits Chrome Trace Event JSON.
 */
function createSpanRecorder(options) {
  const o = options || {};
  const enabled = o.enabled !== false;
  const clock = o.clock || nowNs;

  if (!enabled) {
    const stub = { end() {}, child() { return stub; } };
    return { span: () => stub, spans: () => [], tree: () => "", chrome: () => ({ traceEvents: [] }), clear() {} };
  }

  const events = [];
  let seq = 0;
  const origin = clock();

  function makeSpan(name, attrs, parentId) {
    const id = ++seq;
    const start = clock();
    const rec = { id, name: String(name), parent: parentId || null, startNs: start, endNs: null, attrs: attrs || {} };
    events.push(rec);
    return {
      id,
      end(extra) { if (rec.endNs == null) { rec.endNs = clock(); if (extra) Object.assign(rec.attrs, extra); } return nsToMs(rec.endNs - rec.startNs); },
      child(childName, childAttrs) { return makeSpan(childName, childAttrs, id); },
    };
  }

  function durMs(rec) { return rec.endNs == null ? null : nsToMs(rec.endNs - rec.startNs); }

  function tree() {
    const byParent = new Map();
    for (const e of events) { const k = e.parent || 0; if (!byParent.has(k)) byParent.set(k, []); byParent.get(k).push(e); }
    const lines = [];
    const walk = (parentId, depth) => {
      const kids = byParent.get(parentId) || [];
      for (const e of kids) {
        const d = durMs(e);
        lines.push("  ".repeat(depth) + e.name + " " + (d == null ? "(open)" : d.toFixed(3) + "ms"));
        walk(e.id, depth + 1);
      }
    };
    walk(0, 0);
    return lines.join("\n");
  }

  // Chrome Trace Event format: complete ("X") events with ts/dur in microseconds.
  function chrome() {
    const traceEvents = events.filter((e) => e.endNs != null).map((e) => ({
      name: e.name, ph: "X", pid: 1, tid: 1,
      ts: Number(e.startNs - origin) / 1000,
      dur: Number(e.endNs - e.startNs) / 1000,
      args: e.attrs,
    }));
    return { traceEvents, displayTimeUnit: "ms" };
  }

  return {
    span: (name, attrs) => makeSpan(name, attrs, null),
    spans: () => events.map((e) => ({ id: e.id, name: e.name, parent: e.parent, ms: durMs(e), attrs: e.attrs })),
    tree, chrome,
    clear() { events.length = 0; seq = 0; },
  };
}

module.exports = { createMetrics, createSpanRecorder, Histogram, nowNs, nsToMs };
