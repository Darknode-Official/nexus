"use strict";
// Multi-lens "ultrareview" — an adversarial, rigorous code review of a diff across
// several dimensions, asking for severity-ranked, file:line-anchored findings.
// buildReviewPrompt + countBySeverity are pure and unit-tested; the engine call
// that runs the review is done by the Nexus TUI.

const DIMENSIONS = [
  { key: "correctness", label: "Correctness & bugs", ask: "logic errors, off-by-one, null/undefined, wrong edge-case handling, broken error paths, race conditions" },
  { key: "security", label: "Security", ask: "injection, auth/authz gaps, secret exposure, unsafe deserialization, path traversal, SSRF, missing input validation" },
  { key: "performance", label: "Performance", ask: "needless O(n^2), repeated work, sync I/O on hot paths, unbounded memory, missing caching/pagination" },
  { key: "tests", label: "Tests & coverage", ask: "untested new logic, missing edge-case or failure-path tests, brittle assertions, flakiness" },
  { key: "maintainability", label: "Maintainability", ask: "unclear naming, dead code, duplication, tight coupling, inconsistent style vs the surrounding code" },
];
const SEVERITY = ["critical", "high", "medium", "low", "nit"];

// buildReviewPrompt(diff, opts) -> the full review prompt.
function buildReviewPrompt(diff, opts) {
  opts = opts || {};
  const dims = opts.dimensions || DIMENSIONS;
  const maxDiff = opts.maxDiff || 24000;
  const d = String(diff == null ? "" : diff);
  const clipped = d.length > maxDiff;
  const body = clipped ? d.slice(0, maxDiff) + "\n… (diff truncated)" : d;
  const rubric = dims.map((x, i) => "  " + (i + 1) + ". " + x.label + " — " + x.ask).join("\n");
  return [
    "You are a principal engineer performing a rigorous, adversarial code review of the DIFF below.",
    "Examine it across these dimensions:",
    rubric,
    "",
    "For every REAL issue, output exactly one line:",
    "  [SEVERITY] path:line — the problem — the concrete fix",
    "SEVERITY is one of: " + SEVERITY.join(", ") + ". List the most severe first.",
    "Do NOT invent problems; if a dimension is clean, say nothing about it. Prefer real defects over style nits.",
    "End with a one-line VERDICT: ship / ship-with-fixes / do-not-ship.",
    "",
    "--- DIFF ---",
    body,
    "--- END DIFF ---",
  ].join("\n");
}

// countBySeverity(reviewText) -> { critical, high, medium, low, nit } from [SEVERITY] tags.
function countBySeverity(text) {
  const c = {}; for (const s of SEVERITY) c[s] = 0;
  const re = /\[(critical|high|medium|low|nit)\]/gi; let m;
  while ((m = re.exec(String(text == null ? "" : text)))) c[m[1].toLowerCase()]++;
  return c;
}

module.exports = { DIMENSIONS, SEVERITY, buildReviewPrompt, countBySeverity };
