"use strict";
// NX-101 OVERHEAD BENCHMARK (deterministic, no credentials required).
//
// Measures the input tokens Nexus ADDS per turn over a bare direct engine call
// (`claude -p "<task>"`), and how much the cost-saver claws back. Runs the real
// repo modules (context, prompt-engine, costsave, knowledge-graph) against a
// target codebase.
//
//   node bench/nx101-overhead.js [targetDir]
//
// Default targetDir = repo root (a real ~12k-line codebase). Writes JSON to
// bench/results/nx101-overhead.json and prints a table.
//
// WHAT THIS PROVES: the additive input overhead and the cost-saver reclaim, both
// deterministically. WHAT IT DOES NOT PROVE: net dollars vs a live engine (needs
// the engine's own gathering + output tokens + real billing). See bench/README.md.

const path = require("path");
const fs = require("fs");
const overhead = require("../src/overhead");
const tasks = require("./tasks");

const targetDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, "..");

function pct(n) { return (n * 100).toFixed(0) + "%"; }

const rows = tasks.map(t => {
  const c = overhead.compareTask(targetDir, t.task, { intent: "code_edit" });
  return Object.assign({ id: t.id, class: t.class }, c);
});

// Aggregate
const sum = (arr, k) => arr.reduce((s, r) => s + r[k], 0);
const avg = (arr, k) => arr.length ? sum(arr, k) / arr.length : 0;
const nexusCheaperThanBare = rows.filter(r => r.fullTokens <= r.bareTokens).length;
const leanCheaperThanFull = rows.filter(r => r.leanTokens < r.fullTokens).length;

const report = {
  generatedAt: new Date().toISOString(),
  targetDir,
  unit: "estimated tokens (ceil(chars/4)) — ratios robust to the estimator",
  tasks: rows.length,
  perTask: rows,
  aggregate: {
    avgBareTokens: Math.round(avg(rows, "bareTokens")),
    avgFullTokens: Math.round(avg(rows, "fullTokens")),
    avgLeanTokens: Math.round(avg(rows, "leanTokens")),
    avgFullOverheadRatio: +(avg(rows, "fullRatio")).toFixed(2),
    avgLeanOverheadRatio: +(avg(rows, "leanRatio")).toFixed(2),
    tasksWhereNexusInputAtOrBelowBare: nexusCheaperThanBare + "/" + rows.length,
    tasksWhereLeanBeatsFull: leanCheaperThanFull + "/" + rows.length,
  },
  caveats: [
    "Additive INPUT overhead only. Does NOT include the engine's own lazy context gathering, output tokens, or real dollar billing.",
    "A full Nexus-vs-direct-engine dollar comparison needs live runs with credentials (ANTHROPIC_API_KEY or an authed claude/gemini/codex CLI). See bench/README.md.",
    "Cache reclaim applies only to EXACT read-only repeats; squeeze reclaim applies only to duplicated inlined blocks + whitespace.",
  ],
};

const outDir = path.join(__dirname, "results");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "nx101-overhead.json"), JSON.stringify(report, null, 2));

// ---- print ----
console.log("NX-101 OVERHEAD BENCHMARK");
console.log("target:", targetDir);
console.log("unit:", report.unit);
console.log("");
const H = ["id", "class", "bare", "full", "lean", "fullX", "leanX"];
console.log(H.map((h, i) => h.padEnd([5, 20, 7, 8, 8, 7, 7][i])).join(""));
for (const r of rows) {
  console.log([
    r.id.padEnd(5),
    r.class.padEnd(20),
    String(r.bareTokens).padEnd(7),
    String(r.fullTokens).padEnd(8),
    String(r.leanTokens).padEnd(8),
    (r.fullRatio + "x").padEnd(7),
    (r.leanRatio + "x").padEnd(7),
  ].join(""));
}
console.log("");
console.log("AGGREGATE:");
console.log("  avg bare input tokens (direct engine call):", report.aggregate.avgBareTokens);
console.log("  avg full-Nexus input tokens:               ", report.aggregate.avgFullTokens);
console.log("  avg lean-path input tokens:                ", report.aggregate.avgLeanTokens);
console.log("  avg overhead multiple (full):              ", report.aggregate.avgFullOverheadRatio + "x bare");
console.log("  avg overhead multiple (lean):              ", report.aggregate.avgLeanOverheadRatio + "x bare");
console.log("  tasks where Nexus input <= bare:           ", report.aggregate.tasksWhereNexusInputAtOrBelowBare);
console.log("  tasks where lean beats full:               ", report.aggregate.tasksWhereLeanBeatsFull);
console.log("");
console.log("HEADLINE:",
  nexusCheaperThanBare === 0
    ? "Nexus sends MORE input tokens than a bare direct engine call on EVERY task. The wrapper's input is additive; net savings (if any) must come from the engine's own avoided gathering, cowork delegation, or cache hits on repeats — none of which this deterministic run can credit."
    : nexusCheaperThanBare + "/" + rows.length + " tasks had Nexus input at or below bare.");
console.log("");
console.log("wrote", path.join(outDir, "nx101-overhead.json"));
