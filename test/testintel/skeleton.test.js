"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const codegraph = require("../../src/codegraph");
const skeleton = require("../../src/testintel/skeleton");

function index() {
  return codegraph.indexFiles([
    { file: "src/calc.js", source: "export function add(a, b){return a+b;}\nexport function subtract(a, b){return a-b;}" },
    { file: "test/calc.test.js", source: "import {add} from '../src/calc.js';\nimport {test} from 'node:test';\ntest('add',()=>{});" },
    { file: "src/str.py", source: "def shout(text):\n    return text.upper()\n" },
  ]);
}

describe("testintel/skeleton — untested function detection via codegraph", () => {
  it("flags functions no test references, and spares tested ones", () => {
    const fns = skeleton.untestedFunctions(index());
    const names = fns.map((f) => f.name);
    assert.ok(names.includes("subtract"), "subtract has no test");
    assert.ok(!names.includes("add"), "add is referenced by calc.test.js");
    assert.ok(names.includes("shout"), "python func untested");
  });
  it("does not suggest tests for test files themselves", () => {
    const fns = skeleton.untestedFunctions(index());
    assert.ok(!fns.some((f) => f.file.includes(".test.")));
  });
});

describe("testintel/skeleton — generation", () => {
  const fn = { name: "subtract", file: "src/calc.js", params: ["a", "b"], exported: true, lang: "javascript" };
  it("generates a node:test skeleton with arrange/act/assert and a correct relative import", () => {
    const sk = skeleton.suggestSkeleton(fn, { framework: "node:test" });
    assert.equal(sk.framework, "node:test");
    assert.match(sk.code, /require\("node:test"\)/);
    assert.match(sk.code, /const \{ subtract \} = require\("\.\/calc"\)/);
    assert.match(sk.code, /\/\/ Arrange/);
    assert.match(sk.code, /\/\/ Act/);
    assert.match(sk.code, /\/\/ Assert/);
    assert.match(sk.code, /subtract\(/);
  });
  it("generates a jest skeleton with describe/expect", () => {
    const sk = skeleton.suggestSkeleton(fn, { framework: "jest" });
    assert.match(sk.code, /describe\("subtract"/);
    assert.match(sk.code, /expect\(actual\)/);
  });
  it("generates a pytest skeleton importing the module", () => {
    const sk = skeleton.suggestSkeleton({ name: "shout", file: "src/str.py", params: ["text"], lang: "python" }, {});
    assert.equal(sk.framework, "pytest");
    assert.match(sk.code, /import str/);
    assert.match(sk.code, /def test_shout_happy_path/);
    assert.match(sk.code, /assert actual ==/);
  });
  it("generates a go test skeleton", () => {
    const sk = skeleton.suggestSkeleton({ name: "add", file: "calc.go", params: ["a", "b"], lang: "go" }, { pkg: "calc" });
    assert.match(sk.code, /func TestAdd\(t \*testing\.T\)/);
    assert.match(sk.code, /t\.Errorf/);
  });
  it("derives edge-case prompts from parameter names", () => {
    const cases = skeleton.edgeCases({ params: ["items", "name", "count"], async: false });
    assert.ok(cases.some((c) => /empty array/.test(c)));
    assert.ok(cases.some((c) => /empty string/.test(c)));
    assert.ok(cases.some((c) => /0, negative/.test(c)));
  });
  it("emitted JS skeleton is syntactically valid JavaScript", () => {
    const vm = require("vm");
    const sk = skeleton.suggestSkeleton(fn, { framework: "jest" });
    // compiling the source proves it parses; we don't execute it.
    assert.doesNotThrow(() => new vm.Script(sk.code));
  });
});

describe("testintel/skeleton — parameter recovery from source", () => {
  // Disk indexes carry `abs`, so the suggester can read the source to recover params
  // that codegraph records only for methods. This mirrors real CLI usage.
  const { makeProject } = require("./tmputil");
  it("recovers params for top-level JS functions and arrows", () => {
    const { root, cleanup } = makeProject({ "src/m.js": "export function add(a, b){return a+b;}\nexport const mul = (x, y) => x*y;" });
    try {
      const idx = codegraph.indexDirectory(root, { cacheFile: null });
      const fns = skeleton.untestedFunctions(idx);
      assert.deepEqual(fns.find((f) => f.name === "add").params, ["a", "b"]);
      assert.deepEqual(fns.find((f) => f.name === "mul").params, ["x", "y"]);
    } finally { cleanup(); }
  });
  it("recovers python def params and drops self", () => {
    const { root, cleanup } = makeProject({ "svc.py": "def handle(self, request, timeout):\n    return request\n" });
    try {
      const idx = codegraph.indexDirectory(root, { cacheFile: null });
      const h = skeleton.untestedFunctions(idx).find((f) => f.name === "handle");
      assert.deepEqual(h.params, ["request", "timeout"]);
    } finally { cleanup(); }
  });
});

describe("testintel/skeleton — suggestForFile", () => {
  it("returns skeletons only for untested functions in the target file", () => {
    const items = skeleton.suggestForFile(index(), "src/calc.js", { framework: "node:test" });
    assert.equal(items.length, 1);
    assert.equal(items[0].fn.name, "subtract");
  });
});
