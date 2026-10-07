"use strict";
// ===================== Repo Map — CLI =====================
// Runnable command that builds a ranked, token-budgeted map of a repository.
// Designed to be surfaced as `nexus repomap`.
//
// Usage:
//   node src/repomap/cli.js [dir] [options]
//
// Options:
//   --budget N         token budget for the map (default 2048)
//   --focus <f>        bias ranking toward a file/symbol (repeatable or comma-list)
//   --exclude <p>      omit paths containing <p> from the map (repeatable/comma)
//   --model M          model family for token estimation (default generic)
//   --max-per-file N   cap symbols shown per file (default 40)
//   --no-cache         disable the incremental cache
//   --stats            print ranking/graph stats, not the map
//   --top N            with --stats, show the top-N ranked files/symbols
//   --savings          print map tokens vs. full-source tokens (savings report)
//   --bench            cold vs. warm (cached) build timing
//
// Examples:
//   node src/repomap/cli.js src --budget 2000
//   node src/repomap/cli.js . --focus src/retrieval/bm25.js --budget 1500
//   node src/repomap/cli.js . --savings
const path = require("path");
const os = require("os");
const fs = require("fs");
const repomap = require("./index");

function argVal(flag, dflt) { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : dflt; }
function argAll(flag) {
  const out = [];
  for (let i = 2; i < process.argv.length; i++) if (process.argv[i] === flag) out.push(process.argv[i + 1]);
  return out.flatMap((v) => String(v || "").split(",")).map((s) => s.trim()).filter(Boolean);
}
function has(flag) { return process.argv.includes(flag); }

const VALUE_FLAGS = new Set(["--budget", "--focus", "--exclude", "--model", "--max-per-file", "--top"]);

function parseArgs() {
  const positional = [];
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a.startsWith("--")) { if (VALUE_FLAGS.has(a)) i++; continue; }
    positional.push(a);
  }
  return {
    dir: positional[0] || process.cwd(),
    budget: parseInt(argVal("--budget", "2048"), 10),
    focus: argAll("--focus"),
    exclude: argAll("--exclude"),
    model: argVal("--model", "generic"),
    maxPerFile: parseInt(argVal("--max-per-file", "40"), 10),
    noCache: has("--no-cache"),
    stats: has("--stats"),
    top: parseInt(argVal("--top", "15"), 10),
    savings: has("--savings"),
    bench: has("--bench"),
  };
}

function cacheFor(root) {
  return path.join(os.tmpdir(), "nexus-repomap-" + Buffer.from(root).toString("hex").slice(0, 16) + ".json");
}

function main() {
  const o = parseArgs();
  const root = path.resolve(o.dir);
  const cacheFile = o.noCache ? null : cacheFor(root);

  if (o.bench) return bench(root, cacheFile, o);
  if (o.savings) return savings(root, o);

  const t0 = Date.now();
  const r = repomap.repomap(root, {
    budget: o.budget, model: o.model, focus: o.focus, exclude: o.exclude,
    maxPerFile: o.maxPerFile, cacheFile,
  });
  const ms = Date.now() - t0;

  if (o.stats) return printStats(r, root, ms, o);

  // Header line to stderr so the map on stdout is clean/pipeable.
  process.stderr.write(
    "repomap " + root + "  —  " + r.meta.files + " files, " +
    r.includedFiles.length + " shown, " + r.includedSymbols + " symbols, " +
    r.tokens + "/" + r.budget + " tokens" + (r.degraded ? " (degraded)" : "") +
    "  [" + ms + "ms, " + r.meta.reused + " cached]\n"
  );
  if (r.focus && r.focus.unmatched && r.focus.unmatched.length) {
    process.stderr.write("  focus unmatched: " + r.focus.unmatched.join(", ") + "\n");
  }
  console.log(r.map);
}

function printStats(r, root, ms, o) {
  console.log("Repo Map — " + root);
  console.log("-".repeat(64));
  console.log("files indexed:   " + r.meta.files + "  (" + r.meta.fresh + " fresh, " + r.meta.reused + " cached)");
  console.log("graph:           " + r.graph.edges + " edges, " + r.graph.names + " names (" +
    r.graph.ambiguousNames + " ambiguous), " + r.graph.refEdges + " ref + " + r.graph.importEdges + " import");
  console.log("pagerank:        " + r.pagerank.iterations + " iters, converged=" + r.pagerank.converged +
    ", delta=" + r.pagerank.delta.toExponential(2));
  console.log("map:             " + r.includedFiles.length + " files / " + r.includedSymbols +
    " symbols / " + r.tokens + " tokens (budget " + r.budget + ")  [" + ms + "ms]");
  console.log("\nTop " + o.top + " files by importance:");
  for (const f of r.files.slice(0, o.top)) {
    console.log("  " + (100 * f.score).toFixed(2).padStart(6) + "%  " + f.file + "  (" + f.symbolCount + " sym)");
  }
  console.log("\nTop " + o.top + " symbols by importance:");
  for (const s of r.symbols.slice(0, o.top)) {
    console.log("  " + (100 * s.score).toFixed(3).padStart(7) + "%  " + s.file + " :: " + (s.parent ? s.parent + "." : "") + s.name + " (" + s.kind + ")");
  }
}

function savings(root, o) {
  const r = repomap.repomap(root, { budget: o.budget, model: o.model, maxPerFile: o.maxPerFile, cacheFile: o.noCache ? null : cacheFor(root) });
  const base = repomap.fullSourceTokens(root, { model: o.model });
  const pct = base.sourceTokens > 0 ? (100 * (1 - r.tokens / base.sourceTokens)) : 0;
  console.log("Repo Map — token savings vs. full source  (" + root + ")");
  console.log("-".repeat(64));
  console.log("full source:     " + base.sourceTokens + " tokens across " + base.files + " files");
  console.log("repo map:        " + r.tokens + " tokens (" + r.includedFiles.length + " files, " + r.includedSymbols + " symbols)");
  console.log("savings:         " + pct.toFixed(1) + "%   (" + (base.sourceTokens - r.tokens) + " tokens avoided)");
  console.log("ratio:           full source is " + (r.tokens > 0 ? (base.sourceTokens / r.tokens).toFixed(1) : "inf") + "x the map");
}

function bench(root, cacheFile, o) {
  const cf = cacheFile || cacheFor(root);
  try { fs.unlinkSync(cf); } catch (_) {}
  const c0 = Date.now(); const cold = repomap.repomap(root, { budget: o.budget, model: o.model, cacheFile: cf }); const coldMs = Date.now() - c0;
  const w0 = Date.now(); const warm = repomap.repomap(root, { budget: o.budget, model: o.model, cacheFile: cf }); const warmMs = Date.now() - w0;
  console.log("Repo Map benchmark — " + root);
  console.log("-".repeat(64));
  console.log("cold build: " + coldMs + "ms   (" + cold.meta.fresh + " files extracted)");
  console.log("warm build: " + warmMs + "ms   (" + warm.meta.reused + " files reused, " + warm.meta.fresh + " re-extracted)");
  console.log("speedup:    " + (coldMs > 0 ? (coldMs / Math.max(1, warmMs)).toFixed(1) : "n/a") + "x");
  console.log("map:        " + warm.tokens + " tokens, " + warm.includedFiles.length + " files, " + warm.includedSymbols + " symbols");
}

if (require.main === module) main();
module.exports = { main, parseArgs };
