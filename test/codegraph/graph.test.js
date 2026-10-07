"use strict";
// Tests for the symbol table (cross-file resolution), dependency graph (cycles +
// topological order) and impact/blast-radius analysis.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { parseSource } = require("../../src/codegraph/parse");
const { buildDepGraph, detectCycles, topoOrder, resolveImport } = require("../../src/codegraph/depgraph");
const { buildSymbolTable } = require("../../src/codegraph/symbols");
const { transitiveDependents, symbolImpact, fileImpact } = require("../../src/codegraph/impact");

function project(map) {
  return Object.keys(map).map((file) => parseSource(map[file], file));
}

describe("Code Graph — import resolution", () => {
  const known = new Set(["src/a.js", "src/b.js", "src/dir/index.js", "pkg/mod.py", "pkg/__init__.py"]);
  it("resolves relative JS imports incl. extension and index files", () => {
    assert.equal(resolveImport("src/a.js", "./b", "javascript", known), "src/b.js");
    assert.equal(resolveImport("src/a.js", "./dir", "javascript", known), "src/dir/index.js");
    assert.equal(resolveImport("src/a.js", "lodash", "javascript", known), null);
  });
  it("resolves python dotted and relative imports", () => {
    assert.equal(resolveImport("pkg/x.py", ".mod", "python", known), "pkg/mod.py");
    assert.equal(resolveImport("pkg/x.py", "pkg", "python", known), "pkg/__init__.py");
  });
});

describe("Code Graph — dependency graph", () => {
  const files = project({
    "a.js": 'import { b } from "./b.js"; export const a = 1;',
    "b.js": 'import { c } from "./c.js"; export const b = 1;',
    "c.js": 'export const c = 1;',
  });
  const g = buildDepGraph(files);
  it("builds forward and reverse edges", () => {
    assert.deepEqual([...g.adj.get("a.js")], ["b.js"]);
    assert.deepEqual([...g.rdeps.get("c.js")], ["b.js"]);
  });
  it("tracks external packages", () => {
    const g2 = buildDepGraph(project({ "x.js": 'import fs from "fs"; import _ from "lodash";' }));
    const ext = [...(g2.externals.get("x.js") || [])].sort();
    assert.deepEqual(ext, ["fs", "lodash"]);
  });
  it("produces a topological order (deps before dependents)", () => {
    const { order, cyclic } = topoOrder(g.adj);
    assert.equal(cyclic, false);
    assert.ok(order.indexOf("c.js") < order.indexOf("b.js"));
    assert.ok(order.indexOf("b.js") < order.indexOf("a.js"));
  });
  it("detects cycles via SCC", () => {
    const cg = buildDepGraph(project({
      "p.js": 'import { q } from "./q.js"; export const p = 1;',
      "q.js": 'import { p } from "./p.js"; export const q = 1;',
    }));
    const cycles = detectCycles(cg.adj);
    assert.equal(cycles.length, 1);
    assert.deepEqual(cycles[0].sort(), ["p.js", "q.js"]);
    assert.equal(topoOrder(cg.adj).cyclic, true);
  });
});

describe("Code Graph — symbol table & cross-file resolution", () => {
  it("binds imports to the concrete exported definition", () => {
    const files = project({
      "util.js": 'export function readConfig() { return {}; }',
      "app.js": 'import { readConfig } from "./util.js"; readConfig();',
    });
    const st = buildSymbolTable(files);
    const binding = st.bindings.get("app.js").get("readConfig");
    assert.equal(binding.kind, "internal");
    assert.equal(binding.file, "util.js");
    assert.equal(binding.symbol.name, "readConfig");
  });
  it("follows re-export chains and aliases", () => {
    const files = project({
      "core.js": 'export function engine() { return 1; }',
      "index.js": 'export { engine as motor } from "./core.js";',
      "app.js": 'import { motor } from "./index.js";',
    });
    const st = buildSymbolTable(files);
    const r = st.resolveExport("index.js", "motor", new Set());
    assert.equal(r.file, "core.js");
    assert.equal(r.symbol.name, "engine");
    assert.equal(st.bindings.get("app.js").get("motor").file, "core.js");
  });
  it("follows star re-exports", () => {
    const files = project({
      "core.js": 'export function alpha() {}',
      "barrel.js": 'export * from "./core.js";',
      "app.js": 'import { alpha } from "./barrel.js";',
    });
    const st = buildSymbolTable(files);
    assert.equal(st.bindings.get("app.js").get("alpha").file, "core.js");
  });
});

describe("Code Graph — impact / blast radius", () => {
  const files = project({
    "util.js": 'export function base() { return 1; }',
    "mid.js": 'import { base } from "./util.js"; export function mid() { return base(); }',
    "top.js": 'import { mid } from "./mid.js"; mid();',
    "other.js": 'export const unrelated = 1;',
  });
  const g = buildDepGraph(files);
  const st = buildSymbolTable(files);
  it("computes transitive dependents with distance", () => {
    const deps = transitiveDependents(g, "util.js");
    assert.deepEqual(deps.map((d) => d.file).sort(), ["mid.js", "top.js"]);
    assert.equal(deps.find((d) => d.file === "mid.js").distance, 1);
    assert.equal(deps.find((d) => d.file === "top.js").distance, 2);
  });
  it("identifies direct symbol users and severity", () => {
    const imp = symbolImpact(g, st, { file: "util.js", name: "base" });
    assert.deepEqual(imp.directSymbolUsers, ["mid.js"]);
    assert.equal(imp.transitiveCount, 2);
    assert.equal(imp.severity, "low");
  });
  it("reports isolated change for unused symbol", () => {
    const imp = symbolImpact(g, st, { file: "other.js", name: "unrelated" });
    assert.equal(imp.severity, "isolated");
    assert.equal(imp.transitiveCount, 0);
  });
  it("fileImpact lists direct dependents", () => {
    assert.deepEqual(fileImpact(g, "util.js").directDependents, ["mid.js"]);
  });
});
