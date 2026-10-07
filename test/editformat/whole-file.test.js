"use strict";
// Tests for whole-file detection: fence enumeration, path inference from the
// fence info / preceding header / lead-in sentence / leading comment, and the
// guard that excludes SEARCH/REPLACE and unified-diff payloads.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const wf = require("../../src/editformat/whole-file");

describe("whole-file.enumerateFences", () => {
  it("enumerates fenced blocks with their info and bounds", () => {
    const text = "intro\n```js\ncode1\n```\nmiddle\n~~~\ncode2\n~~~\n";
    const blocks = wf.enumerateFences(text);
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].info, "js");
    assert.equal(blocks[0].content, "code1");
    assert.equal(blocks[1].content, "code2");
  });
  it("flags an unclosed fence", () => {
    const blocks = wf.enumerateFences("```js\ncode without close\n");
    assert.equal(blocks[0].closed, false);
  });
});

describe("whole-file.parse — path inference", () => {
  it("infers the path from the fence info string", () => {
    const text = "```js src/app.js\nconst x = 1;\n```";
    const { edits } = wf.parse(text);
    assert.equal(edits.length, 1);
    assert.equal(edits[0].path, "src/app.js");
    assert.equal(edits[0].pathSource, "fence-info");
  });

  it("infers the path from a preceding header", () => {
    const text = "## src/app.js\n```js\nconst x = 1;\n```";
    const { edits } = wf.parse(text);
    assert.equal(edits[0].path, "src/app.js");
    assert.equal(edits[0].pathSource, "header");
  });

  it("infers the path from a lead-in sentence with backticks", () => {
    const text = "Here is the updated `src/app.js`:\n```js\nconst x = 1;\n```";
    const { edits } = wf.parse(text);
    assert.equal(edits[0].path, "src/app.js");
    assert.equal(edits[0].pathSource, "sentence");
  });

  it("infers the path from a leading comment", () => {
    const text = "```js\n// src/app.js\nconst x = 1;\n```";
    const { edits } = wf.parse(text);
    assert.equal(edits[0].path, "src/app.js");
    assert.equal(edits[0].pathSource, "comment");
  });

  it("appends a trailing newline to content", () => {
    const text = "```js x.js\nconst x = 1;\n```";
    const { edits } = wf.parse(text);
    assert.ok(edits[0].content.endsWith("\n"));
  });
});

describe("whole-file.parse — payload guard", () => {
  it("ignores a fenced SEARCH/REPLACE block", () => {
    const text = "x.js\n```\n<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE\n```";
    const { edits } = wf.parse(text);
    assert.equal(edits.length, 0);
  });
  it("ignores a fenced unified diff", () => {
    const text = "```diff\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n```";
    const { edits } = wf.parse(text);
    assert.equal(edits.length, 0);
  });
  it("skips a block with no inferable path", () => {
    const text = "Some code:\n```\nconst x = 1;\n```";
    const { edits } = wf.parse(text);
    assert.equal(edits.length, 0);
  });
});
