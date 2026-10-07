"use strict";
// Tests for sectools/index (aggregate audit + formatting), walk, and the CLI.
// Exercises end-to-end scanning over real fixture files on disk.
// Run: node --test test/sectools/

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const sectools = require("../../src/sectools");
const walk = require("../../src/sectools/walk");
const cli = require("../../src/sectools/audit");

describe("sectools · public surface", () => {
  it("exposes all submodules and the aggregate API", () => {
    for (const k of ["secrets", "sast", "sastRules", "advisories", "advisoryDb", "explain", "guards", "walk"]) {
      assert.ok(sectools[k], "missing " + k);
    }
    assert.equal(typeof sectools.audit, "function");
    assert.equal(typeof sectools.formatReport, "function");
    assert.equal(typeof sectools.sortFindings, "function");
  });
});

describe("walk", () => {
  let dir;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sectools-walk-"));
    fs.mkdirSync(path.join(dir, "node_modules", "pkg"), { recursive: true });
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src", "a.js"), "const a = 1;");
    fs.writeFileSync(path.join(dir, "node_modules", "pkg", "b.js"), "const b = 2;");
    fs.writeFileSync(path.join(dir, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
  });
  after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });

  it("skips ignored dirs and binary files", () => {
    const res = walk.walk(dir);
    const rels = res.files.map((f) => f.rel);
    assert.ok(rels.includes("src/a.js"));
    assert.ok(!rels.some((r) => r.includes("node_modules")));
    assert.ok(!rels.some((r) => r.endsWith(".png")));
  });

  it("detects binary content", () => {
    assert.equal(walk.looksBinary(Buffer.from([1, 0, 2])), true);
    assert.equal(walk.looksBinary(Buffer.from("plain text", "utf8")), false);
  });

  it("readText returns null for binary and content for text", () => {
    assert.equal(walk.readText(path.join(dir, "logo.png")), null);
    assert.ok(walk.readText(path.join(dir, "src", "a.js")).includes("const a"));
  });
});

describe("sectools · audit (end-to-end)", () => {
  let dir;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sectools-audit-"));
    fs.writeFileSync(path.join(dir, "server.js"), [
      'const token = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";',
      "cp.exec(`cat ${file}`);",
      'crypto.createHash("sha1");',
    ].join("\n"));
    fs.writeFileSync(path.join(dir, "worker.py"), [
      "import pickle",
      "data = pickle.loads(blob)",
    ].join("\n"));
    fs.writeFileSync(path.join(dir, "requirements.txt"), "Django==3.1.0\n");
    fs.writeFileSync(path.join(dir, "ok.js"), "module.exports = (a,b) => a+b;\n");
  });
  after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });

  it("runs all scanners and sorts by severity", () => {
    const report = sectools.audit(dir);
    assert.ok(report.findings.length >= 4);
    const ids = report.findings.map((f) => f.id);
    assert.ok(ids.includes("github-token"));
    assert.ok(ids.includes("js-child-process-exec"));
    assert.ok(ids.includes("py-pickle-loads"));
    assert.ok(ids.some((i) => /^DN-/.test(i)));
    // severity ordering: first finding ranks >= last
    const order = sectools.SEVERITY_ORDER;
    const first = report.findings[0], last = report.findings[report.findings.length - 1];
    assert.ok((order[first.severity] || 0) >= (order[last.severity] || 0));
    assert.ok(report.counts.total === report.findings.length);
    assert.ok(report.manifests.includes("requirements.txt"));
  });

  it("honours scanner toggles", () => {
    const onlySecrets = sectools.audit(dir, { sast: false, deps: false });
    assert.ok(onlySecrets.findings.every((f) => f.type === "secret"));
  });

  it("can attach explanations", () => {
    const report = sectools.audit(dir, { explain: true });
    assert.ok(report.findings.every((f) => f.explanation));
  });

  it("formatReport produces readable text without leaking secrets", () => {
    const report = sectools.audit(dir);
    const txt = sectools.formatReport(report);
    assert.ok(txt.includes("Nexus sectools audit"));
    assert.ok(txt.includes("Findings:"));
    assert.ok(!txt.includes("ghp_1234567890abcdefghijklmnopqrstuvwxyz"));
  });
});

describe("sectools · CLI", () => {
  let dir;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sectools-cli-"));
    fs.writeFileSync(path.join(dir, "bad.js"), 'const k = "AKIAIOSFODNN7QF2JKLM";\neval(x);\n');
    fs.writeFileSync(path.join(dir, "good.js"), "export const n = 1;\n");
  });
  after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });

  it("parses arguments", () => {
    const o = cli.parseArgs([dir, "--json", "--no-deps", "--fail-on", "critical"]);
    assert.equal(o.root, dir);
    assert.equal(o.json, true);
    assert.equal(o.deps, false);
    assert.equal(o.failOn, "critical");
  });

  it("exit code 2 when findings meet --fail-on, 0 when clean", () => {
    const stdout = process.stdout.write;
    process.stdout.write = () => true; // silence
    try {
      const codeBad = cli.main([dir, "--fail-on", "high"]);
      const codeClean = cli.main([path.join(dir, "good.js")]);
      assert.equal(codeBad, 2);
      assert.equal(codeClean, 0);
    } finally {
      process.stdout.write = stdout;
    }
  });

  it("--help returns 0", () => {
    const stdout = process.stdout.write;
    process.stdout.write = () => true;
    try { assert.equal(cli.main(["--help"]), 0); }
    finally { process.stdout.write = stdout; }
  });
});
