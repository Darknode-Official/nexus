"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { makeProject } = require("./tmputil");
const cli = require("../../src/testintel/cli");

// Capture stdout produced by cli.main() for a given argv.
async function capture(argv) {
  const orig = process.stdout.write.bind(process.stdout);
  let buf = "";
  process.stdout.write = (chunk) => { buf += chunk; return true; };
  let code;
  try { code = await cli.main(argv); } finally { process.stdout.write = orig; }
  return { code, out: buf };
}

describe("testintel/cli", () => {
  it("detect prints detected runners (text)", async () => {
    const { root, cleanup } = makeProject({
      "package.json": JSON.stringify({ scripts: { test: "node --test" } }),
      "test/a.test.js": "const {test}=require('node:test');test('a',()=>{});",
    });
    try {
      const { code, out } = await capture(["detect", root]);
      assert.equal(code, 0);
      assert.match(out, /node:test/);
    } finally { cleanup(); }
  });

  it("affected --json reports selection", async () => {
    const { root, cleanup } = makeProject({
      "src/calc.js": "export function add(a,b){return a+b;}",
      "src/util.js": "export function fmt(x){return String(x);}",
      "test/calc.test.js": "import {add} from '../src/calc.js';\nimport {test} from 'node:test';\ntest('a',()=>{});",
      "test/util.test.js": "import {fmt} from '../src/util.js';\nimport {test} from 'node:test';\ntest('b',()=>{});",
    });
    try {
      const { code, out } = await capture(["affected", root, "--changed", "src/calc.js", "--json"]);
      assert.equal(code, 0);
      const data = JSON.parse(out);
      assert.ok(data.selected.includes("test/calc.test.js"));
      assert.ok(!data.selected.includes("test/util.test.js"));
      assert.ok(data.skippedFraction > 0);
    } finally { cleanup(); }
  });

  it("skeleton --json lists untested functions", async () => {
    const { root, cleanup } = makeProject({
      "src/calc.js": "export function add(a,b){return a+b;}\nexport function mul(a,b){return a*b;}",
      "test/calc.test.js": "import {add} from '../src/calc.js';\nimport {test} from 'node:test';\ntest('a',()=>{});",
    });
    try {
      const { code, out } = await capture(["skeleton", root, "--json"]);
      assert.equal(code, 0);
      const data = JSON.parse(out);
      const names = data.functions.map((f) => f.name);
      assert.ok(names.includes("mul"));
      assert.ok(!names.includes("add"));
    } finally { cleanup(); }
  });

  it("coverage parses a file and reports uncovered changed lines", async () => {
    const { root, cleanup } = makeProject({
      "lcov.info": "SF:src/x.js\nDA:1,1\nDA:2,0\nDA:3,0\nend_of_record\n",
    });
    try {
      const { code, out } = await capture(["coverage", root + "/lcov.info", "--changed-lines", "src/x.js:1-3", "--json"]);
      assert.equal(code, 0);
      const data = JSON.parse(out);
      assert.deepEqual(data.uncoveredChanged.uncovered["src/x.js"], [2, 3]);
    } finally { cleanup(); }
  });

  it("unknown command returns a nonzero code with help", async () => {
    const { code } = await capture(["frobnicate"]);
    assert.equal(code, 2);
  });
});
