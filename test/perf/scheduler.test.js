"use strict";
// Tests for the concurrent task executor: concurrency bound, priority order, timeouts,
// cancellation (pre-start and mid-flight), backpressure, draining, and mapLimit.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { createScheduler, mapLimit, TaskHeap } = require("../../src/perf/scheduler");

const delay = (ms, v) => new Promise((r) => setTimeout(() => r(v), ms));

describe("perf/scheduler: TaskHeap", () => {
  it("pops in priority then FIFO order", () => {
    const h = new TaskHeap();
    h.push({ priority: 0, seq: 0 });
    h.push({ priority: 5, seq: 1 });
    h.push({ priority: 5, seq: 2 });
    h.push({ priority: 10, seq: 3 });
    assert.equal(h.pop().seq, 3);  // highest priority
    assert.equal(h.pop().seq, 1);  // next priority, earliest seq
    assert.equal(h.pop().seq, 2);
    assert.equal(h.pop().seq, 0);
    assert.equal(h.pop(), null);
  });

  it("removes an arbitrary node and stays valid", () => {
    const h = new TaskHeap();
    const nodes = [];
    for (let i = 0; i < 20; i++) { const n = { priority: (i * 7) % 11, seq: i }; nodes.push(n); h.push(n); }
    assert.equal(h.remove(nodes[10]), true);
    assert.equal(h.size, 19);
    let prev = Infinity, popped = 0;
    let last = null;
    while (h.size) { const n = h.pop(); popped++; if (last) { assert.ok(last.priority > n.priority || (last.priority === n.priority && last.seq < n.seq)); } last = n; }
    assert.equal(popped, 19);
    void prev;
  });
});

describe("perf/scheduler: concurrency", () => {
  it("never exceeds the configured concurrency", async () => {
    const sched = createScheduler({ concurrency: 3 });
    let active = 0, peak = 0;
    const task = () => { active++; peak = Math.max(peak, active); return delay(15).then(() => { active--; }); };
    await Promise.all(Array.from({ length: 20 }, () => sched.submit(task)));
    assert.ok(peak <= 3, "peak concurrency " + peak + " should be <= 3");
    assert.equal(sched.stats().completed, 20);
  });

  it("runs serially and deterministically at concurrency 1 by priority", async () => {
    const sched = createScheduler({ concurrency: 1 });
    const order = [];
    const mk = (label, priority) => sched.submit(() => delay(5).then(() => order.push(label)), { priority });
    // Submit a low-priority task first; it starts immediately (slot free). The rest queue.
    const p0 = mk("first", 0);
    const pLow = mk("low", 1);
    const pHigh = mk("high", 10);
    const pMid = mk("mid", 5);
    await Promise.all([p0, pLow, pHigh, pMid]);
    // "first" runs immediately; queued ones drain by priority: high, mid, low.
    assert.deepEqual(order, ["first", "high", "mid", "low"]);
  });

  it("setConcurrency raises throughput live", async () => {
    const sched = createScheduler({ concurrency: 1 });
    let active = 0, peak = 0;
    const task = () => { active++; peak = Math.max(peak, active); return delay(20).then(() => active--); };
    const ps = Array.from({ length: 10 }, () => sched.submit(task));
    sched.setConcurrency(5);
    await Promise.all(ps);
    assert.ok(peak > 1, "raising concurrency should allow parallelism, peak=" + peak);
  });
});

