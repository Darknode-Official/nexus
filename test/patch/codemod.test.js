"use strict";
// Tests for structured codemods: identifier awareness (no string/comment damage),
// word boundaries, call wrapping with paren balancing, previews, and atomic file runs.

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const codemod = require("../../src/patch/codemod");
const { mkTmp, rmTmp, write, read } = require("./tmputil");

describe("codemod.codeMask", () => {
  it("marks string and comment regions as non-code", () => {
    const src = 'const x = "foo"; // bar\nconst y = foo;';
    const mask = codemod.codeMask(src);
    const idx = src.indexOf('"foo"') + 1; // inside the string
    assert.equal(mask[idx], false);
    const idx2 = src.indexOf("// bar") + 2; // inside the comment
    assert.equal(mask[idx2], false);
    const idx3 = src.lastIndexOf("foo"); // the real identifier
    assert.equal(mask[idx3], true);
  });
});

describe("codemod.renameIdentifier", () => {
  it("renames whole-word identifiers in code only", () => {
    const src = [
      "function total(items) {",
      "  // total is the sum",
      '  const label = "total count";',
      "  return total_count + items.total;", // total_count must NOT match; items.total SHOULD
      "}",
    ].join("\n");
    const r = codemod.renameIdentifier(src, "total", "sum");
    assert.ok(r.text.includes("function sum(items)"));
    assert.ok(r.text.includes("// total is the sum"), "comment untouched");
    assert.ok(r.text.includes('"total count"'), "string literal untouched");
    assert.ok(r.text.includes("total_count"), "longer identifier untouched");
    assert.ok(r.text.includes("items.sum"), "member access renamed");
  });

  it("reports change locations", () => {
    const r = codemod.renameIdentifier("foo + foo\n", "foo", "bar");
    assert.equal(r.changes.length, 2);
    assert.equal(r.changes[0].line, 1);
  });

  it("does not touch substrings of larger identifiers", () => {
    const r = codemod.renameIdentifier("foobar fooBaz foo\n", "foo", "X");
    assert.equal(r.text, "foobar fooBaz X\n");
  });
});

describe("codemod.wrapCalls", () => {
  it("wraps a call and balances nested parens", () => {
    const src = "const r = fetch(url, opts(a, b));\n";
    const r = codemod.wrapCalls(src, "fetch", "traced");
    assert.equal(r.text, "const r = traced(fetch(url, opts(a, b)));\n");
    assert.equal(r.changes.length, 1);
  });

  it("ignores matches inside strings/comments and non-call identifiers", () => {
    const src = 'const s = "fetch(x)"; // fetch(y)\nconst z = fetch;\n';
    const r = codemod.wrapCalls(src, "fetch", "traced");
    assert.equal(r.text, src, "no real call site -> unchanged");
  });

  it("wraps multiple call sites", () => {
    const src = "f(1); f(2); f(3);\n";
    const r = codemod.wrapCalls(src, "f", "w");
    assert.equal(r.text, "w(f(1)); w(f(2)); w(f(3));\n");
    assert.equal(r.changes.length, 3);
  });
});

describe("codemod.replaceLiteral", () => {
  it("replaces code-only when codeOnly is set", () => {
    const src = 'x = OLD; s = "OLD";\n';
    const r = codemod.replaceLiteral(src, "OLD", "NEW", { codeOnly: true, wholeWord: true });
    assert.equal(r.text, 'x = NEW; s = "OLD";\n');
  });

  it("respects wholeWord", () => {
    const r = codemod.replaceLiteral("cat category\n", "cat", "dog", { wholeWord: true });
    assert.equal(r.text, "dog category\n");
  });
});

describe("codemod.preview", () => {
  it("produces a unified diff of the transform", () => {
    const before = "a\nfoo\nb\n";
    const after = codemod.renameIdentifier(before, "foo", "bar").text;
    const d = codemod.preview(before, after, "f.js");
    assert.match(d, /-foo/);
    assert.match(d, /\+bar/);
  });
});

describe("codemod.runOnFiles", () => {
  let dir;
  beforeEach(() => { dir = mkTmp(); });
  afterEach(() => { rmTmp(dir); });

  it("applies a codemod across files atomically", () => {
    const f1 = write(dir, "a.js", "const foo = 1; use(foo);\n");
    const f2 = write(dir, "b.js", "import foo from 'x';\nfoo();\n");
    const res = codemod.runOnFiles([f1, f2], (t) => codemod.renameIdentifier(t, "foo", "bar"), { cwd: dir });
    assert.ok(res.ok);
    assert.equal(res.changedFiles.length, 2);
    assert.ok(read(f1).includes("const bar = 1"));
    assert.ok(read(f2).includes("bar()"));
  });

  it("dry run reports diffs without writing", () => {
    const f1 = write(dir, "a.js", "const foo = 1;\n");
    const res = codemod.runOnFiles([f1], (t) => codemod.renameIdentifier(t, "foo", "bar"), { cwd: dir, dryRun: true });
    assert.ok(res.dryRun);
    assert.equal(res.changedFiles.length, 1);
    assert.equal(read(f1), "const foo = 1;\n", "dry run must not write");
  });

  it("skips files the codemod does not change", () => {
    const f1 = write(dir, "a.js", "nothing here\n");
    const res = codemod.runOnFiles([f1], (t) => codemod.renameIdentifier(t, "foo", "bar"), { cwd: dir });
    assert.ok(res.ok);
    assert.equal(res.changedFiles.length, 0);
  });
});
