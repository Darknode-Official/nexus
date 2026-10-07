"use strict";
// ===================== Retrieval — Self Benchmark =====================
// Measures the subsystem against the Nexus repo itself and, crucially, quantifies
// the TOKEN SAVING: how many tokens a budget-bounded retrieval returns versus the
// naive baseline of feeding whole candidate files into the prompt. This is the
// number that justifies the subsystem's existence.
//
// Run: node src/retrieval/bench.js [dir] [--budget N]
const path = require("path");
const os = require("os");
const fs = require("fs");
const retrieval = require("./index");

let tokensave; try { tokensave = require("../tokensave"); } catch (_) { tokensave = null; }
function estTokens(t) { return tokensave ? tokensave.estimateTokens(t, "generic") : Math.round(String(t || "").length / 4); }

// A spread of realistic developer queries over this repo.
const QUERIES = [
  "parse import statement",
  "bm25 ranking with tunable parameters",
  "token budget context packing",
  "incremental file cache mtime hash",
  "maximal marginal relevance diversification",
  "tokenize camelCase snake_case identifier",
];

function main() {
  const dir = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : process.cwd();
  const root = path.resolve(dir);
  const bi = process.argv.indexOf("--budget");
  const budget = bi >= 0 ? parseInt(process.argv[bi + 1], 10) : 1500;
  const cacheFile = path.join(os.tmpdir(), "nexus-retrieval-bench-" + Buffer.from(root).toString("hex").slice(0, 12) + ".json");
  try { fs.unlinkSync(cacheFile); } catch (_) {}

  console.log("Retrieval benchmark — " + root + "   (budget " + budget + " tok)");
  console.log("=".repeat(72));

  const t0 = Date.now();
  const idx = retrieval.indexDirectory(root, { cacheFile });
  const buildMs = Date.now() - t0;
  const s = idx.stats();
  console.log("index: " + s.files + " files, " + s.chunks + " chunks, " + s.index.terms +
    " terms in " + buildMs + "ms" + (idx.cgIndex ? "  [hybrid]" : ""));

  // Warm re-index (incremental).
  const w0 = Date.now(); retrieval.indexDirectory(root, { cacheFile }); const warmMs = Date.now() - w0;
  console.log("warm re-index: " + warmMs + "ms (" + (buildMs / Math.max(1, warmMs)).toFixed(1) + "x faster)\n");

  let totLat = 0, totRetTok = 0, totBaseTok = 0;
  for (const q of QUERIES) {
    const qt0 = Date.now();
    const res = idx.retrieve(q, { budget, topN: 8 });
    const lat = Date.now() - qt0;
    totLat += lat;

    // Baseline: the whole files that the returned chunks came from (what a naive
    // "grep the files and paste them" approach would cost).
    const files = new Set(res.chunks.map((c) => c.file));
    let baseTok = 0;
    for (const f of files) {
      try { baseTok += estTokens(fs.readFileSync(path.join(root, f), "utf8")); } catch (_) {}
    }
    totRetTok += res.usedTokens;
    totBaseTok += baseTok;

    const saved = baseTok > 0 ? (100 * (1 - res.usedTokens / baseTok)).toFixed(1) : "n/a";
    console.log('"' + q + '"');
    console.log("  " + res.count + " chunks, " + res.usedTokens + " tok (" + lat + "ms)  vs whole-file " +
      baseTok + " tok  → " + saved + "% saved");
    if (res.chunks[0]) {
      const top = res.chunks[0];
      console.log("  top: " + top.file + ":" + top.startLine + "-" + top.endLine + " (" + (top.name || top.kind) + ")");
    }
  }

  console.log("\n" + "-".repeat(72));
  console.log("avg query latency: " + (totLat / QUERIES.length).toFixed(1) + "ms");
  if (totBaseTok > 0) {
    console.log("retrieved tokens:  " + totRetTok + "   whole-file baseline: " + totBaseTok);
    console.log("overall token saving vs whole-file: " + (100 * (1 - totRetTok / totBaseTok)).toFixed(1) + "%");
  }
}

if (require.main === module) main();
module.exports = { main, QUERIES };
