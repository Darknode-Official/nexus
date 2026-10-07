"use strict";
// Tests for the tolerant unified-diff parser: clean diffs, a/ b/ prefixes,
// fenced diffs, missing counts/line-numbers, recomputed counts, /dev/null
// create & delete, multi-file, and diff --git headers.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const ud = require("../../src/editformat/unified-diff");

describe("unified-diff.parse — clean", () => {
  it("parses a standard diff and strips a/ b/ prefixes", () => {
    const text = [
      "--- a/src/x.js",
      "+++ b/src/x.js",
      "@@ -1,3 +1,3 @@",
      " a",
      "-b",
      "+B",
      " c",
    ].join("\n");
    const { files } = ud.parse(text);
    assert.equal(files.length, 1);
    assert.equal(files[0].path, "src/x.js");
    assert.equal(files[0].hunks.length, 1);
    assert.equal(files[0].hunks[0].oldLines, 3); // context a + del b + context c
    assert.equal(files[0].hunks[0].newLines, 3); // context a + add B + context c
  });
});

describe("unified-diff.parse — sloppy", () => {
  it("recovers when @@ has no line numbers", () => {
    const text = [
      "--- x.js",
      "+++ x.js",
      "@@ ... @@",
      " a",
      "-b",
      "+B",
      " c",
    ].join("\n");
    const { files } = ud.parse(text);
    assert.equal(files.length, 1);
    assert.equal(files[0].hunks.length, 1);
    assert.equal(files[0].hunks[0].lines.length, 4);
  });

  it("recomputes wrong declared counts from the actual lines", () => {
    const text = [
      "--- x.js",
      "+++ x.js",
      "@@ -1,99 +1,99 @@",
      " a",
      "-b",
      "+B",
    ].join("\n");
    const { files } = ud.parse(text);
    assert.equal(files[0].hunks[0].oldLines, 2);
    assert.equal(files[0].hunks[0].newLines, 2);
  });

  it("parses a fenced diff", () => {
    const text = [
      "```diff",
      "--- a/x.js",
      "+++ b/x.js",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "```",
    ].join("\n");
    const { files } = ud.parse(text);
    assert.equal(files.length, 1);
    assert.equal(files[0].hunks[0].lines.length, 2);
  });
});

describe("unified-diff.parse — create & delete", () => {
  it("recognizes /dev/null source as a create", () => {
    const text = [
      "--- /dev/null",
      "+++ b/new.js",
      "@@ -0,0 +1,2 @@",
      "+line1",
      "+line2",
    ].join("\n");
    const { files } = ud.parse(text);
    assert.equal(files[0].isCreate, true);
    assert.equal(files[0].path, "new.js");
  });

  it("recognizes /dev/null destination as a delete", () => {
    const text = [
      "--- a/gone.js",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-line1",
      "-line2",
    ].join("\n");
    const { files } = ud.parse(text);
    assert.equal(files[0].isDelete, true);
    assert.equal(files[0].path, "gone.js");
  });
});

describe("unified-diff.parse — git headers & multi-file", () => {
  it("reads the path from diff --git and parses multiple files", () => {
    const text = [
      "diff --git a/one.js b/one.js",
      "--- a/one.js",
      "+++ b/one.js",
      "@@ -1 +1 @@",
      "-a",
      "+A",
      "diff --git a/two.js b/two.js",
      "--- a/two.js",
      "+++ b/two.js",
      "@@ -1 +1 @@",
      "-b",
      "+B",
    ].join("\n");
    const { files } = ud.parse(text);
    assert.equal(files.length, 2);
    assert.deepEqual(files.map((f) => f.path), ["one.js", "two.js"]);
  });
});

describe("unified-diff.stripPrefix", () => {
  it("strips a/ b/ and unquotes", () => {
    assert.equal(ud.stripPrefix("a/src/x.js"), "src/x.js");
    assert.equal(ud.stripPrefix("b/x.js"), "x.js");
    assert.equal(ud.stripPrefix('"a/my file.js"'), "my file.js");
    assert.equal(ud.stripPrefix("plain.js"), "plain.js");
  });
});

describe("unified-diff.has", () => {
  it("detects diff markers", () => {
    assert.equal(ud.has("@@ -1 +1 @@"), true);
    assert.equal(ud.has("diff --git a/x b/x"), true);
    assert.equal(ud.has("nothing here"), false);
  });
});
