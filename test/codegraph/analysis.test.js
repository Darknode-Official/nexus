"use strict";
// Tests for duplication/DRY detection and the "find existing implementation" API.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const dup = require("../../src/codegraph/duplication");
const { parseSource } = require("../../src/codegraph/parse");
const { buildSearchIndex, search, splitWords, paramCount } = require("../../src/codegraph/search");

describe("Code Graph — duplication detector", () => {
  it("normalizes tokens: identifiers -> V, numbers -> N, keywords kept", () => {
    const toks = dup.tokenize("const foo = 42 + bar;").map((t) => t.t);
    assert.ok(toks.includes("const") && toks.includes("V") && toks.includes("N"));
    assert.ok(!toks.includes("foo"), "identifier should be normalized");
  });

  it("detects Type-2 clones (renamed variables) with locations", () => {
    const a = 'function process(items) {\n  const out = [];\n  for (const it of items) {\n    if (it.ok) { out.push(it.v * 2); }\n  }\n  return out;\n}';
    const b = 'function transform(records) {\n  const result = [];\n  for (const rec of records) {\n    if (rec.ok) { result.push(rec.v * 2); }\n  }\n  return result;\n}';
    const r = dup.findDuplicates([{ file: "a.js", source: a, lang: "javascript" }, { file: "b.js", source: b, lang: "javascript" }], { k: 8, minTokens: 20 });
    assert.equal(r.clones.length, 1);
    const inst = r.clones[0].instances;
    assert.deepEqual(inst.map((i) => i.file).sort(), ["a.js", "b.js"]);
    assert.ok(r.clones[0].tokens >= 20);
  });

  it("does not flag genuinely different code", () => {
    const a = 'function sum(a, b) { return a + b; }';
    const b = 'const server = http.createServer((req, res) => res.end("hi"));';
    const r = dup.findDuplicates([{ file: "a.js", source: a, lang: "javascript" }, { file: "b.js", source: b, lang: "javascript" }], { k: 8, minTokens: 20 });
    assert.equal(r.clones.length, 0);
  });

  it("jaccard similarity of shingle sets is sane", () => {
    const s1 = dup.shingleSet("for (const x of y) { f(x); }", 4);
    const s2 = dup.shingleSet("for (const x of y) { f(x); }", 4);
    assert.equal(dup.jaccard(s1, s2), 1, "identical code -> 1.0");
    const s3 = dup.shingleSet("class Totally { different() {} }", 4);
    assert.ok(dup.jaccard(s1, s3) < 0.2);
  });
});

describe("Code Graph — find existing implementation", () => {
  const files = [
    parseSource('export function parseConfigFile(path) { return {}; }\nexport function writeOutput(data) {}\nexport const computeChecksum = (buf) => 0;', "io.js"),
    parseSource('export function validateEmail(addr) { return true; }\nexport class HttpClient { sendRequest(opts) {} get(url) {} }', "net.js"),
  ];
  const idx = buildSearchIndex(files);

  it("splits identifiers from camelCase and snake_case", () => {
    assert.deepEqual(splitWords("parseConfigFile"), ["parse", "config", "file"]);
    assert.deepEqual(splitWords("compute_check_sum"), ["compute", "check", "sum"]);
  });

  it("ranks the matching function first for a description", () => {
    const hits = search(idx, "parse config file");
    assert.ok(hits.length > 0);
    assert.equal(hits[0].name, "parseConfigFile");
  });

  it("finds methods by name and class", () => {
    const hits = search(idx, "send request");
    assert.equal(hits[0].name, "sendRequest");
    assert.equal(hits[0].parent, "HttpClient");
  });

  it("uses parameter count from a signature-shaped query", () => {
    assert.equal(paramCount("foo(a, b, c)"), 3);
    assert.equal(paramCount("bar()"), 0);
  });

  it("returns nothing for an unrelated query", () => {
    const hits = search(idx, "quantum blockchain hologram");
    assert.equal(hits.length, 0);
  });
});
