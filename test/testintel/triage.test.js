"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const triage = require("../../src/testintel/triage");
const model = require("../../src/testintel/model");

describe("testintel/triage — kind classification", () => {
  it("classifies assertion, timeout, type-error, import-error", () => {
    assert.equal(triage.classifyKind({ message: "expected 1 but got 2" }), "assertion");
    assert.equal(triage.classifyKind({ expected: 1, actual: 2 }), "assertion");
    assert.equal(triage.classifyKind({ message: "Test timed out after 2000ms" }), "timeout");
    assert.equal(triage.classifyKind({ message: "TypeError: x is not a function" }), "type-error");
    assert.equal(triage.classifyKind({ message: "Cannot find module 'foo'" }), "import-error");
  });
});

describe("testintel/triage — salient extraction", () => {
  it("picks the first user-code frame, skipping node internals / node_modules", () => {
    const frame = triage.topFrame([
      "    at node:internal/test_runner/test:796:25",
      "    at Object.<anonymous> (/proj/node_modules/lib/x.js:1:1)",
      "    at test (/proj/src/calc.test.js:10:5)",
    ].join("\n"));
    assert.equal(frame, "/proj/src/calc.test.js:10");
  });
  it("builds an expected/actual headline for assertions", () => {
    const s = triage.extractSalient({ expected: 3, actual: 2, operator: "==", message: "2 == 3" });
    assert.match(s.headline, /expected 3/);
    assert.match(s.headline, /actual 2/);
    assert.equal(s.kind, "assertion");
  });
});

describe("testintel/triage — clustering", () => {
  it("collapses cosmetically-different instances of the same bug into one cluster", () => {
    const result = model.makeResult({ runner: "jest", tests: [
      { name: "t1", status: "fail", failure: { message: "expected 1 but got 2", stack: "at /a/x.js:10:2" } },
      { name: "t2", status: "fail", failure: { message: "expected 5 but got 9", stack: "at /a/x.js:10:9" } },
      { name: "t3", status: "fail", failure: { message: "Cannot find module 'foo'", stack: "at /a/y.js:3:1", type: "Error" } },
    ] });
    const clusters = triage.clusterFailures(result.tests);
    assert.equal(clusters.length, 2);
    const assertionCluster = clusters.find((c) => c.kind === "assertion");
    assert.equal(assertionCluster.count, 2);
    assert.deepEqual(assertionCluster.members.map((m) => m.name).sort(), ["t1", "t2"]);
  });
  it("does not merge genuinely different failures", () => {
    const result = model.makeResult({ runner: "x", tests: [
      { name: "a", status: "fail", failure: { message: "TypeError: foo", stack: "at /a/a.js:1:1" } },
      { name: "b", status: "fail", failure: { message: "ReferenceError: bar", stack: "at /a/b.js:2:1" } },
    ] });
    assert.equal(triage.clusterFailures(result.tests).length, 2);
  });
  it("triage() summarizes clusters by kind", () => {
    const result = model.makeResult({ runner: "x", tests: [
      { name: "a", status: "fail", failure: { message: "expected 1 but got 2", stack: "at /a/x.js:1:1" } },
      { name: "b", status: "fail", failure: { message: "expected 3 but got 4", stack: "at /a/x.js:1:1" } },
      { name: "c", status: "pass" },
    ] });
    const d = triage.triage(result);
    assert.equal(d.total, 2);
    assert.equal(d.clusterCount, 1);
    assert.equal(d.byKind.assertion, 2);
    assert.match(d.summary, /distinct failure/);
  });
  it("reports no failures cleanly", () => {
    const d = triage.triage(model.makeResult({ runner: "x", tests: [{ name: "a", status: "pass" }] }));
    assert.equal(d.total, 0);
    assert.equal(d.summary, "no failures");
  });
});
