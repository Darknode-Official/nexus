"use strict";
// Tests for sectools/explain — explanations + deterministic autofixes.
// Run: node --test test/sectools/

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const explain = require("../../src/sectools/explain");

describe("explain · explanation", () => {
  it("explains a SAST finding with CWE context", () => {
    const e = explain.explain({ type: "sast", id: "js-eval", cwe: "CWE-95", title: "Use of eval()", message: "eval runs code", file: "a.js", line: 3 });
    assert.ok(e.why.length > 0);
    assert.ok(e.impact.length > 0);
    assert.match(e.cwe, /CWE-95/);
    assert.ok(e.what.includes("a.js"));
  });

  it("explains a secret finding", () => {
    const e = explain.explain({ type: "secret", provider: "AWS", cwe: "CWE-798", title: "AWS key", file: "b.js", line: 1 });
    assert.ok(e.what.includes("AWS"));
    assert.match(e.cwe, /CWE-798/);
  });

  it("explains a dependency finding", () => {
    const e = explain.explain({ type: "dependency", package: "lodash", version: "4.17.0", title: "Prototype pollution", aliases: ["CVE-2021-23337"], cwe: "CWE-1321" });
    assert.ok(e.what.includes("lodash@4.17.0"));
    assert.ok(e.what.includes("CVE-2021-23337"));
  });

  it("falls back gracefully for an unknown CWE", () => {
    const e = explain.explain({ type: "sast", id: "x", cwe: "CWE-99999", title: "t", message: "m", file: "f", line: 1 });
    assert.equal(e.cwe, "CWE-99999");
    assert.equal(e.why, "m");
  });
});

describe("explain · deterministic autofixes", () => {
  it("rewrites md5 to sha256", () => {
    const fix = explain.suggestFix({ type: "sast", fixHint: "upgrade-hash", lang: "js" }, 'crypto.createHash("md5");');
    assert.equal(fix.autofixable, true);
    assert.ok(fix.suggested.includes("sha256"));
    assert.ok(!fix.suggested.includes("md5"));
  });

  it("rewrites shell=True to shell=False", () => {
    const fix = explain.suggestFix({ type: "sast", fixHint: "py-shell-false" }, "subprocess.run(cmd, shell=True)");
    assert.equal(fix.autofixable, true);
    assert.ok(fix.suggested.includes("shell=False"));
  });

  it("rewrites yaml.load to yaml.safe_load", () => {
    const fix = explain.suggestFix({ type: "sast", fixHint: "yaml-safe-load" }, "yaml.load(s)");
    assert.equal(fix.autofixable, true);
    assert.ok(fix.suggested.includes("safe_load"));
  });

  it("tightens 0o777 to 0o600", () => {
    const fix = explain.suggestFix({ type: "sast", fixHint: "tighten-perms" }, "os.chmod(p, 0o777)");
    assert.equal(fix.autofixable, true);
    assert.ok(fix.suggested.includes("0o600"));
  });

  it("provides guidance-only snippets for unsafe-to-auto-rewrite rules", () => {
    const fix = explain.suggestFix({ type: "sast", fixHint: "parameterise-sql", lang: "py" });
    assert.equal(fix.autofixable, false);
    assert.ok(fix.snippet.includes("%s"));
  });

  it("suggests env-var migration for secrets", () => {
    const fix = explain.suggestFix({ type: "secret", id: "github-token", file: "a.js" });
    assert.equal(fix.autofixable, false);
    assert.ok(/process\.env/.test(fix.snippet));
    assert.ok(/rotate/i.test(fix.note));
  });

  it("suggests an upgrade for dependency findings", () => {
    const fix = explain.suggestFix({ type: "dependency", ecosystem: "npm", package: "lodash", patched: "4.17.21" });
    assert.ok(fix.snippet.includes("4.17.21"));
  });

  it("returns null when no fixer is registered", () => {
    assert.equal(explain.suggestFix({ type: "sast", id: "whatever" }), null);
  });
});

describe("explain · explainAll", () => {
  it("enriches a batch with explanation + fix", () => {
    const out = explain.explainAll([
      { type: "sast", id: "js-weak-hash", cwe: "CWE-327", fixHint: "upgrade-hash", lang: "js", title: "md5", message: "weak", snippet: 'createHash("md5")', file: "a.js", line: 1 },
    ]);
    assert.ok(out[0].explanation);
    assert.ok(out[0].fix);
    assert.equal(out[0].fix.autofixable, true);
  });
});
