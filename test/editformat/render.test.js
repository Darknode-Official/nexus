"use strict";
// Tests for rendering edits from changes, and the render -> parse -> validate
// round-trip for every format.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const render = require("../../src/editformat/render");
const { detect } = require("../../src/editformat/detect");
const { validate } = require("../../src/editformat/validate");

const BEFORE = "function add(a, b) {\n  return a - b;\n}\n";
const AFTER = "function add(a, b) {\n  return a + b;\n}\n";

describe("render.renderSearchReplace", () => {
  it("emits a parseable block from before/after", () => {
    const out = render.renderSearchReplace({ path: "m.js", before: BEFORE, after: AFTER }, { lang: "js" });
    assert.match(out, /<<<<<<< SEARCH/);
    assert.match(out, />>>>>>> REPLACE/);
    const { edits } = detect(out);
    assert.equal(edits[0].path, "m.js");
  });

  it("round-trips: render -> parse -> validate reproduces AFTER", () => {
    const out = render.renderSearchReplace({ path: "m.js", before: BEFORE, after: AFTER });
    const { edits } = detect(out);
    const r = validate(edits, { files: { "m.js": BEFORE } });
    assert.ok(r.ok);
    assert.equal(r.files[0].after, AFTER);
  });

  it("renders a creation as an empty-SEARCH block", () => {
    const out = render.renderSearchReplace({ path: "n.js", before: "", after: "const x = 1;\n" });
    const { edits } = detect(out);
    assert.equal(edits[0].isCreate, true);
  });
});

describe("render.renderUnifiedDiff", () => {
  it("round-trips through the tolerant diff parser", () => {
    const out = render.renderUnifiedDiff({ path: "m.js", before: BEFORE, after: AFTER });
    const { edits } = detect(out);
    assert.equal(edits[0].type, "unified-diff");
    const r = validate(edits, { files: { "m.js": BEFORE } });
    assert.ok(r.ok);
    assert.equal(r.files[0].after, AFTER);
  });

  it("supports an optional git header", () => {
    const out = render.renderUnifiedDiff({ path: "m.js", before: BEFORE, after: AFTER }, { gitHeader: true });
    assert.match(out, /^diff --git a\/m\.js b\/m\.js/);
  });
});

describe("render.renderWholeFile", () => {
  it("round-trips as a whole-file edit", () => {
    const out = render.renderWholeFile({ path: "m.js", after: AFTER }, { lang: "js" });
    const { edits } = detect(out);
    assert.equal(edits[0].type, "whole-file");
    assert.equal(edits[0].path, "m.js");
    const r = validate(edits, { files: { "m.js": BEFORE } });
    assert.ok(r.ok);
    assert.equal(r.files[0].after, AFTER);
  });
});

describe("render.render (dispatch)", () => {
  it("renders multiple changes in the chosen format", () => {
    const changes = [
      { path: "a.js", before: "x\n", after: "y\n" },
      { path: "b.js", before: "p\n", after: "q\n" },
    ];
    const out = render.render(changes, { format: "search-replace" });
    const { edits } = detect(out);
    assert.equal(edits.length, 2);
  });
});
