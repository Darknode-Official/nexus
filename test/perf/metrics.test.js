"use strict";
// Tests for metrics (counters/gauges/histograms + timing) and the span recorder.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { createMetrics, createSpanRecorder, Histogram } = require("../../src/perf/metrics");

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

describe("perf/metrics: Histogram", () => {
  it("tracks count/sum/min/max and percentiles", () => {
    const h = new Histogram();
    for (let i = 1; i <= 100; i++) h.record(i);
    const s = h.summary();
    assert.equal(s.count, 100);
    assert.equal(s.min, 1);
    assert.equal(s.max, 100);
    assert.equal(s.sum, 5050);
    assert.equal(s.mean, 50.5);
    assert.ok(s.p50 >= 45 && s.p50 <= 55, "p50=" + s.p50);
    assert.ok(s.p99 >= 95, "p99=" + s.p99);
  });

  it("ignores non-finite values", () => {
    const h = new Histogram();
    h.record(NaN); h.record(Infinity); h.record(5);
    assert.equal(h.count, 1);
  });

  it("bounds its reservoir sample size", () => {
    const h = new Histogram(50);
    for (let i = 0; i < 1000; i++) h.record(i);
    assert.equal(h.count, 1000);
    assert.ok(h.sample.length <= 50);
  });
});

describe("perf/metrics: createMetrics", () => {
  it("counts and gauges", () => {
    const m = createMetrics();
    m.inc("calls"); m.inc("calls", 2); m.dec("calls");
    m.gauge("queue", 7);
    const s = m.snapshot();
    assert.equal(s.counters.calls, 2);
    assert.equal(s.gauges.queue, 7);
  });

  it("times a sync function", () => {
    const m = createMetrics();
    const r = m.time("work", () => { let x = 0; for (let i = 0; i < 1000; i++) x += i; return x; });
    assert.equal(r, 499500);
    assert.equal(m.snapshot().timers.work.count, 1);
  });

  it("times an async function and records duration", async () => {
    const m = createMetrics();
    const r = await m.timeAsync("io", async () => { await delay(15); return "ok"; });
    assert.equal(r, "ok");
    const t = m.snapshot().timers.io;
    assert.equal(t.count, 1);
    assert.ok(t.mean >= 10, "measured mean " + t.mean + "ms should be ~15ms");
  });

  it("records even when the timed fn throws", () => {
    const m = createMetrics();
    assert.throws(() => m.time("boom", () => { throw new Error("x"); }));
    assert.equal(m.snapshot().timers.boom.count, 1);
  });

  it("startTimer returns elapsed and records it", async () => {
    const m = createMetrics();
    const stop = m.startTimer("manual");
    await delay(10);
    const ms = stop();
    assert.ok(ms >= 5);
    assert.equal(m.snapshot().timers.manual.count, 1);
  });

  it("report() renders a readable summary", () => {
    const m = createMetrics();
    m.inc("c"); m.gauge("g", 1); m.observe("t", 5);
    const txt = m.report();
    assert.match(txt, /Counters/);
    assert.match(txt, /Timers/);
  });

  it("is a no-op when disabled", () => {
    const m = createMetrics({ enabled: false });
    m.inc("x"); m.observe("t", 10);
    assert.equal(m.enabled, false);
    const s = m.snapshot();
    assert.deepEqual(s.counters, {});
    assert.equal(m.time("x", () => 5), 5); // still runs the fn
  });
});

describe("perf/metrics: createSpanRecorder", () => {
  it("records nested spans with durations", () => {
    let t = 0n;
    const clock = () => t;
    const rec = createSpanRecorder({ clock });
    const root = rec.span("turn");
    t += 1000000n; // 1ms
    const child = root.child("subtask");
    t += 2000000n; // 2ms
    child.end();
    t += 1000000n;
    root.end();
    const spans = rec.spans();
    assert.equal(spans.length, 2);
    const turn = spans.find((s) => s.name === "turn");
    const sub = spans.find((s) => s.name === "subtask");
    assert.equal(sub.parent, turn.id);
    assert.ok(Math.abs(sub.ms - 2) < 1e-6);
    assert.ok(Math.abs(turn.ms - 4) < 1e-6);
  });

  it("renders an indented tree", () => {
    const rec = createSpanRecorder();
    const r = rec.span("a");
    r.child("b").end();
    r.end();
    const tree = rec.tree();
    assert.match(tree, /a /);
    assert.match(tree, /\n {2}b /); // child indented
  });

  it("emits Chrome trace events for completed spans", () => {
    let t = 0n;
    const rec = createSpanRecorder({ clock: () => t });
    const s = rec.span("x", { tag: "v" });
    t += 5000000n;
    s.end();
    const trace = rec.chrome();
    assert.equal(trace.traceEvents.length, 1);
    const ev = trace.traceEvents[0];
    assert.equal(ev.ph, "X");
    assert.equal(ev.name, "x");
    assert.ok(Math.abs(ev.dur - 5000) < 1e-6); // microseconds
    assert.equal(ev.args.tag, "v");
  });

  it("is a no-op when disabled", () => {
    const rec = createSpanRecorder({ enabled: false });
    const s = rec.span("x");
    s.child("y").end();
    s.end();
    assert.equal(rec.spans().length, 0);
    assert.equal(rec.tree(), "");
  });
});
