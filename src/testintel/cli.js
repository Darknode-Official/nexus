"use strict";
// ===================== Test Intelligence — CLI =====================
// Runnable entrypoint for the `nexus test ...` subcommands. Reads process.argv and
// prints human-readable output; every command also supports --json for machine use.
//
// Usage:
//   node src/testintel/cli.js detect [dir]                 detect runner(s)
//   node src/testintel/cli.js discover [dir] [--runner R]  list test files
//   node src/testintel/cli.js affected [dir] --changed a,b [--symbol file:name]
//   node src/testintel/cli.js run [dir] [--runner R] [--files a,b] [--coverage]
//   node src/testintel/cli.js flaky [dir] --times N [--runner R] [--grep P]
//   node src/testintel/cli.js triage [dir] [--runner R]    run + cluster failures
//   node src/testintel/cli.js coverage <file> [--changed-lines file:1-10]
//   node src/testintel/cli.js skeleton [dir] [--file F] [--framework FW]
const path = require("path");
const fs = require("fs");
const codegraph = require("../codegraph");
const testintel = require("./index");

function arg(flag, argv) { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; }
function has(flag, argv) { return argv.includes(flag); }
function list(v) { return v ? String(v).split(",").map((s) => s.trim()).filter(Boolean) : []; }
function out(obj, jsonMode) { if (jsonMode) { process.stdout.write(JSON.stringify(obj, null, 2) + "\n"); return true; } return false; }

function dirArg(argv) { return argv[0] && !argv[0].startsWith("--") ? path.resolve(argv[0]) : process.cwd(); }

function cmdDetect(argv, json) {
  const dir = dirArg(argv);
  const runners = testintel.detectRunners(dir);
  if (out({ dir, runners }, json)) return 0;
  console.log("Runner detection — " + dir);
  console.log("-".repeat(60));
  if (!runners.length) { console.log("No test runner detected by convention."); return 0; }
  for (const r of runners) {
    console.log(pad(r.runner, 10) + " conf=" + r.confidence.toFixed(2) + "  (" + r.command + ")");
    for (const e of r.evidence) console.log("   - " + e);
  }
  return 0;
}

function cmdDiscover(argv, json) {
  const dir = dirArg(argv);
  const runner = arg("--runner", argv) || (testintel.detectPrimaryRunner(dir) || {}).runner || null;
  const files = testintel.discoverTestFiles(dir, { runner });
  if (out({ dir, runner, count: files.length, files }, json)) return 0;
  console.log("Test files (" + (runner || "any") + "): " + files.length);
  for (const f of files) console.log("  " + f);
  return 0;
}

function cmdAffected(argv, json) {
  const dir = dirArg(argv);
  const changed = list(arg("--changed", argv));
  const symbols = list(arg("--symbol", argv)).map((s) => { const [file, name] = s.split(":"); return { file, name }; });
  const index = codegraph.indexDirectory(dir, { cacheFile: null });
  const sel = testintel.selectAffected(index, { changed, changedSymbols: symbols });
  if (out({ changed, selected: sel.selected, skipped: sel.skipped, skippedFraction: sel.skippedFraction, reasons: sel.reasons }, json)) return 0;
  console.log("Affected-test selection — " + dir);
  console.log("-".repeat(60));
  console.log("changed: " + (changed.join(", ") || "(none)"));
  console.log("selected " + sel.selectedCount + " / " + sel.total + " tests  (skipping " + (sel.skippedFraction * 100).toFixed(1) + "%)");
  for (const t of sel.selected) console.log("  RUN  " + t + "  <- " + (sel.reasons[t] || []).join("; "));
  if (!sel.selected.length) console.log("  (nothing affected — safe to skip the suite)");
  return 0;
}

async function cmdRun(argv, json) {
  const dir = dirArg(argv);
  const runner = arg("--runner", argv) || (testintel.detectPrimaryRunner(dir) || {}).runner;
  if (!runner) { console.error("No runner detected; pass --runner."); return 2; }
  const files = list(arg("--files", argv));
  const res = await testintel.run(runner, { cwd: dir, files, coverage: has("--coverage", argv), grep: arg("--grep", argv) });
  if (out(testintel.summarize(res), json)) return res.ok ? 0 : 1;
  printResult(res);
  return res.ok ? 0 : 1;
}

async function cmdTriage(argv, json) {
  const dir = dirArg(argv);
  const runner = arg("--runner", argv) || (testintel.detectPrimaryRunner(dir) || {}).runner;
  if (!runner) { console.error("No runner detected; pass --runner."); return 2; }
  const res = await testintel.run(runner, { cwd: dir, files: list(arg("--files", argv)), grep: arg("--grep", argv) });
  const diag = testintel.triage(res);
  if (out({ summary: testintel.summarize(res), triage: diag }, json)) return res.ok ? 0 : 1;
  printResult(res);
  console.log("\nTriage: " + diag.summary);
  for (const c of diag.clusters) {
    console.log("  [" + c.kind + " x" + c.count + "] " + c.headline + (c.location ? "  @ " + c.location : ""));
    for (const m of c.members.slice(0, 5)) console.log("       - " + m.name);
    if (c.members.length > 5) console.log("       … +" + (c.members.length - 5) + " more");
  }
  return res.ok ? 0 : 1;
}

