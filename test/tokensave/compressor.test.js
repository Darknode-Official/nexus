"use strict";
// Tests for the prompt compressor, with heavy emphasis on the SAFETY CONTRACT:
// protected regions must survive byte-for-byte.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { compress, mask, unmask } = require("../../src/tokensave/compressor");

describe("Compressor — basic behavior", () => {
  it("returns a report with token deltas", () => {
    const r = compress("Please kindly fix the bug.   \n\n\n\n  Thanks.", { level: 2, model: "gpt" });
    assert.ok(typeof r.before === "number" && typeof r.after === "number");
    assert.ok(r.after <= r.before);
    assert.ok(r.saved >= 0);
    assert.equal(r.saved, Math.max(0, r.before - r.after));
  });

  it("collapses whitespace at level 0", () => {
    const r = compress("line1   with    spaces\n\n\n\n\nline2", { level: 0 });
    assert.ok(!/\n{3,}/.test(r.text), "no 3+ newline runs");
    assert.ok(!/ {2,}/.test(r.text), "no multi-space runs");
  });

  it("removes filler words at level 1+", () => {
    const r = compress("This is basically just a really very simple task.", { level: 1 });
    assert.ok(!/\bbasically\b/i.test(r.text));
    assert.ok(!/\breally\b/i.test(r.text));
    assert.ok(/simple task/i.test(r.text));
  });

  it("removes politeness phrases at level 2+", () => {
    const r = compress("Could you please fix the parser in order to pass the tests?", { level: 2 });
    assert.ok(!/could you please/i.test(r.text));
    assert.ok(/\bto pass the tests\b/i.test(r.text), "'in order to' -> 'to': " + r.text);
  });

  it("de-duplicates redundant sentences at level 2+", () => {
    const input = "Fix the authentication bug now. Fix the authentication bug now. Then run the tests.";
    const r = compress(input, { level: 2 });
    const occurrences = (r.text.match(/fix the authentication bug now/gi) || []).length;
    assert.equal(occurrences, 1, "duplicate instruction should be dropped: " + r.text);
    assert.ok(/run the tests/i.test(r.text));
  });

  it("higher levels never produce longer output than lower levels", () => {
    const input = "Please, basically, could you please fix the bug in order to pass? Fix the bug in order to pass.";
    const l0 = compress(input, { level: 0 }).after;
    const l3 = compress(input, { level: 3 }).after;
    assert.ok(l3 <= l0, "l3=" + l3 + " l0=" + l0);
  });
});

describe("Compressor — SAFETY CONTRACT (protected regions)", () => {
  it("never alters fenced code blocks", () => {
    const code = "```js\nconst  reallyLongName = 1;   // please keep    spacing\n\n\n\nbasically();\n```";
    const input = "Please fix this really important thing:\n\n" + code + "\n\nThanks basically.";
    const r = compress(input, { level: 3 });
    assert.ok(r.text.includes(code), "fenced block must be preserved verbatim");
  });

  it("never alters inline code", () => {
    const r = compress("Call `really.basically.fn( x )` please to just run it.", { level: 3 });
    assert.ok(r.text.includes("`really.basically.fn( x )`"));
  });

  it("never alters URLs", () => {
    const url = "https://example.com/path?please=really&x=just";
    const r = compress("Fetch " + url + " please.", { level: 3 });
    assert.ok(r.text.includes(url), "URL preserved: " + r.text);
  });

  it("never alters file paths", () => {
    const r = compress("Edit ./src/really_basically.js and config/just.config.yaml please.", { level: 3 });
    assert.ok(r.text.includes("./src/really_basically.js"));
    assert.ok(r.text.includes("config/just.config.yaml"));
  });

  it("never alters quoted strings", () => {
    const r = compress('Set the flag to "please really just do it" exactly.', { level: 3 });
    assert.ok(r.text.includes('"please really just do it"'));
  });

  it("never alters technical identifiers (camelCase, snake_case, dotted)", () => {
    const r = compress("Rename reallyBasicallyVar and just_a_filler and a.b.reallyField please.", { level: 3 });
    assert.ok(r.text.includes("reallyBasicallyVar"), r.text);
    assert.ok(r.text.includes("just_a_filler"), r.text);
    assert.ok(r.text.includes("a.b.reallyField"), r.text);
  });

  it("mask/unmask round-trips to the original", () => {
    const input = "mix `code` and https://x.y and ./a/b.js and \"str\" and camelCase and plain words";
    const { masked, spans } = mask(input);
    assert.equal(unmask(masked, spans), input);
  });
});

describe("Compressor — edge cases", () => {
  it("handles empty input", () => {
    const r = compress("", { level: 3 });
    assert.equal(r.text, "");
    assert.equal(r.before, 0);
    assert.equal(r.after, 0);
    assert.equal(r.savedPct, 0);
  });

  it("handles nullish input", () => {
    const r = compress(null, { level: 2 });
    assert.equal(r.text, "");
  });

  it("clamps the level to 0..3", () => {
    assert.equal(compress("x", { level: 99 }).level, 3);
    assert.equal(compress("x", { level: -5 }).level, 0);
  });

  it("defaults to level 2 when unspecified", () => {
    assert.equal(compress("hello").level, 2);
  });

  it("does not drop short repeated fragments (bullets, 'Yes.')", () => {
    const r = compress("Yes. Yes. No.", { level: 2 });
    // Short fragments (<15 normalized chars) are never de-duped.
    assert.ok((r.text.match(/yes/gi) || []).length >= 2);
  });
});
