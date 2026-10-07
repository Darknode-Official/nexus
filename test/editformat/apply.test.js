"use strict";
// Tests for the application layer against a real temp directory: atomic multi-file
// commit, all-or-nothing rollback when one block is bad, dry-run preview writes
// nothing, create/delete on disk, and apply -> verify -> revert.

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { mkTmp, rmTmp, write, read } = require("./tmputil");
const ef = require("../../src/editformat");

let dir;
beforeEach(() => { dir = mkTmp(); });
afterEach(() => { rmTmp(dir); });

function sr(file, search, replace) {
  return `${file}\n<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE`;
}

describe("applyEdits — atomic multi-file", () => {
  it("commits several files together", () => {
    write(dir, "a.js", "let x = 1;\n");
    write(dir, "b.js", "const z = 3;\n");
    const msg = sr("a.js", "let x = 1;", "let x = 10;") + "\n\n" + sr("b.js", "const z = 3;", "const z = 30;");
    const r = ef.applyModelOutput(msg, { cwd: dir });
    assert.ok(r.ok);
    assert.equal(r.written.length, 2);
    assert.equal(read(path.join(dir, "a.js")), "let x = 10;\n");
    assert.equal(read(path.join(dir, "b.js")), "const z = 30;\n");
  });

  it("writes nothing when any one block cannot be placed", () => {
    write(dir, "a.js", "let x = 1;\n");
    write(dir, "b.js", "const z = 3;\n");
    const msg = sr("a.js", "let x = 1;", "let x = 10;") + "\n\n" + sr("b.js", "const z = 999;", "const z = 30;");
    const r = ef.applyModelOutput(msg, { cwd: dir });
    assert.equal(r.ok, false);
    assert.equal(r.phase, "validate");
    // Neither file changed.
    assert.equal(read(path.join(dir, "a.js")), "let x = 1;\n");
    assert.equal(read(path.join(dir, "b.js")), "const z = 3;\n");
  });
});

describe("applyEdits — dry run", () => {
  it("produces a preview and writes nothing", () => {
    write(dir, "a.js", "let x = 1;\n");
    const r = ef.applyModelOutput(sr("a.js", "let x = 1;", "let x = 2;"), { cwd: dir, dryRun: true });
    assert.ok(r.ok);
    assert.equal(r.phase, "preview");
    assert.equal(r.preview.files[0].action, "modify");
    assert.match(r.preview.files[0].diff, /-let x = 1;/);
    assert.equal(read(path.join(dir, "a.js")), "let x = 1;\n"); // untouched
  });
});

describe("applyEdits — create & delete on disk", () => {
  it("creates a new file", () => {
    const r = ef.applyModelOutput("new.js\n<<<<<<< SEARCH\n=======\nconsole.log(1);\n>>>>>>> REPLACE", { cwd: dir });
    assert.ok(r.ok);
    assert.equal(read(path.join(dir, "new.js")), "console.log(1);\n");
  });

  it("deletes a file via a /dev/null diff", () => {
    write(dir, "gone.js", "a\nb\n");
    const r = ef.applyModelOutput("--- a/gone.js\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n", { cwd: dir });
    assert.ok(r.ok);
    assert.equal(fs.existsSync(path.join(dir, "gone.js")), false);
  });
});

describe("applyEditsVerified — verify & revert", () => {
  it("keeps changes when verify passes", () => {
    write(dir, "a.js", "let x = 1;\n");
    const edits = ef.detect.detect(sr("a.js", "let x = 1;", "let x = 2;")).edits;
    const r = ef.apply.applyEditsVerified(edits, { verify: () => true, opts: { cwd: dir, onDirty: "snapshot" } });
    assert.ok(r.ok);
    assert.equal(read(path.join(dir, "a.js")), "let x = 2;\n");
  });

  it("reverts changes when verify fails", () => {
    write(dir, "a.js", "let x = 1;\n");
    const edits = ef.detect.detect(sr("a.js", "let x = 1;", "let x = 2;")).edits;
    const r = ef.apply.applyEditsVerified(edits, {
      verify: () => ({ passed: false, stderr: "nope" }),
      opts: { cwd: dir, onDirty: "snapshot" },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reverted, true);
    assert.equal(read(path.join(dir, "a.js")), "let x = 1;\n"); // restored
  });
});
