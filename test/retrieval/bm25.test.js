"use strict";
// Tests for the inverted index: BM25 ranking correctness on fixtures, TF-IDF
// cosine, idf behaviour, incremental add/remove consistency, determinism and
// serialization.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { createIndex } = require("../../src/retrieval/bm25");
const { tokenize } = require("../../src/retrieval/tokenize");

function build(docs) {
  const idx = createIndex();
  for (const [id, text] of Object.entries(docs)) idx.add(id, tokenize(text));
  return idx;
}

describe("Retrieval — BM25 ranking", () => {
  const idx = build({
    d1: "the quick brown fox jumps",
    d2: "a quick brown dog runs quick quick",   // 'quick' thrice
    d3: "slow green turtle sleeps",
    d4: "quick brown fox and quick brown fox",   // 'quick' twice, long doc
  });

  it("ranks documents containing the query term, by relevance", () => {
    const hits = idx.bm25(["quick"]);
    const ids = hits.map((h) => h.id);
    assert.ok(ids.includes("d2") && ids.includes("d1") && ids.includes("d4"));
    assert.ok(!ids.includes("d3"), "doc without term excluded");
  });

  it("term frequency increases score (saturating)", () => {
    const hits = idx.bm25(["quick"]);
    const d2 = hits.find((h) => h.id === "d2").score;
    const d1 = hits.find((h) => h.id === "d1").score;
    assert.ok(d2 > d1, "more occurrences => higher score");
  });

  it("length normalization: shorter doc with same tf scores higher (b>0)", () => {
    const i2 = createIndex();
    i2.add("short", tokenize("alpha beta"));
    i2.add("long", tokenize("alpha beta " + "filler ".repeat(40)));
    const hits = i2.bm25(["alpha"], { b: 0.75 });
    const s = hits.find((h) => h.id === "short").score;
    const l = hits.find((h) => h.id === "long").score;
    assert.ok(s > l, "shorter document ranks higher for the same term");
  });

  it("rarer terms get more weight (idf)", () => {
    const i3 = createIndex();
    i3.add("a", tokenize("common rare_term"));
    i3.add("b", tokenize("common common"));
    i3.add("c", tokenize("common filler"));
    // 'common' appears in all 3 (low idf), 'rareterm' in 1 (high idf).
    assert.ok(i3.idf("rareterm") > i3.idf("common"));
  });

  it("k1/b are tunable and change scores", () => {
    const h1 = idx.bm25(["quick"], { k1: 0.5 });
    const h2 = idx.bm25(["quick"], { k1: 2.0 });
    const s1 = h1.find((h) => h.id === "d2").score;
    const s2 = h2.find((h) => h.id === "d2").score;
    assert.notEqual(s1, s2);
  });

  it("reports which query terms matched", () => {
    const hits = idx.bm25(["quick", "fox"]);
    const d1 = hits.find((h) => h.id === "d1");
    assert.deepEqual(d1.matched.sort(), ["fox", "quick"]);
  });

  it("is deterministic and breaks ties by id", () => {
    const a = createIndex(), b = createIndex();
    a.add("z", tokenize("same words")); a.add("a", tokenize("same words"));
    b.add("a", tokenize("same words")); b.add("z", tokenize("same words"));
    const ha = a.bm25(["same"]).map((h) => h.id);
    const hb = b.bm25(["same"]).map((h) => h.id);
    assert.deepEqual(ha, hb);
    assert.deepEqual(ha, ["a", "z"], "equal scores => id order");
  });

  it("respects limit and minScore", () => {
    assert.equal(idx.bm25(["quick"], { limit: 1 }).length, 1);
    assert.equal(idx.bm25(["quick"], { minScore: 1e9 }).length, 0);
  });
});

describe("Retrieval — incremental add/remove consistency", () => {
  it("removing a doc restores the index to its prior state", () => {
    const base = build({ d1: "alpha beta", d2: "beta gamma" });
    const before = JSON.stringify(base.stats());
    base.add("tmp", tokenize("alpha alpha gamma"));
    base.remove("tmp");
    assert.equal(JSON.stringify(base.stats()), before, "stats identical after add+remove");
    assert.deepEqual(
      base.bm25(["alpha"]).map((h) => h.id),
      ["d1"],
    );
  });

  it("re-adding an existing id replaces it", () => {
    const i = createIndex();
    i.add("d", tokenize("alpha alpha"));
    i.add("d", tokenize("beta"));
    assert.equal(i.size(), 1);
    assert.equal(i.bm25(["alpha"]).length, 0);
    assert.equal(i.bm25(["beta"]).length, 1);
  });

  it("df and postings are cleaned up when the last doc with a term is removed", () => {
    const i = createIndex();
    i.add("d", tokenize("unique_token shared"));
    i.add("e", tokenize("shared"));
    i.remove("d");
    assert.equal(i.idf("uniquetoken"), 0, "term gone => idf 0");
    assert.ok(i.bm25(["shared"]).length === 1);
  });
});

describe("Retrieval — TF-IDF cosine", () => {
  const idx = build({
    d1: "parse import statement from module",
    d2: "write output data to file",
    d3: "parse the import clause",
  });
  it("scores are in [0,1] and rank the best lexical overlap first", () => {
    const hits = idx.cosine(tokenize("parse import"));
    assert.ok(hits.length >= 2);
    assert.ok(hits.every((h) => h.score >= 0 && h.score <= 1.0001));
    assert.ok(["d1", "d3"].includes(hits[0].id));
  });
  it("excludes documents with no shared terms", () => {
    const hits = idx.cosine(tokenize("parse import"));
    assert.ok(!hits.map((h) => h.id).includes("d2"));
  });
});

describe("Retrieval — serialization", () => {
  it("round-trips via toJSON/fromJSON preserving rankings", () => {
    const idx = build({ d1: "alpha beta", d2: "beta gamma gamma" });
    const snap = JSON.parse(JSON.stringify(idx.toJSON()));
    const idx2 = createIndex().fromJSON(snap);
    assert.deepEqual(idx.bm25(["gamma"]), idx2.bm25(["gamma"]));
    assert.equal(idx2.stats().docs, 2);
  });
});
