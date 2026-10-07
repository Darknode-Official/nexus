"use strict";
// Tests for the diff-context builder.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { changedLineRanges, buildContext, fromEdit, enclosingSymbol, mergeRanges } = require("../../src/tokensave/diff-context");

function makeFile(n) {
  return Array.from({ length: n }, (_, i) => "line " + (i + 1)).join("\n");
}

describe("changedLineRanges", () => {
  it("detects a single modified line", () => {
    const oldText = makeFile(10);
    const newText = oldText.split("\n").map((l, i) => (i === 4 ? "line 5 CHANGED" : l)).join("\n");
    const ranges = changedLineRanges(oldText, newText);
    assert.equal(ranges.length, 1);
    assert.equal(ranges[0].start, 5);
    assert.equal(ranges[0].end, 5);
  });

  it("detects appended lines", () => {
    const oldText = makeFile(5);
    const newText = oldText + "\nline 6\nline 7";
    const ranges = changedLineRanges(oldText, newText);
    assert.equal(ranges[ranges.length - 1].end, 7);
  });

  it("merges adjacent changed lines into one range", () => {
    const oldText = makeFile(10);
    const lines = oldText.split("\n");
    lines[4] = "x"; lines[5] = "y";
    const ranges = changedLineRanges(oldText, lines.join("\n"));
    assert.equal(ranges.length, 1);
    assert.equal(ranges[0].start, 5);
    assert.equal(ranges[0].end, 6);
  });

  it("returns no ranges for identical text", () => {
    const t = makeFile(20);
    assert.deepEqual(changedLineRanges(t, t), []);
  });
});

describe("buildContext — minimal context + measurement", () => {
  it("includes a neighborhood around the change and omits the rest", () => {
    const file = makeFile(100);
    const r = buildContext(file, [{ start: 50, end: 50 }], { neighbors: 2, includeSymbols: false });
    assert.ok(r.context.includes("line 50"));
    assert.ok(r.context.includes("line 48"));
    assert.ok(r.context.includes("line 52"));
    assert.ok(!r.context.includes("line 10"));
    assert.ok(r.context.includes("lines omitted"));
  });

  it("measures real token savings vs the full file", () => {
    const file = makeFile(1000);
    const r = buildContext(file, [{ start: 500, end: 502 }], { neighbors: 3, model: "gpt" });
    assert.ok(r.fullTokens > r.contextTokens);
    assert.ok(r.saved > 0);
    assert.ok(r.savedPct > 80, "a 3-line edit in a 1000-line file should save most tokens: " + r.savedPct + "%");
    assert.equal(r.lines.total, 1000);
    assert.ok(r.lines.shown < 30);
  });

  it("attaches the enclosing symbol header", () => {
    const file = [
      "function outer() {",
      "  const a = 1;",
      "  const b = 2;",
      "  const c = 3;",
      "  const d = 4;",
      "  return a + b + c + d;",
      "}",
    ].join("\n");
    const r = buildContext(file, [{ start: 6, end: 6 }], { neighbors: 0, includeSymbols: true });
    assert.ok(r.context.includes("function outer()"), "should include the enclosing function header:\n" + r.context);
    assert.ok(r.context.includes("return a + b"));
  });

  it("handles multiple separate hunks", () => {
    const file = makeFile(100);
    const r = buildContext(file, [{ start: 10, end: 10 }, { start: 90, end: 90 }], { neighbors: 1, includeSymbols: false });
    assert.equal(r.hunks.length, 2);
    assert.ok(r.context.includes("line 10"));
    assert.ok(r.context.includes("line 90"));
  });

  it("merges overlapping expanded ranges", () => {
    const merged = mergeRanges([{ start: 1, end: 5 }, { start: 4, end: 8 }, { start: 20, end: 22 }]);
    assert.equal(merged.length, 2);
    assert.deepEqual(merged[0], { start: 1, end: 8 });
  });
});

describe("enclosingSymbol", () => {
  it("finds the nearest function/class above a line", () => {
    const lines = ["class Foo {", "  method() {", "    doThing();", "  }", "}"];
    assert.equal(enclosingSymbol(lines, 3), 2); // nearest is the method
    assert.equal(enclosingSymbol(lines, 1), 1);
  });

  it("returns 0 when no symbol is found", () => {
    assert.equal(enclosingSymbol(["just", "plain", "text"], 3), 0);
  });
});

describe("fromEdit", () => {
  it("diffs then builds context in one call", () => {
    const oldText = makeFile(200);
    const newText = oldText.split("\n").map((l, i) => (i === 99 ? "line 100 EDITED" : l)).join("\n");
    const r = fromEdit(oldText, newText, { neighbors: 2, model: "claude" });
    assert.equal(r.ranges.length, 1);
    assert.ok(r.context.includes("line 100 EDITED"));
    assert.ok(r.saved > 0);
  });

  it("handles an unchanged file (no ranges -> empty context)", () => {
    const t = makeFile(50);
    const r = fromEdit(t, t, { model: "gpt" });
    assert.deepEqual(r.ranges, []);
    assert.equal(r.context, "");
    assert.equal(r.saved, 0);
  });
});
