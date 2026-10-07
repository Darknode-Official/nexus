"use strict";
// Tests for the indexer orchestrator, the incremental cache, and the top-level API.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const codegraph = require("../../src/codegraph");
const { IndexCache, sha1 } = require("../../src/codegraph/cache");

const SAMPLE = path.join(__dirname, "fixtures", "sample");

describe("Code Graph — indexFiles (in-memory)", () => {
  const idx = codegraph.indexFiles([
    { file: "src/math.js", source: "export function add(a,b){return a+b;}\nexport const double = x => x*2;" },
    { file: "src/calc.js", source: 'import { add, double } from "./math.js";\nexport function calc(n){ return double(add(n,n)); }' },
  ]);

  it("indexes files and reports stats", () => {
    const s = idx.stats();
    assert.equal(s.files, 2);
    assert.ok(s.symbols >= 3);
    assert.equal(s.edges, 1);
  });
  it("exposes findImplementation", () => {
    const hits = idx.findImplementation("add");
    assert.equal(hits[0].name, "add");
  });
  it("exposes impact for a symbol", () => {
    const imp = idx.impact({ file: "src/math.js", name: "add" });
    assert.deepEqual(imp.directSymbolUsers, ["src/calc.js"]);
  });
  it("exposes topo order", () => {
    const { order } = idx.topo();
    assert.ok(order.indexOf("src/math.js") < order.indexOf("src/calc.js"));
  });
});

describe("Code Graph — indexDirectory (disk, multi-language)", () => {
  const idx = codegraph.indexDirectory(SAMPLE);
  it("discovers JS and Python files under the tree", () => {
    const s = idx.stats();
    assert.ok(s.files >= 5, "should find the fixture files");
    assert.ok(s.byLang.javascript >= 3 && s.byLang.python >= 2);
  });
  it("resolves cross-file + cross-dir imports into graph edges", () => {
    assert.ok(idx.graph.adj.get("src/calc.js").has("src/math.js"));
    assert.ok(idx.graph.adj.get("src/calc.js").has("lib/logger.js"));
    assert.ok(idx.graph.adj.get("src/app.py").has("src/helpers.py"));
  });
  it("finds the Calculator class and its methods", () => {
    const calc = idx.symbol("Calculator");
    assert.ok(calc.length >= 1);
    const methods = idx.files.find((f) => f.file === "src/calc.js").symbols.filter((s) => s.parent === "Calculator");
    assert.ok(methods.some((m) => m.name === "addTo"));
  });
  it("computes impact across the fixture graph", () => {
    const imp = idx.impact({ file: "src/math.js", name: "add" });
    assert.ok(imp.directSymbolUsers.includes("src/calc.js"));
  });
});

describe("Code Graph — incremental cache", () => {
  it("fast-paths unchanged files by mtime+size", () => {
    const c = new IndexCache(null);
    const stat = { mtimeMs: 1000, size: 50 };
    c.set("a.js", stat, "content", { file: "a.js" });
    assert.ok(c.hit("a.js", stat), "same stat -> hit");
    assert.equal(c.hit("a.js", { mtimeMs: 2000, size: 50 }), null, "changed mtime -> miss");
    assert.equal(c.hits, 1);
    assert.equal(c.misses, 1);
  });
  it("verifies content via hash", () => {
    const c = new IndexCache(null);
    c.set("a.js", { mtimeMs: 1, size: 1 }, "hello", {});
    assert.ok(c.verify("a.js", "hello"));
    assert.ok(!c.verify("a.js", "changed"));
    assert.equal(c.entries["a.js"].hash, sha1("hello"));
  });
  it("persists and reuses the cache across runs (big speedup)", () => {
    const cacheFile = path.join(os.tmpdir(), "nexus-cg-test-" + process.pid + ".json");
    try { fs.unlinkSync(cacheFile); } catch (_) {}
    const cold = codegraph.indexDirectory(SAMPLE, { cacheFile });
    assert.equal(cold.meta.cache.hits, 0);
    assert.ok(cold.meta.parsed >= 5);
    const warm = codegraph.indexDirectory(SAMPLE, { cacheFile });
    assert.equal(warm.meta.parsed, 0, "nothing re-parsed on a clean warm run");
    assert.equal(warm.meta.reused, cold.meta.parsed, "all files served from cache");
    assert.equal(warm.meta.cache.hitRate, 1);
    assert.equal(warm.stats().files, cold.stats().files, "same result from cache");
    try { fs.unlinkSync(cacheFile); } catch (_) {}
  });
  it("prunes entries for deleted files", () => {
    const c = new IndexCache(null);
    c.set("gone.js", { mtimeMs: 1, size: 1 }, "x", {});
    c.set("live.js", { mtimeMs: 1, size: 1 }, "y", {});
    c.prune(new Set(["live.js"]));
    assert.ok(!c.entries["gone.js"] && c.entries["live.js"]);
  });
});

describe("Code Graph — top-level API surface", () => {
  it("exposes the documented entrypoints", () => {
    for (const k of ["indexDirectory", "indexFiles", "parseSource", "detectLang", "duplication", "search", "impact", "depgraph", "symbols", "tokenizer"]) {
      assert.ok(codegraph[k], "codegraph." + k + " should be exported");
    }
    assert.ok(codegraph.lang.javascript && codegraph.lang.python && codegraph.lang.go && codegraph.lang.ruby);
  });
});
