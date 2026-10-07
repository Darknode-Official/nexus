"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { makeProject } = require("./tmputil");
const discovery = require("../../src/testintel/discovery");

describe("testintel/discovery — runner detection", () => {
  it("detects jest from devDependencies + test script", () => {
    const { root, cleanup } = makeProject({
      "package.json": JSON.stringify({ name: "x", scripts: { test: "jest" }, devDependencies: { jest: "^29" } }),
      "src/a.test.js": "test('a',()=>{});",
    });
    try {
      const r = discovery.detectRunners(root);
      assert.equal(r[0].runner, "jest");
      assert.ok(r[0].confidence > 0.6);
      assert.ok(r[0].evidence.some((e) => /devDependency/.test(e)));
    } finally { cleanup(); }
  });

  it("detects node:test when JS tests exist and no jest/mocha dep", () => {
    const { root, cleanup } = makeProject({
      "package.json": JSON.stringify({ name: "x", scripts: { test: "node --test" } }),
      "test/a.test.js": "const {test}=require('node:test'); test('a',()=>{});",
    });
    try {
      const r = discovery.detectRunners(root);
      assert.equal(r[0].runner, "node:test");
      assert.ok(r[0].confidence >= 0.9);
    } finally { cleanup(); }
  });

  it("detects pytest from config + test files", () => {
    const { root, cleanup } = makeProject({
      "pytest.ini": "[pytest]\n",
      "tests/test_calc.py": "def test_add():\n    assert 1+1==2\n",
    });
    try {
      const r = discovery.detectRunners(root);
      const py = r.find((x) => x.runner === "pytest");
      assert.ok(py, "pytest detected");
      assert.ok(py.evidence.some((e) => /pytest\.ini/.test(e)));
    } finally { cleanup(); }
  });

  it("detects go test from go.mod + *_test.go", () => {
    const { root, cleanup } = makeProject({
      "go.mod": "module example.com/x\n\ngo 1.21\n",
      "calc_test.go": "package main\nimport \"testing\"\nfunc TestAdd(t *testing.T){}\n",
    });
    try {
      const r = discovery.detectRunners(root);
      const go = r.find((x) => x.runner === "go test");
      assert.ok(go && go.confidence > 0.7);
    } finally { cleanup(); }
  });

  it("returns an empty list when nothing is detectable", () => {
    const { root, cleanup } = makeProject({ "README.md": "# hi" });
    try { assert.deepEqual(discovery.detectRunners(root), []); } finally { cleanup(); }
  });

  it("detects multiple runners in a polyglot repo, ranked by confidence", () => {
    const { root, cleanup } = makeProject({
      "package.json": JSON.stringify({ devDependencies: { mocha: "^10" }, scripts: { test: "mocha" } }),
      "test/x.spec.js": "describe('x',()=>{});",
      "go.mod": "module m\n",
      "m_test.go": "package m\nimport \"testing\"\nfunc TestX(t *testing.T){}\n",
    });
    try {
      const r = discovery.detectRunners(root);
      const names = r.map((x) => x.runner);
      assert.ok(names.includes("mocha"));
      assert.ok(names.includes("go test"));
      // sorted descending
      for (let i = 1; i < r.length; i++) assert.ok(r[i - 1].confidence >= r[i].confidence);
    } finally { cleanup(); }
  });
});

describe("testintel/discovery — file enumeration", () => {
  it("finds test files by convention and skips vendored dirs", () => {
    const { root, cleanup } = makeProject({
      "src/a.js": "module.exports={};",
      "src/a.test.js": "test('a',()=>{});",
      "test/b.test.js": "test('b',()=>{});",
      "node_modules/pkg/x.test.js": "should be skipped",
    });
    try {
      const files = discovery.discoverTestFiles(root, { runner: "node:test" });
      assert.ok(files.includes("src/a.test.js"));
      assert.ok(files.includes("test/b.test.js"));
      assert.ok(!files.some((f) => f.includes("node_modules")));
    } finally { cleanup(); }
  });

  it("isTestFile applies per-runner conventions", () => {
    assert.equal(discovery.isTestFile("src/x.test.js", "jest"), true);
    assert.equal(discovery.isTestFile("tests/test_x.py", "pytest"), true);
    assert.equal(discovery.isTestFile("x_test.go", "go test"), true);
    assert.equal(discovery.isTestFile("src/index.js", "node:test"), false);
  });
});
