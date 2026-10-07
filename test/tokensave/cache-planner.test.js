"use strict";
// Tests for the provider prompt-cache planner.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { plan, describe: describeProvider, normalizeProvider, isStable } = require("../../src/tokensave/cache-planner");

const bigDoc = "x ".repeat(2000); // ~1000+ tokens of stable content

describe("cache-planner — provider normalization", () => {
  it("maps provider/model strings to canonical providers", () => {
    assert.equal(normalizeProvider("claude-opus-4"), "anthropic");
    assert.equal(normalizeProvider("anthropic"), "anthropic");
    assert.equal(normalizeProvider("gpt-5"), "openai");
    assert.equal(normalizeProvider("openai"), "openai");
    assert.equal(normalizeProvider("gemini-2.5"), "generic");
  });

  it("classifies stable vs dynamic segments", () => {
    assert.equal(isStable({ kind: "system", content: "x" }), true);
    assert.equal(isStable({ kind: "tools", content: "x" }), true);
    assert.equal(isStable({ kind: "user", content: "x" }), false);
    assert.equal(isStable({ stable: true, content: "x" }), true);
    assert.equal(isStable({ stable: false, kind: "system", content: "x" }), false);
  });
});

describe("cache-planner — Anthropic", () => {
  it("emits cache_control breakpoints on the stable prefix", () => {
    const segs = [
      { kind: "system", content: "You are an expert." },
      { kind: "tools", content: bigDoc },
      { kind: "user", content: "fix the bug" },
    ];
    const r = plan(segs, { provider: "anthropic", model: "claude-opus-4" });
    assert.equal(r.provider, "anthropic");
    assert.ok(r.breakpoints.length >= 1);
    // The dynamic user message must be last and must NOT carry cache_control.
    const last = r.messages[r.messages.length - 1];
    assert.equal(last.role, "user");
    assert.ok(!last.cache_control);
    // At least one stable message has cache_control.
    assert.ok(r.messages.some((m) => m.cache_control && m.cache_control.type === "ephemeral"));
  });

  it("never emits more than 4 breakpoints", () => {
    const segs = Array.from({ length: 8 }, (_, i) => ({ kind: "context", content: "doc " + i + " " + bigDoc }));
    segs.push({ kind: "user", content: "go" });
    const r = plan(segs, { provider: "anthropic" });
    assert.ok(r.breakpoints.length <= 4, "breakpoints=" + r.breakpoints.length);
  });

  it("reorders dynamic-before-stable into stable-first", () => {
    const segs = [
      { kind: "user", content: "the question" },
      { kind: "system", content: bigDoc },
    ];
    const r = plan(segs, { provider: "anthropic" });
    assert.equal(r.reordered, true);
    assert.equal(r.messages[0].role, "system");
    assert.ok(r.notes.some((n) => /reordered/i.test(n)));
  });

  it("reports qualifies=true when a stable prefix exists", () => {
    const r = plan([{ kind: "system", content: bigDoc }, { kind: "user", content: "hi" }], { provider: "anthropic" });
    assert.equal(r.qualifies, true);
    assert.ok(r.estimatedCacheableTokens > 0);
  });

  it("notes when there is nothing stable to cache", () => {
    const r = plan([{ kind: "user", content: "just a question" }], { provider: "anthropic" });
    assert.equal(r.qualifies, false);
    assert.equal(r.breakpoints.length, 0);
  });
});

describe("cache-planner — OpenAI", () => {
  it("emits no breakpoints but orders stable-first", () => {
    const segs = [
      { kind: "system", content: bigDoc },
      { kind: "user", content: "fix it" },
    ];
    const r = plan(segs, { provider: "openai", model: "gpt-5" });
    assert.equal(r.breakpoints.length, 0);
    assert.equal(r.messages[0]._kind, "system");
    assert.equal(r.messages[r.messages.length - 1]._kind, "user");
  });

  it("qualifies only when the stable prefix meets the auto-cache threshold", () => {
    const big = plan([{ kind: "system", content: bigDoc }, { kind: "user", content: "x" }], { provider: "openai" });
    assert.equal(big.qualifies, true);
    const small = plan([{ kind: "system", content: "short system prompt" }, { kind: "user", content: "x" }], { provider: "openai" });
    assert.equal(small.qualifies, false);
    assert.ok(small.notes.some((n) => /below the automatic-cache threshold/i.test(n)));
  });
});

describe("cache-planner — describe()", () => {
  it("describes each provider's caching", () => {
    assert.ok(/cache_control/.test(describeProvider("anthropic")));
    assert.ok(/automatic/i.test(describeProvider("openai")));
    assert.ok(describeProvider("gemini").length > 0);
  });
});
