"use strict";
// Tests for the symbol/reference graph builder: definer tracking, cross-file
// reference edges, ambiguity damping, the import backbone, and symbol-in weights.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { parseSource } = require("../../src/codegraph/parse");
const { buildDepGraph } = require("../../src/codegraph/depgraph");
const { extractFile } = require("../../src/repomap/extract");
const { buildSymbolGraph, nameWeight } = require("../../src/repomap/symbolgraph");

// Build an extractions Map from an { file: source } object.
function extract(map) {
  const ex = new Map();
  for (const file of Object.keys(map)) {
    const parsed = parseSource(map[file], file);
    ex.set(file, extractFile(file, map[file], parsed));
  }
  return ex;
}

function depOf(ex) {
  const records = [];
  for (const [file, e] of ex) records.push({ file, lang: e.lang, imports: e.imports });
  return buildDepGraph(records);
}

describe("Repo Map — symbol graph", () => {
  it("tracks every file that defines a name", () => {
    const ex = extract({
      "a.js": "export function parseThing(x) { return x; }",
      "b.js": "function parseThing(y) { return y; }",
    });
    const g = buildSymbolGraph(ex);
    assert.deepEqual([...g.definers.get("parseThing")].sort(), ["a.js", "b.js"]);
    assert.equal(g.stats.ambiguousNames, 1);
  });

  it("adds a reference edge from the user of a symbol to its definer", () => {
    const ex = extract({
      "util.js": "export function computeChecksum(buf) { return 0; }",
      "main.js": "const v = computeChecksum(data);\nconsole.log(computeChecksum);",
    });
    const g = buildSymbolGraph(ex);
    const edge = g.edges.find((e) => e.from === "main.js" && e.to === "util.js");
    assert.ok(edge, "expected main.js -> util.js reference edge");
    assert.ok(edge.weight > 0);
  });

  it("does not create self-loop edges for a file's own symbols", () => {
    const ex = extract({ "solo.js": "function helper() {}\nfunction run() { helper(); helper(); }" });
    const g = buildSymbolGraph(ex);
    assert.equal(g.edges.filter((e) => e.from === e.to).length, 0);
    // but the file still accrues symbol-in weight for its used-own symbol
    const inW = g.symbolInWeight.get("solo.js");
    assert.ok(inW && inW.get("helper") > 0);
  });

  it("damps ambiguous names (weight split across many definers)", () => {
    const unique = extract({
      "def.js": "export function uniqueDescriptiveName(x) {}",
      "use.js": "uniqueDescriptiveName();",
    });
    const ambiguous = extract({
      "d1.js": "export function sharedName(x) {}",
      "d2.js": "export function sharedName(y) {}",
      "use.js": "sharedName();",
    });
    const gu = buildSymbolGraph(unique);
    const ga = buildSymbolGraph(ambiguous);
    const wu = gu.edges.find((e) => e.from === "use.js" && e.to === "def.js").weight;
    const wa = ga.edges.find((e) => e.from === "use.js" && e.to === "d1.js").weight;
    assert.ok(wa < wu, "ambiguous edge should be weaker: " + wa + " vs " + wu);
  });

  it("adds an import backbone edge from the codegraph dependency graph", () => {
    const ex = extract({
      "lib.js": "export const K = 1;",
      "app.js": "import { K } from './lib';\n", // import but no other reference
    });
    const g = buildSymbolGraph(ex, { cgIndex: { graph: depOf(ex) } });
    const edge = g.edges.find((e) => e.from === "app.js" && e.to === "lib.js");
    assert.ok(edge, "expected import backbone edge app.js -> lib.js");
    assert.ok(g.stats.importEdges >= 1);
  });

  it("produces a deterministic, sorted edge list", () => {
    const ex = extract({
      "a.js": "export function foo() {}",
      "b.js": "foo(); export function bar() {}",
      "c.js": "bar(); foo();",
    });
    const g1 = buildSymbolGraph(ex);
    const g2 = buildSymbolGraph(ex);
    assert.deepEqual(g1.edges, g2.edges);
    const keys = g1.edges.map((e) => e.from + ">" + e.to);
    assert.deepEqual(keys, keys.slice().sort());
  });

  it("nameWeight rewards descriptive identifiers over short ones", () => {
    assert.ok(nameWeight("computeChecksum") > nameWeight("fn"));
    assert.ok(nameWeight("parse_config_file") > nameWeight("tmp"));
  });
});
