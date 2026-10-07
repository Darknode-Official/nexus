"use strict";
// Tests for sectools/guards — pre-send and pre-commit guard hooks.
// Run: node --test test/sectools/

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const guards = require("../../src/sectools/guards");

describe("guards · severity helpers", () => {
  it("ranks severities", () => {
    assert.ok(guards.severityRank("critical") > guards.severityRank("high"));
    assert.ok(guards.severityRank("high") > guards.severityRank("low"));
    assert.equal(guards.severityRank("bogus"), 0);
  });
  it("counts by severity", () => {
    const c = guards.countBySeverity([{ severity: "high" }, { severity: "high" }, { severity: "low" }]);
    assert.equal(c.high, 2);
    assert.equal(c.low, 1);
    assert.equal(c.total, 3);
  });
  it("decides blocking at a threshold", () => {
    const findings = [{ severity: "medium" }, { severity: "high" }];
    assert.equal(guards.decide(findings, "high").blocked, true);
    assert.equal(guards.decide([{ severity: "low" }], "high").blocked, false);
  });
});

describe("guards · preSendGuard", () => {
  it("blocks and redacts text containing a secret", () => {
    const r = guards.preSendGuard('token = "ghp_1234567890abcdefghijklmnopqrstuvwxyz"');
    assert.equal(r.ok, false);
    assert.equal(r.blocked, true);
    assert.ok(!r.redacted.includes("ghp_1234567890abcdefghijklmnopqrstuvwxyz"));
    assert.ok(r.findings.length >= 1);
  });

  it("passes clean text through", () => {
    const r = guards.preSendGuard("please refactor the login handler for clarity");
    assert.equal(r.ok, true);
    assert.equal(r.blocked, false);
    assert.equal(r.findings.length, 0);
  });

  it("respects the threshold option", () => {
    // A JWT is medium severity; threshold high should not block.
    const jwt = "eyJhbGciOiJIUzI1Niwith.eyJzdWIiOiIxMjMverylong.abcDEFghiJKLmnoPQR12345";
    const r = guards.preSendGuard("token " + jwt, { threshold: "high" });
    assert.equal(r.blocked, false);
  });
});

describe("guards · preCommitGuard", () => {
  let dir;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sectools-guard-"));
    fs.writeFileSync(path.join(dir, "app.js"), [
      'const key = "AKIAIOSFODNN7QF2JKLM";',
      "cp.exec(`rm ${name}`);",
      'crypto.createHash("md5");',
    ].join("\n"));
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ dependencies: { lodash: "4.17.0" } }));
    fs.writeFileSync(path.join(dir, "clean.js"), "function add(a, b) { return a + b; }\n");
  });
  after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });

  it("aggregates secret, SAST and dependency findings and blocks", () => {
    const r = guards.preCommitGuard(dir, { threshold: "high" });
    assert.equal(r.blocked, true);
    const ids = r.findings.map((f) => f.id);
    assert.ok(ids.includes("aws-access-key-id"), "secret");
    assert.ok(ids.includes("js-child-process-exec"), "sast");
    assert.ok(ids.some((i) => /^DN-/.test(i)), "dependency");
    assert.ok(r.filesScanned >= 2);
  });

  it("accepts an explicit file list (staged files)", () => {
    const r = guards.preCommitGuard(dir, { files: [path.join(dir, "clean.js")] });
    assert.equal(r.ok, true);
    assert.equal(r.blocked, false);
  });

  it("can attach explanations when requested", () => {
    const r = guards.preCommitGuard(dir, { explain: true, files: [path.join(dir, "app.js")] });
    assert.ok(r.findings[0].explanation);
  });
});
