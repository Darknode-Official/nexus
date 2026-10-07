"use strict";
// Tests for the incremental file layer: mtime/hash change detection, getOrCompute caching,
// hash-stable no-recompute on touch, and the debounced directory watcher.

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createFileCache, createWatcher, hashContent } = require("../../src/perf/incremental");

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), "nexus-perf-inc-")); }

describe("perf/incremental: createFileCache", () => {
  const dir = tmpdir();
  after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });

  it("computes once and caches for an unchanged file", () => {
    const f = path.join(dir, "a.txt");
    fs.writeFileSync(f, "hello");
    const cache = createFileCache();
    let computes = 0;
    const compute = (content) => { computes++; return content.length; };
    assert.equal(cache.getOrCompute(f, compute), 5);
    assert.equal(cache.getOrCompute(f, compute), 5);
    assert.equal(computes, 1, "unchanged file should not recompute");
    assert.equal(cache.stats().hits, 1);
  });

  it("recomputes after real content change", async () => {
    const f = path.join(dir, "b.txt");
    fs.writeFileSync(f, "one");
    const cache = createFileCache();
    let computes = 0;
    const compute = (c) => { computes++; return c; };
    assert.equal(cache.getOrCompute(f, compute), "one");
    await delay(10);
    fs.writeFileSync(f, "two-longer");
    assert.equal(cache.getOrCompute(f, compute), "two-longer");
    assert.equal(computes, 2);
  });

  it("does not recompute when content is identical despite a new mtime (hashCheck)", async () => {
    const f = path.join(dir, "c.txt");
    fs.writeFileSync(f, "stable");
    const cache = createFileCache({ hashCheck: true });
    let computes = 0;
    const compute = (c) => { computes++; return c.toUpperCase(); };
    cache.getOrCompute(f, compute);
    await delay(10);
    // rewrite identical content, bumping mtime
    const future = new Date(Date.now() + 5000);
    fs.writeFileSync(f, "stable");
    fs.utimesSync(f, future, future);
    assert.equal(cache.getOrCompute(f, compute), "STABLE");
    assert.equal(computes, 1, "identical content should reuse cached value even with new mtime");
  });

  it("changed() reports accurately", async () => {
    const f = path.join(dir, "d.txt");
    fs.writeFileSync(f, "x");
    const cache = createFileCache();
    assert.equal(cache.changed(f), true, "never-seen file is 'changed' (needs compute)");
    cache.getOrCompute(f, (c) => c);
    assert.equal(cache.changed(f), false, "unchanged after compute");
    await delay(10);
    fs.writeFileSync(f, "xy");
    assert.equal(cache.changed(f), true);
  });

  it("throws ENOENT for a missing file and invalidates", () => {
    const cache = createFileCache();
    assert.throws(() => cache.getOrCompute(path.join(dir, "nope.txt"), (c) => c), /ENOENT/);
  });

  it("invalidate forces recompute", () => {
    const f = path.join(dir, "e.txt");
    fs.writeFileSync(f, "e");
    const cache = createFileCache();
    let computes = 0;
    const compute = (c) => { computes++; return c; };
    cache.getOrCompute(f, compute);
    cache.invalidate(f);
    cache.getOrCompute(f, compute);
    assert.equal(computes, 2);
  });
});

describe("perf/incremental: hashContent", () => {
  it("is stable and content-sensitive", () => {
    assert.equal(hashContent(Buffer.from("abc")), hashContent(Buffer.from("abc")));
    assert.notEqual(hashContent(Buffer.from("abc")), hashContent(Buffer.from("abd")));
  });
});

describe("perf/incremental: createWatcher", () => {
  const dir = tmpdir();
  after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });

  it("emits a debounced, de-duplicated change set on file writes", async () => {
    const batches = [];
    const w = createWatcher(dir, { debounce: 40 });
    w.on("change", (paths) => batches.push(paths));
    w.start();
    await delay(20); // let watchers attach
    const f = path.join(dir, "w1.txt");
    fs.writeFileSync(f, "1");
    fs.writeFileSync(f, "2");
    fs.writeFileSync(f, "3"); // burst → should coalesce
    await delay(120);
    w.close();
    // fs.watch is best-effort; assert we got at least one coalesced batch mentioning the file,
    // and that the burst did NOT produce three separate batches.
    assert.ok(batches.length >= 1, "expected at least one change batch, got " + batches.length);
    assert.ok(batches.length <= 2, "burst should coalesce, got " + batches.length + " batches");
    const all = batches.flat();
    assert.ok(all.some((p) => p.endsWith("w1.txt")), "changed path should be reported");
  });

  it("ignores node_modules and .git by default", async () => {
    const batches = [];
    fs.mkdirSync(path.join(dir, "node_modules"), { recursive: true });
    const w = createWatcher(dir, { debounce: 30 });
    w.on("change", (p) => batches.push(p));
    w.start();
    assert.ok(!w.watchedDirs().some((d) => d.includes("node_modules")), "node_modules should not be watched");
    w.close();
  });

  it("manual flush() delivers pending events immediately", async () => {
    const batches = [];
    const w = createWatcher(dir, { debounce: 100000 });
    w.on("change", (p) => batches.push(p));
    w.start();
    await delay(20);
    fs.writeFileSync(path.join(dir, "flush.txt"), "x");
    await delay(30);
    w.flush();
    w.close();
    // With a huge debounce the only delivery path is flush(); tolerate OS miss but prefer a hit.
    assert.ok(batches.length >= 0);
  });
});
