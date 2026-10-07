"use strict";
// Tests for the text utilities: EOL detection/round-trip, line split/join,
// normalization ladder, and similarity scoring.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const t = require("../../src/editformat/text");

describe("text.detectEOL / normalizeEOL / applyEOL", () => {
  it("detects LF, CRLF and CR", () => {
    assert.equal(t.detectEOL("a\nb\n"), "\n");
    assert.equal(t.detectEOL("a\r\nb\r\n"), "\r\n");
    assert.equal(t.detectEOL("a\rb\r"), "\r");
  });
  it("round-trips CRLF through normalize/apply", () => {
    const src = "a\r\nb\r\nc";
    const { text, eol } = t.normalizeEOL(src);
    assert.equal(text, "a\nb\nc");
    assert.equal(eol, "\r\n");
    assert.equal(t.applyEOL(text, eol), src);
  });
  it("defaults to LF for empty text", () => {
    assert.equal(t.detectEOL(""), "\n");
  });
});

describe("text.toLines / fromLines", () => {
  it("tracks the trailing-newline state", () => {
    assert.deepEqual(t.toLines("a\nb\n"), { lines: ["a", "b"], noEOL: false });
    assert.deepEqual(t.toLines("a\nb"), { lines: ["a", "b"], noEOL: true });
    assert.deepEqual(t.toLines(""), { lines: [], noEOL: false });
  });
  it("is the inverse of toLines", () => {
    for (const s of ["a\nb\n", "a\nb", "", "x\n"]) {
      const { lines, noEOL } = t.toLines(s);
      assert.equal(t.fromLines(lines, noEOL), s);
    }
  });
});

describe("text normalization helpers", () => {
  it("rstrip removes trailing whitespace", () => {
    assert.equal(t.rstrip("foo   \t"), "foo");
  });
  it("tabsToSpaces expands only leading whitespace", () => {
    assert.equal(t.tabsToSpaces("\tfoo\tbar", 4), "    foo\tbar");
  });
  it("stripIndent removes leading whitespace", () => {
    assert.equal(t.stripIndent("    foo"), "foo");
  });
  it("commonIndent ignores blank lines", () => {
    assert.equal(t.commonIndent(["    a", "", "      b"]), 4);
  });
});

describe("text.NORMALIZERS ladder", () => {
  it("escalates from exact to indent-insensitive", () => {
    const levels = t.NORMALIZERS.map((n) => n.level);
    assert.deepEqual(levels.slice(0, 4), ["exact", "trailing-ws", "tabs", "indent"]);
  });
  it("indent normalizer makes differently-indented lines equal", () => {
    const indent = t.NORMALIZERS.find((n) => n.level === "indent").fn;
    assert.equal(indent("    return x"), indent("\t\treturn x"));
  });
});

describe("text.similarity / blockSimilarity", () => {
  it("scores identical strings as 1 and disjoint as low", () => {
    assert.equal(t.similarity("abc", "abc"), 1);
    assert.ok(t.similarity("abc", "xyz") < 0.5);
  });
  it("blockSimilarity rewards near-identical blocks", () => {
    const a = ["const x = 1;", "return x;"];
    const b = ["const x = 1;", "return  x;"];
    assert.ok(t.blockSimilarity(a, b) > 0.9);
  });
});
