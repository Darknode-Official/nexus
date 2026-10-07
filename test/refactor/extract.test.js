"use strict";
// Tests for extract-function: parameter inference from free variables, single and
// multiple return values, await handling, and control-flow refusal.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { session } = require("./fixture");

function out(p) { return [...p.edits.values()][0]; }

describe("extract — parameters & returns", () => {
  it("infers params and a single return value", () => {
    const src = "function calc(a, b) {\n  const doubled = a * 2;\n  return doubled + b;\n}\n";
    const s = session({ "m.js": src });
    const p = s.extract({ file: "m.js", startLine: 2, endLine: 2, newName: "twice" });
    assert.ok(p.ok, JSON.stringify(p.safety));
    assert.deepEqual(p.details.params, ["a"]);
    assert.deepEqual(p.details.returns, ["doubled"]);
    const t = out(p);
    assert.match(t, /function twice\(a\) \{/);
    assert.match(t, /return doubled;/);
    assert.match(t, /const doubled = twice\(a\);/);
  });

  it("returns an object for multiple outputs", () => {
    const src = "function calc(a, b) {\n  const sum = a + b;\n  const product = a * b;\n  return sum + product;\n}\n";
    const s = session({ "m.js": src });
    const p = s.extract({ file: "m.js", startLine: 2, endLine: 3, newName: "combine" });
    assert.ok(p.ok);
    assert.deepEqual(p.details.params.sort(), ["a", "b"]);
    assert.deepEqual(p.details.returns.sort(), ["product", "sum"]);
    const t = out(p);
    assert.match(t, /return \{ sum, product \};/);
    assert.match(t, /const \{ sum, product \} = combine\(a, b\);/);
  });

  it("extracts a void statement (no params, no return)", () => {
    const src = "function run() {\n  console.log('hello world');\n  return 1;\n}\n";
    const s = session({ "m.js": src });
    const p = s.extract({ file: "m.js", startLine: 2, endLine: 2, newName: "greet" });
    assert.ok(p.ok);
    assert.equal(p.details.params.length, 0);
    assert.equal(p.details.returns.length, 0);
    assert.match(out(p), /greet\(\);/);
  });

  it("makes the extracted function async when the selection awaits", () => {
    const src = "async function load(url) {\n  const res = await get(url);\n  return res.body;\n}\n";
    const s = session({ "m.js": src });
    const p = s.extract({ file: "m.js", startLine: 2, endLine: 2, newName: "fetchRes" });
    assert.ok(p.ok);
    assert.equal(p.details.async, true);
    const t = out(p);
    assert.match(t, /async function fetchRes\(url\) \{/);
    assert.match(t, /const res = await fetchRes\(url\);/);
  });
});

describe("extract — safety", () => {
  it("refuses a selection containing a top-level return", () => {
    const src = "function f(x) {\n  if (x) return 1;\n  return 2;\n}\n";
    const s = session({ "m.js": src });
    const p = s.extract({ file: "m.js", startLine: 2, endLine: 2, newName: "g" });
    assert.equal(p.ok, false);
    assert.match(p.safety.reasons[0], /return/);
  });

  it("refuses an invalid new name", () => {
    const src = "function f() {\n  const a = 1;\n}\n";
    const s = session({ "m.js": src });
    const p = s.extract({ file: "m.js", startLine: 2, endLine: 2, newName: "1bad" });
    assert.equal(p.ok, false);
  });

  it("refuses an out-of-range selection", () => {
    const src = "function f() { return 1; }\n";
    const s = session({ "m.js": src });
    const p = s.extract({ file: "m.js", startLine: 50, endLine: 60, newName: "g" });
    assert.equal(p.ok, false);
  });
});

describe("extract — round-trips semantically", () => {
  it("preview result is syntactically valid JS", () => {
    const src = "function calc(a, b) {\n  const sum = a + b;\n  const product = a * b;\n  return sum + product;\n}\n";
    const s = session({ "m.js": src });
    const p = s.extract({ file: "m.js", startLine: 2, endLine: 3, newName: "combine" });
    assert.ok(p.ok);
    // new Function throws on a syntax error.
    assert.doesNotThrow(() => new Function(out(p)));
  });
});
