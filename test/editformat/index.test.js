"use strict";
// End-to-end tests for the public entrypoint: applyModelOutput on a realistic
// mixed-prose message, the no-edits case, and the parseEdits convenience.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const ef = require("../../src/editformat");

describe("applyModelOutput — realistic message (in-memory, dry run)", () => {
  it("parses prose + a fenced SEARCH/REPLACE and previews the change", () => {
    const msg = [
      "Good catch. The bug is the subtraction. Here's the fix:",
      "",
      "```js",
      "src/math.js",
      "<<<<<<< SEARCH",
      "  return a - b;",
      "=======",
      "  return a + b;",
      ">>>>>>> REPLACE",
      "```",
      "",
      "That should do it!",
    ].join("\n");
    const before = "function add(a, b) {\n  return a - b;\n}\n";
    const r = ef.applyModelOutput(msg, { files: { "src/math.js": before }, dryRun: true });
    assert.ok(r.ok);
    assert.deepEqual(r.detection.formats, ["search-replace"]);
    assert.equal(r.preview.files[0].action, "modify");
    assert.match(r.preview.files[0].diff, /\+  return a \+ b;/);
  });
});

describe("applyModelOutput — no edits", () => {
  it("reports no-edits for pure prose", () => {
    const r = ef.applyModelOutput("I think the code looks fine as is.");
    assert.equal(r.ok, false);
    assert.equal(r.phase, "detect");
    assert.equal(r.diagnoses[0].reason, "no-edits");
  });
});

describe("applyModelOutput — self-repair end to end", () => {
  it("auto-repairs indentation drift and reports the repair", () => {
    const before = "class A:\n    def m(self):\n        return 1\n";
    const msg = "a.py\n<<<<<<< SEARCH\nreturn 1\n=======\nreturn 2\n>>>>>>> REPLACE";
    const r = ef.applyModelOutput(msg, { files: { "a.py": before }, dryRun: true });
    assert.ok(r.ok);
    const srResult = r.plan.results.find((x) => x.status === "repaired");
    assert.ok(srResult, "expected a repaired edit");
  });
});

describe("parseEdits convenience", () => {
  it("returns normalized edits without touching disk", () => {
    const r = ef.parseEdits("x.js\n<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE");
    assert.equal(r.edits.length, 1);
    assert.equal(r.edits[0].path, "x.js");
  });
});

describe("module surface", () => {
  it("exposes the documented API", () => {
    for (const k of ["detect", "searchReplace", "unifiedDiff", "wholeFile", "locate",
      "validate", "apply", "render", "applyModelOutput", "parseEdits"]) {
      assert.ok(ef[k], `missing export: ${k}`);
    }
  });
});
