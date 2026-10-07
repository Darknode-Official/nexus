"use strict";
// ===================== Test Intelligence — Affected-Test Selection =====================
// Given a set of changed files (and optionally changed symbols), compute the MINIMAL
// set of test files worth running. This is where the token/time savings live: the agent
// edits three files, and instead of re-running the whole suite it runs only the tests
// whose dependency closure touches the change.
//
// Method (built on src/codegraph):
//   • codegraph already models the import/require graph with reverse edges and
//     blast-radius (impact) analysis. A test file that imports a source file is a
//     *dependent* of it, so codegraph's reverse-reachability answers "which tests
//     transitively depend on this change?" directly and correctly across hops.
//   • For symbol-level changes we use codegraph's symbolImpact (direct symbol users +
//     transitive modules) to tighten selection to tests that actually reach the symbol.
//   • A convention-based fallback (foo.js <-> foo.test.js, src/x.py <-> test_x.py)
//     catches tests whose link to source isn't an analyzable static import (dynamic
//     require, string path, cross-language, or an unresolved external).
//
// Honest: this is import-graph + heuristics, not execution tracing. It is designed to
// *over*-select slightly (safe: you never skip a test that should run because of a
// missed dynamic edge — the fallback and whole-suite guard cover that) rather than
// under-select. The report states exactly why each test was chosen and the skip fraction.
//
//   buildTestMap(index, opts)       -> Map testFile -> { deps:Set, closure:Set }
//   selectAffected(index, opts)     -> { selected, skipped, reasons, fraction, ... }
const path = require("path");
const codegraph = require("../codegraph");
const discovery = require("./discovery");

