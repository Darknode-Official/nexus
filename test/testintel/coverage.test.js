"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const coverage = require("../../src/testintel/coverage");

describe("testintel/coverage — lcov", () => {
  const LCOV = "TN:\nSF:src/x.js\nFN:1,add\nFNDA:3,add\nDA:1,1\nDA:2,0\nDA:3,5\nLF:3\nLH:2\nFNF:1\nFNH:1\nend_of_record\n";
  const cov = coverage.parse(LCOV);
  it("parses per-line hits and derives uncovered lines", () => {
    assert.equal(cov.format, "lcov");
    const f = cov.files["src/x.js"];
    assert.equal(f.lines.get(2), 0);
    assert.deepEqual([...f.uncovered], [2]);
    assert.equal(f.lineRate, 0.6667);
  });
  it("rolls up totals", () => {
    assert.equal(cov.totals.files, 1);
    assert.ok(cov.totals.lineRate > 0.6 && cov.totals.lineRate < 0.7);
  });
});

describe("testintel/coverage — node --experimental-test-coverage table", () => {
  const TABLE = `# start of coverage report
# -------------------------------------------------------------------------------
# file        | line % | branch % | funcs % | uncovered lines
# -------------------------------------------------------------------------------
# src/calc.js |  66.67 |   100.00 |   50.00 | 2-4, 9
# all files   |  85.71 |   100.00 |   66.67 |
# -------------------------------------------------------------------------------
# end of coverage report`;
  const cov = coverage.parse(TABLE);
  it("parses uncovered-line ranges", () => {
    assert.equal(cov.format, "node-table");
    assert.deepEqual([...cov.files["src/calc.js"].uncovered], [2, 3, 4, 9]);
    assert.equal(cov.files["src/calc.js"].lineRate, 0.6667);
  });
  it("ignores the 'all files' summary row", () => {
    assert.ok(!cov.files["all files"]);
  });
});

describe("testintel/coverage — coverage.py report", () => {
  const REP = `Name           Stmts   Miss  Cover   Missing
--------------------------------------------
src/calc.py       10      2    80%   5-6, 9
--------------------------------------------
TOTAL             10      2    80%`;
  const cov = coverage.parse(REP);
  it("parses the Missing column into uncovered lines", () => {
    assert.equal(cov.format, "coverage.py");
    assert.deepEqual([...cov.files["src/calc.py"].uncovered], [5, 6, 9]);
    assert.equal(cov.files["src/calc.py"].summary.lines.covered, 8);
  });
});

describe("testintel/coverage — uncoveredChangedLines", () => {
  const LCOV = "SF:src/x.js\nDA:1,1\nDA:2,0\nDA:3,0\nDA:4,2\nend_of_record\n";
  const cov = coverage.parse(LCOV);
  it("flags changed lines with zero hits", () => {
    const r = coverage.uncoveredChangedLines(cov, { "src/x.js": [1, 2, 3, 4] });
    assert.deepEqual(r.uncovered["src/x.js"], [2, 3]);
  });
  it("separates lines with no coverage datum as 'unknown' (not 'covered')", () => {
    const r = coverage.uncoveredChangedLines(cov, { "src/x.js": [1, 99] });
    assert.ok(!r.uncovered["src/x.js"]);
    assert.deepEqual(r.unknown["src/x.js"], [99]);
  });
  it("reports files with no coverage at all under unknown", () => {
    const r = coverage.uncoveredChangedLines(cov, { "src/new.js": [1, 2] });
    assert.deepEqual(r.unknown["src/new.js"], [1, 2]);
  });
});

describe("testintel/coverage — expandRanges", () => {
  it("expands single lines and a-b ranges", () => {
    assert.deepEqual(coverage.expandRanges("1, 3-5, 8"), [1, 3, 4, 5, 8]);
    assert.deepEqual(coverage.expandRanges(""), []);
  });
});
