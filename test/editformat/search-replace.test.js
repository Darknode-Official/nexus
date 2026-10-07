"use strict";
// Tests for the SEARCH/REPLACE parser: basic blocks, fence variations, filename
// inference (header / fence-info / preceding sentence), multi-block, multi-file,
// malformed blocks with precise error locations, and new-file (empty SEARCH).

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const sr = require("../../src/editformat/search-replace");

describe("search-replace.parse — basic", () => {
  it("parses a single block with a filename header", () => {
    const text = [
      "src/a.js",
      "<<<<<<< SEARCH",
      "old",
      "=======",
      "new",
      ">>>>>>> REPLACE",
    ].join("\n");
    const { edits, errors } = sr.parse(text);
    assert.equal(errors.length, 0);
    assert.equal(edits.length, 1);
    assert.equal(edits[0].path, "src/a.js");
    assert.equal(edits[0].search, "old");
    assert.equal(edits[0].replace, "new");
    assert.equal(edits[0].loc.line, 2);
  });

  it("handles a fenced block and strips the closing fence from REPLACE", () => {
    const text = [
      "a.py",
      "```python",
      "<<<<<<< SEARCH",
      "x = 1",
      "=======",
      "x = 2",
      ">>>>>>> REPLACE",
      "```",
    ].join("\n");
    const { edits } = sr.parse(text);
    assert.equal(edits.length, 1);
    assert.equal(edits[0].path, "a.py");
    assert.equal(edits[0].replace, "x = 2");
  });

  it("tolerates marker length and casing variations", () => {
    const text = [
      "f.txt",
      "<<<<<<<<< search",
      "a",
      "=========",
      "b",
      ">>>>>>>>> replace",
    ].join("\n");
    const { edits, errors } = sr.parse(text);
    assert.equal(errors.length, 0);
    assert.equal(edits.length, 1);
    assert.equal(edits[0].search, "a");
  });
});

describe("search-replace.parse — filename inference", () => {
  it("reads the path from the fence info string", () => {
    const text = [
      "```js src/app.js",
      "<<<<<<< SEARCH",
      "a",
      "=======",
      "b",
      ">>>>>>> REPLACE",
      "```",
    ].join("\n");
    const { edits } = sr.parse(text);
    assert.equal(edits[0].path, "src/app.js");
  });

  it("inherits the last seen path for a following pathless block", () => {
    const text = [
      "dir/x.js",
      "<<<<<<< SEARCH",
      "a",
      "=======",
      "b",
      ">>>>>>> REPLACE",
      "<<<<<<< SEARCH",
      "c",
      "=======",
      "d",
      ">>>>>>> REPLACE",
    ].join("\n");
    const { edits } = sr.parse(text);
    assert.equal(edits.length, 2);
    assert.equal(edits[1].path, "dir/x.js");
  });

  it("strips markdown header decoration from the path line", () => {
    const text = [
      "### `src/a.js`",
      "<<<<<<< SEARCH",
      "a",
      "=======",
      "b",
      ">>>>>>> REPLACE",
    ].join("\n");
    const { edits } = sr.parse(text);
    assert.equal(edits[0].path, "src/a.js");
  });
});

describe("search-replace.parse — multi-file & multi-block", () => {
  it("parses several files in one message", () => {
    const text = [
      "one.js",
      "<<<<<<< SEARCH",
      "a",
      "=======",
      "A",
      ">>>>>>> REPLACE",
      "",
      "two.js",
      "<<<<<<< SEARCH",
      "b",
      "=======",
      "B",
      ">>>>>>> REPLACE",
    ].join("\n");
    const { edits } = sr.parse(text);
    assert.equal(edits.length, 2);
    assert.deepEqual(edits.map((e) => e.path), ["one.js", "two.js"]);
  });
});

describe("search-replace.parse — new file (empty SEARCH)", () => {
  it("marks a block with an empty SEARCH as a create", () => {
    const text = [
      "new.js",
      "<<<<<<< SEARCH",
      "=======",
      "console.log(1);",
      ">>>>>>> REPLACE",
    ].join("\n");
    const { edits } = sr.parse(text);
    assert.equal(edits[0].isCreate, true);
    assert.equal(edits[0].replace, "console.log(1);");
  });
});

describe("search-replace.parse — malformed", () => {
  it("reports a missing divider with a line number", () => {
    const text = [
      "a.js",
      "<<<<<<< SEARCH",
      "a",
      ">>>>>>> REPLACE",
    ].join("\n");
    const { errors } = sr.parse(text);
    assert.ok(errors.some((e) => /divider/.test(e.message)));
  });

  it("reports a missing REPLACE marker", () => {
    const text = [
      "a.js",
      "<<<<<<< SEARCH",
      "a",
      "=======",
      "b",
    ].join("\n");
    const { errors } = sr.parse(text);
    assert.ok(errors.some((e) => /REPLACE/.test(e.message)));
  });

  it("reports a block with no inferable path", () => {
    const text = [
      "Some prose that is not a path at all here.",
      "<<<<<<< SEARCH",
      "a",
      "=======",
      "b",
      ">>>>>>> REPLACE",
    ].join("\n");
    const { errors } = sr.parse(text);
    assert.ok(errors.some((e) => /path/.test(e.message)));
  });
});

describe("search-replace.extractPathHeader", () => {
  it("accepts path-like tokens and rejects prose", () => {
    assert.equal(sr.extractPathHeader("src/x.js"), "src/x.js");
    assert.equal(sr.extractPathHeader("file.py"), "file.py");
    assert.equal(sr.extractPathHeader(".gitignore"), ".gitignore");
    assert.equal(sr.extractPathHeader("just some words"), null);
    assert.equal(sr.extractPathHeader("Hello"), null);
  });
});
