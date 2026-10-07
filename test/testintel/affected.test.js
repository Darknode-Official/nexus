"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const codegraph = require("../../src/codegraph");
const affected = require("../../src/testintel/affected");

function buildIndex() {
  return codegraph.indexFiles([
    { file: "src/calc.js", source: "export function add(a,b){return a+b;}\nexport function sub(a,b){return a-b;}" },
    { file: "src/util.js", source: "export function fmt(x){return String(x);}" },
    { file: "src/app.js", source: "import {add} from './calc.js';\nimport {fmt} from './util.js';\nexport function run(){return fmt(add(1,2));}" },
    { file: "test/calc.test.js", source: "import {add} from '../src/calc.js';\nimport {test} from 'node:test';\ntest('add',()=>{});" },
    { file: "test/util.test.js", source: "import {fmt} from '../src/util.js';\nimport {test} from 'node:test';\ntest('fmt',()=>{});" },
    { file: "test/app.test.js", source: "import {run} from '../src/app.js';\nimport {test} from 'node:test';\ntest('run',()=>{});" },
  ]);
}

describe("testintel/affected — selection via codegraph impact", () => {
  const index = buildIndex();

  it("selects only tests whose dependency closure touches the changed file", () => {
    const sel = affected.selectAffected(index, { changed: ["src/util.js"] });
    // util.js is imported by util.test.js directly and app.js (-> app.test.js transitively)
    assert.ok(sel.selected.includes("test/util.test.js"));
    assert.ok(sel.selected.includes("test/app.test.js"));
    assert.ok(!sel.selected.includes("test/calc.test.js"), "calc test must be skipped");
    assert.ok(sel.skippedFraction > 0);
  });

  it("reports why each test was selected", () => {
    const sel = affected.selectAffected(index, { changed: ["src/calc.js"] });
    assert.ok(sel.reasons["test/calc.test.js"].some((r) => /changed file/.test(r)));
  });

  it("includes a changed test file itself", () => {
    const sel = affected.selectAffected(index, { changed: ["test/calc.test.js"] });
    assert.ok(sel.selected.includes("test/calc.test.js"));
    assert.ok(sel.reasons["test/calc.test.js"].some((r) => /changed test file/.test(r)));
  });

  it("computes the skipped fraction honestly", () => {
    const sel = affected.selectAffected(index, { changed: ["src/calc.js"] });
    assert.equal(sel.total, 3);
    // calc change reaches calc.test and app.test (app imports calc), not util.test
    assert.ok(sel.selected.includes("test/calc.test.js"));
    assert.ok(sel.selected.includes("test/app.test.js"));
    assert.ok(!sel.selected.includes("test/util.test.js"));
    assert.equal(sel.skippedCount, 1);
  });

  it("selects nothing when the change is isolated from all tests", () => {
    const idx2 = codegraph.indexFiles([
      { file: "src/lonely.js", source: "export function x(){return 1;}" },
      { file: "test/other.test.js", source: "import {y} from '../src/other.js';\nimport {test} from 'node:test';\ntest('y',()=>{});" },
      { file: "src/other.js", source: "export function y(){return 2;}" },
    ]);
    const sel = affected.selectAffected(idx2, { changed: ["src/lonely.js"] });
    assert.deepEqual(sel.selected, []);
    assert.equal(sel.skippedFraction, 1);
  });

  it("symbol-level change tightens to tests that reach the symbol", () => {
    const sel = affected.selectAffected(index, { changedSymbols: [{ file: "src/calc.js", name: "add" }] });
    assert.ok(sel.selected.includes("test/calc.test.js"));
  });

  it("convention fallback catches name matches when imports are unresolved", () => {
    const idx3 = codegraph.indexFiles([
      { file: "src/parser.js", source: "export function parse(){}" },
      // test uses a dynamic require that codegraph can't statically resolve to the module
      { file: "test/parser.test.js", source: "const {test}=require('node:test');\nconst p=require(dynamicPath);\ntest('parse',()=>{});" },
    ]);
    const sel = affected.selectAffected(idx3, { changed: ["src/parser.js"] });
    assert.ok(sel.selected.includes("test/parser.test.js"));
    assert.ok(sel.reasons["test/parser.test.js"].some((r) => /name-convention/.test(r)));
  });
});

describe("testintel/affected — test map", () => {
  it("builds a forward closure of source deps per test", () => {
    const index = buildIndex();
    const map = affected.buildTestMap(index);
    const appTest = map.get("test/app.test.js");
    assert.ok(appTest.closure.has("src/app.js"));
    assert.ok(appTest.closure.has("src/calc.js"), "transitive dep via app.js");
    assert.ok(appTest.closure.has("src/util.js"));
  });
});
