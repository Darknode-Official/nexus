"use strict";
// Tests for MMR diversification: Jaccard similarity, redundancy suppression,
// lambda trade-off and determinism.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { mmr, jaccard } = require("../../src/retrieval/mmr");

describe("Retrieval — Jaccard similarity", () => {
  it("is 1 for identical sets and 0 for disjoint", () => {
    assert.equal(jaccard(new Set([1, 2, 3]), new Set([1, 2, 3])), 1);
    assert.equal(jaccard(new Set([1, 2]), new Set([3, 4])), 0);
  });
  it("computes partial overlap", () => {
    assert.equal(jaccard(new Set([1, 2, 3, 4]), new Set([3, 4, 5, 6])), 2 / 6);
  });
  it("is 0 when either set is empty", () => {
    assert.equal(jaccard(new Set(), new Set([1])), 0);
  });
});

describe("Retrieval — MMR re-ranking", () => {
  it("demotes a near-duplicate of an already-selected chunk", () => {
    const cands = [
      { id: "a", score: 1.0, terms: new Set(["parse", "import", "statement"]) },
      { id: "b", score: 0.98, terms: new Set(["parse", "import", "statement"]) }, // near-dup of a
      { id: "c", score: 0.8, terms: new Set(["write", "output", "file"]) },        // novel
    ];
    const out = mmr(cands, { lambda: 0.6 });
    assert.equal(out[0].id, "a");
    assert.equal(out[1].id, "c", "novel chunk beats the near-duplicate despite lower raw score");
    assert.equal(out[2].id, "b");
    assert.ok(out[2].redundancy > 0.9, "b flagged as highly redundant");
  });

  it("lambda=1 is pure relevance (no diversification)", () => {
    const cands = [
      { id: "a", score: 1.0, terms: new Set(["x", "y"]) },
      { id: "b", score: 0.9, terms: new Set(["x", "y"]) },
      { id: "c", score: 0.5, terms: new Set(["z"]) },
    ];
    const out = mmr(cands, { lambda: 1 }).map((c) => c.id);
    assert.deepEqual(out, ["a", "b", "c"]);
  });

  it("lambda=0 maximizes novelty after the first pick", () => {
    const cands = [
      { id: "a", score: 1.0, terms: new Set(["x", "y"]) },
      { id: "b", score: 0.95, terms: new Set(["x", "y"]) }, // dup
      { id: "c", score: 0.1, terms: new Set(["z"]) },       // novel
    ];
    const out = mmr(cands, { lambda: 0 }).map((c) => c.id);
    assert.equal(out[0], "a");
    assert.equal(out[1], "c", "pure novelty picks the dissimilar chunk next");
  });

  it("respects the limit", () => {
    const cands = [
      { id: "a", score: 1, terms: new Set(["a"]) },
      { id: "b", score: 0.9, terms: new Set(["b"]) },
      { id: "c", score: 0.8, terms: new Set(["c"]) },
    ];
    assert.equal(mmr(cands, { limit: 2 }).length, 2);
  });

  it("is deterministic", () => {
    const mk = () => ([
      { id: "a", score: 0.9, terms: new Set(["p", "q"]) },
      { id: "b", score: 0.9, terms: new Set(["p", "q"]) },
      { id: "c", score: 0.7, terms: new Set(["r"]) },
    ]);
    assert.deepEqual(mmr(mk()).map((c) => c.id), mmr(mk()).map((c) => c.id));
  });

  it("accepts iterables for terms and passes through chunk fields", () => {
    const out = mmr([{ id: "a", score: 1, terms: ["x"], file: "f.js" }]);
    assert.equal(out[0].file, "f.js");
    assert.equal(out[0].redundancy, 0);
  });
});
