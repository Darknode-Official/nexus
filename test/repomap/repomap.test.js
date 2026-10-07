"use strict";
// End-to-end tests for the repo map orchestrator on real fixture projects written
// to temp directories: ranking sanity, budget enforcement, personalization shifting
// ranks, exclusion, incremental cache reuse on file change, and the savings baseline.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const repomap = require("../../src/repomap");

// ---- fixture helpers ----
function mkproject(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "repomap-test-"));
  for (const rel of Object.keys(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, files[rel]);
  }
  return dir;
}
function rmproject(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }

// A small project where core.js is depended on by everything (should rank highest).
const PROJECT = {
  "src/core.js": "export function initCore(cfg) { return cfg; }\nexport function shutdownCore() {}\nexport class Engine { start() {} stop() {} }",
  "src/api.js": "import { initCore, Engine } from './core';\nexport function handleRequest(req) { const e = new Engine(); initCore(req); return e.start(); }",
  "src/db.js": "import { initCore } from './core';\nexport function connect() { return initCore({}); }\nexport function query(sql) { return sql; }",
  "src/util.js": "export function formatDate(d) { return String(d); }\nexport function slugify(s) { return s.toLowerCase(); }",
  "src/main.js": "import { handleRequest } from './api';\nimport { connect } from './db';\nconnect();\nhandleRequest({});",
};

describe("Repo Map — end to end (memory)", () => {
  it("ranks a heavily-depended-on module highly", () => {
    const r = repomap.repomapFromSources(PROJECT, { budget: 4000 });
    const top = r.files.map((f) => f.file);
    assert.equal(top[0], "src/core.js", "core.js should rank first; got " + top.join(", "));
  });

  it("emits signatures, not bodies", () => {
    const r = repomap.repomapFromSources(PROJECT, { budget: 4000 });
    assert.ok(r.map.includes("function initCore(cfg)"));
    assert.ok(!r.map.includes("return cfg"), "body must not appear in the map");
  });

  it("respects the token budget", () => {
    for (const budget of [100, 300, 800]) {
      const r = repomap.repomapFromSources(PROJECT, { budget });
      assert.ok(r.tokens <= budget, "budget " + budget + " exceeded: " + r.tokens);
    }
  });

  it("personalization (focus) shifts a file's rank upward", () => {
    const base = repomap.repomapFromSources(PROJECT, { budget: 4000 });
    const focused = repomap.repomapFromSources(PROJECT, { budget: 4000, focus: ["src/util.js"] });
    const baseUtil = base.files.find((f) => f.file === "src/util.js").score;
    const focUtil = focused.files.find((f) => f.file === "src/util.js").score;
    assert.ok(focUtil > baseUtil, "focus should raise util.js: " + focUtil + " vs " + baseUtil);
    assert.deepEqual(focused.focus.files, ["src/util.js"]);
  });

  it("focus by symbol name biases toward its defining file", () => {
    const base = repomap.repomapFromSources(PROJECT, { budget: 4000 });
    const focused = repomap.repomapFromSources(PROJECT, { budget: 4000, focus: ["slugify"] });
    const baseUtil = base.files.find((f) => f.file === "src/util.js").score;
    const focUtil = focused.files.find((f) => f.file === "src/util.js").score;
    assert.ok(focUtil > baseUtil);
    assert.deepEqual(focused.focus.symbols, ["slugify"]);
  });

  it("reports unmatched focus tokens", () => {
    const r = repomap.repomapFromSources(PROJECT, { budget: 4000, focus: ["does_not_exist_anywhere"] });
    assert.deepEqual(r.focus.unmatched, ["does_not_exist_anywhere"]);
  });

  it("exclude omits matching files from the output", () => {
    const r = repomap.repomapFromSources(PROJECT, { budget: 4000, exclude: ["src/util.js"] });
    assert.ok(!r.map.includes("formatDate"), "excluded file's symbols must not appear");
    assert.ok(!r.includedFiles.includes("src/util.js"));
  });

  it("includes multiple languages in one map", () => {
    const multi = {
      "a.js": "export function jsFn(x) {}",
      "b.py": "def py_fn(x):\n    return x",
      "c.go": "package main\nfunc GoFn(a int) int { return a }",
    };
    const r = repomap.repomapFromSources(multi, { budget: 4000 });
    assert.ok(r.map.includes("jsFn"));
    assert.ok(r.map.includes("py_fn"));
    assert.ok(r.map.includes("GoFn"));
  });
});

describe("Repo Map — end to end (disk + incremental cache)", () => {
  let dir, cacheFile;
  before(() => {
    dir = mkproject(PROJECT);
    cacheFile = path.join(dir, ".nexus-repomap.json");
  });
  after(() => rmproject(dir));

  it("builds from a directory and fits the budget", () => {
    const r = repomap.repomap(dir, { budget: 1000, cacheFile });
    assert.ok(r.tokens <= 1000);
    assert.equal(r.meta.mode, "disk");
    assert.ok(r.meta.fresh > 0);
  });

  it("reuses cached extractions on an unchanged rebuild", () => {
    const r = repomap.repomap(dir, { budget: 1000, cacheFile });
    assert.ok(r.meta.reused > 0, "expected cache reuse");
    assert.equal(r.meta.fresh, 0, "nothing changed: no fresh extraction");
  });

  it("re-extracts only the changed file after an edit", () => {
    // Give the edited file a distinctly new mtime/size.
    const target = path.join(dir, "src/util.js");
    fs.writeFileSync(target, "export function formatDate(d) { return String(d); }\nexport function slugify(s) { return s; }\nexport function brandNewSymbol() { return 1; }\n");
    const r = repomap.repomap(dir, { budget: 2000, cacheFile });
    assert.equal(r.meta.fresh, 1, "only the edited file should be re-extracted");
    assert.ok(r.meta.reused >= 4);
    // the new symbol must now be discoverable in the ranking
    assert.ok(r.symbols.some((s) => s.name === "brandNewSymbol"));
  });

  it("prunes cache entries for deleted files", () => {
    fs.rmSync(path.join(dir, "src/util.js"));
    const r = repomap.repomap(dir, { budget: 2000, cacheFile });
    assert.ok(!r.files.some((f) => f.file === "src/util.js"));
  });
});

describe("Repo Map — savings baseline", () => {
  let dir;
  before(() => { dir = mkproject(PROJECT); });
  after(() => rmproject(dir));

  it("the map is far smaller than full source", () => {
    const base = repomap.fullSourceTokens(dir);
    const r = repomap.repomap(dir, { budget: 2000 });
    assert.ok(base.sourceTokens > 0);
    assert.ok(r.tokens < base.sourceTokens, "map should be smaller than full source");
  });

  it("register() attaches a bound API to a context object", () => {
    const ctx = {};
    const api = repomap.register(ctx, { model: "claude" });
    assert.ok(ctx.repomap === api);
    const r = ctx.repomap.mapSources(PROJECT, { budget: 1000 });
    assert.ok(r.tokens <= 1000);
    assert.equal(r.meta.model, "claude");
  });
});
