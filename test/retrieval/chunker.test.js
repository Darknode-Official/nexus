"use strict";
// Tests for the chunker: symbol-aware chunking, stable ids, line spans, preamble,
// oversized-symbol windowing, and the unknown-language sliding-window fallback.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const C = require("../../src/retrieval/chunker");

const SRC = [
  'const fs = require("fs");',           // 1  (preamble)
  'const path = require("path");',       // 2  (preamble)
  '',                                    // 3
  'function alpha(a) {',                 // 4  symbol alpha
  '  return a + 1;',                     // 5
  '}',                                   // 6
  '',                                    // 7
  'function beta(b) {',                  // 8  symbol beta
  '  return b * 2;',                     // 9
  '}',                                   // 10
].join("\n");

describe("Retrieval — chunker: symbol-aware", () => {
  const chunks = C.chunkFile("src/x.js", SRC);

  it("produces a preamble chunk for the import header", () => {
    const pre = chunks.find((c) => c.kind === "preamble");
    assert.ok(pre, "preamble chunk exists");
    assert.equal(pre.startLine, 1);
    assert.ok(pre.content.includes("require"));
  });
  it("produces one chunk per top-level symbol with correct spans", () => {
    const alpha = chunks.find((c) => c.name === "alpha");
    const beta = chunks.find((c) => c.name === "beta");
    assert.ok(alpha && beta);
    assert.equal(alpha.startLine, 4);
    assert.equal(beta.startLine, 8);
    assert.ok(alpha.content.includes("return a + 1"));
    assert.ok(beta.content.includes("return b * 2"));
  });
  it("gives stable, name-derived chunk ids", () => {
    const alpha = chunks.find((c) => c.name === "alpha");
    assert.equal(alpha.id, "src/x.js::alpha~0");
  });
  it("chunk ids are stable when code is inserted ABOVE a symbol", () => {
    const shifted = "// a new comment line\n// another\n" + SRC;
    const c2 = C.chunkFile("src/x.js", shifted);
    const alpha = c2.find((c) => c.name === "alpha");
    assert.equal(alpha.id, "src/x.js::alpha~0", "id unchanged despite line shift");
    assert.notEqual(alpha.startLine, 4, "but line span updates");
  });
  it("disambiguates repeated names with an ordinal", () => {
    const dup = 'function same(){return 1;}\nfunction same(){return 2;}\n';
    const cs = C.chunkFile("d.js", dup);
    const ids = cs.filter((c) => c.name === "same").map((c) => c.id);
    assert.deepEqual(ids, ["d.js::same~0", "d.js::same~1"]);
  });
});

describe("Retrieval — chunker: windowing", () => {
  it("sub-splits an oversized symbol into overlapping windows", () => {
    const body = Array.from({ length: 200 }, (_, i) => "  const v" + i + " = " + i + ";").join("\n");
    const big = "function huge() {\n" + body + "\n}\n";
    const cs = C.chunkFile("big.js", big, { maxLines: 50, windowLines: 40, overlapLines: 10 });
    const parts = cs.filter((c) => c.name === "huge");
    assert.ok(parts.length > 1, "oversized symbol split into multiple windows");
    assert.ok(parts.every((c) => c.id.includes("#w")), "window parts carry #w suffix");
    // windows cover contiguous, overlapping ranges
    assert.ok(parts[1].startLine < parts[0].endLine, "windows overlap");
  });
  it("falls back to sliding windows for unknown languages", () => {
    const text = Array.from({ length: 100 }, (_, i) => "line " + i).join("\n");
    const cs = C.chunkFile("notes.unknownext", text, { windowLines: 30, overlapLines: 5 });
    assert.ok(cs.length > 1);
    assert.ok(cs.every((c) => c.kind === "window"));
    assert.equal(cs[0].startLine, 1);
  });
  it("windowSpans respects size and overlap and covers the range", () => {
    const spans = C.windowSpans(1, 100, 40, 10);
    assert.equal(spans[0].startLine, 1);
    assert.equal(spans[0].endLine, 40);
    assert.equal(spans[1].startLine, 31); // step = size - overlap = 30
    assert.equal(spans[spans.length - 1].endLine, 100);
  });
  it("returns no chunks for empty source", () => {
    assert.deepEqual(C.chunkFile("e.js", ""), []);
  });
});
