"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const model = require("../../src/testintel/model");

describe("testintel/model — status normalization", () => {
  it("maps runner vocabularies onto canonical statuses", () => {
    assert.equal(model.normStatus("passed"), "pass");
    assert.equal(model.normStatus("ok"), "pass");
    assert.equal(model.normStatus("failed"), "fail");
    assert.equal(model.normStatus("not ok"), "fail");
    assert.equal(model.normStatus("pending"), "skip");
    assert.equal(model.normStatus("skipped"), "skip");
    assert.equal(model.normStatus("todo"), "todo");
  });
  it("treats unknown/absent status as a failure, never a silent pass", () => {
    assert.equal(model.normStatus("weird"), "fail");
    assert.equal(model.normStatus(undefined), "fail");
  });
});

describe("testintel/model — makeResult", () => {
  it("recomputes counts and ok from the tests", () => {
    const r = model.makeResult({ runner: "jest", tests: [
      { name: "a", status: "passed", durationMs: 1 },
      { name: "b", status: "failed", failure: { message: "boom" } },
      { name: "c", status: "skipped" },
    ] });
    assert.deepEqual(r.counts, { total: 3, pass: 1, fail: 1, skip: 1, todo: 0 });
    assert.equal(r.ok, false);
    assert.equal(r.runner, "jest");
  });
  it("is ok only when there are zero failures and no process error", () => {
    const ok = model.makeResult({ tests: [{ name: "a", status: "pass" }] });
    assert.equal(ok.ok, true);
    const errored = model.makeResult({ tests: [{ name: "a", status: "pass" }], errored: true });
    assert.equal(errored.ok, false);
  });
  it("honours an explicit ok:false even without captured failures", () => {
    const r = model.makeResult({ tests: [{ name: "a", status: "pass" }], ok: false });
    assert.equal(r.ok, false);
  });
  it("sums durations when no total is given", () => {
    const r = model.makeResult({ tests: [{ name: "a", status: "pass", durationMs: 2 }, { name: "b", status: "pass", durationMs: 3 }] });
    assert.equal(r.durationMs, 5);
  });
});

describe("testintel/model — helpers", () => {
  const r = model.makeResult({ runner: "x", tests: [
    { name: "slow", status: "pass", durationMs: 100 },
    { name: "mid", status: "pass", durationMs: 50 },
    { name: "fail", status: "fail", durationMs: 10, failure: { message: "nope" } },
  ] });
  it("failures() returns only failed tests", () => {
    assert.deepEqual(model.failures(r).map((t) => t.name), ["fail"]);
  });
  it("slowest() ranks by duration desc", () => {
    assert.deepEqual(model.slowest(r, 2).map((t) => t.name), ["slow", "mid"]);
  });
  it("summarize() produces a compact rollup with passRate", () => {
    const s = model.summarize(r);
    assert.equal(s.total, 3); assert.equal(s.fail, 1);
    assert.equal(s.passRate, model.summarize(r).passRate);
    assert.ok(s.passRate > 0.66 && s.passRate < 0.67);
  });
  it("mergeResults() concatenates and recomputes", () => {
    const a = model.makeResult({ runner: "go test", tests: [{ name: "a", status: "pass" }] });
    const b = model.makeResult({ runner: "go test", tests: [{ name: "b", status: "fail", failure: { message: "x" } }] });
    const m = model.mergeResults([a, b]);
    assert.equal(m.counts.total, 2);
    assert.equal(m.ok, false);
    assert.equal(m.runner, "go test");
  });
});
