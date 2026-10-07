"use strict";
// Tests for the generic personalized PageRank engine: distribution correctness on
// known graphs, dangling-node mass conservation, weighting, personalization shift,
// and determinism.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { pageRank, ranked, buildPersonalization } = require("../../src/repomap/pagerank");

function sum(map) { let s = 0; for (const v of map.values()) s += v; return s; }

describe("Repo Map — PageRank", () => {
  it("returns an empty distribution for an empty graph", () => {
    const r = pageRank({ nodes: [], edges: [] });
    assert.equal(r.rank.size, 0);
    assert.equal(r.converged, true);
  });

  it("distribution always sums to ~1", () => {
    const r = pageRank({
      nodes: ["a", "b", "c", "d"],
      edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "c", to: "a" }, { from: "d", to: "a" }],
    });
    assert.ok(Math.abs(sum(r.rank) - 1) < 1e-9, "sum=" + sum(r.rank));
  });

  it("is symmetric: a two-node mutual link splits rank evenly", () => {
    const r = pageRank({ nodes: ["a", "b"], edges: [{ from: "a", to: "b" }, { from: "b", to: "a" }] });
    assert.ok(Math.abs(r.rank.get("a") - 0.5) < 1e-6);
    assert.ok(Math.abs(r.rank.get("b") - 0.5) < 1e-6);
  });

  it("ranks a hub above its referrers (star graph)", () => {
    const r = pageRank({
      nodes: ["hub", "a", "b", "c"],
      edges: [{ from: "a", to: "hub" }, { from: "b", to: "hub" }, { from: "c", to: "hub" }],
    });
    const top = ranked(r.rank);
    assert.equal(top[0].id, "hub");
    assert.ok(r.rank.get("hub") > r.rank.get("a"));
  });

  it("conserves mass with dangling nodes (no out-edges)", () => {
    // 'sink' has no out-edges; its rank must flow back via teleport, not vanish.
    const r = pageRank({ nodes: ["a", "b", "sink"], edges: [{ from: "a", to: "sink" }, { from: "b", to: "sink" }] });
    assert.ok(Math.abs(sum(r.rank) - 1) < 1e-9);
    assert.ok(r.rank.get("sink") > r.rank.get("a"));
  });

  it("respects edge weights: the heavier target gets more rank", () => {
    const r = pageRank({
      nodes: ["src", "light", "heavy"],
      edges: [{ from: "src", to: "light", weight: 1 }, { from: "src", to: "heavy", weight: 9 }],
    });
    assert.ok(r.rank.get("heavy") > r.rank.get("light"));
  });

  it("ignores self-loops and non-positive weights", () => {
    const r = pageRank({
      nodes: ["a", "b"],
      edges: [{ from: "a", to: "a", weight: 5 }, { from: "a", to: "b", weight: 0 }, { from: "a", to: "b", weight: -3 }],
    });
    // 'a' effectively dangling -> teleports; distribution still valid and summing to 1.
    assert.ok(Math.abs(sum(r.rank) - 1) < 1e-9);
  });

  it("personalization shifts mass toward the seed", () => {
    const graph = { nodes: ["a", "b", "c"], edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }] };
    const uniform = pageRank(graph);
    const seeded = pageRank(graph, { personalization: { a: 1 } });
    assert.ok(seeded.rank.get("a") > uniform.rank.get("a"), "seed node should gain mass");
  });

  it("personalization accepts a Map and normalizes it", () => {
    const graph = { nodes: ["a", "b", "c"], edges: [{ from: "a", to: "b" }] };
    const r = pageRank(graph, { personalization: new Map([["c", 10], ["a", 0]]) });
    assert.ok(r.rank.get("c") > r.rank.get("b"));
  });

  it("is deterministic across runs", () => {
    const graph = {
      nodes: ["x", "y", "z", "w"],
      edges: [{ from: "x", to: "y", weight: 2 }, { from: "y", to: "z" }, { from: "z", to: "x" }, { from: "w", to: "y" }],
    };
    const a = pageRank(graph);
    const b = pageRank(graph);
    for (const k of a.rank.keys()) assert.equal(a.rank.get(k), b.rank.get(k));
  });

  it("converges well within the iteration cap on a small graph", () => {
    const r = pageRank({ nodes: ["a", "b", "c"], edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "c", to: "a" }] }, { tol: 1e-10 });
    assert.ok(r.converged);
    assert.ok(r.iterations < 200);
  });

  it("ranked() sorts by descending score with id tie-break", () => {
    const m = new Map([["b", 0.3], ["a", 0.3], ["c", 0.4]]);
    const order = ranked(m).map((x) => x.id);
    assert.deepEqual(order, ["c", "a", "b"]);
  });

  it("buildPersonalization falls back to uniform when empty", () => {
    const p = buildPersonalization(null, ["a", "b", "c", "d"], new Map());
    for (const v of p) assert.ok(Math.abs(v - 0.25) < 1e-12);
  });
});
