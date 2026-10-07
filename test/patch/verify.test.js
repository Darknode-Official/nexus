"use strict";
// Tests for the apply -> verify -> auto-revert harness, including auto-revert on a
// failing verify, keeping changes on success, dirty-tree refusal, and dry-run.

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const transaction = require("../../src/patch/transaction");
const verify = require("../../src/patch/verify");
const { mkTmp, rmTmp, write, read } = require("./tmputil");

let dir;
beforeEach(() => { dir = mkTmp(); });
afterEach(() => { rmTmp(dir); });

describe("verify.runVerify", () => {
  it("captures a passing command", () => {
    const r = verify.runVerify("node -e \"process.exit(0)\"", { cwd: dir });
    assert.equal(r.passed, true);
    assert.equal(r.exitCode, 0);
  });

  it("captures a failing command without throwing", () => {
    const r = verify.runVerify("node -e \"process.exit(3)\"", { cwd: dir });
    assert.equal(r.passed, false);
    assert.equal(r.exitCode, 3);
  });
});

describe("verify.applyVerifyRevert — function verifier", () => {
  it("keeps changes when verify passes", () => {
    const f1 = write(dir, "a.txt", "orig\n");
    const tx = transaction.begin({ cwd: dir });
    tx.stageWrite(f1, "changed\n");
    const res = verify.applyVerifyRevert({
      transaction: tx,
      verify: () => true,
      opts: { cwd: dir, onDirty: "snapshot" },
    });
    assert.ok(res.ok && res.verified);
    assert.equal(res.reverted, false);
    assert.equal(read(f1), "changed\n");
  });

  it("auto-reverts when verify fails", () => {
    const f1 = write(dir, "a.txt", "orig\n");
    const tx = transaction.begin({ cwd: dir });
    tx.stageWrite(f1, "changed\n");
    const res = verify.applyVerifyRevert({
      transaction: tx,
      verify: () => false,
      opts: { cwd: dir, onDirty: "snapshot" },
    });
    assert.equal(res.ok, false);
    assert.equal(res.verified, false);
    assert.equal(res.reverted, true);
    assert.equal(read(f1), "orig\n", "file reverted to original after failed verify");
  });
});

describe("verify.applyVerifyRevert — command verifier", () => {
  it("auto-reverts based on a real failing shell command", () => {
    const f1 = write(dir, "code.txt", "v1\n");
    const tx = transaction.begin({ cwd: dir });
    tx.stageWrite(f1, "v2\n");
    const res = verify.applyVerifyRevert({
      transaction: tx,
      verify: "node -e \"process.exit(1)\"",
      opts: { cwd: dir, onDirty: "snapshot" },
    });
    assert.equal(res.ok, false);
    assert.equal(res.reverted, true);
    assert.equal(read(f1), "v1\n");
  });

  it("keeps changes when the shell command passes", () => {
    const f1 = write(dir, "code.txt", "v1\n");
    const tx = transaction.begin({ cwd: dir });
    tx.stageWrite(f1, "v2\n");
    const res = verify.applyVerifyRevert({
      transaction: tx,
      verify: "node -e \"process.exit(0)\"",
      opts: { cwd: dir, onDirty: "snapshot" },
    });
    assert.ok(res.ok && res.verified);
    assert.equal(read(f1), "v2\n");
  });
});

describe("verify — dirty-tree handling", () => {
  it("refuses when a target file has uncommitted git changes", () => {
    // Build a real git repo in the sandbox.
    execSync("git init -q", { cwd: dir });
    execSync("git config user.email t@t.t && git config user.name t", { cwd: dir });
    write(dir, "f.txt", "committed\n");
    execSync("git add -A && git commit -q -m init", { cwd: dir });
    // Make the file dirty.
    fs.writeFileSync(path.join(dir, "f.txt"), "dirty-edit\n");

    const tx = transaction.begin({ cwd: dir });
    tx.stageWrite(path.join(dir, "f.txt"), "engine-edit\n");
    const res = verify.applyVerifyRevert({
      transaction: tx,
      verify: () => true,
      opts: { cwd: dir, onDirty: "refuse" },
    });
    assert.equal(res.ok, false);
    assert.equal(res.reason, "dirty-tree");
    assert.equal(read(path.join(dir, "f.txt")), "dirty-edit\n", "dirty file left intact");
  });

  it("proceeds in snapshot mode despite a dirty tree and reverts on failure", () => {
    execSync("git init -q", { cwd: dir });
    execSync("git config user.email t@t.t && git config user.name t", { cwd: dir });
    write(dir, "f.txt", "committed\n");
    execSync("git add -A && git commit -q -m init", { cwd: dir });
    fs.writeFileSync(path.join(dir, "f.txt"), "dirty-edit\n");

    const tx = transaction.begin({ cwd: dir });
    tx.stageWrite(path.join(dir, "f.txt"), "engine-edit\n");
    const res = verify.applyVerifyRevert({
      transaction: tx,
      verify: () => false,
      opts: { cwd: dir, onDirty: "snapshot" },
    });
    assert.equal(res.reverted, true);
    // Snapshot was taken AFTER the dirty edit, so revert returns to the dirty state.
    assert.equal(read(path.join(dir, "f.txt")), "dirty-edit\n");
  });
});

describe("verify — dry run", () => {
  it("previews without writing or running verify", () => {
    const f1 = write(dir, "a.txt", "orig\n");
    const tx = transaction.begin({ cwd: dir });
    tx.stageWrite(f1, "changed\n");
    const res = verify.applyVerifyRevert({
      transaction: tx,
      verify: () => { throw new Error("verify should not run in dry run"); },
      opts: { cwd: dir, dryRun: true },
    });
    assert.ok(res.ok);
    assert.equal(res.phase, "dry-run");
    assert.equal(read(f1), "orig\n");
  });
});

describe("verify — invalid change set", () => {
  it("fails at plan phase before writing when a patch cannot apply", () => {
    const f1 = write(dir, "a.txt", "a\nb\nc\n");
    const diff = require("../../src/patch/diff");
    const tx = transaction.begin({ cwd: dir });
    tx.stagePatch(f1, diff.createUnifiedDiff("x\ny\nz\n", "x\nY\nz\n"), { fuzz: 0, maxOffset: 0 });
    const res = verify.applyVerifyRevert({ transaction: tx, verify: () => true, opts: { cwd: dir, onDirty: "snapshot" } });
    assert.equal(res.ok, false);
    assert.equal(res.phase, "plan");
    assert.equal(read(f1), "a\nb\nc\n");
  });
});
