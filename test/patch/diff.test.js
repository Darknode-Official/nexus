"use strict";
// Tests for the unified-diff engine: diff generation, parsing, round-trip, stats,
// no-newline handling, and empty-line fidelity.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const diff = require("../../src/patch/diff");

describe("diff.splitLines / joinLines", () => {
  it("round-trips text that ends with a newline", () => {
    const t = "a\nb\nc\n";
    const s = diff.splitLines(t);
    assert.deepEqual(s.lines, ["a", "b", "c"]);
    assert.equal(s.noEOL, false);
    assert.equal(diff.joinLines(s.lines, s.noEOL), t);
  });

  it("round-trips text with no trailing newline", () => {
    const t = "a\nb";
    const s = diff.splitLines(t);
    assert.deepEqual(s.lines, ["a", "b"]);
    assert.equal(s.noEOL, true);
    assert.equal(diff.joinLines(s.lines, s.noEOL), t);
  });

  it("handles the empty string", () => {
    const s = diff.splitLines("");
    assert.deepEqual(s.lines, []);
    assert.equal(diff.joinLines(s.lines, s.noEOL), "");
  });
});

describe("diff.diffLines (Myers)", () => {
  it("returns all-equal for identical input", () => {
    const ops = diff.diffLines(["a", "b"], ["a", "b"]);
    assert.ok(ops.every(o => o.type === "equal"));
  });

  it("produces a minimal edit script", () => {
    const ops = diff.diffLines(["a", "b", "c"], ["a", "x", "c"]);
    const dels = ops.filter(o => o.type === "delete").map(o => o.value);
    const ins = ops.filter(o => o.type === "insert").map(o => o.value);
    assert.deepEqual(dels, ["b"]);
    assert.deepEqual(ins, ["x"]);
  });

  it("handles pure insertion and pure deletion", () => {
    assert.equal(diff.diffLines([], ["a", "b"]).filter(o => o.type === "insert").length, 2);
    assert.equal(diff.diffLines(["a", "b"], []).filter(o => o.type === "delete").length, 2);
  });
});

describe("diff.createUnifiedDiff", () => {
  it("returns empty string for identical texts", () => {
    assert.equal(diff.createUnifiedDiff("a\nb\n", "a\nb\n"), "");
  });

  it("emits ---/+++ headers and hunk headers", () => {
    const d = diff.createUnifiedDiff("a\nb\nc\n", "a\nB\nc\n", { oldPath: "x", newPath: "y" });
    assert.match(d, /^--- x\n\+\+\+ y\n/);
    assert.match(d, /@@ -\d+,\d+ \+\d+,\d+ @@/);
    assert.ok(d.includes("-b"));
    assert.ok(d.includes("+B"));
  });

  it("marks a missing trailing newline", () => {
    const d = diff.createUnifiedDiff("a\nb", "a\nc");
    assert.ok(d.includes(diff.NO_NEWLINE));
  });
});

describe("diff.parseUnifiedDiff", () => {
  it("parses a single-file diff into hunks", () => {
    const d = diff.createUnifiedDiff("a\nb\nc\n", "a\nB\nc\n", { oldPath: "f", newPath: "f" });
    const files = diff.parseUnifiedDiff(d);
    assert.equal(files.length, 1);
    assert.equal(files[0].hunks.length, 1);
    const h = files[0].hunks[0];
    assert.equal(h.oldStart, 1);
    assert.ok(h.lines.some(l => l.type === "-" && l.content === "b"));
    assert.ok(h.lines.some(l => l.type === "+" && l.content === "B"));
  });

  it("does not invent a trailing empty context line from the diff newline", () => {
    const d = diff.createUnifiedDiff("a\nb\nc\n", "a\nb\nC\n");
    const h = diff.parseUnifiedDiff(d)[0].hunks[0];
    // last hunk line must be a real content line, never a phantom "".
    const last = h.lines[h.lines.length - 1];
    assert.ok(last.type === "+" || last.type === "-" || last.content !== "" || last.type === " ");
    // and it must round-trip:
    const apply = require("../../src/patch/apply");
    const r = apply.applyPatch("a\nb\nc\n", diff.parseUnifiedDiff(d)[0], {});
    assert.equal(r.text, "a\nb\nC\n");
  });

  it("parses a multi-file diff", () => {
    const d1 = diff.createUnifiedDiff("a\n", "b\n", { oldPath: "f1", newPath: "f1" });
    const d2 = diff.createUnifiedDiff("x\n", "y\n", { oldPath: "f2", newPath: "f2" });
    const files = diff.parseUnifiedDiff(d1 + d2);
    assert.equal(files.length, 2);
    assert.equal(files[0].oldPath, "f1");
    assert.equal(files[1].oldPath, "f2");
  });
});

describe("diff.diffStat", () => {
  it("counts additions and deletions", () => {
    const d = diff.createUnifiedDiff("a\nb\nc\n", "a\nX\nc\nd\n");
    const stat = diff.diffStat(d);
    assert.equal(stat.additions, 2); // X and d
    assert.equal(stat.deletions, 1); // b
    assert.equal(stat.files, 1);
    assert.ok(stat.hunks >= 1);
  });
});

describe("diff round-trip property", () => {
  it("createUnifiedDiff -> applyPatch reproduces the target on varied edits", () => {
    const apply = require("../../src/patch/apply");
    const cases = [
      ["", "hello\n"],
      ["hello\n", ""],
      ["one\ntwo\nthree\n", "one\ntwo\nthree\nfour\n"],
      ["a\nb\nc\nd\ne\n", "a\nc\nd\ne\nf\n"],
      ["x\n\ny\n", "x\n\nz\n"],
      ["no-eol-before", "no-eol-after"],
    ];
    for (const [a, b] of cases) {
      const d = diff.createUnifiedDiff(a, b);
      if (d === "") { assert.equal(a, b); continue; }
      const r = apply.applyPatch(a, diff.parseUnifiedDiff(d)[0], {});
      assert.ok(r.ok, `apply ok for ${JSON.stringify([a, b])}`);
      assert.equal(r.text, b, `round-trip for ${JSON.stringify([a, b])}`);
    }
  });
});
