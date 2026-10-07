"use strict";
// Tests for the code-aware tokenizer: identifier splitting, operators, stop words,
// numerics and determinism.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const T = require("../../src/retrieval/tokenize");

describe("Retrieval — tokenizer: identifier splitting", () => {
  it("splits camelCase", () => {
    assert.deepEqual(T.splitIdentifier("parseConfigFile"), ["parse", "config", "file"]);
  });
  it("splits snake_case and kebab-case", () => {
    assert.deepEqual(T.splitIdentifier("compute_check_sum"), ["compute", "check", "sum"]);
    assert.deepEqual(T.splitIdentifier("render-home-view"), ["render", "home", "view"]);
  });
  it("splits an acronym followed by a word", () => {
    assert.deepEqual(T.splitIdentifier("parseHTTPResponse"), ["parse", "http", "response"]);
    assert.deepEqual(T.splitIdentifier("HTTPServer"), ["http", "server"]);
  });
  it("splits letter/digit boundaries", () => {
    assert.deepEqual(T.splitIdentifier("utf8Decoder"), ["utf", "8", "decoder"]);
    assert.deepEqual(T.splitIdentifier("base64"), ["base", "64"]);
  });
  it("handles empty / null input", () => {
    assert.deepEqual(T.splitIdentifier(""), []);
    assert.deepEqual(T.splitIdentifier(null), []);
  });
});

describe("Retrieval — tokenizer: token stream", () => {
  it("emits sub-words AND the collapsed full identifier for compound names", () => {
    const toks = T.tokenize("const parseConfig = 1");
    assert.ok(toks.includes("parse"));
    assert.ok(toks.includes("config"));
    assert.ok(toks.includes("parseconfig"), "collapsed identifier kept for exact-id queries");
  });
  it("does not emit a redundant full identifier for a single-word name", () => {
    const toks = T.tokenize("foo");
    assert.deepEqual(toks, ["foo"]);
  });
  it("keeps programming keywords (not treated as stop words)", () => {
    const toks = T.tokenize("class Foo extends Bar { async run() {} }");
    assert.ok(toks.includes("class"));
    assert.ok(toks.includes("async"));
    assert.ok(toks.includes("extends"));
  });
  it("drops natural-language stop words", () => {
    const toks = T.tokenize("the value of the item");
    assert.ok(!toks.includes("the"));
    assert.ok(!toks.includes("of"));
    assert.ok(toks.includes("value"));
    assert.ok(toks.includes("item"));
  });
  it("keeps multi-character operators when enabled", () => {
    const toks = T.tokenize("a === b && c => d");
    assert.ok(toks.includes("==="));
    assert.ok(toks.includes("&&"));
    assert.ok(toks.includes("=>"));
  });
  it("matches operators greedily (longest first)", () => {
    const toks = T.tokenize("x === y");
    assert.ok(toks.includes("==="), "=== not split into == and =");
    assert.ok(!toks.includes("=="));
  });
  it("can disable operator tokens", () => {
    const toks = T.tokenize("a === b", { keepOperators: false });
    assert.ok(!toks.includes("==="));
  });
  it("keeps short numerics but drops long digit runs", () => {
    const toks = T.tokenize("port 8080 id 1234567890123");
    assert.ok(toks.includes("8080"));
    assert.ok(!toks.includes("1234567890123"), "long digit run dropped as likely id/hash");
  });
  it("is deterministic", () => {
    const s = "function resolveImport(file, spec) { return spec; }";
    assert.deepEqual(T.tokenize(s), T.tokenize(s));
  });
  it("handles empty input", () => {
    assert.deepEqual(T.tokenize(""), []);
    assert.deepEqual(T.tokenize(null), []);
  });
});

describe("Retrieval — tokenizer: term frequencies & query terms", () => {
  it("counts repeated terms", () => {
    const tf = T.termFrequencies("path path path");
    assert.equal(tf.get("path"), 3);
  });
  it("query terms are unique in first-seen order", () => {
    assert.deepEqual(T.queryTerms("parse parse config file"), ["parse", "config", "file"]);
  });
});
