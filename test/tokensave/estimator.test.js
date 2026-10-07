"use strict";
// Tests for the token estimator and savings ledger.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { estimateTokens, estimateMessages, familyOf, profileOf, Ledger } = require("../../src/tokensave/estimator");

describe("Estimator — estimateTokens", () => {
  it("returns 0 for empty/nullish input", () => {
    assert.equal(estimateTokens(""), 0);
    assert.equal(estimateTokens(null), 0);
    assert.equal(estimateTokens(undefined), 0);
  });

  it("is deterministic", () => {
    const t = "The quick brown fox jumps over the lazy dog.";
    assert.equal(estimateTokens(t, "gpt"), estimateTokens(t, "gpt"));
  });

  it("scales monotonically with length", () => {
    const small = estimateTokens("hello world", "gpt");
    const big = estimateTokens("hello world ".repeat(50), "gpt");
    assert.ok(big > small);
  });

  it("is in a sane range for prose (~chars/4 ballpark)", () => {
    const text = "a".repeat(400).split("").join(""); // 400 chars, one long word though
    // Use real prose instead: 100 short words ~ 100-140 tokens
    const prose = Array.from({ length: 100 }, () => "word").join(" ");
    const est = estimateTokens(prose, "gpt");
    assert.ok(est >= 80 && est <= 180, "est=" + est);
  });

  it("differs by model family but stays close", () => {
    const t = "implement a recursive descent parser for arithmetic expressions";
    const gpt = estimateTokens(t, "gpt");
    const claude = estimateTokens(t, "claude");
    assert.ok(gpt > 0 && claude > 0);
    assert.ok(Math.abs(gpt - claude) <= Math.max(gpt, claude) * 0.3, "families should be within 30%");
  });
});

describe("Estimator — familyOf / profileOf", () => {
  it("maps model ids to families", () => {
    assert.equal(familyOf("claude-opus-4-8"), "claude");
    assert.equal(familyOf("gpt-5-codex"), "gpt");
    assert.equal(familyOf("gemini-2.5-pro"), "gemini");
    assert.equal(familyOf("llama3.1:70b"), "llama");
    assert.equal(familyOf("qwen2.5-coder"), "llama");
    assert.equal(familyOf("something-unknown"), "generic");
    assert.equal(familyOf(""), "generic");
  });

  it("returns a profile object with required fields", () => {
    const p = profileOf("claude");
    assert.ok(typeof p.charsPerToken === "number");
    assert.ok(typeof p.otherDivisor === "number");
    assert.ok(typeof p.scale === "number");
  });
});

describe("Estimator — estimateMessages", () => {
  it("adds per-message framing overhead", () => {
    const one = estimateMessages([{ role: "user", content: "hi" }], "gpt");
    const bare = estimateTokens("hi", "gpt");
    assert.ok(one > bare, "messages should cost more than raw text due to framing");
  });

  it("handles array content blocks", () => {
    const n = estimateMessages([
      { role: "system", content: "You are helpful." },
      { role: "user", content: [{ type: "text", text: "explain closures" }] },
    ], "claude");
    assert.ok(n > 0);
  });

  it("falls back to estimateTokens for a non-array", () => {
    assert.equal(estimateMessages("plain string", "gpt"), estimateTokens("plain string", "gpt"));
  });
});

describe("Estimator — Ledger", () => {
  it("records savings and computes totals", () => {
    const l = new Ledger("gpt");
    l.record("compressor", { before: 100, after: 70 });
    l.record("diff-context", { before: 500, after: 50 });
    assert.equal(l.totalSaved(), 30 + 450);
    assert.equal(l.totalBefore(), 600);
    assert.equal(l.overallPct(), +(100 * 480 / 600).toFixed(1));
  });

  it("estimates before/after from text when counts omitted", () => {
    const l = new Ledger("gpt");
    const e = l.record("compressor", { beforeText: "please kindly do the thing", afterText: "do the thing" });
    assert.ok(e.before > e.after);
    assert.ok(e.saved > 0);
  });

  it("never records negative savings", () => {
    const l = new Ledger();
    const e = l.record("x", { before: 10, after: 40 });
    assert.equal(e.saved, 0);
  });

  it("groups by technique and renders a report", () => {
    const l = new Ledger("claude");
    l.record("compressor", { before: 100, after: 80 });
    l.record("compressor", { before: 50, after: 40 });
    const by = l.byTechnique();
    assert.equal(by.compressor.count, 2);
    assert.equal(by.compressor.saved, 30);
    const r = l.report();
    assert.ok(r.includes("compressor"));
    assert.ok(r.includes("TOTAL"));
  });

  it("handles an empty ledger", () => {
    const l = new Ledger();
    assert.equal(l.totalSaved(), 0);
    assert.equal(l.overallPct(), 0);
    assert.ok(l.report().includes("TOTAL"));
  });
});
