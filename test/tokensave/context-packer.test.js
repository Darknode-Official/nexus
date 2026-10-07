"use strict";
// Tests for the knapsack context packer.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { pack, assemble, canonicalSort, normalize } = require("../../src/tokensave/context-packer");

describe("Context packer — budget enforcement", () => {
  it("never exceeds the budget", () => {
    const chunks = [
      { id: "a", tokens: 60, relevance: 0.9 },
      { id: "b", tokens: 60, relevance: 0.8 },
      { id: "c", tokens: 60, relevance: 0.7 },
    ];
    const r = pack(chunks, 150);
    assert.ok(r.usedTokens <= 150, "used=" + r.usedTokens);
    assert.ok(r.included.length <= 2);
  });

  it("packs the highest-relevance chunks first when they fit", () => {
    const chunks = [
      { id: "low", tokens: 100, relevance: 0.1 },
      { id: "high", tokens: 100, relevance: 0.9 },
    ];
    const r = pack(chunks, 100);
    assert.equal(r.included.length, 1);
    assert.equal(r.included[0].id, "high");
    assert.equal(r.dropped[0].id, "low");
  });

  it("drops chunks that exceed the entire budget with a clear reason", () => {
    const chunks = [{ id: "huge", tokens: 5000, relevance: 1 }];
    const r = pack(chunks, 1000);
    assert.equal(r.included.length, 0);
    assert.ok(/exceeds entire budget/.test(r.dropped[0].reason));
  });

  it("maximizes total relevance (exact knapsack) over naive greedy", () => {
    // Greedy-by-ratio would take two 0.6/50 items (1.2). Exact should still find
    // the best fit; here optimum is the two 0.6 items = 1.2 within budget 100.
    const chunks = [
      { id: "x", tokens: 80, relevance: 1.0 },  // ratio 0.0125
      { id: "y", tokens: 50, relevance: 0.6 },  // ratio 0.012
      { id: "z", tokens: 50, relevance: 0.6 },  // ratio 0.012
    ];
    const r = pack(chunks, 100);
    // Optimal within 100 tokens: y+z = 1.2 relevance (beats x alone = 1.0).
    assert.ok(r.totalRelevance >= 1.2 - 1e-9, "totalRelevance=" + r.totalRelevance);
    assert.equal(r.strategy, "exact-dp");
  });

  it("estimates tokens from content when not provided", () => {
    const chunks = [{ id: "a", content: "x ".repeat(200), relevance: 0.5 }];
    const r = pack(chunks, 1000, { model: "gpt" });
    assert.ok(r.included[0].tokens > 0);
  });
});

describe("Context packer — determinism and edge cases", () => {
  it("is deterministic across runs", () => {
    const chunks = Array.from({ length: 10 }, (_, i) => ({ id: "c" + i, tokens: 30 + i, relevance: (i % 3) / 3 }));
    const a = pack(chunks, 120);
    const b = pack(chunks, 120);
    assert.deepEqual(a.included.map((x) => x.id), b.included.map((x) => x.id));
  });

  it("breaks ties deterministically (relevance, then fewer tokens, then id)", () => {
    const chunks = [
      { id: "b", tokens: 50, relevance: 0.5 },
      { id: "a", tokens: 50, relevance: 0.5 },
    ];
    const sorted = canonicalSort(normalize(chunks));
    assert.equal(sorted[0].id, "a"); // same relevance & tokens -> id order
  });

  it("handles zero budget", () => {
    const r = pack([{ id: "a", tokens: 10, relevance: 1 }], 0);
    assert.equal(r.included.length, 0);
    assert.ok(/zero budget/.test(r.dropped[0].reason));
  });

  it("handles empty chunk list", () => {
    const r = pack([], 1000);
    assert.equal(r.included.length, 0);
    assert.equal(r.dropped.length, 0);
    assert.equal(r.usedTokens, 0);
  });

  it("falls back to greedy for very large problems", () => {
    const many = Array.from({ length: 300 }, (_, i) => ({ id: "c" + i, tokens: 500, relevance: Math.random() }));
    const r = pack(many, 1_000_000, { workCap: 1000 });
    assert.equal(r.strategy, "greedy");
    assert.ok(r.usedTokens <= 1_000_000);
  });

  it("assembles included chunks into a labeled string", () => {
    const chunks = [{ id: "a", label: "File A", content: "contents of A", tokens: 5, relevance: 1 }];
    const r = pack(chunks, 1000);
    const text = assemble(r);
    assert.ok(text.includes("File A"));
    assert.ok(text.includes("contents of A"));
  });

  it("produces a readable report", () => {
    const r = pack([{ id: "a", tokens: 10, relevance: 1 }, { id: "b", tokens: 10000, relevance: 1 }], 100);
    assert.ok(r.report.includes("included"));
    assert.ok(r.report.includes("[+]") || r.report.includes("[-]"));
  });
});
