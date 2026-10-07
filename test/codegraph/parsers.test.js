"use strict";
// Tests for the multi-language symbol parsers (JS/TS, Python, Go, Ruby).
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { parseSource, detectLang, supported } = require("../../src/codegraph/parse");

const names = (syms, kind) => syms.filter((s) => !kind || s.kind === kind).map((s) => s.name);
const find = (syms, name) => syms.find((s) => s.name === name);

describe("Code Graph — parser dispatch", () => {
  it("detects languages by extension", () => {
    assert.equal(detectLang("a.ts"), "typescript");
    assert.equal(detectLang("a.py"), "python");
    assert.equal(detectLang("a.go"), "go");
    assert.equal(detectLang("a.rb"), "ruby");
    assert.equal(detectLang("a.txt"), null);
  });
  it("reports supported files", () => {
    assert.ok(supported("x.jsx") && supported("x.mjs") && supported("x.tsx"));
    assert.ok(!supported("x.md"));
  });
});

describe("Code Graph — JavaScript/TypeScript parser", () => {
  const src = `
import defaultThing, { a, b as bb } from "./dep.js";
import * as ns from "./all.js";
const legacy = require("./legacy");
export function compute(x, y) { return x + y; }
export const arrow = async (z) => z;
let helper = function () { return 1; };
export class Service extends Base {
  constructor() { super(); }
  async handle(req) { if (req) { return req; } for (const k of req) {} }
  static create() { return new Service(); }
  #secret() { return 42; }
}
export { arrow as publicArrow };
export * from "./reexport.js";
module.exports.cjsThing = 1;
`;
  const r = parseSource(src, "mod.ts");

  it("extracts functions incl. arrows and function-expressions", () => {
    const fns = names(r.symbols, "function");
    assert.ok(fns.includes("compute") && fns.includes("arrow") && fns.includes("helper"));
  });
  it("extracts classes with extends", () => {
    const svc = find(r.symbols, "Service");
    assert.equal(svc.kind, "class");
    assert.equal(svc.extends, "Base");
  });
  it("extracts methods via scope tracking (not control-flow keywords)", () => {
    const methods = r.symbols.filter((s) => s.kind === "method" && s.parent === "Service").map((s) => s.name);
    assert.ok(methods.includes("handle") && methods.includes("create") && methods.includes("constructor"));
    assert.ok(!methods.includes("if") && !methods.includes("for"), "control flow is not a method");
  });
  it("extracts ESM, namespace and CommonJS imports", () => {
    const esm = r.imports.find((i) => i.source === "./dep.js");
    assert.equal(esm.default, "defaultThing");
    assert.deepEqual(esm.names, [{ imported: "a", local: "a" }, { imported: "b", local: "bb" }]);
    assert.ok(r.imports.find((i) => i.namespace === "ns"));
    assert.ok(r.imports.find((i) => i.kind === "require" && i.source === "./legacy"));
  });
  it("extracts named, aliased, re-export and cjs exports", () => {
    const exp = r.exports.map((e) => e.name);
    assert.ok(exp.includes("compute") && exp.includes("publicArrow"));
    assert.ok(r.exports.find((e) => e.kind === "reexport-all" && e.source === "./reexport.js"));
    assert.ok(r.exports.find((e) => e.kind === "cjs" && e.name === "cjsThing"));
  });
  it("records accurate line numbers", () => {
    assert.equal(find(r.symbols, "compute").line, 5);
  });
});

