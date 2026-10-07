"use strict";
// Tests for budget-bounded rendering: the hard token bound, graceful degradation,
// deterministic tree output, and the full (unbudgeted) render.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { renderBudgeted, renderTree, importanceBar } = require("../../src/repomap/render");
const { estimateTokens } = require("../../src/tokensave/estimator");

// Synthetic ranked inputs: 3 files, several symbols with descending scores.
function fixture() {
  const files = [
    { file: "src/core.js", score: 0.5, lang: "javascript", loc: 100, symbolCount: 3 },
    { file: "src/util.js", score: 0.3, lang: "javascript", loc: 50, symbolCount: 2 },
    { file: "lib/old.js", score: 0.2, lang: "javascript", loc: 30, symbolCount: 2 },
  ];
  const symbols = [
    { file: "src/core.js", name: "run", kind: "function", parent: null, line: 1, exported: true, score: 0.30, signature: "function run(opts)" },
    { file: "src/core.js", name: "init", kind: "function", parent: null, line: 10, exported: true, score: 0.15, signature: "function init(config)" },
    { file: "src/core.js", name: "helper", kind: "function", parent: null, line: 20, exported: false, score: 0.05, signature: "function helper(x)" },
    { file: "src/util.js", name: "format", kind: "function", parent: null, line: 1, exported: true, score: 0.20, signature: "function format(s)" },
    { file: "src/util.js", name: "parse", kind: "function", parent: null, line: 5, exported: true, score: 0.10, signature: "function parse(s)" },
    { file: "lib/old.js", name: "legacy", kind: "function", parent: null, line: 1, exported: false, score: 0.12, signature: "function legacy()" },
    { file: "lib/old.js", name: "deprecated", kind: "function", parent: null, line: 8, exported: false, score: 0.08, signature: "function deprecated()" },
  ];
  return { files, symbols };
}

describe("Repo Map — budgeted rendering", () => {
  it("never exceeds the token budget (sweep of budgets)", () => {
    const { files, symbols } = fixture();
    for (const budget of [20, 40, 60, 100, 200, 500]) {
      const r = renderBudgeted(files, symbols, { budget, model: "generic" });
      assert.ok(r.tokens <= budget, "budget " + budget + " exceeded: " + r.tokens);
      // the measured token count of the actual string matches the reported one
      assert.equal(estimateTokens(r.map, "generic"), r.tokens);
    }
  });

  it("degrades gracefully: a smaller budget yields no more symbols than a larger one", () => {
    const { files, symbols } = fixture();
    const small = renderBudgeted(files, symbols, { budget: 40, model: "generic" });
    const large = renderBudgeted(files, symbols, { budget: 500, model: "generic" });
    assert.ok(small.includedSymbols <= large.includedSymbols);
    assert.ok(large.includedSymbols <= symbols.length);
  });

  it("prioritizes higher-ranked symbols/files when space is tight", () => {
    const { files, symbols } = fixture();
    const r = renderBudgeted(files, symbols, { budget: 60, model: "generic" });
    // the top-ranked symbol must survive; the lowest-ranked must not (at this budget)
    assert.ok(r.map.includes("run(opts)"), r.map);
    assert.ok(!r.map.includes("helper(x)"), "lowest-rank symbol should be dropped\n" + r.map);
  });

  it("marks degraded when symbols were dropped", () => {
    const { files, symbols } = fixture();
    const r = renderBudgeted(files, symbols, { budget: 50, model: "generic" });
    assert.equal(r.degraded, true);
    assert.ok(r.droppedSymbols > 0);
  });

  it("groups files under their directory and shows an importance bar", () => {
    const { files, symbols } = fixture();
    const r = renderBudgeted(files, symbols, { budget: 1000, model: "generic" });
    assert.ok(r.map.includes("src/"));
    assert.ok(r.map.includes("lib/"));
    assert.ok(/\[#+-*\]/.test(r.map), "expected an ASCII importance bar");
  });

  it("is deterministic", () => {
    const { files, symbols } = fixture();
    const a = renderBudgeted(files, symbols, { budget: 120, model: "generic" });
    const b = renderBudgeted(files, symbols, { budget: 120, model: "generic" });
    assert.equal(a.map, b.map);
  });

  it("renderTree includes all symbols (unbudgeted)", () => {
    const { files, symbols } = fixture();
    const t = renderTree(files, symbols, { model: "generic" });
    assert.equal(t.symbols, symbols.length);
    assert.ok(t.map.includes("helper(x)"));
  });

  it("handles an impossibly small budget without throwing or exceeding it", () => {
    const { files, symbols } = fixture();
    const r = renderBudgeted(files, symbols, { budget: 1, model: "generic" });
    assert.ok(r.tokens <= 1);
    assert.ok(typeof r.map === "string");
  });

  it("importanceBar is bounded and scales with score", () => {
    const low = importanceBar(0.01, 1);
    const high = importanceBar(1, 1);
    assert.equal(high, "[##########]");
    assert.ok(low.startsWith("[") && low.endsWith("]"));
    assert.equal(low.length, high.length);
  });
});
