"use strict";
// NX-110 EVALUATION HARNESS.
//
// Runs the task set (bench/tasks.js) per engine, per seed, recording cost,
// latency, tokens ALONGSIDE correctness. Reports variance across seeds, not just
// the mean. Keeps a held-out set reserved until the end. Checks routing: which
// engine wins each task class and whether cowork's router would pick it.
//
//   node bench/nx110-eval.js [--seeds N] [--engines claude,gemini,...] [--held-out]
//
// Correctness needs a LIVE engine via an adapter:
//   NEXUS_EVAL_ADAPTER=./bench/adapters/my-adapter.js node bench/nx110-eval.js
// Without one it uses bench/adapters/null-adapter.js, which records tokens/latency
// but reports correctness = null (UNSCORED). This is reported honestly; the
// harness is runnable by a third party from this file + bench/README.md alone.

const path = require("path");
const fs = require("fs");
const allTasks = require("./tasks");
const cowork = require("../src/cowork");

function arg(flag, dflt) { const i = process.argv.indexOf(flag); return i >= 0 ? (process.argv[i + 1] || true) : dflt; }

const SEEDS = parseInt(arg("--seeds", "3"), 10);
const ENGINES = String(arg("--engines", "claude,gemini,ollama")).split(",");
const useHeldOut = process.argv.includes("--held-out");

const adapterPath = process.env.NEXUS_EVAL_ADAPTER || "./adapters/null-adapter.js";
const adapter = require(path.resolve(__dirname, adapterPath));

// Contamination gate: a task of unknown provenance is excluded.
const usable = allTasks.filter(t => t.provenance === "synthetic" || t.provenance === "repo-local");
const dev = usable.filter(t => !t.heldOut);
const held = usable.filter(t => t.heldOut);
const tasks = useHeldOut ? held : dev;

function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0; }
function stddev(a) { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))); }

async function main() {
  const records = [];
  for (const engine of ENGINES) {
    for (const t of tasks) {
      for (let seed = 0; seed < SEEDS; seed++) {
        const r = await adapter.run({ task: t.task, engine, seed });
        const correct = await adapter.score(t, r.output);
        records.push({ engine, task: t.id, class: t.class, seed, correct, tokensIn: r.tokensIn || 0, tokensOut: r.tokensOut || 0, latencyMs: r.latencyMs || 0, cost: r.cost || 0, live: r.live !== false });
      }
    }
  }

  // Aggregate per engine x class with variance across seeds.
  const agg = {};
  for (const rec of records) {
    const key = rec.engine + "|" + rec.class;
    (agg[key] = agg[key] || []).push(rec);
  }
  const summary = Object.entries(agg).map(([key, recs]) => {
    const [engine, cls] = key.split("|");
    const scored = recs.map(r => r.correct).filter(c => c === true || c === false);
    const correctness = scored.length ? mean(scored.map(c => (c ? 1 : 0))) : null;
    const tok = recs.map(r => r.tokensIn + r.tokensOut);
    const lat = recs.map(r => r.latencyMs);
    return {
      engine, class: cls, runs: recs.length,
      correctnessMean: correctness,
      correctnessStdev: scored.length ? stddev(scored.map(c => (c ? 1 : 0))) : null,
      scored: scored.length + "/" + recs.length,
      tokensMean: Math.round(mean(tok)), tokensStdev: Math.round(stddev(tok)),
      latencyMean: Math.round(mean(lat)),
      costMean: +mean(recs.map(r => r.cost)).toFixed(6),
      live: recs.every(r => r.live),
    };
  });

  // Routing check: for each class, which engine wins (by correctness, tie-break
  // cheaper tokens), and would cowork route there?
  const classes = [...new Set(tasks.map(t => t.class))];
  const routing = classes.map(cls => {
    const cands = summary.filter(s => s.class === cls);
    const scored = cands.filter(s => s.correctnessMean != null);
    const winner = (scored.length ? scored : cands).slice().sort((a, b) =>
      (b.correctnessMean || 0) - (a.correctnessMean || 0) || a.tokensMean - b.tokensMean)[0];
    const sample = tasks.find(t => t.class === cls);
    const routed = cowork.routeTask(sample.task, { strongEngine: "claude", weakEngine: "ollama" });
    return {
      class: cls,
      measuredWinner: winner ? winner.engine : null,
      winnerScored: winner ? winner.correctnessMean != null : false,
      routerPicks: routed.engine,
      routerAgrees: winner ? routed.engine === winner.engine : null,
    };
  });

  const report = {
    generatedAt: new Date().toISOString(),
    adapter: adapter.name,
    live: records.every(r => r.live),
    seeds: SEEDS, engines: ENGINES,
    set: useHeldOut ? "HELD-OUT (used once)" : "dev",
    taskCount: tasks.length,
    excludedForProvenance: allTasks.length - usable.length,
    summary, routing, records,
    note: records.every(r => r.live)
      ? "live run"
      : "NOT A LIVE RUN — correctness is UNSCORED (null adapter). Tokens/latency are recorded; dollars require live billing. Provide NEXUS_EVAL_ADAPTER for real correctness.",
  };

  const outDir = path.join(__dirname, "results");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, useHeldOut ? "nx110-eval-heldout.json" : "nx110-eval.json");
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));

  console.log("NX-110 EVAL HARNESS");
  console.log("adapter:", adapter.name, "| set:", report.set, "| seeds:", SEEDS, "| engines:", ENGINES.join(","));
  console.log("tasks:", tasks.length, "| excluded (provenance):", report.excludedForProvenance);
  console.log("");
  console.log(["engine", "class", "correct", "tok(±sd)", "lat ms"].map((h, i) => h.padEnd([10, 20, 9, 14, 8][i])).join(""));
  for (const s of summary) {
    console.log([
      s.engine.padEnd(10),
      s.class.padEnd(20),
      (s.correctnessMean == null ? "unscored" : (s.correctnessMean * 100).toFixed(0) + "%").padEnd(9),
      (s.tokensMean + "±" + s.tokensStdev).padEnd(14),
      String(s.latencyMean).padEnd(8),
    ].join(""));
  }
  console.log("");
  console.log("ROUTING (which engine wins each class vs what cowork routes):");
  for (const r of routing) console.log("  " + r.class.padEnd(20) + " winner=" + (r.measuredWinner || "?") + (r.winnerScored ? "" : "(unscored)") + " router=" + r.routerPicks + " agree=" + r.routerAgrees);
  console.log("");
  console.log(report.live ? "LIVE RUN" : "NOTE: " + report.note);
  console.log("wrote", outFile);
}

main().catch(e => { console.error(e); process.exit(1); });
