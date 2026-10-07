"use strict";
// Tests for the public entrypoint: module surface and the high-level convenience.

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const patch = require("../../src/patch");
const { mkTmp, rmTmp, write, read } = require("./tmputil");

describe("patch index surface", () => {
  it("exposes all submodules", () => {
    for (const k of ["diff", "apply", "transaction", "codemod", "verify", "preview"]) {
      assert.ok(patch[k], `patch.${k} should exist`);
    }
  });

  it("exposes flattened conveniences", () => {
    assert.equal(typeof patch.createUnifiedDiff, "function");
    assert.equal(typeof patch.applyPatch, "function");
    assert.equal(typeof patch.begin, "function");
    assert.equal(typeof patch.applyVerifyRevert, "function");
    assert.equal(typeof patch.applyDiffToFile, "function");
  });
});

describe("patch.applyDiffToFile", () => {
  let dir;
  beforeEach(() => { dir = mkTmp(); });
  afterEach(() => { rmTmp(dir); });

  it("applies a unified diff to a file atomically", () => {
    const f1 = write(dir, "a.txt", "a\nb\nc\n");
    const d = patch.createUnifiedDiff("a\nb\nc\n", "a\nB\nc\n");
    const res = patch.applyDiffToFile(f1, d, { cwd: dir });
    assert.ok(res.ok && res.committed);
    assert.equal(read(f1), "a\nB\nc\n");
  });

  it("supports dry run", () => {
    const f1 = write(dir, "a.txt", "a\nb\nc\n");
    const d = patch.createUnifiedDiff("a\nb\nc\n", "a\nB\nc\n");
    const res = patch.applyDiffToFile(f1, d, { cwd: dir, dryRun: true });
    assert.ok(res.ok);
    assert.equal(res.committed, false);
    assert.equal(read(f1), "a\nb\nc\n");
  });

  it("applies with drift via fuzz/offset tolerance", () => {
    const f1 = write(dir, "a.txt", "pre\npre\na\nb\nc\n");
    const d = patch.createUnifiedDiff("a\nb\nc\n", "a\nB\nc\n");
    const res = patch.applyDiffToFile(f1, d, { cwd: dir });
    assert.ok(res.ok);
    assert.equal(read(f1), "pre\npre\na\nB\nc\n");
  });
});
