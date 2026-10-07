"use strict";
// ===================== Test Intelligence — Failure Triage =====================
// Turn a pile of failures into a short, structured diagnosis the agent can act on
// without re-reading raw logs. Deterministic and local — no LLM in the baseline.
//
//   extractSalient(failure)   -> { headline, kind, location, expected, actual, frame }
//   signature(failure)        -> a stable clustering key (normalized message + top frame)
//   clusterFailures(tests)    -> [{ signature, kind, count, representative, members[] }]
//   triage(result)            -> { clusters, total, summary }
//
// Clustering groups failures that share a root cause (same assertion at the same
// place, same thrown error type, same timeout) so "47 failures" collapses into the
// 2-3 real problems. The salient extractor pulls the one line that matters out of a
// multi-frame stack and classifies the failure kind.
const model = require("./model");

const KIND = Object.freeze({
  ASSERTION: "assertion", TIMEOUT: "timeout", TYPE_ERROR: "type-error",
  REFERENCE_ERROR: "reference-error", SYNTAX_ERROR: "syntax-error", THROWN: "thrown",
  IMPORT: "import-error", UNKNOWN: "unknown",
});

// classifyKind(failure) -> KIND based on message/type.
function classifyKind(failure) {
  const msg = (failure.message || "") + " " + (failure.type || "") + " " + (failure.stack || "");
  if (failure.expected !== null && failure.expected !== undefined || failure.operator) return KIND.ASSERTION;
  if (/AssertionError|expect\(|to\s+(equal|be|deep.?equal|contain|match|have)\b|assert\b/i.test(msg)) return KIND.ASSERTION;
  if (/\bexpected\b[\s\S]{0,40}\b(but\s+)?(got|received|actual)\b/i.test(msg)) return KIND.ASSERTION;
  if (/timed out|timeout|exceeded .*ms|ETIMEDOUT/i.test(msg)) return KIND.TIMEOUT;
  if (/TypeError/i.test(msg)) return KIND.TYPE_ERROR;
  if (/ReferenceError/i.test(msg)) return KIND.REFERENCE_ERROR;
  if (/SyntaxError/i.test(msg)) return KIND.SYNTAX_ERROR;
  if (/Cannot find module|ModuleNotFoundError|ImportError|cannot import|MODULE_NOT_FOUND/i.test(msg)) return KIND.IMPORT;
  if (/Error:|panic:|raised|threw/i.test(msg)) return KIND.THROWN;
  return KIND.UNKNOWN;
}

// topFrame(stack) -> the first stack frame that points at user code (skips node internals
// and node_modules), as "file:line" where possible.
function topFrame(stack) {
  if (!stack) return null;
  const lines = String(stack).split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/node:internal|node_modules|internal\/test_runner|async_hooks/.test(line)) continue;
    // "at fn (/path/file.js:10:5)"  or  "/path/file.js:10:5"  or  "file.py:12:"
    const m = line.match(/\(?([^\s()]+(?:\.[a-z]+)):(\d+)(?::\d+)?\)?/i);
    if (m && /\.(js|ts|jsx|tsx|mjs|cjs|py|go|rb)$/.test(m[1])) return m[1] + ":" + m[2];
  }
  // fall back to first frame with a location at all
  for (const raw of lines) { const m = raw.match(/([^\s()]+):(\d+)(?::\d+)?/); if (m) return m[1] + ":" + m[2]; }
  return null;
}

// extractSalient(failure) -> the distilled, human/agent-facing summary of one failure.
function extractSalient(failure) {
  failure = failure || {};
  const kind = classifyKind(failure);
  const frame = topFrame(failure.stack);
  let headline = cleanLine(failure.message) || (failure.stack ? cleanLine(firstLine(failure.stack)) : "failure");
  // For assertions, prefer an "expected X, got Y" headline when we have the values.
  if (kind === KIND.ASSERTION && failure.expected !== null && failure.expected !== undefined) {
    headline = "expected " + repr(failure.expected) + (failure.operator ? " " + failure.operator + " " : " == ") + "actual " + repr(failure.actual);
  }
  return {
    headline: headline.slice(0, 300),
    kind,
    location: failure.location || frame || null,
    frame,
    expected: failure.expected === undefined ? null : failure.expected,
    actual: failure.actual === undefined ? null : failure.actual,
    type: failure.type || null,
  };
}

// signature(failure) -> a stable string key for clustering. Normalizes volatile parts
// (numbers, hex, paths' line numbers, quoted literals) so cosmetically-different
// instances of the same bug land in one cluster, but genuinely different bugs don't.
function signature(failure) {
  const s = extractSalient(failure);
  let key = String(s.headline).toLowerCase();
  key = key
    .replace(/0x[0-9a-f]+/g, "0xH")
    .replace(/\b\d+(\.\d+)?\b/g, "N")
    .replace(/(['"]).*?\1/g, "S")
    .replace(/[a-z0-9_./\\-]+:(N)/g, "FILE:N")
    .replace(/\s+/g, " ")
    .trim();
  const frameKey = s.frame ? s.frame.replace(/:\d+$/, "") : "";
  return s.kind + "|" + key + "|" + frameKey;
}

// clusterFailures(tests) — tests is a Test[] (only failures are considered).
function clusterFailures(tests) {
  const groups = new Map();
  for (const t of tests || []) {
    if (t.status !== model.STATUS.FAIL || !t.failure) continue;
    const sig = signature(t.failure);
    let g = groups.get(sig);
    if (!g) { g = { signature: sig, kind: classifyKind(t.failure), salient: extractSalient(t.failure), members: [] }; groups.set(sig, g); }
    g.members.push({ name: t.fullName || t.name, file: t.file, location: (t.failure && t.failure.location) || null });
  }
  const clusters = [...groups.values()].map((g) => ({
    signature: g.signature,
    kind: g.kind,
    count: g.members.length,
    headline: g.salient.headline,
    location: g.salient.location,
    representative: g.members[0].name,
    members: g.members,
  }));
  clusters.sort((a, b) => b.count - a.count || a.headline.localeCompare(b.headline));
  return clusters;
}

// triage(result) — full triage of a Result.
function triage(result) {
  const fails = model.failures(result);
  const clusters = clusterFailures(result.tests);
  const byKind = {};
  for (const c of clusters) byKind[c.kind] = (byKind[c.kind] || 0) + c.count;
  return {
    total: fails.length,
    clusterCount: clusters.length,
    clusters,
    byKind,
    summary: clusters.length
      ? clusters.length + " distinct failure" + (clusters.length === 1 ? "" : "s") + " across " + fails.length + " failing test" + (fails.length === 1 ? "" : "s")
      : "no failures",
  };
}

// --- helpers ---
// Strip ANSI SGR color codes without a literal escape in source (repo convention).
const ANSI_RE = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g");
function cleanLine(s) { return String(s == null ? "" : s).replace(ANSI_RE, "").trim(); }
function firstLine(s) { return String(s || "").split("\n")[0]; }
function repr(v) {
  if (v === null) return "null";
  if (typeof v === "string") return JSON.stringify(v.length > 60 ? v.slice(0, 60) + "…" : v);
  if (typeof v === "object") { try { const j = JSON.stringify(v); return j.length > 60 ? j.slice(0, 60) + "…" : j; } catch (_) { return String(v); } }
  return String(v);
}

module.exports = { extractSalient, signature, clusterFailures, triage, classifyKind, topFrame, KIND };
