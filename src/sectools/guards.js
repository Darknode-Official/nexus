"use strict";
// ================= sectools/guards — pre-send & pre-commit guard hooks =================
// Structured guards the Nexus agent runs at two choke points:
//
//   • preSendGuard(text)   — before any text is sent to an AI engine. Detects
//     secrets and returns a redacted copy plus a block decision, so credentials
//     are never shipped to a third-party model.
//   • preCommitGuard(root) — before a commit. Runs the secret, SAST and dependency
//     scanners over the working tree (or a supplied file list) and returns a block
//     decision keyed to a severity threshold.
//
// These functions only DECIDE and REPORT — they never call git, never exit the
// process, and never mutate files. The main agent wires the actual gating UX
// (prompt the user, abort the send, print the report) per INTEGRATION.md.

const fs = require("fs");
const secrets = require("./secrets");
const sast = require("./sast");
const advisories = require("./advisories");
const { explainAll } = require("./explain");
const { walk, readText } = require("./walk");

const SEVERITY_ORDER = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

/**
 * Rank a severity string to a number (unknown -> 0).
 * @param {string} s
 */
function severityRank(s) {
  return SEVERITY_ORDER[String(s || "").toLowerCase()] || 0;
}

/**
 * Count findings by severity.
 * @param {Array<object>} findings
 * @returns {{critical:number, high:number, medium:number, low:number, info:number, total:number}}
 */
function countBySeverity(findings) {
  const c = { critical: 0, high: 0, medium: 0, low: 0, info: 0, total: 0 };
  for (const f of findings || []) {
    const s = String(f.severity || "info").toLowerCase();
    if (c[s] == null) c[s] = 0;
    c[s]++; c.total++;
  }
  return c;
}

/**
 * Decide whether findings should block given a minimum blocking severity.
 * @param {Array<object>} findings
 * @param {string} threshold minimum severity that blocks (default "high")
 * @returns {{blocked:boolean, blocking:Array<object>, counts:object}}
 */
function decide(findings, threshold) {
  const min = severityRank(threshold || "high");
  const blocking = (findings || []).filter((f) => severityRank(f.severity) >= min);
  return { blocked: blocking.length > 0, blocking, counts: countBySeverity(findings) };
}

/**
 * Pre-send guard: scan outgoing text for secrets and produce a redacted copy.
 * @param {string} text
 * @param {object} [opts]
 * @param {string} [opts.threshold="medium"] severity that blocks the send
 * @param {boolean} [opts.redact=true] include a redacted copy of the text
 * @param {boolean} [opts.entropy=true] enable entropy-based detection
 * @returns {{ ok:boolean, blocked:boolean, findings:Array<object>, redacted:string|null, counts:object, reason:string }}
 */
function preSendGuard(text, opts) {
  opts = opts || {};
  const threshold = opts.threshold || "medium";
  const findings = secrets.scanText(text, { file: "<outgoing>", entropy: opts.entropy !== false });
  const { blocked, counts } = decide(findings, threshold);
  const redacted = opts.redact === false ? null : secrets.redact(text, { entropy: opts.entropy !== false }).text;
  return {
    ok: findings.length === 0,
    blocked,
    findings,
    redacted,
    counts,
    reason: findings.length
      ? `${findings.length} secret finding(s) in outgoing text; ${blocked ? "blocked" : "allowed"} at threshold ${threshold}. Send the redacted copy instead.`
      : "No secrets detected in outgoing text.",
  };
}

/**
 * Collect candidate files to scan for the pre-commit guard.
 * Accepts an explicit `files` list (e.g. git staged paths) or walks `root`.
 * @param {string} root
 * @param {object} opts
 * @returns {Array<{path:string, rel:string}>}
 */
function collectFiles(root, opts) {
  if (opts.files && opts.files.length) {
    return opts.files
      .filter((p) => { try { return fs.statSync(p).isFile(); } catch (_) { return false; } })
      .map((p) => ({ path: p, rel: p }));
  }
  return walk(root, opts).files;
}

/**
 * Pre-commit guard: run secret + SAST + dependency scanners and decide.
 * @param {string} root directory to scan (ignored when opts.files is given)
 * @param {object} [opts]
 * @param {string[]} [opts.files] explicit file list (e.g. git staged files)
 * @param {string} [opts.threshold="high"] minimum severity that blocks the commit
 * @param {boolean} [opts.deps=true] also check dependency manifests
 * @param {boolean} [opts.explain=false] attach explanation + fix to each finding
 * @returns {{ ok:boolean, blocked:boolean, findings:Array<object>, counts:object, filesScanned:number, reason:string }}
 */
function preCommitGuard(root, opts) {
  opts = opts || {};
  const threshold = opts.threshold || "high";
  const files = collectFiles(root, opts);
  const findings = [];
  let scanned = 0;

  for (const f of files) {
    const text = readText(f.path, opts);
    if (text == null) continue;
    scanned++;
    findings.push(...secrets.scanText(text, Object.assign({}, opts, { file: f.rel })));
    if (sast.languageOf(f.rel)) {
      findings.push(...sast.scanText(text, Object.assign({}, opts, { file: f.rel })));
    }
    const base = f.rel.toLowerCase();
    if (opts.deps !== false) {
      if (base.endsWith("package.json")) {
        findings.push(...advisories.checkDependencies(advisories.parsePackageJson(text), opts));
      } else if (base.endsWith("requirements.txt")) {
        findings.push(...advisories.checkDependencies(advisories.parseRequirementsTxt(text), opts));
      } else if (base.endsWith("package-lock.json")) {
        findings.push(...advisories.checkDependencies(advisories.parsePackageLock(text), opts));
      }
    }
  }

  const decision = decide(findings, threshold);
  const enriched = opts.explain ? explainAll(findings) : findings;
  return {
    ok: findings.length === 0,
    blocked: decision.blocked,
    findings: enriched,
    counts: decision.counts,
    filesScanned: scanned,
    reason: findings.length
      ? `${findings.length} finding(s) across ${scanned} file(s); ${decision.blocked ? "COMMIT BLOCKED" : "commit allowed"} at threshold ${threshold}.`
      : `No findings across ${scanned} file(s).`,
  };
}

module.exports = {
  SEVERITY_ORDER,
  severityRank,
  countBySeverity,
  decide,
  preSendGuard,
  preCommitGuard,
  collectFiles,
};
