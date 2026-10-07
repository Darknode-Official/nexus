"use strict";
// Tests for format auto-detection: pick the right format out of mixed prose,
// extract multiple edits, and handle a message mixing two formats.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { detect, classify } = require("../../src/editformat/detect");

describe("detect — single format in prose", () => {
  it("extracts a SEARCH/REPLACE edit, ignoring surrounding prose", () => {
    const text = [
      "Sure! I'll make that change for you.",
      "",
      "src/a.js",
      "<<<<<<< SEARCH",
      "a",
      "=======",
      "b",
      ">>>>>>> REPLACE",
      "",
      "Let me know if you need anything else.",
    ].join("\n");
    const r = detect(text);
    assert.deepEqual(r.formats, ["search-replace"]);
    assert.equal(r.edits.length, 1);
    assert.equal(r.edits[0].path, "src/a.js");
  });

  it("extracts a unified-diff edit", () => {
    const text = "Here's the patch:\n```diff\n--- a/x.js\n+++ b/x.js\n@@ -1 +1 @@\n-a\n+b\n```";
    const r = detect(text);
    assert.deepEqual(r.formats, ["unified-diff"]);
    assert.equal(r.edits[0].type, "unified-diff");
    assert.equal(r.edits[0].path, "x.js");
  });

  it("extracts a whole-file edit", () => {
    const text = "Here is `app.js`:\n```js\nconst x = 1;\n```";
    const r = detect(text);
    assert.deepEqual(r.formats, ["whole-file"]);
    assert.equal(r.edits[0].type, "whole-file");
  });
});

describe("detect — mixed formats", () => {
  it("extracts both a SEARCH/REPLACE and a unified diff from one message", () => {
    const text = [
      "one.js",
      "<<<<<<< SEARCH",
      "a",
      "=======",
      "A",
      ">>>>>>> REPLACE",
      "",
      "```diff",
      "--- a/two.js",
      "+++ b/two.js",
      "@@ -1 +1 @@",
      "-b",
      "+B",
      "```",
    ].join("\n");
    const r = detect(text);
    assert.ok(r.formats.includes("search-replace"));
    assert.ok(r.formats.includes("unified-diff"));
    assert.equal(r.edits.length, 2);
  });

  it("orders edits by their position in the source", () => {
    const text = [
      "```diff",
      "--- a/two.js",
      "+++ b/two.js",
      "@@ -1 +1 @@",
      "-b",
      "+B",
      "```",
      "",
      "one.js",
      "<<<<<<< SEARCH",
      "a",
      "=======",
      "A",
      ">>>>>>> REPLACE",
    ].join("\n");
    const r = detect(text);
    assert.equal(r.edits[0].format, "unified-diff");
    assert.equal(r.edits[1].format, "search-replace");
  });
});

describe("detect — empty", () => {
  it("returns no edits for pure prose", () => {
    const r = detect("Just a normal explanation with no code.");
    assert.equal(r.edits.length, 0);
    assert.equal(r.formats.length, 0);
  });
});

describe("classify", () => {
  it("reports which markers are present", () => {
    const c = classify("<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE");
    assert.equal(c.searchReplace, true);
    assert.equal(c.unifiedDiff, false);
  });
});
