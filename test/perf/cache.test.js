"use strict";
// Tests for the caching layer: LRU eviction, byte accounting, TTL expiry, stale-while-
// revalidate, disk persistence, and async memoization.

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createLRU, createDiskCache, memoizeAsync, estimateSize } = require("../../src/perf/cache");

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

describe("perf/cache: createLRU basics", () => {
  it("stores and retrieves values", () => {
    const c = createLRU({ max: 10 });
    c.set("a", 1); c.set("b", 2);
    assert.equal(c.get("a"), 1);
    assert.equal(c.get("b"), 2);
    assert.equal(c.get("missing"), undefined);
  });

  it("evicts the least-recently-used entry past max", () => {
    const c = createLRU({ max: 2 });
    c.set("a", 1); c.set("b", 2);
    c.get("a");          // touch a → b is now LRU
    c.set("c", 3);       // evicts b
    assert.equal(c.get("b"), undefined);
    assert.equal(c.get("a"), 1);
    assert.equal(c.get("c"), 3);
    assert.equal(c.stats().evictions, 1);
  });

  it("evicts by byte budget", () => {
    const c = createLRU({ max: 1000, maxBytes: 30, sizeOf: () => 10 });
    c.set("a", "x"); c.set("b", "y"); c.set("c", "z"); // 30 bytes, at cap
    assert.equal(c.size, 3);
    c.set("d", "w"); // 40 > 30 → evict oldest
    assert.ok(c.size <= 3);
    assert.equal(c.get("a"), undefined);
  });

  it("tracks hit/miss metrics and hit rate", () => {
    const c = createLRU({ max: 10 });
    c.set("a", 1);
    c.get("a"); c.get("a"); c.get("b");
    const s = c.stats();
    assert.equal(s.hits, 2);
    assert.equal(s.misses, 1);
    assert.ok(Math.abs(s.hitRate - 2 / 3) < 1e-3); // hitRate is rounded to 4 decimals
  });

  it("peek does not affect LRU order or metrics", () => {
    const c = createLRU({ max: 2 });
    c.set("a", 1); c.set("b", 2);
    c.peek("a");        // should NOT make a recently-used
    c.set("c", 3);      // evicts a (still LRU)
    assert.equal(c.get("a"), undefined);
  });
});

describe("perf/cache: TTL and stale-while-revalidate", () => {
  it("expires entries after ttl", async () => {
    const c = createLRU({ ttl: 15 });
    c.set("a", 1);
    assert.equal(c.get("a"), 1);
    await delay(25);
    assert.equal(c.get("a"), undefined);
    assert.equal(c.stats().expirations, 1);
  });

  it("serves stale value and refreshes in background (SWR)", async () => {
    let loads = 0;
    const c = createLRU({ ttl: 40, staleTtl: 1000 });
    const loader = async () => { loads++; await delay(5); return "v" + loads; };
    assert.equal(await c.getOrLoad("k", loader), "v1"); // miss → load
    await delay(55);                                     // now stale (past ttl, within staleTtl)
    const served = await c.getOrLoad("k", loader);       // stale → serve old, refresh bg
    assert.equal(served, "v1", "stale value served immediately");
    await delay(20);                                     // let background refresh finish (value fresh again)
    assert.equal(await c.getOrLoad("k", loader), "v2", "refreshed value now cached");
    assert.equal(loads, 2);
  });

  it("getOrLoad awaits loader on a cold miss", async () => {
    const c = createLRU({ ttl: 100 });
    let ran = false;
    const v = await c.getOrLoad("x", async () => { ran = true; return 7; });
    assert.equal(v, 7);
    assert.equal(ran, true);
    assert.equal(c.get("x"), 7); // cached for next time
  });
});

describe("perf/cache: estimateSize", () => {
  it("measures strings, buffers, and objects", () => {
    assert.equal(estimateSize("hello"), 5);
    assert.equal(estimateSize(Buffer.alloc(16)), 16);
    assert.ok(estimateSize({ a: 1, b: "two" }) > 0);
  });
});

describe("perf/cache: createDiskCache", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-perf-cache-"));
  after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });

  it("persists and retrieves across instances", () => {
    const a = createDiskCache(dir);
    a.set("k", { hello: "world" });
    const b = createDiskCache(dir); // fresh instance, same dir
    assert.deepEqual(b.get("k"), { hello: "world" });
  });

  it("honors TTL on read", async () => {
    const c = createDiskCache(dir, { ttl: 15 });
    c.set("short", 123);
    assert.equal(c.get("short"), 123);
    await delay(25);
    assert.equal(c.get("short"), undefined);
  });

  it("deletes, clears, and reports stats", () => {
    const c = createDiskCache(dir);
    c.set("x", 1); c.set("y", 2);
    assert.ok(c.has("x"));
    c.delete("x");
    assert.equal(c.has("x"), false);
    const s = c.stats();
    assert.ok(s.entries >= 1);
    c.clear();
    assert.equal(c.stats().entries, 0);
  });

  it("prune removes only expired entries", async () => {
    const c = createDiskCache(dir, { ttl: 10 });
    c.set("gone", 1);
    const longLived = createDiskCache(dir, { ttl: 100000 });
    longLived.set("stay", 2);
    await delay(20);
    const removed = c.prune();
    assert.ok(removed >= 1);
    assert.equal(longLived.get("stay"), 2);
  });
});

describe("perf/cache: memoizeAsync", () => {
  it("caches results and collapses concurrent misses", async () => {
    let calls = 0;
    const slow = memoizeAsync(async (n) => { calls++; await delay(10); return n * n; }, { ttl: 1000 });
    const [a, b] = await Promise.all([slow(4), slow(4)]); // concurrent → single-flight
    assert.equal(a, 16); assert.equal(b, 16);
    assert.equal(calls, 1);
    assert.equal(await slow(4), 16); // cached
    assert.equal(calls, 1);
    assert.equal(await slow(5), 25); // different arg → new call
    assert.equal(calls, 2);
  });

  it("exposes the underlying cache stats", async () => {
    const f = memoizeAsync(async (x) => x, { ttl: 1000 });
    await f(1); await f(1);
    const s = f.stats();
    assert.ok(s.hits >= 1);
  });
});
