"use strict";
// Tests for the end-to-end Query API: budget-bounded retrieval, why-selected
// explanations, topN capping, diversity, hybrid integration, and determinism.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const retrieval = require("../../src/retrieval");

const FILES = [
  { file: "src/io.js", source: 'const fs = require("fs");\nexport function parseConfigFile(p) {\n  const raw = fs.readFileSync(p);\n  return JSON.parse(raw);\n}\nexport function writeOutput(d) { return d; }\n' },
  { file: "src/net.js", source: 'import { parseConfigFile } from "./io";\nexport class HttpClient {\n  sendRequest(o) { return parseConfigFile(o.cfg); }\n  get(u) { return u; }\n}\n' },
  { file: "src/math.js", source: 'export function computeChecksum(buf) {\n  let sum = 0;\n  for (const b of buf) sum += b;\n  return sum;\n}\n' },
  // a near-duplicate of math.js to exercise diversity
  { file: "src/math2.js", source: 'export function computeChecksum2(buffer) {\n  let total = 0;\n  for (const x of buffer) total += x;\n  return total;\n}\n' },
];

describe("Retrieval — Query API", () => {
  const idx = retrieval.indexFiles(FILES);

  it("returns the most relevant chunk first", () => {
    const res = idx.retrieve("parse config file", { budget: 600, topN: 5 });
    assert.ok(res.count > 0);
    assert.equal(res.chunks[0].name, "parseConfigFile");
  });

  it("respects the token budget", () => {
    const res = idx.retrieve("parse config file", { budget: 40, topN: 5 });
    assert.ok(res.usedTokens <= 40, "used tokens within budget, got " + res.usedTokens);
    // every included chunk individually fits
    for (const c of res.chunks) assert.ok(c.tokens <= 40);
  });

  it("drops lower-value chunks that do not fit the budget", () => {
    const tiny = idx.retrieve("parse config checksum", { budget: 30, topN: 10 });
    const big = idx.retrieve("parse config checksum", { budget: 2000, topN: 10 });
    assert.ok(big.count >= tiny.count);
    assert.ok(tiny.dropped.length > 0 || tiny.count < big.count);
  });

  it("caps results to topN", () => {
    const res = idx.retrieve("parse config checksum compute", { budget: 100000, topN: 2 });
    assert.ok(res.count <= 2);
  });

  it("provides a why-selected explanation per chunk", () => {
    const res = idx.retrieve("parse config file", { budget: 600, topN: 3 });
    assert.ok(Array.isArray(res.chunks[0].why));
    assert.ok(res.chunks[0].why.some((w) => /matched terms/.test(w)));
  });

  it("includes line spans and an assembled context string", () => {
    const res = idx.retrieve("parse config file", { budget: 600, topN: 3 });
    const c = res.chunks[0];
    assert.ok(c.startLine >= 1 && c.endLine >= c.startLine);
    assert.ok(res.context.includes(c.file));
    assert.ok(res.context.includes("parseConfigFile"));
  });

  it("uses the hybrid structural signal when codegraph is attached", () => {
    assert.ok(idx.cgIndex, "codegraph index built for hybrid");
    const res = idx.retrieve("parse config file", { budget: 600, topN: 3 });
    const top = res.chunks[0];
    assert.ok(top.struct > 0, "structural score contributes");
    assert.ok(top.why.some((w) => /impl match|defines symbol/.test(w)));
  });

  it("diversifies near-duplicate chunks (MMR redundancy annotated)", () => {
    const res = idx.retrieve("compute checksum", { budget: 2000, topN: 5 });
    const names = res.chunks.map((c) => c.name);
    assert.ok(names.includes("computeChecksum"));
    // the second checksum variant, if present, carries a redundancy signal
    const dup = res.chunks.find((c) => c.name === "computeChecksum2");
    if (dup) assert.ok(dup.redundancy > 0, "near-duplicate flagged redundant");
  });

  it("falls back to pure-lexical when hybrid is disabled", () => {
    const res = idx.retrieve("parse config file", { budget: 600, topN: 3, hybrid: false });
    assert.ok(res.count > 0);
    assert.equal(res.chunks[0].struct, 0);
  });

  it("supports the TF-IDF cosine scorer", () => {
    const res = idx.retrieve("parse config file", { budget: 600, topN: 3, scorer: "cosine" });
    assert.ok(res.count > 0);
  });

  it("returns empty for an all-stopword / empty query", () => {
    assert.equal(idx.retrieve("the of a", { budget: 500 }).count, 0);
    assert.equal(idx.retrieve("", { budget: 500 }).count, 0);
  });

  it("returns empty when nothing matches", () => {
    const res = idx.retrieve("xyzzy_nonexistent_symbol", { budget: 500 });
    assert.equal(res.count, 0);
  });

  it("is deterministic", () => {
    const a = retrieval.indexFiles(FILES).retrieve("parse config file", { budget: 600, topN: 4 });
    const b = retrieval.indexFiles(FILES).retrieve("parse config file", { budget: 600, topN: 4 });
    assert.deepEqual(a.chunks.map((c) => c.id), b.chunks.map((c) => c.id));
    assert.deepEqual(a.chunks.map((c) => c.score), b.chunks.map((c) => c.score));
  });
});

describe("Retrieval — no-budget mode", () => {
  it("returns topN by score when no budget is given", () => {
    const idx = retrieval.indexFiles(FILES);
    const res = idx.retrieve("parse config file", { topN: 2 });
    assert.ok(res.count <= 2);
    assert.equal(res.strategy, "topN");
  });
});
