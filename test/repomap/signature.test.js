"use strict";
// Tests for signature extraction: compact, body-free declaration lines across
// JS/TS/Python/Go, multi-line signatures, and brace/colon-in-string robustness.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { extractSignature, topLevelColon } = require("../../src/repomap/signature");
const { parseSource } = require("../../src/codegraph/parse");

// Helper: parse a source, find a symbol by name, return its extracted signature.
function sigOf(source, file, name) {
  const rec = parseSource(source, file);
  const sym = (rec.symbols || []).find((s) => s.name === name);
  assert.ok(sym, "symbol not found: " + name);
  return extractSignature(source, sym, rec.lang);
}

describe("Repo Map — signature extraction (JavaScript/TypeScript)", () => {
  it("extracts a function declaration without its body", () => {
    const src = "export function parseConfig(path, opts) {\n  return readFileSync(path);\n}";
    assert.equal(sigOf(src, "a.js", "parseConfig"), "export function parseConfig(path, opts)");
  });

  it("keeps the arrow but drops the body for arrow functions", () => {
    const src = "const toArray = (x) => {\n  return [x];\n};";
    assert.equal(sigOf(src, "a.js", "toArray"), "const toArray = (x) =>");
  });

  it("captures class declarations with extends, no body", () => {
    const src = "export class HttpClient extends BaseClient {\n  get(url) {}\n}";
    assert.equal(sigOf(src, "a.js", "HttpClient"), "export class HttpClient extends BaseClient");
  });

  it("handles multi-line parameter lists", () => {
    const src = "function build(\n  a,\n  b,\n  c\n) {\n  return a;\n}";
    assert.equal(sigOf(src, "a.js", "build"), "function build( a, b, c )");
  });

  it("is not fooled by a brace inside a string on the signature line", () => {
    const src = 'function greet(name = "{world}") {\n  return name;\n}';
    const sig = sigOf(src, "a.js", "greet");
    assert.ok(sig.startsWith("function greet("), sig);
    assert.ok(!sig.includes("return"), "must not include body");
  });

  it("extracts a TypeScript method signature with a return type", () => {
    const src = "class Store {\n  find(id: string): Item | null {\n    return null;\n  }\n}";
    const sig = sigOf(src, "a.ts", "find");
    assert.ok(sig.includes("find(id: string)"), sig);
    assert.ok(!sig.includes("return null"), "no body");
  });
});

describe("Repo Map — signature extraction (Python)", () => {
  it("extracts a def signature up to the colon, no body", () => {
    const src = "def compute_score(items, weight=1.0):\n    return sum(items) * weight";
    assert.equal(sigOf(src, "a.py", "compute_score"), "def compute_score(items, weight=1.0)");
  });

  it("extracts a class signature with bases", () => {
    const src = "class Node(Base, Mixin):\n    def __init__(self):\n        pass";
    assert.equal(sigOf(src, "a.py", "Node"), "class Node(Base, Mixin)");
  });

  it("handles a multi-line python signature", () => {
    const src = "def long_fn(\n    a,\n    b,\n):\n    return a + b";
    assert.equal(sigOf(src, "a.py", "long_fn"), "def long_fn( a, b, )");
  });

  it("topLevelColon ignores colons inside brackets", () => {
    // first top-level colon is after the closing paren
    const masked = "def f(x: int, y: int)   :";
    const idx = topLevelColon(masked);
    assert.equal(masked[idx], ":");
    assert.ok(idx > masked.indexOf(")"));
  });
});

describe("Repo Map — signature extraction (Go)", () => {
  it("extracts a Go function signature", () => {
    const src = 'package main\n\nfunc Add(a int, b int) int {\n\treturn a + b\n}';
    const sig = sigOf(src, "a.go", "Add");
    assert.ok(sig.includes("func Add(a int, b int) int"), sig);
    assert.ok(!sig.includes("return"), "no body");
  });
});
