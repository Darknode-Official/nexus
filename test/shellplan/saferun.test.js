"use strict";
// Tests for the guarded safe-run wrapper. Only low-risk commands actually execute;
// anything above threshold or outside policy is refused without spawning.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const { safeRun } = require("../../src/shellplan/saferun");

const TMP = os.tmpdir();

describe("shellplan/saferun: refusal", () => {
  it("refuses a command above the risk threshold", async () => {
    const r = await safeRun("rm -rf /", { riskThreshold: "low" });
    assert.equal(r.ran, false);
    assert.equal(r.refused, true);
    assert.ok(/exceeds threshold/.test(r.reason));
  });

  it("refuses a high-risk command even at medium threshold", async () => {
    const r = await safeRun("git push --force", { riskThreshold: "medium" });
    assert.equal(r.refused, true);
  });

  it("refuses when a sandbox policy would deny", async () => {
    const r = await safeRun("echo hi", { policy: { roots: [TMP], commands: ["ls"] } });
    assert.equal(r.refused, true);
    assert.ok(/policy would deny/.test(r.reason));
  });

  it("never executes a destructive command at default threshold", async () => {
    const r = await safeRun("rm -rf node_modules");
    assert.equal(r.ran, false);
    assert.equal(r.refused, true);
  });
});

describe("shellplan/saferun: dry run", () => {
  it("returns a plan without executing", async () => {
    const r = await safeRun("echo hello", { dryRun: true });
    assert.equal(r.ran, false);
    assert.equal(r.dryRun, true);
    assert.ok(r.plan && Array.isArray(r.plan.steps));
  });
});

describe("shellplan/saferun: execution", () => {
  it("runs a safe command and captures stdout", async () => {
    const r = await safeRun("echo hello-world", { riskThreshold: "low" });
    assert.equal(r.ran, true);
    assert.equal(r.refused, false);
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("hello-world"));
  });

  it("captures a non-zero exit code", async () => {
    const r = await safeRun("false", { riskThreshold: "low" });
    assert.equal(r.ran, true);
    assert.notEqual(r.exitCode, 0);
  });

  it("captures stderr", async () => {
    const r = await safeRun("echo oops 1>&2", { riskThreshold: "low" });
    assert.ok(r.stderr.includes("oops"));
  });

  it("respects a chosen cwd", async () => {
    const r = await safeRun("pwd", { riskThreshold: "low", cwd: TMP });
    assert.ok(r.stdout.trim().length > 0);
    assert.equal(r.cwd, TMP);
  });

  it("passes env overrides", async () => {
    const r = await safeRun("echo $MY_SHELLPLAN_VAR", { riskThreshold: "low", env: { MY_SHELLPLAN_VAR: "xyz123" } });
    assert.ok(r.stdout.includes("xyz123"));
  });

  it("enforces a timeout and kills the process", async () => {
    const r = await safeRun("sleep 5", { riskThreshold: "low", timeout: 150 });
    assert.equal(r.timedOut, true);
    assert.equal(r.ran, true);
  });

  it("allows an in-policy safe command to run", async () => {
    const r = await safeRun("echo ok", { riskThreshold: "low", policy: { roots: [TMP], commands: ["echo"] }, cwd: TMP });
    assert.equal(r.ran, true);
    assert.ok(r.stdout.includes("ok"));
  });
});