describe("Code Graph — Python parser", () => {
  const src = `
import os, sys
from .utils import helper, thing as t
from pkg.mod import (alpha,
    beta)
class Dog(Animal, Mixin):
    """class Fake: def fake(): pass"""
    def bark(self):
        def inner():
            return 1
        return inner
def top_level():
    return 2
def _hidden():
    return 3
__all__ = ["top_level", "Dog"]
`;
  const r = parseSource(src, "zoo.py");
  it("extracts classes with bases and methods", () => {
    const dog = find(r.symbols, "Dog");
    assert.equal(dog.kind, "class");
    assert.deepEqual(dog.bases, ["Animal", "Mixin"]);
    assert.equal(find(r.symbols, "bark").kind, "method");
    assert.equal(find(r.symbols, "bark").parent, "Dog");
  });
  it("treats a def nested in a def as a function, not a method", () => {
    assert.equal(find(r.symbols, "inner").kind, "function");
    assert.equal(find(r.symbols, "inner").parent, null);
  });
  it("ignores keywords inside docstrings", () => {
    assert.ok(!find(r.symbols, "fake"), "docstring content must not parse");
  });
  it("parses import, from-import, aliases and multi-line parens", () => {
    assert.ok(r.imports.find((i) => i.source === "os"));
    const fromU = r.imports.find((i) => i.source === ".utils");
    assert.deepEqual(fromU.names, [{ imported: "helper", local: "helper" }, { imported: "thing", local: "t" }]);
    const multi = r.imports.find((i) => i.source === "pkg.mod");
    assert.deepEqual(multi.names.map((n) => n.imported), ["alpha", "beta"]);
  });
  it("uses __all__ for exports", () => {
    assert.deepEqual(r.exports.map((e) => e.name).sort(), ["Dog", "top_level"]);
  });
});

describe("Code Graph — Go parser", () => {
  const src = `
package svc
import (
    "fmt"
    m "math"
)
import "strings"
type Shape struct { x int }
type Reader interface { Read() int }
type Celsius float64
func (s *Shape) Area() int { return s.x }
func (s Shape) small() int { return 0 }
func Compute(a, b int) int { return a + b }
func helper() {}
`;
  const r = parseSource(src, "svc.go");
  it("extracts functions, methods with receivers, and types", () => {
    assert.equal(find(r.symbols, "Compute").kind, "function");
    const area = find(r.symbols, "Area");
    assert.equal(area.kind, "method");
    assert.equal(area.parent, "Shape");
    assert.equal(find(r.symbols, "Shape").kind, "class");
    assert.equal(find(r.symbols, "Shape").goKind, "struct");
    assert.equal(find(r.symbols, "Celsius").kind, "type");
  });
  it("marks exported by capitalization", () => {
    assert.equal(find(r.symbols, "Compute").exported, true);
    assert.equal(find(r.symbols, "helper").exported, false);
    assert.equal(find(r.symbols, "small").exported, false);
  });
  it("parses block and single imports with aliases", () => {
    assert.ok(r.imports.find((i) => i.source === "fmt"));
    assert.ok(r.imports.find((i) => i.source === "math" && i.alias === "m"));
    assert.ok(r.imports.find((i) => i.source === "strings"));
  });
});

describe("Code Graph — Ruby parser", () => {
  const src = `
require "set"
require_relative "./helper"
module Animals
  class Dog < Pet
    def bark; "woof"; end
    def fetch
      1
    end
  end
end
def toplevel
  x = 1 if true
  2
end
`;
  const r = parseSource(src, "zoo.rb");
  it("extracts modules, classes with superclass, and methods", () => {
    assert.equal(find(r.symbols, "Animals").kind, "class");
    const dog = find(r.symbols, "Dog");
    assert.equal(dog.parent, "Animals");
    assert.equal(dog.extends, "Pet");
    assert.equal(find(r.symbols, "bark").kind, "method");
    assert.equal(find(r.symbols, "bark").parent, "Dog");
  });
  it("treats trailing modifier-if as not opening a scope", () => {
    // toplevel is a free function; fetch/bark remain methods of Dog
    assert.equal(find(r.symbols, "toplevel").kind, "function");
    assert.equal(find(r.symbols, "fetch").parent, "Dog");
  });
  it("parses require and require_relative", () => {
    assert.ok(r.imports.find((i) => i.source === "set" && i.kind === "require"));
    assert.ok(r.imports.find((i) => i.source === "./helper" && i.kind === "require_relative"));
  });
});
