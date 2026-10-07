"use strict";
// ===================== Code Graph — CLI =====================
// Runnable script that indexes a directory and prints stats, duplicates, cycles,
// an "find existing implementation" query, and an incremental-reindex benchmark.
//
// Usage:
//   node src/codegraph/cli.js [dir]                      index + stats
//   node src/codegraph/cli.js [dir] --dupes              list duplicate clones
//   node src/codegraph/cli.js [dir] --cycles             list import cycles
//   node src/codegraph/cli.js [dir] --find "parse json"  rank reusable functions
//   node src/codegraph/cli.js [dir] --bench              cold vs. cached timing
const path = require("path");
const os = require("os");
const fs = require("fs");
const codegraph = require("./index");

function arg(flag) { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : null; }
function has(flag) { return process.argv.includes(flag); }
function bar(n, max, w) { const len = max ? Math.round((n / max) * (w || 24)) : 0; return "#".repeat(len); }

function main() {
  const dir = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : process.cwd();
  const root = path.resolve(dir);
  const cacheFile = path.join(os.tmpdir(), "nexus-codegraph-" + Buffer.from(root).toString("hex").slice(0, 16) + ".json");

  const t0 = Date.now();
  const idx = codegraph.indexDirectory(root, { cacheFile });
  const ms = Date.now() - t0;
  const s = idx.stats();

  console.log("Code Graph — " + root);
  console.log("-".repeat(60));
  console.log("files:    " + s.files + "   (" + idx.meta.scanned + " scanned, " + idx.meta.parsed + " parsed, " + idx.meta.reused + " cached)");
  console.log("symbols:  " + s.symbols + "   exports: " + s.exports + "   imports: " + s.imports);
  console.log("loc:      " + s.loc + "   graph edges: " + s.edges + "   cycles: " + s.cycles);
  console.log("indexed in " + ms + "ms   cache: " + JSON.stringify(idx.meta.cache));
  console.log("");
  const langs = Object.keys(s.byLang).sort((a, b) => s.byLang[b] - s.byLang[a]);
  const maxL = Math.max(1, ...langs.map((l) => s.byLang[l]));
  console.log("By language:");
  for (const l of langs) console.log("  " + l.padEnd(12) + String(s.byLang[l]).padStart(5) + "  " + bar(s.byLang[l], maxL));

  if (has("--dupes")) {
    const d = idx.duplicates();
    console.log("\nDuplicate clones (>= 45 tokens, top 15):");
    if (!d.clones.length) console.log("  none found");
    for (const c of d.clones.slice(0, 15)) {
      console.log("  ~" + c.tokens + " tokens:");
      for (const inst of c.instances) console.log("    " + inst.file + ":" + inst.startLine + "-" + inst.endLine);
    }
  }
  if (has("--cycles")) {
    const cyc = idx.cycles();
    console.log("\nImport cycles: " + cyc.length);
    cyc.slice(0, 20).forEach((c, i) => console.log("  [" + (i + 1) + "] " + c.join(" -> ")));
  }
  const q = arg("--find");
  if (q) {
    console.log("\nfindImplementation(\"" + q + "\"):");
    const hits = idx.findImplementation(q, { limit: 10 });
    if (!hits.length) console.log("  no candidates");
    for (const h of hits) console.log("  " + h.score.toFixed(3) + "  " + (h.parent ? h.parent + "." : "") + h.name + "   " + h.file + ":" + h.line);
  }
  if (has("--bench")) {
    try { fs.unlinkSync(cacheFile); } catch (_) {}
    const c0 = Date.now(); codegraph.indexDirectory(root, { cacheFile }); const cold = Date.now() - c0;
    const w0 = Date.now(); const warm = codegraph.indexDirectory(root, { cacheFile }); const warmMs = Date.now() - w0;
    console.log("\nBenchmark (incremental cache):");
    console.log("  cold index: " + cold + "ms");
    console.log("  warm index: " + warmMs + "ms   (" + (cold > 0 ? (cold / Math.max(1, warmMs)).toFixed(1) : "n/a") + "x faster)   " + JSON.stringify(warm.meta.cache));
  }
}

if (require.main === module) main();
module.exports = { main };
