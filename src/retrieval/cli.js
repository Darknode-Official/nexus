"use strict";
// ===================== Retrieval — CLI =====================
// Runnable command that indexes a directory and retrieves chunks for a query
// within a token budget. Designed to be surfaced as `nexus retrieve`.
//
// Usage:
//   node src/retrieval/cli.js "<query>" [dir] [options]
//
// Options:
//   --budget N     token budget for the returned context (default 1500)
//   --top N        max chunks to return (default 8)
//   --model M      model family for token estimation (default generic)
//   --cosine       use TF-IDF cosine instead of BM25
//   --no-hybrid    disable codegraph structural fusion
//   --context      print the assembled context string (the packed code)
//   --stats        print index statistics only
//   --bench        cold vs. warm (cached) index timing
//
// Examples:
//   node src/retrieval/cli.js "parse import statement" src --budget 1200
//   node src/retrieval/cli.js "bm25 ranking" . --cosine --context
const path = require("path");
const os = require("os");
const fs = require("fs");
const retrieval = require("./index");

function arg(flag, dflt) { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : dflt; }
function has(flag) { return process.argv.includes(flag); }

function parseArgs() {
  // First non-flag arg = query; second non-flag = dir.
  const positional = [];
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a.startsWith("--")) {
      // skip the value of value-taking flags
      if (["--budget", "--top", "--model"].includes(a)) i++;
      continue;
    }
    positional.push(a);
  }
  return {
    query: positional[0] || "",
    dir: positional[1] || process.cwd(),
    budget: parseInt(arg("--budget", "1500"), 10),
    top: parseInt(arg("--top", "8"), 10),
    model: arg("--model", "generic"),
    cosine: has("--cosine"),
    hybrid: !has("--no-hybrid"),
    context: has("--context"),
    stats: has("--stats"),
    bench: has("--bench"),
  };
}

function cacheFor(root) {
  return path.join(os.tmpdir(), "nexus-retrieval-" + Buffer.from(root).toString("hex").slice(0, 16) + ".json");
}

function main() {
  const o = parseArgs();
  const root = path.resolve(o.dir);
  const cacheFile = cacheFor(root);

  if (o.bench) return bench(root, cacheFile);

  const t0 = Date.now();
  const idx = retrieval.indexDirectory(root, { cacheFile });
  const ms = Date.now() - t0;
  const s = idx.stats();

  console.log("Retrieval index — " + root);
  console.log("-".repeat(64));
  console.log("files: " + s.files + "   chunks: " + s.chunks + "   terms: " + s.index.terms +
    "   avgdl: " + s.index.avgdl);
  console.log("indexed in " + ms + "ms   (" + idx.meta.changed + " changed, " + idx.meta.reused + " cached)" +
    (idx.cgIndex ? "   [hybrid: codegraph on]" : "   [hybrid: off]"));

  if (o.stats) return;

  if (!o.query) {
    console.log("\nNo query given. Usage: node src/retrieval/cli.js \"<query>\" [dir] [--budget N]");
    return;
  }

  const res = idx.retrieve(o.query, {
    budget: o.budget, topN: o.top, model: o.model,
    scorer: o.cosine ? "cosine" : "bm25", hybrid: o.hybrid,
  });

  console.log("");
  console.log(res.report);

  if (o.context) {
    console.log("\n" + "=".repeat(64) + "\nPacked context (" + res.usedTokens + " tokens):\n" + "=".repeat(64));
    console.log(res.context);
  }
}

function bench(root, cacheFile) {
  try { fs.unlinkSync(cacheFile); } catch (_) {}
  const c0 = Date.now(); const cold = retrieval.indexDirectory(root, { cacheFile }); const coldMs = Date.now() - c0;
  const w0 = Date.now(); const warm = retrieval.indexDirectory(root, { cacheFile }); const warmMs = Date.now() - w0;
  console.log("Retrieval benchmark — " + root);
  console.log("-".repeat(64));
  console.log("cold index: " + coldMs + "ms   (" + cold.meta.changed + " files chunked)");
  console.log("warm index: " + warmMs + "ms   (" + warm.meta.reused + " files reused, " + warm.meta.changed + " re-chunked)");
  console.log("speedup:    " + (coldMs > 0 ? (coldMs / Math.max(1, warmMs)).toFixed(1) : "n/a") + "x");
  console.log("chunks: " + warm.stats().chunks + "   terms: " + warm.stats().index.terms);
}

if (require.main === module) main();
module.exports = { main, parseArgs };
