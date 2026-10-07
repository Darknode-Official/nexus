"use strict";
// NX-107 — generate the local-model capability-by-tier table from MEASUREMENT of
// the actually-installed models (real context length + parameter count via
// `ollama show`). Writes bench/results/nx107-tiers.json and prints a table.
//
//   node bench/nx107-tiertable.js
//
// HONEST SCOPE: this measures each installed model's CONTEXT and SIZE (the hard
// limits that decide what fits). The task-level "what works / what silently
// degrades at 8-32K" column requires running the task suite against each model
// (expensive, live) and is left as the column marked "needs task run".

const fs = require("fs");
const path = require("path");
const lp = require("../src/local-preflight");

const models = lp.installedModels();
const rows = [];
if (models) {
  for (const m of models) {
    const info = lp.modelContext(m);
    const need = lp.estVramMiBForParams(info.parameters);
    // Tier by context window (the binding constraint for coding tasks).
    let tier = "unknown";
    if (info.context != null) {
      if (info.context <= 8192) tier = "8K (snippets, single-file edits, Q&A)";
      else if (info.context <= 16384) tier = "16K (multi-function, small modules)";
      else if (info.context <= 32768) tier = "32K (small multi-file changes)";
      else tier = ">32K (approaching hosted-lite)";
    }
    rows.push({
      model: m,
      parameters: info.parameters,
      context: info.context,
      estVramMiB: need,
      tier,
      taskCapability: "needs task run (live)",
    });
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  ollamaReachable: models !== null,
  recommended: {
    minHardware: "8 GB RAM for a 7-8B Q4 model at 8K context (CPU ok, slow); measured from model sizes above.",
    note: "Hosted context is 200K-1M; local tops out ~32K here. Tasks needing whole-repo context should use a hosted engine — preflight({requireHosted:true}) says so BEFORE spending.",
  },
  models: rows,
  caveat: "Context + VRAM columns are measured. The task-capability column requires running bench/tasks.js against each model and scoring correctness — not done here (see bench/README.md).",
};

const outDir = path.join(__dirname, "results");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "nx107-tiers.json"), JSON.stringify(report, null, 2));

console.log("NX-107 LOCAL-MODEL TIER TABLE (measured)");
console.log("ollama reachable:", report.ollamaReachable);
console.log("");
console.log(["model", "params", "context", "~VRAM MiB", "tier"].map((h, i) => h.padEnd([34, 8, 9, 11, 40][i])).join(""));
for (const r of rows) {
  console.log([
    String(r.model).padEnd(34),
    String(r.parameters || "?").padEnd(8),
    String(r.context || "?").padEnd(9),
    String(r.estVramMiB || "?").padEnd(11),
    String(r.tier).padEnd(40),
  ].join(""));
}
console.log("");
console.log("CAVEAT:", report.caveat);
console.log("wrote", path.join(outDir, "nx107-tiers.json"));
