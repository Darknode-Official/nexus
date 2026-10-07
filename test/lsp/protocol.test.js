"use strict";
// Tests for the pure protocol helpers: URI<->path, enum normalization of every
// result shape (Location/LocationLink, hover markup, hierarchical vs flat
// symbols, completion list vs array, WorkspaceEdit changes vs documentChanges),
// and the incremental-sync diff computation.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const proto = require("../../src/lsp/protocol");

describe("protocol — URI <-> path", () => {
  it("round-trips an absolute path", () => {
    const p = "/home/user/project/src/app.ts";
    assert.equal(proto.uriToPath(proto.pathToUri(p)), p);
  });
  it("leaves non-file URIs untouched", () => {
    assert.equal(proto.uriToPath("untitled:Untitled-1"), "untitled:Untitled-1");
  });
});

describe("protocol.normalizeLocations", () => {
  it("wraps a single Location into an array", () => {
    const r = proto.normalizeLocations({ uri: "file:///a.js", range: proto.range(1, 0, 1, 3) });
    assert.equal(r.length, 1);
    assert.equal(r[0].path, proto.uriToPath("file:///a.js"));
  });
  it("handles LocationLink (targetUri/targetSelectionRange)", () => {
    const r = proto.normalizeLocations([{ targetUri: "file:///b.js", targetSelectionRange: proto.range(2, 1, 2, 5) }]);
    assert.equal(r[0].uri, "file:///b.js");
    assert.equal(r[0].range.start.line, 2);
  });
  it("returns [] for null", () => {
    assert.deepEqual(proto.normalizeLocations(null), []);
  });
});

describe("protocol.normalizeHover", () => {
  it("flattens MarkupContent", () => {
    assert.equal(proto.normalizeHover({ contents: { kind: "markdown", value: "**x**" } }).contents, "**x**");
  });
  it("joins MarkedString arrays", () => {
    const h = proto.normalizeHover({ contents: ["line1", { language: "ts", value: "const x" }] });
    assert.equal(h.contents, "line1\n\nconst x");
  });
  it("returns null when empty", () => {
    assert.equal(proto.normalizeHover({ contents: null }), null);
  });
});

describe("protocol.normalizeSymbols", () => {
  it("normalizes hierarchical DocumentSymbols with children", () => {
    const r = proto.normalizeSymbols([{ name: "f", kind: 12, range: proto.range(0, 0, 2, 0), selectionRange: proto.range(0, 0, 0, 1), children: [{ name: "g", kind: 13, range: proto.range(1, 0, 1, 2), selectionRange: proto.range(1, 0, 1, 1), children: [] }] }]);
    assert.equal(r[0].kind, "function");
    assert.equal(r[0].children[0].name, "g");
    assert.equal(r[0].children[0].kind, "variable");
  });
  it("normalizes flat SymbolInformation", () => {
    const r = proto.normalizeSymbols([{ name: "C", kind: 5, location: { uri: "file:///c.js", range: proto.range(0, 0, 0, 1) }, containerName: "mod" }]);
    assert.equal(r[0].kind, "class");
    assert.equal(r[0].containerName, "mod");
    assert.equal(r[0].path, proto.uriToPath("file:///c.js"));
  });
});

describe("protocol.normalizeCompletion", () => {
  it("accepts a bare array", () => {
    const r = proto.normalizeCompletion([{ label: "foo", kind: 3 }]);
    assert.equal(r.isIncomplete, false);
    assert.equal(r.items[0].kind, "function");
    assert.equal(r.items[0].insertText, "foo");
  });
  it("accepts a CompletionList and marks deprecation from tags", () => {
    const r = proto.normalizeCompletion({ isIncomplete: true, items: [{ label: "bar", kind: 6, tags: [1] }] });
    assert.equal(r.isIncomplete, true);
    assert.equal(r.items[0].deprecated, true);
  });
});

describe("protocol.normalizeWorkspaceEdit", () => {
  it("handles the changes map form", () => {
    const r = proto.normalizeWorkspaceEdit({ changes: { "file:///a.js": [{ range: proto.range(0, 0, 0, 1), newText: "X" }] } });
    assert.equal(r.length, 1);
    assert.equal(r[0].edits[0].newText, "X");
  });
  it("handles the documentChanges form", () => {
    const r = proto.normalizeWorkspaceEdit({ documentChanges: [{ textDocument: { uri: "file:///b.js", version: 2 }, edits: [{ range: proto.range(1, 0, 1, 1), newText: "Y" }] }] });
    assert.equal(r[0].path, proto.uriToPath("file:///b.js"));
    assert.equal(r[0].edits[0].newText, "Y");
  });
});

describe("protocol.computeIncrementalChange", () => {
  it("returns null for identical text", () => {
    assert.equal(proto.computeIncrementalChange("abc", "abc"), null);
  });
  it("computes a minimal single-line replacement", () => {
    const ch = proto.computeIncrementalChange("const x = 1;\n", "const y = 1;\n");
    assert.equal(ch.text, "y");
    assert.equal(ch.range.start.line, 0);
    assert.equal(ch.range.start.character, 6);
    assert.equal(ch.range.end.character, 7);
  });
  it("computes a minimal multi-line insertion that reproduces newText", () => {
    const mock = require("../../src/lsp/mock");
    const oldText = "line1\nline3\n";
    const newText = "line1\nline2\nline3\n";
    const ch = proto.computeIncrementalChange(oldText, newText);
    // The diff is minimal (common prefix/suffix stripped), so it starts inside
    // the shared "line" prefix rather than at a line boundary; what matters is
    // that applying it reproduces newText exactly.
    assert.equal(mock.applyChanges(oldText, [ch]), newText);
    assert.equal(ch.range.start.line, 1);
  });
  it("computes a deletion (empty replacement text)", () => {
    const ch = proto.computeIncrementalChange("abcdef", "abef");
    assert.equal(ch.text, "");
    assert.equal(ch.range.start.character, 2);
    assert.equal(ch.range.end.character, 4);
  });

  it("round-trips: applying the change reproduces newText", () => {
    const mock = require("../../src/lsp/mock");
    const oldText = "function add(a, b) {\n  return a - b;\n}\n";
    const newText = "function add(a, b) {\n  return a + b;\n}\n";
    const ch = proto.computeIncrementalChange(oldText, newText);
    assert.equal(mock.applyChanges(oldText, [ch]), newText);
  });
});

describe("protocol.offsetToPosition", () => {
  it("maps offsets to line/character across newlines", () => {
    const t = "ab\ncd\nef";
    assert.deepEqual(proto.offsetToPosition(t, 0), { line: 0, character: 0 });
    assert.deepEqual(proto.offsetToPosition(t, 3), { line: 1, character: 0 });
    assert.deepEqual(proto.offsetToPosition(t, 7), { line: 2, character: 1 });
  });
});
