"use strict";
// Tests for validation + self-repair using an in-memory file map: exact apply,
// whitespace/indent repair with REPLACE re-indentation, sequential edits to one
// file, unified-diff reconciliation, whole-file overwrite, create, delete, and
// structured diagnoses for not-found / ambiguous / missing-path edits.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { validate } = require("../../src/editformat/validate");
const { detect } = require("../../src/editformat/detect");

function plan(text, files, opts) {
  const { edits } = detect(text);
  return validate(edits, Object.assign({ files }, opts || {}));
}

describe("validate — search-replace", () => {
  it("applies an exact edit", () => {
    const r = plan(
      "a.js\n<<<<<<< SEARCH\nlet x = 1;\n=======\nlet x = 2;\n>>>>>>> REPLACE",
      { "a.js": "let x = 1;\n" }
    );
    assert.ok(r.ok);
    assert.equal(r.files[0].action, "modify");
    assert.equal(r.files[0].after, "let x = 2;\n");
  });

  it("re-indents the REPLACE when the SEARCH was indent-repaired", () => {
    const file = "class A:\n    def m(self):\n        return 1\n";
    const r = plan(
      "a.py\n<<<<<<< SEARCH\nreturn 1\n=======\nreturn 2\n>>>>>>> REPLACE",
      { "a.py": file }
    );
    assert.ok(r.ok);
    assert.equal(r.files[0].after, "class A:\n    def m(self):\n        return 2\n");
  });

  it("threads two sequential edits to the same file", () => {
    const text = [
      "a.js",
      "<<<<<<< SEARCH",
      "let x = 1;",
      "=======",
      "let x = 2;",
      ">>>>>>> REPLACE",
      "a.js",
      "<<<<<<< SEARCH",
      "let y = 3;",
      "=======",
      "let y = 4;",
      ">>>>>>> REPLACE",
    ].join("\n");
    const r = plan(text, { "a.js": "let x = 1;\nlet y = 3;\n" });
    assert.ok(r.ok);
    assert.equal(r.files[0].after, "let x = 2;\nlet y = 4;\n");
    assert.equal(r.files[0].edits, 2);
  });
});

describe("validate — diagnoses (no silent guess)", () => {
  it("refuses an unlocatable SEARCH and reports a diagnosis", () => {
    const r = plan(
      "a.js\n<<<<<<< SEARCH\ncompletely absent\n=======\nx\n>>>>>>> REPLACE",
      { "a.js": "something else entirely\n" }
    );
    assert.equal(r.ok, false);
    assert.equal(r.diagnoses.length, 1);
    assert.equal(r.diagnoses[0].path, "a.js");
  });

  it("refuses an ambiguous SEARCH", () => {
    const r = plan(
      "a.js\n<<<<<<< SEARCH\nx = 1\n=======\nx = 9\n>>>>>>> REPLACE",
      { "a.js": "x = 1\ny = 2\nx = 1\n" }
    );
    assert.equal(r.ok, false);
    assert.equal(r.diagnoses[0].reason, "ambiguous");
  });

  it("reports an edit with no resolvable path", () => {
    const edits = [{ type: "search-replace", format: "search-replace", path: null,
      searchLines: ["a"], replaceLines: ["b"], loc: { line: 1 } }];
    const r = validate(edits, { files: {} });
    assert.equal(r.ok, false);
    assert.equal(r.diagnoses[0].reason, "no-path");
  });
});

describe("validate — unified diff", () => {
  it("applies a diff and reconciles drifted line numbers", () => {
    const text = "```diff\n--- a/x.js\n+++ b/x.js\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n```";
    // Real file has extra lines above, so the model's @@ -1 is wrong.
    const r = plan(text, { "x.js": "pre1\npre2\na\nb\nc\n" });
    assert.ok(r.ok);
    assert.equal(r.files[0].after, "pre1\npre2\na\nB\nc\n");
  });

  it("refuses a diff whose context is absent", () => {
    const text = "```diff\n--- a/x.js\n+++ b/x.js\n@@ -1 +1 @@\n-nowhere\n+here\n```";
    const r = plan(text, { "x.js": "totally different content\n" });
    assert.equal(r.ok, false);
    assert.equal(r.diagnoses[0].reason, "hunk-rejected");
  });
});

describe("validate — whole file / create / delete", () => {
  it("overwrites an existing file", () => {
    const r = plan("Here is `x.js`:\n```js\nconst v = 2;\n```", { "x.js": "const v = 1;\n" });
    assert.ok(r.ok);
    assert.equal(r.files[0].action, "modify");
    assert.equal(r.files[0].after, "const v = 2;\n");
  });

  it("creates a new file via whole-file", () => {
    const r = plan("Here is `new.js`:\n```js\nconst v = 1;\n```", {});
    assert.ok(r.ok);
    assert.equal(r.files[0].action, "create");
  });

  it("creates a new file via empty-SEARCH block", () => {
    const r = plan(
      "new.js\n<<<<<<< SEARCH\n=======\nconsole.log(1);\n>>>>>>> REPLACE",
      {}
    );
    assert.ok(r.ok);
    assert.equal(r.files[0].action, "create");
    assert.equal(r.files[0].after, "console.log(1);\n");
  });

  it("stages a delete from a /dev/null diff", () => {
    const text = "--- a/gone.js\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n";
    const r = plan(text, { "gone.js": "a\nb\n" });
    assert.ok(r.ok);
    assert.equal(r.files[0].action, "delete");
  });
});

describe("validate — line endings preserved", () => {
  it("keeps CRLF line endings on the output", () => {
    const r = plan(
      "a.js\n<<<<<<< SEARCH\nlet x = 1;\n=======\nlet x = 2;\n>>>>>>> REPLACE",
      { "a.js": "let x = 1;\r\nlet y = 2;\r\n" }
    );
    assert.ok(r.ok);
    assert.ok(r.files[0].after.includes("\r\n"));
  });
});
