"use strict";
// ===================== Test Intelligence — Unified Result Model =====================
// One shape for test outcomes no matter which runner produced them (node:test, jest,
// mocha, pytest, go test). The parsers in ./parsers.js normalize raw runner output
// into this model; everything downstream (triage, flaky classification, coverage
// correlation, the CLI) consumes only this. Keeping the model tiny and explicit is
// what lets the agent reason about "what failed and why" without re-learning five
// output formats. Pure data + pure functions — no I/O, Node stdlib only.
//
// A Test:
//   { name, fullName, file, status, durationMs, failure }
//     status  — one of STATUS (pass | fail | skip | todo)
//     failure — null, or { message, type, stack, expected, actual, operator, location }
//
// A Result:
//   { runner, ok, tests: Test[], durationMs, counts, meta }
//     ok      — true iff no test has status "fail" (and the run itself didn't error)
//     counts  — { total, pass, fail, skip, todo }

const STATUS = Object.freeze({ PASS: "pass", FAIL: "fail", SKIP: "skip", TODO: "todo" });
const STATUSES = Object.freeze(["pass", "fail", "skip", "todo"]);

// normStatus(s) -> canonical status string. Maps the various runner vocabularies
// ("passed"/"ok"/"success", "failed"/"error", "pending"/"skipped", "todo") onto STATUS.
function normStatus(s) {
  const v = String(s == null ? "" : s).toLowerCase().trim();
  if (v === "pass" || v === "passed" || v === "ok" || v === "success") return STATUS.PASS;
  if (v === "fail" || v === "failed" || v === "error" || v === "errored" || v === "not ok") return STATUS.FAIL;
  if (v === "skip" || v === "skipped" || v === "pending" || v === "ignored" || v === "disabled") return STATUS.SKIP;
  if (v === "todo") return STATUS.TODO;
  return STATUS.FAIL; // unknown/absent is treated as a failure, never silently a pass
}

// makeFailure(obj) -> normalized failure record, or null for falsy input.
function makeFailure(obj) {
  if (!obj) return null;
  const f = {
    message: str(obj.message),
    type: obj.type ? String(obj.type) : null,
    stack: obj.stack ? String(obj.stack) : null,
    expected: obj.expected === undefined ? null : obj.expected,
    actual: obj.actual === undefined ? null : obj.actual,
    operator: obj.operator ? String(obj.operator) : null,
    location: obj.location ? String(obj.location) : null,
  };
  if (!f.message && f.stack) f.message = firstLine(f.stack);
  return f;
}

// makeTest(obj) -> normalized Test. Tolerant of partial input.
function makeTest(obj) {
  obj = obj || {};
  const status = normStatus(obj.status);
  const name = str(obj.name) || str(obj.title) || "(anonymous test)";
  return {
    name,
    fullName: str(obj.fullName) || name,
    file: obj.file ? String(obj.file) : null,
    status,
    durationMs: num(obj.durationMs),
    failure: status === STATUS.FAIL ? makeFailure(obj.failure) : (obj.failure ? makeFailure(obj.failure) : null),
  };
}

// countTests(tests) -> { total, pass, fail, skip, todo }.
function countTests(tests) {
  const c = { total: 0, pass: 0, fail: 0, skip: 0, todo: 0 };
  for (const t of tests || []) { c.total++; c[t.status] = (c[t.status] || 0) + 1; }
  return c;
}

// makeResult(obj) -> normalized Result. Recomputes counts and `ok` from the tests
// so callers can't hand back an inconsistent summary. If `errored` is set (the runner
// process itself blew up, e.g. a syntax error before any test ran), ok is forced false.
function makeResult(obj) {
  obj = obj || {};
  const tests = (obj.tests || []).map(makeTest);
  const counts = countTests(tests);
  const errored = !!obj.errored;
  const declaredOk = obj.ok === undefined ? null : !!obj.ok;
  let ok = counts.fail === 0 && !errored;
  if (declaredOk === false) ok = false; // honour an explicit runner-level failure signal
  return {
    runner: obj.runner ? String(obj.runner) : "unknown",
    ok,
    errored,
    tests,
    counts,
    durationMs: obj.durationMs != null ? num(obj.durationMs) : sumDuration(tests),
    stdout: obj.stdout != null ? String(obj.stdout) : undefined,
    stderr: obj.stderr != null ? String(obj.stderr) : undefined,
    exitCode: obj.exitCode === undefined ? null : obj.exitCode,
    meta: obj.meta || {},
  };
}

// emptyResult(runner, extra) -> a zero-test Result (used when a runner is missing).
function emptyResult(runner, extra) {
  return makeResult(Object.assign({ runner: runner || "unknown", tests: [] }, extra || {}));
}

// failures(result) -> the Test[] that failed, in declaration order.
function failures(result) { return (result.tests || []).filter((t) => t.status === STATUS.FAIL); }

// slowest(result, n) -> the n slowest tests by duration (desc). Useful for the agent
// to know where its test budget is being spent.
function slowest(result, n) {
  return [...(result.tests || [])]
    .filter((t) => Number.isFinite(t.durationMs))
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, n || 10);
}

// mergeResults(results, runner) -> one Result aggregating several (e.g. per-package
// go test runs, or the same suite re-run). Tests are concatenated; counts/ok recomputed.
function mergeResults(results, runner) {
  const all = [];
  let dur = 0, errored = false;
  for (const r of results || []) {
    for (const t of (r.tests || [])) all.push(t);
    dur += num(r.durationMs);
    if (r.errored) errored = true;
  }
  return makeResult({ runner: runner || (results && results[0] && results[0].runner) || "unknown", tests: all, durationMs: dur, errored });
}

// summarize(result) -> a compact one-line-friendly summary object.
function summarize(result) {
  const c = result.counts;
  return {
    runner: result.runner,
    ok: result.ok,
    total: c.total, pass: c.pass, fail: c.fail, skip: c.skip, todo: c.todo,
    durationMs: round(result.durationMs),
    passRate: c.total ? round(c.pass / c.total, 4) : 0,
  };
}

// --- tiny internal helpers ---
function str(v) { return v == null ? "" : String(v); }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function sumDuration(tests) { let s = 0; for (const t of tests) s += num(t.durationMs); return round(s, 3); }
function firstLine(s) { const i = String(s).indexOf("\n"); return i < 0 ? String(s) : String(s).slice(0, i); }
function round(n, d) { const p = Math.pow(10, d == null ? 2 : d); return Math.round(num(n) * p) / p; }

module.exports = {
  STATUS, STATUSES,
  normStatus, makeFailure, makeTest, makeResult, emptyResult,
  countTests, failures, slowest, mergeResults, summarize,
};
