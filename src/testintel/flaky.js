"use strict";
// ===================== Test Intelligence — Flaky-Test Detection =====================
// A single run can't tell a flaky test from a real failure. This module runs a test (or
// set) N times and classifies each test by the *variance* of its outcomes across runs,
// with the evidence attached. That's what lets the agent avoid two expensive mistakes:
// treating a flake as a real regression (and burning tokens chasing a ghost), and
// treating a real failure as "probably just flaky" (and shipping a bug).
//
//   classify(outcomesByTest)   -> per-test { verdict, passes, fails, runs, flipRate }
//   classifyRuns(results)      -> fold a list of Result objects into classify() input
//   runRepeated(runFn, n, opt) -> await runFn n times, returns { results, classification }
//
// Verdicts: "stable-pass" | "consistently-failing" | "flaky" | "stable-skip" | "inconclusive".
const model = require("./model");

const VERDICT = Object.freeze({
  STABLE_PASS: "stable-pass",
  CONSISTENT_FAIL: "consistently-failing",
  FLAKY: "flaky",
  STABLE_SKIP: "stable-skip",
  INCONCLUSIVE: "inconclusive",
});

// classifyOne(outcomes) — outcomes: array of status strings for one test across runs.
function classifyOne(outcomes) {
  const runs = outcomes.length;
  const passes = outcomes.filter((o) => o === model.STATUS.PASS).length;
  const fails = outcomes.filter((o) => o === model.STATUS.FAIL).length;
  const skips = outcomes.filter((o) => o === model.STATUS.SKIP || o === model.STATUS.TODO).length;
  // flips: adjacent outcome changes among pass/fail (skips ignored for flip counting).
  const seq = outcomes.filter((o) => o === model.STATUS.PASS || o === model.STATUS.FAIL);
  let flips = 0;
  for (let i = 1; i < seq.length; i++) if (seq[i] !== seq[i - 1]) flips++;
  const decided = passes + fails;
  let verdict;
  if (runs === 0) verdict = VERDICT.INCONCLUSIVE;
  else if (decided === 0) verdict = VERDICT.STABLE_SKIP;
  else if (passes > 0 && fails > 0) verdict = VERDICT.FLAKY;
  else if (fails === decided) verdict = VERDICT.CONSISTENT_FAIL;
  else if (passes === decided) verdict = runs === 1 ? VERDICT.INCONCLUSIVE : VERDICT.STABLE_PASS;
  else verdict = VERDICT.INCONCLUSIVE;
  return {
    verdict, runs, passes, fails, skips,
    flips,
    flipRate: seq.length > 1 ? round(flips / (seq.length - 1), 4) : 0,
    failRate: decided ? round(fails / decided, 4) : 0,
    // confidence in a "stable" verdict grows with run count; 1 run can't prove stability.
    confidence: runs >= 5 ? "high" : runs >= 3 ? "medium" : runs >= 2 ? "low" : "none",
  };
}

// classify(outcomesByTest) — map of testName -> status[] across runs.
// Returns { tests: {name: classification}, flaky: [names], failing: [names], summary }.
function classify(outcomesByTest) {
  const tests = {};
  const flaky = [], failing = [], stable = [];
  for (const name of Object.keys(outcomesByTest || {})) {
    const c = classifyOne(outcomesByTest[name]);
    tests[name] = c;
    if (c.verdict === VERDICT.FLAKY) flaky.push(name);
    else if (c.verdict === VERDICT.CONSISTENT_FAIL) failing.push(name);
    else if (c.verdict === VERDICT.STABLE_PASS) stable.push(name);
  }
  flaky.sort(); failing.sort(); stable.sort();
  return {
    tests, flaky, failing, stable,
    summary: {
      total: Object.keys(tests).length,
      flaky: flaky.length, failing: failing.length, stable: stable.length,
    },
  };
}

// classifyRuns(results) — fold an array of Result objects (same suite run N times)
// into the per-test outcome map, keyed by fullName, then classify.
function classifyRuns(results) {
  const outcomes = {};
  for (const r of results || []) {
    for (const t of (r.tests || [])) {
      const key = t.fullName || t.name;
      (outcomes[key] || (outcomes[key] = [])).push(t.status);
    }
  }
  const out = classify(outcomes);
  out.runCount = (results || []).length;
  return out;
}

// runRepeated(runFn, n, opts) — invoke runFn() n times (it must return/resolve a Result),
// collect the results and classify. opts: { stopOnFirstFlake:false }. Sequential by
// default because re-running the same tests concurrently can itself induce false flakes
// (shared fixtures, ports); callers who know their suite is isolated can parallelize
// outside this function and pass the results to classifyRuns().
async function runRepeated(runFn, n, opts) {
  opts = opts || {};
  n = Math.max(1, n | 0 || 1);
  const results = [];
  for (let i = 0; i < n; i++) {
    const r = await runFn(i);
    results.push(r);
    if (opts.stopOnFirstFlake && i >= 1) {
      const c = classifyRuns(results);
      if (c.flaky.length) { c.earlyStop = true; return { results, classification: c }; }
    }
  }
  return { results, classification: classifyRuns(results) };
}

function round(n, d) { const p = Math.pow(10, d == null ? 2 : d); return Math.round((Number(n) || 0) * p) / p; }

module.exports = { classify, classifyOne, classifyRuns, runRepeated, VERDICT };
