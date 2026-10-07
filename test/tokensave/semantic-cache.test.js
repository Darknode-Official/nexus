"use strict";
// Tests for the SimHash/MinHash near-duplicate response cache.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  SemanticCache, simhash, hamming, simhashSimilarity,
  minhash, minhashSimilarity, shingles, fnv1a64,
} = require("../../src/tokensave/semantic-cache");

describe("SimHash primitives", () => {
  it("fnv1a64 is deterministic and 64-bit", () => {
    const a = fnv1a64("hello");
    assert.equal(a, fnv1a64("hello"));
    assert.notEqual(a, fnv1a64("world"));
    assert.ok(a < (1n << 64n));
  });

  it("identical text has hamming distance 0", () => {
    const t = "scan the target for open ports and services";
    assert.equal(hamming(simhash(t), simhash(t)), 0);
    assert.equal(simhashSimilarity(simhash(t), simhash(t)), 1);
  });

  it("paraphrases are hamming-close", () => {
    const a = simhash("scan the target for open ports");
    const b = simhash("please scan the target for open ports now");
    assert.ok(hamming(a, b) <= 8, "distance " + hamming(a, b));
  });

  it("unrelated text is hamming-far", () => {
    const a = simhash("write a recursive descent parser in rust");
    const b = simhash("bake a chocolate cake with vanilla frosting");
    assert.ok(hamming(a, b) > 8, "distance " + hamming(a, b));
  });

  it("empty text yields a zero fingerprint", () => {
    assert.equal(simhash(""), 0n);
    assert.deepEqual(shingles(""), []);
  });
});

describe("MinHash primitives", () => {
  it("identical sets estimate Jaccard 1", () => {
    const t = "the quick brown fox jumps over the lazy dog";
    assert.equal(minhashSimilarity(minhash(t), minhash(t)), 1);
  });

  it("overlapping sets estimate partial similarity", () => {
    const a = minhash("scan target for open ports services");
    const b = minhash("scan target for open ports");
    const sim = minhashSimilarity(a, b);
    assert.ok(sim > 0.4 && sim < 1, "sim=" + sim);
  });

  it("disjoint sets estimate low similarity", () => {
    const a = minhash("alpha beta gamma delta epsilon");
    const b = minhash("one two three four five six");
    assert.ok(minhashSimilarity(a, b) < 0.2);
  });
});

describe("SemanticCache — hits and misses", () => {
  it("returns a hit for an exact repeat", () => {
    const c = new SemanticCache();
    c.set("how do I scan for open ports", { answer: "use nmap -sV" });
    const r = c.get("how do I scan for open ports");
    assert.equal(r.hit, true);
    assert.deepEqual(r.value, { answer: "use nmap -sV" });
    assert.equal(r.distance, 0);
  });

  it("returns a hit for a near-duplicate within threshold", () => {
    const c = new SemanticCache({ maxHamming: 10 });
    c.set("scan the target host for open ports and running services", { answer: "nmap" });
    const r = c.get("please scan the target host for open ports and running services now");
    assert.equal(r.hit, true, "near-duplicate should hit");
    assert.ok(r.similarity > 0.85);
  });

  it("returns a miss for unrelated input", () => {
    const c = new SemanticCache();
    c.set("explain how TLS handshakes work in detail", "...");
    const r = c.get("what is the capital of France and its population");
    assert.equal(r.hit, false);
  });

  it("tracks hit/miss stats and hit rate", () => {
    const c = new SemanticCache();
    c.set("foo bar baz qux quux corge", 1);
    c.get("foo bar baz qux quux corge"); // hit
    c.get("totally different unrelated query string here"); // miss
    assert.equal(c.stats.hits, 1);
    assert.equal(c.stats.misses, 1);
    assert.equal(c.hitRate(), 0.5);
  });
});

describe("SemanticCache — TTL and size bounds", () => {
  it("expires entries past the TTL", async () => {
    const c = new SemanticCache({ ttlMs: 20 });
    c.set("ephemeral query about something specific here", "v");
    assert.equal(c.get("ephemeral query about something specific here").hit, true);
    await new Promise((res) => setTimeout(res, 35));
    assert.equal(c.get("ephemeral query about something specific here").hit, false);
    assert.ok(c.stats.expirations >= 1);
  });

  it("prune() removes expired entries", async () => {
    const c = new SemanticCache({ ttlMs: 15 });
    c.set("alpha query one two three four five", "a");
    c.set("beta query six seven eight nine ten", "b");
    await new Promise((res) => setTimeout(res, 30));
    const purged = c.prune();
    assert.equal(purged, 2);
    assert.equal(c.size, 0);
  });

  it("enforces the max-entries size bound by evicting oldest", () => {
    const c = new SemanticCache({ maxEntries: 3 });
    for (let i = 0; i < 6; i++) c.set("unique query number " + i + " with some filler words", i);
    assert.equal(c.size, 3);
    assert.ok(c.stats.evictions >= 3);
    // The earliest inserted should be gone.
    assert.equal(c.get("unique query number 0 with some filler words").hit, false);
    // A recent one should remain.
    assert.equal(c.get("unique query number 5 with some filler words").hit, true);
  });

  it("clear() resets everything", () => {
    const c = new SemanticCache();
    c.set("something to cache here now", 1);
    c.get("something to cache here now");
    c.clear();
    assert.equal(c.size, 0);
    assert.equal(c.stats.hits, 0);
  });

  it("deterministic tie-break prefers the earliest matching entry", () => {
    const c = new SemanticCache({ maxHamming: 64 }); // everything matches
    const id1 = c.set("the same base phrase one two three", "first");
    c.set("the same base phrase one two three", "second");
    const r = c.get("the same base phrase one two three");
    assert.equal(r.id, id1, "should return the earliest-inserted matching entry");
    assert.equal(r.value, "first");
  });
});
