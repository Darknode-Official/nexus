"use strict";
// Tests for fuzzy patch apply: clean apply, drift (offset), fuzz (relaxed context),
// clean rejection, and the no-silent-half-apply guarantee.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const diff = require("../../src/patch/diff");
const apply = require("../../src/patch/apply");

function patchFor(a, b) {
  return diff.parseUnifiedDiff(diff.createUnifiedDiff(a, b))[0];
}

describe("apply.applyPatch — clean", () => {
  it("applies with zero drift and zero fuzz", () => {
    const a = "a\nb\nc\nd\n";
    const b = "a\nB\nc\nd\n";
    const r = apply.applyPatch(a, patchFor(a, b), {});
    assert.ok(r.ok);
    assert.equal(r.text, b);
    assert.equal(r.hunks[0].offset, 0);
    assert.equal(r.hunks[0].fuzz, 0);
  });
});

describe("apply.applyPatch — drift", () => {
  it("applies when lines were inserted above the hunk (positive offset)", () => {
    const a = "a\nb\nc\nd\n";
    const b = "a\nB\nc\nd\n";
    const patch = patchFor(a, b);
    const drifted = "pre1\npre2\n" + a;
    const r = apply.applyPatch(drifted, patch, {});
    assert.ok(r.ok);
    assert.equal(r.text, "pre1\npre2\n" + b);
    assert.equal(r.hunks[0].offset, 2);
    assert.equal(r.hunks[0].fuzz, 0);
  });

  it("applies when lines were removed above the hunk (negative offset)", () => {
    const a = "x\ny\nalpha\nbeta\ngamma\n";
    const b = "x\ny\nalpha\nBETA\ngamma\n";
    const patch = patchFor(a, b);
    const drifted = "alpha\nbeta\ngamma\n"; // removed x,y above
    const r = apply.applyPatch(drifted, patch, {});
    assert.ok(r.ok);
    assert.equal(r.text, "alpha\nBETA\ngamma\n");
    assert.ok(r.hunks[0].offset < 0);
  });
});

describe("apply.applyPatch — fuzz", () => {
  it("applies when a context line changed, using fuzz", () => {
    const a = "ctx1\nctx2\ntarget\nctx3\nctx4\n";
    const b = "ctx1\nctx2\nTARGET\nctx3\nctx4\n";
    const patch = patchFor(a, b);
    // Mutate a leading context line so exact match fails; fuzz should recover.
    const mutated = "CTX1-changed\nctx2\ntarget\nctx3\nctx4\n";
    const r = apply.applyPatch(mutated, patch, { fuzz: 2 });
    assert.ok(r.ok, "should apply with fuzz");
    assert.ok(r.hunks[0].fuzz >= 1, "should report nonzero fuzz");
    assert.equal(r.text, "CTX1-changed\nctx2\nTARGET\nctx3\nctx4\n");
  });

  it("refuses when fuzz is disabled and context drifted", () => {
    const a = "ctx1\nctx2\ntarget\nctx3\nctx4\n";
    const b = "ctx1\nctx2\nTARGET\nctx3\nctx4\n";
    const patch = patchFor(a, b);
    const mutated = "CTX1-changed\nCTX2-changed\ntarget\nCTX3-changed\nCTX4-changed\n";
    const r = apply.applyPatch(mutated, patch, { fuzz: 0 });
    assert.equal(r.ok, false);
    assert.equal(r.applied, 0);
  });
});

describe("apply.applyPatch — rejection", () => {
  it("rejects cleanly when the target context is absent", () => {
    const a = "one\ntwo\nthree\n";
    const b = "one\nTWO\nthree\n";
    const patch = patchFor(a, b);
    const unrelated = "completely\ndifferent\nfile\ncontents\n";
    const r = apply.applyPatch(unrelated, patch, {});
    assert.equal(r.ok, false);
    assert.equal(r.applied, 0);
    assert.equal(r.rejected, 1);
    assert.ok(r.hunks[0].reason);
    assert.equal(r.text, unrelated, "text must be untouched on rejection");
  });

  it("never half-applies: one bad hunk aborts the whole file by default", () => {
    // Two-hunk patch: first applies, second cannot.
    const a = "h1a\nh1b\nh1c\nMID\nMID\nMID\nMID\nMID\nMID\nh2a\nh2b\nh2c\n";
    const b = "h1a\nH1B\nh1c\nMID\nMID\nMID\nMID\nMID\nMID\nh2a\nH2B\nh2c\n";
    const patch = patchFor(a, b);
    assert.ok(patch.hunks.length >= 2, "needs 2 hunks for this test");
    // Corrupt the region the SECOND hunk targets so it rejects.
    const broken = a.replace("h2a\nh2b\nh2c", "zzz\nzzz\nzzz");
    const r = apply.applyPatch(broken, patch, {});
    assert.equal(r.ok, false);
    assert.equal(r.text, broken, "no partial write — original returned unchanged");
  });

  it("partial mode applies what fits and reports the rest", () => {
    const a = "h1a\nh1b\nh1c\nMID\nMID\nMID\nMID\nMID\nMID\nh2a\nh2b\nh2c\n";
    const b = "h1a\nH1B\nh1c\nMID\nMID\nMID\nMID\nMID\nMID\nh2a\nH2B\nh2c\n";
    const patch = patchFor(a, b);
    const broken = a.replace("h2a\nh2b\nh2c", "zzz\nzzz\nzzz");
    const r = apply.applyPatch(broken, patch, { partial: true });
    assert.equal(r.applied, 1);
    assert.equal(r.rejected, 1);
    assert.ok(r.text.includes("H1B"), "first hunk did apply");
  });
});

describe("apply.formatRejects", () => {
  it("formats a .rej-style report", () => {
    const a = "one\ntwo\nthree\n";
    const b = "one\nTWO\nthree\n";
    const r = apply.applyPatch("nope\nnope\nnope\n", patchFor(a, b), {});
    const rej = apply.formatRejects(r);
    assert.match(rej, /hunk #1/);
  });
});

describe("apply.applyUnifiedDiff", () => {
  it("parses and applies a raw diff string", () => {
    const a = "a\nb\nc\n";
    const b = "a\nZ\nc\n";
    const d = diff.createUnifiedDiff(a, b);
    const r = apply.applyUnifiedDiff(a, d, {});
    assert.ok(r.ok);
    assert.equal(r.text, b);
  });
});
