"use strict";
// Tests for inline-variable and inline-function, including the safety refusals that
// prevent duplicating side effects or inlining non-trivial functions.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { session } = require("./fixture");

function out(p) { return [...p.edits.values()][0]; }

describe("inline — variable", () => {
  it("inlines a single-use variable and removes the declaration", () => {
    const s = session({ "v.js": "function f(){ const x = a + b; return x * 2; }\n" });
    const p = s.inlineVariable({ file: "v.js", name: "x" });
    assert.ok(p.ok, JSON.stringify(p.safety));
    assert.equal(out(p), "function f(){ return (a + b) * 2; }\n");
  });

  it("inlines a simple multi-use variable", () => {
    const s = session({ "v.js": "const n = cfg.size;\nconst a = n + 1;\nconst b = n - 1;\nmodule.exports = { a, b };\n" });
    const p = s.inlineVariable({ file: "v.js", name: "n" });
    assert.ok(p.ok);
    const t = out(p);
    assert.match(t, /const a = cfg\.size \+ 1;/);
    assert.match(t, /const b = cfg\.size - 1;/);
    assert.doesNotMatch(t, /const n =/);
  });

  it("refuses to duplicate a call-valued initializer across multiple uses", () => {
    const s = session({ "v.js": "const id = genId();\nconst a = id;\nconst b = id;\nmodule.exports = { a, b };\n" });
    const p = s.inlineVariable({ file: "v.js", name: "id" });
    assert.equal(p.ok, false);
    assert.match(p.safety.reasons[0], /side effect/);
  });

  it("force-inlines even a risky initializer", () => {
    const s = session({ "v.js": "const id = genId();\nconst a = id;\nconst b = id;\nmodule.exports = { a, b };\n" });
    const p = s.inlineVariable({ file: "v.js", name: "id", force: true });
    assert.ok(p.ok);
    assert.match(out(p), /const a = \(?genId\(\)\)?;/);
  });

  it("refuses when the variable is reassigned", () => {
    const s = session({ "v.js": "function f(){ let x = 1; x = 2; return x; }\n" });
    const p = s.inlineVariable({ file: "v.js", name: "x" });
    assert.equal(p.ok, false);
    assert.match(p.safety.reasons[0], /reassigned/);
  });
});

describe("inline — function", () => {
  it("inlines a simple arrow function at all call sites", () => {
    const s = session({ "g.js": "const add = (a, b) => a + b;\nconst z = add(1, 2) + add(x, y);\nmodule.exports = { z };\n" });
    const p = s.inlineFunction({ file: "g.js", name: "add" });
    assert.ok(p.ok, JSON.stringify(p.safety));
    const t = out(p);
    assert.match(t, /const z = \(1 \+ 2\) \+ \(x \+ y\);/);
    assert.doesNotMatch(t, /const add =/);
  });

  it("inlines a single-return function declaration", () => {
    const s = session({ "g.js": "function sq(n) { return n * n; }\nconst r = sq(k + 1);\nmodule.exports = { r };\n" });
    const p = s.inlineFunction({ file: "g.js", name: "sq" });
    assert.ok(p.ok);
    assert.match(out(p), /const r = \(\(k \+ 1\) \* \(k \+ 1\)\);/);
  });

  it("refuses to inline a multi-statement function", () => {
    const s = session({ "g.js": "function f(a) { const t = a + 1; return t * 2; }\nconst r = f(3);\n" });
    const p = s.inlineFunction({ file: "g.js", name: "f" });
    assert.equal(p.ok, false);
  });

  it("refuses to inline a recursive function", () => {
    const s = session({ "g.js": "const fac = (n) => n <= 1 ? 1 : n * fac(n - 1);\nconst r = fac(5);\n" });
    const p = s.inlineFunction({ file: "g.js", name: "fac" });
    assert.equal(p.ok, false);
    assert.match(p.safety.reasons[0], /recursive/);
  });

  it("refuses to inline a function using this", () => {
    const s = session({ "g.js": "function m() { return this.x; }\nconst r = m();\n" });
    const p = s.inlineFunction({ file: "g.js", name: "m" });
    assert.equal(p.ok, false);
  });
});