describe("perf/scheduler: timeouts & cancellation", () => {
  it("times out a slow task and rejects with TimeoutError", async () => {
    const sched = createScheduler({ concurrency: 2 });
    await assert.rejects(
      sched.submit((signal) => new Promise((_res, rej) => { signal.addEventListener("abort", () => rej(signal.reason)); }), { timeout: 20 }),
      (e) => e.name === "TimeoutError"
    );
    assert.equal(sched.stats().timedOut, 1);
  });

  it("passes the abort signal into the task on timeout", async () => {
    const sched = createScheduler({ concurrency: 1 });
    let sawAbort = false;
    await assert.rejects(sched.submit((signal) => new Promise((_r, rej) => { signal.addEventListener("abort", () => { sawAbort = true; rej(signal.reason); }); }), { timeout: 15 }));
    assert.equal(sawAbort, true);
  });

  it("cancels a queued task before it starts", async () => {
    const sched = createScheduler({ concurrency: 1 });
    const block = sched.submit(() => delay(40));            // occupies the only slot
    const ac = new AbortController();
    const queued = sched.submit(() => delay(5), { signal: ac.signal }); // waits in queue
    ac.abort();
    await assert.rejects(queued, (e) => e.name === "AbortError");
    await block;
    assert.equal(sched.stats().cancelled, 1);
  });

  it("rejects immediately when submitted with an already-aborted signal", async () => {
    const sched = createScheduler({ concurrency: 2 });
    const ac = new AbortController(); ac.abort();
    await assert.rejects(sched.submit(() => 1, { signal: ac.signal }), (e) => e.name === "AbortError");
  });

  it("cancels a running task mid-flight via external signal", async () => {
    const sched = createScheduler({ concurrency: 1 });
    const ac = new AbortController();
    let aborted = false;
    const p = sched.submit((signal) => new Promise((_r, rej) => { signal.addEventListener("abort", () => { aborted = true; rej(signal.reason); }); }), { signal: ac.signal });
    await delay(5);
    ac.abort(new Error("stop"));
    await assert.rejects(p, (e) => e.name === "AbortError" || e.message === "stop");
    assert.equal(aborted, true);
  });
});

describe("perf/scheduler: backpressure & draining", () => {
  it("rejects submissions past maxQueue", async () => {
    const sched = createScheduler({ concurrency: 1, maxQueue: 2 });
    const running = sched.submit(() => delay(30));   // starts, not queued
    const q1 = sched.submit(() => delay(5));          // queued (1)
    const q2 = sched.submit(() => delay(5));          // queued (2)
    await assert.rejects(sched.submit(() => delay(5)), (e) => e.code === "EQUEUEFULL");
    await Promise.all([running, q1, q2]);
  });

  it("onIdle resolves only when queue and running both drain", async () => {
    const sched = createScheduler({ concurrency: 2 });
    for (let i = 0; i < 6; i++) sched.submit(() => delay(10));
    assert.ok(sched.size() > 0);
    await sched.onIdle();
    assert.equal(sched.size(), 0);
    assert.equal(sched.running(), 0);
  });

  it("clear() rejects queued tasks but leaves running ones", async () => {
    const sched = createScheduler({ concurrency: 1 });
    const running = sched.submit(() => delay(25));
    const q1 = sched.submit(() => 1);
    const q2 = sched.submit(() => 2);
    const n = sched.clear("bye");
    assert.equal(n, 2);
    await assert.rejects(q1, /bye/);
    await assert.rejects(q2, /bye/);
    await running; // unaffected
  });

  it("pause/resume halts and restarts dispatch", async () => {
    const sched = createScheduler({ concurrency: 2 });
    sched.pause();
    let done = 0;
    const ps = Array.from({ length: 4 }, () => sched.submit(() => { done++; }));
    await delay(10);
    assert.equal(done, 0, "paused scheduler should not start tasks");
    sched.resume();
    await Promise.all(ps);
    assert.equal(done, 4);
  });
});

describe("perf/scheduler: results & errors", () => {
  it("resolves with the task's return value", async () => {
    const sched = createScheduler({ concurrency: 2 });
    assert.equal(await sched.submit(() => 42), 42);
    assert.equal(await sched.submit(() => Promise.resolve("x")), "x");
  });

  it("propagates synchronous throws as rejections", async () => {
    const sched = createScheduler({ concurrency: 1 });
    await assert.rejects(sched.submit(() => { throw new Error("boom"); }), /boom/);
    assert.equal(sched.stats().failed, 1);
  });
});

describe("perf/scheduler: mapLimit", () => {
  it("maps with bounded concurrency preserving order", async () => {
    let active = 0, peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (x) => { active++; peak = Math.max(peak, active); await delay(10); active--; return x * 10; });
    assert.deepEqual(out, [10, 20, 30, 40, 50, 60]);
    assert.ok(peak <= 2, "peak=" + peak);
  });

  it("rejects on first error and stops", async () => {
    await assert.rejects(mapLimit([1, 2, 3], 2, async (x) => { if (x === 2) throw new Error("fail " + x); await delay(50); return x; }), /fail 2/);
  });

  it("handles empty input", async () => {
    assert.deepEqual(await mapLimit([], 4, async (x) => x), []);
  });
});
