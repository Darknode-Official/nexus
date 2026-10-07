"use strict";
// ===================== Repo Map — Self Benchmark =====================
// Quantifies the subsystem's headline claim: a ranked, signature-only map of the
// whole repo costs a tiny fraction of the tokens that dumping full source would,
// while still naming the most important symbols. Runs against THIS repository by
// default and prints, for several budgets, the map size, the full-source baseline,
// the savings ratio, and the build timing (cold vs. warm cache).
//
// Run: node src/repomap/benchmark.js [dir] [--model M]
const path = require("path");
const os = require("os");
const fs = require("fs");
const repomap = require("./index");

function argVal(flag, dflt) { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : dflt; }

/**
 * Run the benchmark and return a structured result (also used by tests).
 * @param {string} dir
 * @param {Object} [opts] - { model, budgets:number[] }
 * @returns {Object}
 */
function run(dir, opts) {
  opts = opts || {};
  const root = path.resolve(dir || process.cwd());
  const model = opts.model || "generic";
  const budgets = opts.budgets || [1024, 2048, 4096];
  const cacheFile = path.join(os.tmpdir(), "nexus-repomap-bench-" + Buffer.from(root).toString("hex").slice(0, 16) + ".json");

  const base = repomap.fullSourceTokens(root, { model });

  // cold vs. warm timing at the middle budget
  try { fs.unlinkSync(cacheFile); } catch (_) {}
  const midBudget = budgets[Math.floor(budgets.length / 2)];
  const c0 = Date.now(); const cold = repomap.repomap(root, { budget: midBudget, model, cacheFile }); const coldMs = Date.now() - c0;
  const w0 = Date.now(); const warm = repomap.repomap(root, { budget: midBudget, model, cacheFile }); const warmMs = Date.now() - w0;

  const rows = [];
  for (const budget of budgets) {
    const r = repomap.repomap(root, { budget, model, cacheFile });
    rows.push({
      budget,
      tokens: r.tokens,
      files: r.includedFiles.length,
      symbols: r.includedSymbols,
      degraded: r.degraded,
      withinBudget: r.tokens <= budget,
      savingsPct: base.sourceTokens > 0 ? +(100 * (1 - r.tokens / base.sourceTokens)).toFixed(1) : 0,
      ratio: r.tokens > 0 ? +(base.sourceTokens / r.tokens).toFixed(1) : Infinity,
    });
  }

  return {
    root,
    model,
    base,
    totalFiles: cold.meta.files,
    totalSymbols: cold.symbols.length,
    timing: { coldMs, warmMs, speedup: coldMs > 0 ? +(coldMs / Math.max(1, warmMs)).toFixed(1) : 0, reused: warm.meta.reused },
    rows,
  };
}

function print(res) {
  console.log("Repo Map — self benchmark");
  console.log("=".repeat(70));
  console.log("repo:            " + res.root);
  console.log("model family:    " + res.model);
  console.log("files indexed:   " + res.totalFiles + "   symbols ranked: " + res.totalSymbols);
  console.log("full source:     " + res.base.sourceTokens + " tokens (" + res.base.files + " files)");
  console.log("build timing:    cold " + res.timing.coldMs + "ms, warm " + res.timing.warmMs +
    "ms (" + res.timing.speedup + "x, " + res.timing.reused + " cached)");
  console.log("-".repeat(70));
  console.log("budget".padEnd(8) + "map tok".padEnd(10) + "files".padEnd(8) + "symbols".padEnd(10) + "savings".padEnd(10) + "ratio");
  for (const r of res.rows) {
    console.log(
      String(r.budget).padEnd(8) +
      String(r.tokens).padEnd(10) +
      String(r.files).padEnd(8) +
      String(r.symbols).padEnd(10) +
      (r.savingsPct + "%").padEnd(10) +
      (r.ratio === Infinity ? "inf" : r.ratio + "x") +
      (r.withinBudget ? "" : "  [OVER BUDGET!]")
    );
  }
  console.log("-".repeat(70));
  console.log("Interpretation: the map names the repo's most important symbols for a");
  console.log("few thousand tokens — a small fraction of dumping every file's source.");
}

if (require.main === module) print(run(process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : process.cwd(), { model: argVal("--model", "generic") }));
module.exports = { run, print };