async function cmdFlaky(argv, json) {
  const dir = dirArg(argv);
  const runner = arg("--runner", argv) || (testintel.detectPrimaryRunner(dir) || {}).runner;
  if (!runner) { console.error("No runner detected; pass --runner."); return 2; }
  const times = Number(arg("--times", argv)) || 5;
  const grep = arg("--grep", argv) || (argv[1] && !argv[1].startsWith("--") ? argv[1] : null);
  const files = list(arg("--files", argv));
  const { classification } = await testintel.runRepeated(
    () => testintel.run(runner, { cwd: dir, files, grep }), times);
  if (out(classification, json)) return classification.flaky.length ? 1 : 0;
  console.log("Flaky detection — " + times + " runs, runner=" + runner + (grep ? ", grep=" + grep : ""));
  console.log("-".repeat(60));
  console.log("flaky: " + classification.flaky.length + "  consistently-failing: " + classification.failing.length + "  stable: " + classification.stable.length);
  for (const name of classification.flaky) { const c = classification.tests[name]; console.log("  FLAKY  " + name + "  (" + c.passes + " pass / " + c.fails + " fail, flipRate=" + c.flipRate + ")"); }
  for (const name of classification.failing) console.log("  FAIL   " + name + "  (consistently failing)");
  return classification.flaky.length ? 1 : 0;
}

function cmdCoverage(argv, json) {
  const file = argv[0];
  if (!file || file.startsWith("--")) { console.error("usage: coverage <coverage-file> [--changed-lines f:1-5,...]"); return 2; }
  const text = fs.readFileSync(path.resolve(file), "utf8");
  const cov = testintel.parseCoverage(text);
  const changedSpec = arg("--changed-lines", argv);
  let report = null;
  if (changedSpec) {
    const changedLinesByFile = {};
    for (const spec of changedSpec.split(";")) {
      const [f, lines] = spec.split(":");
      changedLinesByFile[f] = require("./coverage").expandRanges(lines || "");
    }
    report = testintel.uncoveredChangedLines(cov, changedLinesByFile);
  }
  if (out({ format: cov.format, totals: cov.totals, files: Object.keys(cov.files), uncoveredChanged: report }, json)) return 0;
  console.log("Coverage (" + cov.format + "): " + cov.totals.files + " files, line rate " + (cov.totals.lineRate != null ? (cov.totals.lineRate * 100).toFixed(1) + "%" : "n/a"));
  if (report) {
    console.log("\nUncovered changed lines:");
    for (const f of Object.keys(report.uncovered)) console.log("  " + f + ": " + report.uncovered[f].join(", "));
    if (!Object.keys(report.uncovered).length) console.log("  (all changed lines covered)");
  }
  return 0;
}

function cmdSkeleton(argv, json) {
  const dir = dirArg(argv);
  const file = arg("--file", argv);
  const framework = arg("--framework", argv);
  const index = codegraph.indexDirectory(dir, { cacheFile: null });
  const fns = testintel.untestedFunctions(index, { file: file ? path.relative(dir, path.resolve(file)) : undefined, onlyExported: has("--exported", argv) });
  const items = fns.map((fn) => ({ fn, skeleton: testintel.suggestSkeleton(fn, { framework }) }));
  if (out({ count: items.length, functions: fns.map((f) => ({ name: f.name, file: f.file, params: f.params })) }, json)) return 0;
  console.log("Untested functions: " + items.length);
  for (const it of items.slice(0, Number(arg("--limit", argv)) || 20)) {
    console.log("\n// " + it.fn.file + " :: " + it.fn.name + "(" + it.fn.params.join(", ") + ")  [" + it.skeleton.framework + "]");
    console.log(it.skeleton.code);
  }
  return 0;
}

function printResult(res) {
  if (res.available === false) { console.log("Runner " + res.runner + " unavailable: " + res.reason); return; }
  const s = testintel.summarize(res);
  console.log(res.runner + ": " + (res.ok ? "PASS" : "FAIL") + "  " + s.pass + "/" + s.total + " passed, " + s.fail + " failed, " + s.skip + " skipped  (" + s.durationMs + "ms)");
  for (const t of res.tests.filter((t) => t.status === "fail")) console.log("  FAIL " + (t.fullName || t.name) + (t.failure ? "  — " + t.failure.message : ""));
}

async function main(argv) {
  argv = argv || process.argv.slice(2);
  const cmd = argv[0];
  const rest = argv.slice(1);
  const json = has("--json", rest);
  try {
    switch (cmd) {
      case "detect": return cmdDetect(rest, json);
      case "discover": return cmdDiscover(rest, json);
      case "affected": return cmdAffected(rest, json);
      case "run": return await cmdRun(rest, json);
      case "triage": return await cmdTriage(rest, json);
      case "flaky": return await cmdFlaky(rest, json);
      case "coverage": return cmdCoverage(rest, json);
      case "skeleton": return cmdSkeleton(rest, json);
      default:
        console.log("nexus test <detect|discover|affected|run|triage|flaky|coverage|skeleton> [options]");
        console.log("See the header of src/testintel/cli.js for usage.");
        return cmd ? 2 : 0;
    }
  } catch (e) {
    console.error("error: " + (e && e.stack || e));
    return 1;
  }
}

function pad(s, n) { s = String(s); return s.length >= n ? s : s + " ".repeat(n - s.length); }

if (require.main === module) { main().then((code) => process.exit(code || 0)); }

module.exports = { main };
