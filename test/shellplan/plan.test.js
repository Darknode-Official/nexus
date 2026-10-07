"use strict";
// Tests for the dry-run plan, wouldSandboxAllow policy predictor, and assess().

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { dryRun, wouldSandboxAllow, assess, extractUrls } = require("../../src/shellplan/plan");

const ROOT = "/work/project";

describe("shellplan/plan: dryRun", () => {
  it("produces one step per simple command", () => {
    const p = dryRun("cp a b && rm c", { cwd: ROOT });
    const simple = p.steps.filter(s => s.kind === "simple");
    assert.equal(simple.length, 2);
  });

  it("attaches file effects to their command", () => {
    const p = dryRun("rm x.txt", { cwd: ROOT });
    const step = p.steps[0];
    assert.ok(step.effects.some(e => e.path === "x.txt" && e.access === "delete"));
  });

  it("aggregates effects into reads/writes/deletes", () => {
    const p = dryRun("cp a b && rm c", { cwd: ROOT });
    assert.ok(p.effects.reads.length >= 1);
    assert.ok(p.effects.writes.length >= 1);
    assert.ok(p.effects.deletes.length >= 1);
  });

  it("models cd changing cwd for later steps", () => {
    const p = dryRun("cd sub && touch f", { cwd: ROOT });
    const touch = p.steps.find(s => s.program === "touch");
    assert.equal(touch.cwd, path.resolve(ROOT, "sub"));
  });

  it("records env overrides per step", () => {
    const p = dryRun("FOO=1 node app.js", { cwd: ROOT });
    assert.equal(p.steps[0].env.FOO, "1");
  });

  it("includes the risk report", () => {
    const p = dryRun("rm -rf /", { cwd: ROOT });
    assert.equal(p.risk.maxSeverity, "critical");
  });
});

describe("shellplan/plan: wouldSandboxAllow", () => {
  const base = { roots: [ROOT], commands: ["ls", "cat", "git", "rm"], network: ["github.com"] };

  it("allows a listed command within roots", () => {
    const r = wouldSandboxAllow("cat README.md", base, { cwd: ROOT });
    assert.equal(r.allowed, true);
  });

  it("denies a command not on the allowlist", () => {
    const r = wouldSandboxAllow("wget http://x", base, { cwd: ROOT });
    assert.equal(r.allowed, false);
    assert.ok(r.reasons.some(x => /not on the allowlist/.test(x)));
  });

  it("allows any command with '*'", () => {
    const r = wouldSandboxAllow("anything here", { roots: [ROOT], commands: ["*"], network: [] }, { cwd: ROOT });
    assert.equal(r.allowed, true);
  });

  it("denies a destructive op when allowDestructive is false", () => {
    const r = wouldSandboxAllow("rm -rf build", base, { cwd: ROOT });
    assert.equal(r.allowed, false);
    assert.ok(r.reasons.some(x => /destructive/.test(x)));
  });

  it("requires confirmation when allowDestructive but not confirmed", () => {
    const r = wouldSandboxAllow("rm -rf build", Object.assign({}, base, { allowDestructive: true }), { cwd: ROOT });
    assert.equal(r.allowed, false);
    assert.ok(r.perCommand.some(d => d.needsConfirm));
  });

  it("allows a confirmed destructive op in-root", () => {
    const r = wouldSandboxAllow("rm -rf build", Object.assign({}, base, { allowDestructive: true, confirmed: true }), { cwd: ROOT });
    assert.equal(r.allowed, true);
  });

  it("denies a write target outside the roots", () => {
    const r = wouldSandboxAllow("cat /etc/passwd", base, { cwd: ROOT });
    assert.equal(r.allowed, false);
    assert.ok(r.reasons.some(x => /outside declared roots/.test(x)));
  });

  it("allows a relative path inside the root", () => {
    const r = wouldSandboxAllow("cat ./src/index.js", base, { cwd: ROOT });
    assert.equal(r.allowed, true);
  });

  it("treats a dynamic path as uncontainable (deny)", () => {
    const r = wouldSandboxAllow("cat $SECRET_FILE", base, { cwd: ROOT });
    assert.equal(r.allowed, false);
    assert.ok(r.reasons.some(x => /dynamic/.test(x)));
  });

  it("denies a network host not on the allowlist", () => {
    const r = wouldSandboxAllow("git clone https://evil.example.com/x", base, { cwd: ROOT });
    assert.equal(r.allowed, false);
    assert.ok(r.reasons.some(x => /network host/.test(x)));
  });

  it("allows an allowlisted network host (and subdomains)", () => {
    const r = wouldSandboxAllow("git clone https://api.github.com/x", base, { cwd: ROOT });
    assert.equal(r.allowed, true);
  });

  it("defaults roots to cwd when none given", () => {
    const r = wouldSandboxAllow("ls", { commands: ["ls"] }, {});
    assert.equal(r.allowed, true);
  });
});

describe("shellplan/plan: assess", () => {
  it("recommends deny when the sandbox would reject", () => {
    const a = assess("wget http://x", { policy: { roots: [ROOT], commands: ["ls"] }, cwd: ROOT });
    assert.ok(/deny/.test(a.recommendation));
  });

  it("recommends confirm when risk meets the threshold", () => {
    const a = assess("rm -rf build", { policy: { roots: [ROOT], commands: ["rm"], allowDestructive: true, confirmed: true }, cwd: ROOT, riskThreshold: "high" });
    assert.ok(/confirm/.test(a.recommendation));
    assert.equal(a.overThreshold, true);
  });

  it("recommends proceed for a safe in-policy command", () => {
    const a = assess("ls -la", { policy: { roots: [ROOT], commands: ["ls"] }, cwd: ROOT });
    assert.ok(/proceed/.test(a.recommendation));
  });

  it("works without a policy (risk-only)", () => {
    const a = assess("ls");
    assert.equal(a.sandbox, null);
    assert.ok(a.recommendation);
  });
});

describe("shellplan/plan: extractUrls", () => {
  it("pulls http(s) urls from a command", () => {
    const urls = extractUrls("curl https://a.com/x http://b.org/y");
    assert.deepEqual(urls, ["https://a.com/x", "http://b.org/y"]);
  });
  it("returns [] when there are none", () => {
    assert.deepEqual(extractUrls("ls -la"), []);
  });
});
