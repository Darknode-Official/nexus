"use strict";
// ================= sectools — security-aware code tools for Nexus =================
// Single entrypoint for the Nexus code-security subsystem. It bundles:
//   • secrets    — secret scanner (entropy + curated rules) + redaction
//   • sast       — SAST-lite static analysis for JS/TS, Python, shell
//   • sastRules  — the data-driven SAST ruleset
//   • advisories — offline dependency advisory checker + bundled DB
//   • advisoryDb — the seed advisory database (data)
//   • explain    — finding explainer + deterministic autofix suggester
//   • guards     — pre-send and pre-commit guard hooks
//   • walk       — shared file walker utilities
//
// Plus a top-level `audit()` that runs all three scanners over a directory and
// returns a single, severity-sorted finding list with counts. This module is pure
// Node stdlib and has zero third-party dependencies.
//
// See ./README.md for rules, the advisory DB format and honest detection limits,
// and ./INTEGRATION.md for how the main agent wires it into the CLI.

const secrets = require("./secrets");
const sast = require("./sast");
const sastRules = require("./sast-rules");
const advisories = require("./advisories");
const advisoryDb = require("./advisory-db");
const explain = require("./explain");
const guards = require("./guards");
const walk = require("./walk");

const SEVERITY_ORDER = guards.SEVERITY_ORDER;

/**
 * Sort findings by severity (critical first), then file, then line.
 * @param {Array<object>} findings
 * @returns {Array<object>}
 */
function sortFindings(findings) {
  return (findings || []).slice().sort((a, b) => {
    const s = (SEVERITY_ORDER[b.severity] || 0) - (SEVERITY_ORDER[a.severity] || 0);
    if (s !== 0) return s;
    const fa = a.file || "", fb = b.file || "";
    if (fa !== fb) return fa < fb ? -1 : 1;
    return (a.line || 0) - (b.line || 0);
  });
}

/**
 * Run every scanner over a directory (or a single file) and return a combined
 * report. Each scanner can be toggled off via opts.
 *
 * @param {string} root directory or file to audit
 * @param {object} [opts]
 * @param {boolean} [opts.secrets=true] run the secret scanner
 * @param {boolean} [opts.sast=true] run the SAST engine
 * @param {boolean} [opts.deps=true] run the dependency advisory checker
 * @param {boolean} [opts.explain=false] attach explanation + fix to each finding
 * @param {boolean} [opts.entropy=true] enable entropy-based secret detection
 * @returns {{ root:string, findings:Array<object>, counts:object, filesScanned:number, manifests:string[], truncated:boolean }}
 */
function audit(root, opts) {
  opts = opts || {};
  let findings = [];
  let filesScanned = 0;
  let truncated = false;
  let manifests = [];

  if (opts.secrets !== false) {
    const r = secrets.scanDir(root, opts);
    findings.push(...r.findings);
    filesScanned = Math.max(filesScanned, r.filesScanned);
    truncated = truncated || r.truncated;
  }
  if (opts.sast !== false) {
    const r = sast.scanDir(root, opts);
    findings.push(...r.findings);
    truncated = truncated || r.truncated;
  }
  if (opts.deps !== false) {
    const r = advisories.checkManifestsDir(root, opts);
    findings.push(...r.findings);
    manifests = r.manifests;
  }

  if (opts.explain) findings = explain.explainAll(findings);
  findings = sortFindings(findings);

  return {
    root,
    findings,
    counts: guards.countBySeverity(findings),
    filesScanned,
    manifests,
    truncated,
  };
}

/**
 * Render an audit report as plain text (no colour, safe for logs/CI).
 * @param {object} report the result of audit()
 * @returns {string}
 */
function formatReport(report) {
  const c = report.counts;
  const lines = [];
  lines.push(`Nexus sectools audit — ${report.root}`);
  lines.push(`Files scanned: ${report.filesScanned}${report.truncated ? " (truncated)" : ""} | Manifests: ${report.manifests.length}`);
  lines.push(`Findings: ${c.total}  [critical ${c.critical}, high ${c.high}, medium ${c.medium}, low ${c.low}]`);
  lines.push("");
  if (!report.findings.length) {
    lines.push("No findings.");
    return lines.join("\n");
  }
  for (const f of report.findings) {
    const loc = f.type === "dependency"
      ? `${f.package}@${f.version}`
      : `${f.file}:${f.line}${f.column ? ":" + f.column : ""}`;
    lines.push(`[${String(f.severity).toUpperCase()}] ${f.id} (${f.cwe || "n/a"}) — ${f.title}`);
    lines.push(`    ${loc}`);
    if (f.snippet) lines.push(`    > ${f.snippet}`);
    if (f.remediation) lines.push(`    fix: ${f.remediation}`);
    lines.push("");
  }
  return lines.join("\n");
}

module.exports = {
  // submodules
  secrets,
  sast,
  sastRules,
  advisories,
  advisoryDb,
  explain,
  guards,
  walk,
  // aggregate API
  audit,
  sortFindings,
  formatReport,
  SEVERITY_ORDER,
};
