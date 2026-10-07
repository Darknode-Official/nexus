"use strict";
// Tests for the tokenizer/masker — the foundation that makes every parser robust.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { mask, lineIndex, locAt } = require("../../src/codegraph/tokenizer");

describe("Code Graph — tokenizer.mask", () => {
  it("preserves length and newlines exactly", () => {
    const src = 'const x = "hello\\nworld";\n// comment\nfoo();';
    const { masked } = mask(src, "javascript");
    assert.equal(masked.length, src.length, "length must be identical");
    assert.equal((masked.match(/\n/g) || []).length, (src.match(/\n/g) || []).length);
  });

  it("blanks string contents so keywords inside strings are not seen", () => {
    const { masked } = mask('const s = "function fake() {}";', "javascript");
    assert.ok(!/function/.test(masked), "keyword inside string must be masked");
    assert.ok(/const s =/.test(masked), "code outside the string survives");
  });

  it("blanks line and block comments", () => {
    const { masked } = mask("a(); // function g(){}\n/* class H {} */ b();", "javascript");
    assert.ok(!/function/.test(masked) && !/class/.test(masked));
    assert.ok(/a\(\);/.test(masked) && /b\(\);/.test(masked));
  });

  it("does not treat // inside a string as a comment", () => {
    const { masked } = mask('const u = "http://x"; realCode();', "javascript");
    assert.ok(/realCode\(\)/.test(masked), "code after the string must remain");
  });

  it("handles python triple-quoted docstrings", () => {
    const { masked } = mask('def f():\n    """def g(): class H: pass"""\n    return 1', "python");
    assert.ok(/def f\(\):/.test(masked));
    assert.ok(!/def g/.test(masked) && !/class H/.test(masked), "docstring content masked");
  });

  it("handles go raw strings and ruby =begin blocks", () => {
    const go = mask("var s = `func fake() {}`\nreal()", "go").masked;
    assert.ok(!/func fake/.test(go) && /real\(\)/.test(go));
    const rb = mask("=begin\ndef hidden; end\n=end\ndef shown; end", "ruby").masked;
    assert.ok(!/hidden/.test(rb) && /shown/.test(rb));
  });

  it("keepStrings preserves string contents but still skips comments", () => {
    const { masked } = mask('import x from "./mod"; // from "./fake"', "javascript", { keepStrings: true });
    assert.ok(/"\.\/mod"/.test(masked), "real specifier kept");
    assert.ok(!/fake/.test(masked), "commented specifier removed");
  });
});

describe("Code Graph — tokenizer offsets", () => {
  it("locAt maps offsets to 1-based line/col", () => {
    const text = "a\nbb\nccc";
    const starts = lineIndex(text);
    assert.deepEqual(locAt(starts, 0), { line: 1, col: 1 });
    assert.deepEqual(locAt(starts, 2), { line: 2, col: 1 });
    assert.deepEqual(locAt(starts, 5), { line: 3, col: 1 });
    assert.deepEqual(locAt(starts, 7), { line: 3, col: 3 });
  });
});
