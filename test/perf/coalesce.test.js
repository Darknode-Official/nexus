"use strict";
// Tests for single-flight de-duplication, batching/coalescing, and debounce/throttle.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { singleFlight, createBatcher, debounce, throttle } = require("../../src/perf/coalesce");

const delay = (ms, v) => new Promise((r) => setTimeout(() => r(v), ms));

describe("perf/coalesce: singleFlight", () => {
  it("runs once for concurrent identical keys", async () => {
    let calls = 0;
    const fn = singleFlight(async (k) => { calls++; await delay(15); return k + "!"; });
    const [a, b, c] = await Promise.all([fn("x"), fn("x"), fn("x")]);
    assert.equal(calls, 1);
    assert.deepEqual([a, b, c], ["x!", "x!", "x!"]);
  });

  it("runs separately for different keys", async () => {
    let calls = 0;
    const fn = singleFlight(async (k) => { calls++; await delay(10); return k; });
    const [a, b] = await Promise.all([fn("a"), fn("b")]);
    assert.equal(calls, 2);
    assert.deepEqual([a, b], ["a", "b"]);
  });

  it("frees the slot after settling so the next call re-runs", async () => {
    let calls = 0;
    const fn = singleFlight(async (k) => { calls++; await delay(5); return calls; });
    await fn("x");
    await fn("x");
    assert.equal(calls, 2, "second call after first settled should re-run (no stale cache)");
  });

  it("shares rejections among coalesced callers and then clears", async () => {
    let calls = 0;
    const fn = singleFlight(async () => { calls++; await delay(5); throw new Error("nope"); });
    await assert.rejects(Promise.all([fn("k"), fn("k")]), /nope/);
    assert.equal(calls, 1);
    assert.equal(fn.inflight(), 0);
  });

  it("supports custom key functions", async () => {
    let calls = 0;
    const fn = singleFlight(async (obj) => { calls++; await delay(5); return obj.id; }, (obj) => obj.id);
    const [a, b] = await Promise.all([fn({ id: 1, x: "a" }), fn({ id: 1, x: "b" })]);
    assert.equal(calls, 1);
    assert.deepEqual([a, b], [1, 1]);
  });
});

describe("perf/coalesce: createBatcher", () => {
  it("coalesces adds into one executor call within maxWait", async () => {
    let batchCount = 0, seenSizes = [];
    const batcher = createBatcher((keys, items) => { batchCount++; seenSizes.push(items.length); return items.map((n) => n * 2); }, { maxWait: 10, maxBatch: 100 });
    const results = await Promise.all([batcher.add(1), batcher.add(2), batcher.add(3)]);
    assert.deepEqual(results, [2, 4, 6]);
    assert.equal(batchCount, 1);
    assert.deepEqual(seenSizes, [3]);
  });

  it("flushes early when maxBatch is reached", async () => {
    let batches = 0;
    const batcher = createBatcher((keys, items) => { batches++; return items.map((x) => x); }, { maxWait: 1000, maxBatch: 2 });
    const results = await Promise.all([batcher.add("a"), batcher.add("b"), batcher.add("c")]);
    assert.deepEqual(results.sort(), ["a", "b", "c"]);
    assert.ok(batches >= 2, "reaching maxBatch should flush early, batches=" + batches);
  });

  it("de-duplicates identical items in the same batch", async () => {
    let seen = null;
    const batcher = createBatcher((keys, items) => { seen = items.slice(); return items.map((x) => x * 10); }, { maxWait: 10 });
    const [a, b, c] = await Promise.all([batcher.add(5), batcher.add(5), batcher.add(7)]);
    assert.equal(a, 50); assert.equal(b, 50); assert.equal(c, 70);
    assert.equal(seen.length, 2, "duplicate item should only be executed once");
  });

  it("propagates executor errors to all callers in the batch", async () => {
    const batcher = createBatcher(() => { throw new Error("exec fail"); }, { maxWait: 5 });
    await assert.rejects(Promise.all([batcher.add(1), batcher.add(2)]), /exec fail/);
  });

  it("rejects when executor returns a misaligned array", async () => {
    const batcher = createBatcher((keys) => [1], { maxWait: 5 });
    await assert.rejects(Promise.all([batcher.add(1), batcher.add(2)]), /aligned/);
  });

  it("manual flush() resolves pending immediately", async () => {
    const batcher = createBatcher((keys, items) => items.map((x) => x + 1), { maxWait: 10000 });
    const p = batcher.add(41);
    await batcher.flush();
    assert.equal(await p, 42);
  });
});

describe("perf/coalesce: debounce", () => {
  it("collapses a burst into a single trailing call", async () => {
    let calls = 0; let lastArg;
    const d = debounce((x) => { calls++; lastArg = x; return x; }, 20);
    d(1); d(2);
    const p = d(3);
    const r = await p;
    assert.equal(calls, 1);
    assert.equal(lastArg, 3);
    assert.equal(r, 3);
  });

  it("fires immediately with leading:true", async () => {
    let calls = 0;
    const d = debounce(() => { calls++; }, 30, { leading: true, trailing: false });
    d(); d(); d();
    assert.equal(calls, 1, "leading edge fires once immediately");
    await delay(40);
    assert.equal(calls, 1, "trailing disabled so no second call");
  });

  it("cancel() prevents the pending call", async () => {
    let calls = 0;
    const d = debounce(() => { calls++; }, 20);
    const p = d();
    d.cancel();
    await assert.rejects(p, /cancelled/);
    await delay(30);
    assert.equal(calls, 0);
  });

  it("flush() runs the pending call now", async () => {
    let calls = 0;
    const d = debounce((x) => { calls++; return x; }, 1000);
    const p = d(9);
    d.flush();
    assert.equal(await p, 9);
    assert.equal(calls, 1);
  });
});

describe("perf/coalesce: throttle", () => {
  it("runs on the leading edge and limits rate", async () => {
    let calls = 0;
    const t = throttle(() => { calls++; }, 30);
    t(); t(); t();
    assert.equal(calls, 1, "leading call runs immediately, rest are throttled");
    await delay(45);
    assert.ok(calls >= 2, "a trailing call should run after the window, calls=" + calls);
  });

  it("respects leading:false", async () => {
    let calls = 0;
    const t = throttle(() => { calls++; }, 25, { leading: false });
    t();
    assert.equal(calls, 0, "no leading call");
    await delay(40);
    assert.equal(calls, 1, "trailing call runs after window");
  });

  it("cancel() clears a pending trailing call", async () => {
    let calls = 0;
    const t = throttle(() => { calls++; }, 25, { leading: false });
    t();
    t.cancel();
    await delay(40);
    assert.equal(calls, 0);
  });
});
