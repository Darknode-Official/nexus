"use strict";
// NX-106 (deterministic part) — does the Knowledge Graph find code that ALREADY
// exists, so the agent reuses it instead of duplicating? Measures recall two ways
// against this repo:
//   exact-name     — query is the function's own name (easy).
//   descriptive    — query is how a user would phrase the TASK (the real case;
//                    this is what prevents duplication).
//
//   node bench/nx106-duplication.js
//
// The full NX-106 benchmark (true-positive rate, duplication rate, reviewer-
// deletion rate on MATURE repos) needs live engines + human review and is NOT
// covered here — see bench/README.md.

const path = require("path");
const fs = require("fs");
const kg = require("../src/knowledge-graph");

const repo = path.join(__dirname, "..");
const g = kg.buildGraph(repo);

const exact = [
  ["squeezeContext", "src/costsave.js"],
  ["classifyError", "src/error-recovery.js"],
  ["createBudget", "src/budget.js"],
  ["assemblePrompt", "src/prompt-engine.js"],
  ["estimateDifficulty", "src/cowork.js"],
];
const descriptive = [
  ["add a function to dedupe context blocks and collapse whitespace", "src/costsave.js"],
  ["classify an error into a category for retry", "src/error-recovery.js"],
  ["estimate how difficult a task is for model routing", "src/cowork.js"],
  ["build an optimized prompt with chain of thought", "src/prompt-engine.js"],
  ["detect when the agent is stuck in a loop", "src/loop-detect.js"],
];

function run(probes, topN) {
  let found = 0, rank1 = 0;
  const rows = [];
  for (const [q, expect] of probes) {
    const res = kg.queryFiles(g, q).slice(0, topN).map(r => r.file);
    const idx = res.indexOf(expect);
    if (idx >= 0) found++;
    if (idx === 0) rank1++;
    rows.push({ query: q.slice(0, 50), expect, found: idx >= 0, rank: idx >= 0 ? idx + 1 : null, top: res.slice(0, 3) });
  }
  return { total: probes.length, found, rank1, recall: +(found / probes.length).toFixed(2), rank1Rate: +(rank1 / probes.length).toFixed(2), rows };
}

const report = {
  generatedAt: new Date().toISOString(),
  graph: kg.graphSummary(g),
  exactName: run(exact, 3),
  descriptive: run(descriptive, 5),
  verdict: "Exact-name lookup is reliable, but DESCRIPTIVE recall (the duplication-avoidance case) is lower and the correct file often does not rank first. queryFiles is a keyword scorer over entity names, so a task phrased without the function's name (e.g. 'collapse whitespace' vs squeezeContext) can be missed. Reuse guidance should query the KG AND fall back to content search; relying on the KG alone will let some duplication through.",
};

const outDir = path.join(__dirname, "results");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "nx106-duplication.json"), JSON.stringify(report, null, 2));

console.log("NX-106 DUPLICATION-DETECTION RECALL");
console.log("graph:", report.graph.files, "files,", report.graph.functions, "functions");
console.log("exact-name recall:   ", report.exactName.found + "/" + report.exactName.total, "(rank-1:", report.exactName.rank1 + ")");
console.log("descriptive recall:  ", report.descriptive.found + "/" + report.descriptive.total, "(rank-1:", report.descriptive.rank1 + ")");
for (const r of report.descriptive.rows) console.log("  ", (r.found ? "FOUND@" + r.rank : "MISS  "), r.expect);
console.log("");
console.log("VERDICT:", report.verdict);
console.log("wrote", path.join(outDir, "nx106-duplication.json"));
