"use strict";
// Integration tests over real temp projects: fromDir loading, dry-run preview, atomic
// apply, apply->verify->auto-revert (both success and failure), and rollback when a
// write cannot complete. Exercises the full stack onto codegraph + the patch engine.

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { mkProject, rmProject, read, refactor } = require("./fixture");

let dir;
afterEach(() => { if (dir) rmProject(dir); dir = null; });

describe("Refactorer.fromDir + preview", () => {
  it("loads a project from disk and previews without writing", () => {
    dir = mkProject({
      "util.js": "function readCfg(p){ return p; }\nmodule.exports = { readCfg };\n",
      "app.js": "const { readCfg } = require('./util');\nconsole.log(readCfg('x'));\n",
    });
    const r = refactor.fromDir(dir);
    const plan = r.rename({ oldName: "readCfg", newName: "readConfig" });
    const pv = r.preview(plan);
    assert.ok(pv.ok);
    assert.equal(pv.files.length, 2);
    assert.ok(pv.files.every((f) => /readConfig/.test(f.diff)));
    // Preview must not have touched disk.
    assert.match(read(dir, "util.js"), /readCfg/);
  });
});

describe("apply — atomic across files", () => {
  it("writes every file when safe", () => {
    dir = mkProject({
      "util.js": "export function readCfg(p){ return p; }\n",
      "app.js": "import { readCfg } from './util';\nexport const v = readCfg('x');\n",
    });
    const r = refactor.fromDir(dir);
    const plan = r.rename({ oldName: "readCfg", newName: "readConfig" });
    const res = r.apply(plan);
    assert.ok(res.ok && res.committed, JSON.stringify(res));
    assert.match(read(dir, "util.js"), /readConfig/);
    assert.match(read(dir, "app.js"), /import \{ readConfig \}/);
  });

  it("dryRun apply does not write", () => {
    dir = mkProject({ "a.js": "export const x = 1;\nexport const y = x + 1;\n" });
    const r = refactor.fromDir(dir);
    const plan = r.rename({ oldName: "x", newName: "base" });
    const res = r.apply(plan, { dryRun: true });
    assert.ok(res.ok && !res.committed);
    assert.match(read(dir, "a.js"), /export const x = 1/);
  });

  it("refuses to apply an unsafe plan", () => {
    dir = mkProject({ "a.js": "export const x = 1;\n" });
    const r = refactor.fromDir(dir);
    const plan = r.rename({ oldName: "x", newName: "1bad" });
    const res = r.apply(plan);
    assert.equal(res.ok, false);
    assert.ok(res.refused);
  });
});

describe("applyVerify — verify and auto-revert", () => {
  it("keeps the change when verification passes", () => {
    dir = mkProject({
      "util.js": "function add(a, b){ return a + b; }\nmodule.exports = { add };\n",
      "app.js": "const { add } = require('./util');\nif (add(1, 2) !== 3) process.exit(1);\n",
    });
    const r = refactor.fromDir(dir);
    const plan = r.rename({ oldName: "add", newName: "sum" });
    const verifyCmd = "node -e \"require('./app.js')\"";
    const res = r.applyVerify(plan, verifyCmd, { onDirty: "snapshot" });
    assert.ok(res.ok, JSON.stringify(res));
    assert.match(read(dir, "util.js"), /function sum/);
  });

  it("auto-reverts when verification fails", () => {
    dir = mkProject({
      "util.js": "function add(a, b){ return a + b; }\nmodule.exports = { add };\n",
    });
    const r = refactor.fromDir(dir);
    const plan = r.rename({ oldName: "add", newName: "sum" });
    const before = read(dir, "util.js");
    const res = r.applyVerify(plan, () => false, { onDirty: "snapshot" }); // always-failing verify
    assert.equal(res.ok, false);
    assert.equal(res.reverted, true);
    assert.equal(read(dir, "util.js"), before); // restored byte-for-byte
  });
});

describe("rollback — write failure restores all files", () => {
  it("restores every file when a mid-flight write throws", () => {
    dir = mkProject({
      "a.js": "export function thing(){ return 1; }\n",
      "b.js": "import { thing } from './a';\nexport const v = thing();\n",
    });
    const r = refactor.fromDir(dir);
    const plan = r.rename({ oldName: "thing", newName: "widget" });
    const beforeA = read(dir, "a.js");
    const beforeB = read(dir, "b.js");

    // Make b.js unwritable by replacing it with a directory at commit time to force a
    // write error, proving the checkpoint restores a.js.
    const tx = refactor.plan.toTransaction(plan, { cwd: dir });
    // Sabotage: remove b.js and create a directory in its place so writeFileSync throws.
    fs.unlinkSync(path.join(dir, "b.js"));
    fs.mkdirSync(path.join(dir, "b.js"));
    const res = tx.commit();
    assert.equal(res.ok, false);
    assert.equal(res.rolledBack, true);
    // a.js must be restored to its original content.
    assert.equal(read(dir, "a.js"), beforeA);
    void beforeB;
  });
});

describe("version/surface", () => {
  it("exposes the documented planners and helpers", () => {
    for (const k of ["planRename", "planExtract", "planInlineVariable", "planInlineFunction", "planMove", "planOrganizeImports", "Refactorer", "fromDir", "preview", "apply", "applyVerify"]) {
      assert.ok(refactor[k], "missing export: " + k);
    }
  });
});
