"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { makeProject } = require("./tmputil");
const runner = require("../../src/testintel/runner");

describe("testintel/runner — buildCommand (pure)", () => {
  it("node:test: coverage + name pattern + files", () => {
    const c = runner.buildCommand("node:test", { coverage: true, grep: "add", files: ["a.test.js"] });
    assert.equal(c.parseAs, "node:test");
    assert.ok(c.args.includes("--test"));
    assert.ok(c.args.includes("--experimental-test-coverage"));
    assert.deepEqual(c.args.slice(-3), ["--test-name-pattern", "add", "a.test.js"]);
  });
  it("jest: json + coverage reporters", () => {
    const c = runner.buildCommand("jest", { coverage: true, grep: "x" });
    assert.equal(c.cmd, "npx");
    assert.ok(c.args.includes("--json"));
    assert.ok(c.args.includes("--coverage"));
    assert.deepEqual(c.args.slice(c.args.indexOf("-t")), ["-t", "x"]);
  });
  it("pytest: verbose + keyword + cov term-missing", () => {
    const c = runner.buildCommand("pytest", { coverage: true, grep: "calc" });
    assert.equal(c.cmd, "pytest");
    assert.ok(c.args.includes("-v"));
    assert.ok(c.args.includes("--cov-report=term-missing"));
    assert.deepEqual(c.args.slice(c.args.indexOf("-k")), ["-k", "calc"]);
  });
  it("go test: -json and ./... default target", () => {
    const c = runner.buildCommand("go test", {});
    assert.deepEqual(c.args, ["test", "-json", "./..."]);
  });
  it("throws on an unknown runner", () => {
    assert.throws(() => runner.buildCommand("rspec", {}));
  });
});

describe("testintel/runner — availability", () => {
  it("node:test is always available", () => {
    assert.equal(runner.isAvailable("node:test").available, true);
  });
  it("an unavailable runner yields a clear, non-throwing result from run()", async () => {
    // a bogus runner id can't build a command -> unavailable result, not a throw
    const res = await runner.run("definitely-not-a-runner", {});
    assert.equal(res.available, false);
    assert.equal(res.ok, false);
    assert.ok(res.reason);
  });
});

describe("testintel/runner — real node:test execution", () => {
  it("runs a fixture suite and normalizes pass/fail into the model", async () => {
    const { root, cleanup } = makeProject({
      "pass.test.js": "const {test}=require('node:test');const a=require('node:assert');test('ok',()=>a.equal(1+1,2));",
      "fail.test.js": "const {test}=require('node:test');const a=require('node:assert');test('bad',()=>a.equal(1+1,3));",
    });
    try {
      const res = await runner.run("node:test", { cwd: root, files: [path.join(root, "pass.test.js"), path.join(root, "fail.test.js")], timeoutMs: 30000 });
      assert.equal(res.runner, "node:test");
      assert.equal(res.ok, false);
      assert.equal(res.counts.pass, 1);
      assert.equal(res.counts.fail, 1);
      const f = res.tests.find((t) => t.status === "fail");
      assert.equal(f.name, "bad");
      assert.ok(f.failure && f.failure.message);
      assert.ok(typeof res.exitCode === "number");
    } finally { cleanup(); }
  });

  it("runSync works too", () => {
    const { root, cleanup } = makeProject({
      "a.test.js": "const {test}=require('node:test');const a=require('node:assert');test('ok',()=>a.ok(true));",
    });
    try {
      const res = runner.runSync("node:test", { cwd: root, files: [path.join(root, "a.test.js")], timeoutMs: 30000 });
      assert.equal(res.ok, true);
      assert.equal(res.counts.pass, 1);
    } finally { cleanup(); }
  });
});
