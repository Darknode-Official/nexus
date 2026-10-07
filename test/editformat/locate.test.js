"use strict";
// Tests for the locator: exact match, whitespace/indent self-repair, ambiguous
// (duplicate) detection, not-found diagnosis with ranked candidates, and opt-in
// content-fuzzy matching (never silent).

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { locate } = require("../../src/editformat/locate");

const FILE = "function f() {\n  const x = 1;\n  return x;\n}\n";

describe("locate — exact", () => {
  it("finds a verbatim block", () => {
    const r = locate(FILE, ["  const x = 1;"]);
    assert.equal(r.status, "exact");
    assert.equal(r.start, 1);
    assert.equal(r.end, 2);
    assert.deepEqual(r.matched, ["  const x = 1;"]);
  });
});

describe("locate — self-repair", () => {
  it("repairs trailing-whitespace drift", () => {
    const r = locate(FILE, ["  const x = 1;   "]);
    assert.equal(r.status, "repaired");
    assert.equal(r.normalizer, "trailing-ws");
  });
  it("repairs indentation drift", () => {
    const r = locate(FILE, ["const x = 1;"]); // no leading indent
    assert.equal(r.status, "repaired");
    assert.equal(r.normalizer, "indent");
    assert.equal(r.matchIndent, "  ");
  });
  it("repairs tab/space drift", () => {
    const tabbed = "def f():\n\treturn 1\n";
    const r = locate(tabbed, ["    return 1"]);
    assert.equal(r.status, "repaired");
    assert.ok(["tabs", "indent"].includes(r.normalizer));
  });
});

describe("locate — ambiguous", () => {
  it("reports multiple matches instead of guessing", () => {
    const dup = "x = 1\ny = 2\nx = 1\n";
    const r = locate(dup, ["x = 1"]);
    assert.equal(r.status, "ambiguous");
    assert.equal(r.diagnosis.count, 2);
    assert.deepEqual(r.diagnosis.lines, [1, 3]);
  });
});

describe("locate — not-found", () => {
  it("returns a diagnosis with ranked candidates", () => {
    const r = locate(FILE, ["  const y = 42;"]);
    assert.equal(r.status, "not-found");
    assert.ok(r.candidates.length >= 1);
    assert.ok(typeof r.diagnosis.bestSimilarity === "number");
  });
  it("does not accept a fuzzy match unless allowed", () => {
    const r = locate(FILE, ["  const x = 2;"]); // close but not exact
    assert.equal(r.status, "not-found");
  });
});

describe("locate — opt-in fuzzy", () => {
  it("accepts a strong unambiguous fuzzy match when allowed", () => {
    const r = locate(FILE, ["  const x = 2;"], { allowFuzzy: true });
    assert.equal(r.status, "repaired");
    assert.equal(r.normalizer, "fuzzy");
    assert.ok(r.similarity >= 0.75);
  });
});

describe("locate — empty", () => {
  it("reports empty for a blank SEARCH", () => {
    assert.equal(locate(FILE, []).status, "empty");
    assert.equal(locate(FILE, ["", "  "]).status, "empty");
  });
});