function norm(p) { return String(p || "").replace(/\\/g, "/").replace(/^\.\//, ""); }

// forwardClosure(graph, start) -> Set of all files reachable from `start` via import
// edges (what `start` depends on, transitively). graph.adj: file -> Set(deps).
function forwardClosure(graph, start) {
  const seen = new Set();
  const stack = [norm(start)];
  while (stack.length) {
    const f = stack.pop();
    for (const dep of (graph.adj.get(f) || [])) {
      if (!seen.has(dep)) { seen.add(dep); stack.push(dep); }
    }
  }
  return seen;
}

// identifyTestFiles(index, opts) -> Set of normalized test file paths present in the index.
function identifyTestFiles(index, opts) {
  opts = opts || {};
  if (opts.testFiles) return new Set(opts.testFiles.map(norm));
  const set = new Set();
  for (const f of index.files) {
    const p = norm(f.file);
    if (discovery.isTestFile(p)) set.add(p);
  }
  return set;
}

// buildTestMap(index, opts) -> for each test file, its direct source deps and the full
// forward closure (every source file it transitively pulls in).
function buildTestMap(index, opts) {
  const tests = identifyTestFiles(index, opts);
  const map = new Map();
  for (const t of tests) {
    const deps = new Set(index.graph.adj.get(t) || []);
    const closure = forwardClosure(index.graph, t);
    map.set(t, { deps, closure });
  }
  return map;
}

// --- convention fallback: relate a source file to likely test files by name ---
function baseName(file) { return path.posix.basename(norm(file)).replace(/\.(test|spec)\./, ".").replace(/\.[^.]+$/, ""); }
function conventionMatches(changedFile, testFiles) {
  const cf = norm(changedFile);
  const base = baseName(cf);
  const out = [];
  for (const t of testFiles) {
    const tb = baseName(t);
    // foo.js <-> foo.test.js / foo.spec.js ; x.py <-> test_x.py / x_test.py ; x.go <-> x_test.go
    if (tb === base) out.push(t);
    else if (tb === "test_" + base || tb === base + "_test") out.push(t);
    else if (path.posix.basename(t).replace(/\.[^.]+$/, "") === "test_" + base) out.push(t);
  }
  return out;
}

// selectAffected(index, opts)
//   opts: { changed: string[], changedSymbols: [{file,name}], testFiles?, allTests?,
//           includeChangedTests?: true }
// Returns:
//   { selected: string[], skipped: string[], reasons: {test: [why...]},
//     total, selectedCount, skippedFraction, byChange: {changedFile: [tests]} }
function selectAffected(index, opts) {
  opts = opts || {};
  const testFiles = identifyTestFiles(index, opts);
  const allTests = opts.allTests ? new Set(opts.allTests.map(norm)) : testFiles;
  const changed = (opts.changed || []).map(norm);
  const changedSymbols = opts.changedSymbols || [];
  const testMap = buildTestMap(index, { testFiles: [...testFiles] });

  const selected = new Set();
  const reasons = {};
  const byChange = {};
  const addReason = (t, why) => { (reasons[t] || (reasons[t] = [])).push(why); selected.add(t); };
  const addByChange = (ch, t) => { (byChange[ch] || (byChange[ch] = new Set())).add(t); };

  // 1) A changed file that *is* a test -> run it (unless suppressed).
  if (opts.includeChangedTests !== false) {
    for (const cf of changed) {
      if (allTests.has(cf)) { addReason(cf, "changed test file"); addByChange(cf, cf); }
    }
  }

  // 2) File-level blast radius via codegraph: tests that depend on a changed file.
  for (const cf of changed) {
    let dependents = [];
    try { dependents = index.impact(cf).transitive.map((d) => d.file); } catch (_) { dependents = []; }
    for (const dep of dependents) {
      if (allTests.has(dep)) { addReason(dep, "imports changed file (transitively): " + cf); addByChange(cf, dep); }
    }
    // 2b) convention fallback for unresolved static links.
    for (const t of conventionMatches(cf, allTests)) {
      if (!reasons[t] || !reasons[t].some((r) => r.indexOf(cf) >= 0)) { addReason(t, "name-convention match for: " + cf); addByChange(cf, t); }
    }
  }

  // 3) Symbol-level blast radius: tighter selection for a changed symbol.
  for (const sym of changedSymbols) {
    let imp;
    try { imp = index.impact({ file: norm(sym.file), name: sym.name }); } catch (_) { imp = null; }
    if (!imp) continue;
    const users = new Set([...(imp.directSymbolUsers || []), ...((imp.transitiveModules || []).map((m) => m.file))]);
    for (const u of users) {
      if (allTests.has(norm(u))) { addReason(norm(u), "reaches changed symbol " + sym.name + " (" + sym.file + ")"); }
    }
  }

  const selArr = [...selected].filter((t) => allTests.has(t)).sort();
  const skipped = [...allTests].filter((t) => !selected.has(t)).sort();
  const total = allTests.size;
  // Normalize byChange sets to arrays.
  const byChangeOut = {};
  for (const k of Object.keys(byChange)) byChangeOut[k] = [...byChange[k]].sort();

  return {
    selected: selArr,
    skipped,
    reasons,
    byChange: byChangeOut,
    total,
    selectedCount: selArr.length,
    skippedCount: skipped.length,
    skippedFraction: total ? round(skipped.length / total, 4) : 0,
    testMapSize: testMap.size,
  };
}

// selectAffectedFromRoot(root, opts) — convenience that indexes the repo first.
// opts also accepts { cacheFile } passed to codegraph.indexDirectory.
function selectAffectedFromRoot(root, opts) {
  opts = opts || {};
  const index = codegraph.indexDirectory(path.resolve(root || "."), { cacheFile: opts.cacheFile || null });
  const res = selectAffected(index, opts);
  res.index = index;
  return res;
}

function round(n, d) { const p = Math.pow(10, d == null ? 2 : d); return Math.round((Number(n) || 0) * p) / p; }

module.exports = { selectAffected, selectAffectedFromRoot, buildTestMap, identifyTestFiles, forwardClosure, conventionMatches };
