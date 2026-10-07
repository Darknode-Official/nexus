"use strict";
// Tests for the lexical+structural hybrid: symbol-name signal, codegraph impl
// mapping, import-proximity boost, and the blend.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const codegraph = require("../../src/codegraph");
const { chunkFiles } = require("../../src/retrieval/chunker");
const { queryTerms } = require("../../src/retrieval/tokenize");
const { structuralScores, blend, buildLineLookup, chunkAtLine } = require("../../src/retrieval/hybrid");

const FILES = [
  { file: "src/io.js", source: 'export function parseConfigFile(p) {\n  return require("fs").readFileSync(p);\n}\nexport function writeOutput(d) { return d; }\n' },
  { file: "src/net.js", source: 'import { parseConfigFile } from "./io";\nexport class HttpClient {\n  sendRequest(o) { return parseConfigFile(o.cfg); }\n}\n' },
  { file: "src/unrelated.js", source: 'export function totallyDifferent() { return Math.random(); }\n' },
];

describe("Retrieval — hybrid structural signals", () => {
  const chunks = chunkFiles(FILES);
  const cgIndex = codegraph.indexFiles(FILES);
  const qterms = queryTerms("parse config file");

  it("rewards a chunk that DEFINES a symbol matching the query", () => {
    const sm = structuralScores(chunks, qterms, {});
    const defChunk = chunks.find((c) => c.name === "parseConfigFile");
    assert.ok(sm.get(defChunk.id).symbol > 0, "symbol-name signal fires");
    assert.ok(sm.get(defChunk.id).reasons.some((r) => /defines symbol/.test(r)));
  });

  it("maps codegraph impl hits back to the containing chunk", () => {
    const sm = structuralScores(chunks, qterms, { cgIndex, query: "parse config file" });
    const defChunk = chunks.find((c) => c.name === "parseConfigFile");
    assert.ok(sm.get(defChunk.id).impl > 0, "impl signal attributed to the defining chunk");
    assert.ok(sm.get(defChunk.id).reasons.some((r) => /impl match/.test(r)));
  });

  it("boosts chunks near a strong-match file via import proximity", () => {
    const sm = structuralScores(chunks, qterms, { cgIndex, query: "parse config file" });
    // net.js imports io.js (the strong hit) → its chunks get an import boost.
    const netChunk = chunks.find((c) => c.file === "src/net.js" && c.kind !== "preamble");
    assert.ok(sm.get(netChunk.id).import > 0, "neighbour of strong file boosted");
  });

  it("gives an unrelated file no structural score", () => {
    const sm = structuralScores(chunks, qterms, { cgIndex, query: "parse config file" });
    const other = chunks.find((c) => c.name === "totallyDifferent");
    assert.equal(sm.get(other.id).total, 0);
  });

  it("blend fuses normalized lexical and structural scores and re-sorts", () => {
    const sm = structuralScores(chunks, qterms, { cgIndex, query: "parse config file" });
    const lex = [
      { id: chunks.find((c) => c.name === "parseConfigFile").id, score: 2.0, matched: ["parse", "config", "file"] },
      { id: chunks.find((c) => c.name === "writeOutput").id, score: 0.5, matched: ["file"] },
    ];
    const ranked = blend(lex, sm, { wLex: 0.7, wStruct: 0.3 });
    assert.equal(ranked[0].id, chunks.find((c) => c.name === "parseConfigFile").id);
    assert.ok(ranked[0].lex > 0 && ranked[0].struct > 0);
  });
});

describe("Retrieval — line lookup helper", () => {
  it("maps a line to the chunk that contains it", () => {
    const chunks = [
      { id: "a", file: "f.js", startLine: 1, endLine: 10 },
      { id: "b", file: "f.js", startLine: 11, endLine: 20 },
    ];
    const lut = buildLineLookup(chunks);
    assert.equal(chunkAtLine(lut, "f.js", 5), "a");
    assert.equal(chunkAtLine(lut, "f.js", 15), "b");
    assert.equal(chunkAtLine(lut, "f.js", 99), null);
    assert.equal(chunkAtLine(lut, "other.js", 1), null);
  });
});
