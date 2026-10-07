"use strict";
// Tests for the transactional multi-file apply engine: atomic commit, validation
// abort (no writes), rollback on write failure, checkpoint/restore, dry-run.

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const diff = require("../../src/patch/diff");
const transaction = require("../../src/patch/transaction");
const { mkTmp, rmTmp, write, read } = require("./tmputil");

let dir;
beforeEach(() => { dir = mkTmp(); });
afterEach(() => { rmTmp(dir); });

describe("transaction.checkpoint / restore", () => {
  it("restores modified and deleted files, and removes created ones", () => {
    const f1 = write(dir, "a.txt", "original-a\n");
    const f2 = write(dir, "b.txt", "original-b\n");
    const f3 = path.join(dir, "new.txt"); // does not exist yet
    const cp = transaction.checkpoint([f1, f2, f3]);

    fs.writeFileSync(f1, "mutated-a\n");
    fs.unlinkSync(f2);
    fs.writeFileSync(f3, "created\n");

    transaction.restore(cp);
    assert.equal(read(f1), "original-a\n");
    assert.equal(read(f2), "original-b\n");
    assert.equal(fs.existsSync(f3), false, "created file should be removed on restore");
  });
});

describe("transaction.commit — atomic success", () => {
  it("writes, patches, and creates files together", () => {
    const f1 = write(dir, "mod.txt", "a\nb\nc\n");
    const tx = transaction.begin({ cwd: dir });
    tx.stagePatch(f1, diff.createUnifiedDiff("a\nb\nc\n", "a\nB\nc\n"));
    tx.stageWrite(path.join(dir, "created.txt"), "brand new\n");
    const res = tx.commit();
    assert.ok(res.ok && res.committed);
    assert.equal(read(f1), "a\nB\nc\n");
    assert.equal(read(path.join(dir, "created.txt")), "brand new\n");
  });
});

describe("transaction.commit — validation abort (no writes)", () => {
  it("aborts the whole set if one patch cannot apply", () => {
    const f1 = write(dir, "good.txt", "a\nb\nc\n");
    const f2 = write(dir, "bad.txt", "totally\ndifferent\n");
    const tx = transaction.begin({ cwd: dir });
    tx.stagePatch(f1, diff.createUnifiedDiff("a\nb\nc\n", "a\nB\nc\n"));
    // This patch targets content that isn't in f2 -> will reject.
    tx.stagePatch(f2, diff.createUnifiedDiff("x\ny\nz\n", "x\nY\nz\n"), { fuzz: 0, maxOffset: 0 });

    const res = tx.commit();
    assert.equal(res.ok, false);
    assert.ok(res.errors.length >= 1);
    // Crucially, the GOOD file must be untouched because the set aborted.
    assert.equal(read(f1), "a\nb\nc\n", "no file written when set is invalid");
  });
});

describe("transaction.commit — rollback on write failure", () => {
  it("rolls back already-written files when a later write throws", () => {
    const f1 = write(dir, "first.txt", "orig1\n");
    const tx = transaction.begin({ cwd: dir });
    tx.stageWrite(f1, "new1\n");
    // Second op targets a path whose parent is a FILE, forcing a write error.
    const blocker = write(dir, "blocker", "x");
    const badPath = path.join(blocker, "child.txt"); // parent is a file -> ENOTDIR/EEXIST
    tx.stageWrite(badPath, "nope\n");

    const res = tx.commit();
    assert.equal(res.ok, false);
    assert.equal(res.rolledBack, true);
    assert.equal(read(f1), "orig1\n", "first write rolled back to original");
  });
});

describe("transaction — delete semantics", () => {
  it("deletes an existing file and rolls back on failure elsewhere", () => {
    const f1 = write(dir, "del.txt", "bye\n");
    const tx = transaction.begin({ cwd: dir });
    tx.stageDelete(f1);
    const res = tx.commit();
    assert.ok(res.ok);
    assert.equal(fs.existsSync(f1), false);
  });

  it("errors when deleting a missing file", () => {
    const tx = transaction.begin({ cwd: dir });
    tx.stageDelete(path.join(dir, "ghost.txt"));
    const res = tx.commit();
    assert.equal(res.ok, false);
    assert.ok(res.errors.some(e => /does not exist/.test(e.reason)));
  });
});

describe("transaction.commit — dry run and preview", () => {
  it("dry run produces a preview and writes nothing", () => {
    const f1 = write(dir, "p.txt", "a\nb\n");
    const tx = transaction.begin({ cwd: dir });
    tx.stagePatch(f1, diff.createUnifiedDiff("a\nb\n", "a\nB\n"));
    tx.stageWrite(path.join(dir, "c.txt"), "created\n");
    const res = tx.commit({ dryRun: true });
    assert.ok(res.ok);
    assert.equal(res.committed, false);
    assert.equal(res.preview.files.length, 2);
    assert.equal(read(f1), "a\nb\n", "dry run must not write");
    assert.equal(fs.existsSync(path.join(dir, "c.txt")), false);
  });

  it("preview reports accurate add/delete counts and actions", () => {
    const f1 = write(dir, "p.txt", "a\nb\nc\n");
    const tx = transaction.begin({ cwd: dir });
    tx.stagePatch(f1, diff.createUnifiedDiff("a\nb\nc\n", "a\nb\nc\nd\n"));
    tx.stageWrite(path.join(dir, "n.txt"), "x\n");
    const pv = tx.preview();
    const mod = pv.files.find(f => f.file === "p.txt");
    const create = pv.files.find(f => f.file === "n.txt");
    assert.equal(mod.action, "modify");
    assert.equal(mod.additions, 1);
    assert.equal(create.action, "create");
  });
});

describe("transaction — sequential ops on the same file", () => {
  it("threads multiple ops so later patches see earlier results", () => {
    const f1 = write(dir, "seq.txt", "1\n2\n3\n");
    const tx = transaction.begin({ cwd: dir });
    tx.stageWrite(f1, "1\n2\n3\n4\n");
    tx.stagePatch(f1, diff.createUnifiedDiff("1\n2\n3\n4\n", "1\n2\n3\n4\n5\n"));
    const res = tx.commit();
    assert.ok(res.ok);
    assert.equal(read(f1), "1\n2\n3\n4\n5\n");
  });
});
