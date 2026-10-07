"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const flaky = require("../../src/testintel/flaky");
const model = require("../../src/testintel/model");

describe("testintel/flaky — classifyOne", () => {
  it("all-pass over multiple runs is stable-pass", () => {
    assert.equal(flaky.classifyOne(["pass", "pass", "pass"]).verdict, "stable-pass");
  });
  it("a single pass is inconclusive (one run can't prove stability)", () => {
    assert.equal(flaky.classifyOne(["pass"]).verdict, "inconclusive");
  });
  it("all-fail is consistently-failing", () => {
    assert.equal(flaky.classifyOne(["fail", "fail"]).verdict, "consistently-failing");
  });
  it("mixed pass/fail is flaky with flip evidence", () => {
    const c = flaky.classifyOne(["pass", "fail", "pass", "fail"]);
    assert.equal(c.verdict, "flaky");
    assert.equal(c.flips, 3);
    assert.equal(c.flipRate, 1);
    assert.ok(c.failRate > 0 && c.failRate < 1);
  });
  it("all-skip is stable-skip", () => {
    assert.equal(flaky.classifyOne(["skip", "skip"]).verdict, "stable-skip");
  });
  it("confidence scales with run count", () => {
    assert.equal(flaky.classifyOne(["pass", "pass"]).confidence, "low");
    assert.equal(flaky.classifyOne(["pass", "pass", "pass", "pass", "pass"]).confidence, "high");
  });
});

describe("testintel/flaky — classifyRuns over seeded repeated results", () => {
  function run(results) { return flaky.classifyRuns(results); }
  const r = (outcomes) => model.makeResult({ runner: "x", tests: [
    { name: "a", status: outcomes.a }, { name: "b", status: outcomes.b }, { name: "c", status: outcomes.c },
  ] });
  it("separates stable, flaky and consistently-failing tests", () => {
    const cls = run([
      r({ a: "pass", b: "fail", c: "fail" }),
      r({ a: "pass", b: "pass", c: "fail" }),
      r({ a: "pass", b: "fail", c: "fail" }),
    ]);
    assert.deepEqual(cls.stable, ["a"]);
    assert.deepEqual(cls.flaky, ["b"]);
    assert.deepEqual(cls.failing, ["c"]);
    assert.equal(cls.runCount, 3);
  });
});

describe("testintel/flaky — runRepeated", () => {
  it("invokes the runFn N times and classifies", async () => {
    let i = 0;
    // seeded: test 'x' passes on even calls, fails on odd -> flaky
    const runFn = () => model.makeResult({ runner: "x", tests: [{ name: "x", status: (i++ % 2 === 0) ? "pass" : "fail" }] });
    const { results, classification } = await flaky.runRepeated(runFn, 4);
    assert.equal(results.length, 4);
    assert.deepEqual(classification.flaky, ["x"]);
  });
  it("supports early stop on first detected flake", async () => {
    let i = 0;
    const runFn = () => model.makeResult({ runner: "x", tests: [{ name: "x", status: (i++ === 0) ? "pass" : "fail" }] });
    const { results, classification } = await flaky.runRepeated(runFn, 10, { stopOnFirstFlake: true });
    assert.ok(results.length < 10);
    assert.equal(classification.earlyStop, true);
  });
});
