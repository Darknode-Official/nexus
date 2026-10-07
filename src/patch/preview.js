"use strict";
// ================= Dry-run & preview rendering =================
// Human-readable renderings of what a patch/codemod/transaction WOULD do, built on
// the diff engine. Every mutating operation in this subsystem supports a dry run;
// these helpers turn the resulting data into compact, reviewable summaries.

const diff = require("./diff");

/**
 * Render a unified diff with a short stat header.
 * @param {string} before
 * @param {string} after
 * @param {string} [file="file"]
 * @returns {{diff: string, additions: number, deletions: number, changed: boolean}}
 */
function diffPreview(before, after, file) {
  const d = diff.createUnifiedDiff(before, after, { oldPath: file || "file", newPath: file || "file" });
  const stat = diff.diffStat(d);
  return { diff: d, additions: stat.additions, deletions: stat.deletions, changed: d !== "" };
}

/**
 * Summarize a transaction preview ({@link Transaction#preview}) as one text block.
 * @param {{files: Array<{file, action, additions, deletions, diff}>, ok: boolean, errors: Array}} txPreview
 * @returns {string}
 */
function renderTransaction(txPreview) {
  const lines = [];
  const sign = txPreview.ok ? "OK" : "BLOCKED";
  lines.push(`[dry-run ${sign}] ${txPreview.files.length} file(s)`);
  for (const f of txPreview.files) {
    lines.push(`  ${f.action.padEnd(6)} ${f.file}  (+${f.additions} -${f.deletions})`);
  }
  if (txPreview.errors && txPreview.errors.length) {
    lines.push("  errors:");
    for (const e of txPreview.errors) lines.push(`    - ${e.file}: ${e.reason}`);
  }
  return lines.join("\n");
}

/**
 * One-line summary of a single apply result (from apply.applyPatch).
 * @param {{ok, applied, rejected, hunks: Array}} applyResult
 * @returns {string}
 */
function renderApply(applyResult) {
  const parts = [`${applyResult.applied} applied`, `${applyResult.rejected} rejected`];
  const drift = applyResult.hunks.filter(h => h.applied && (h.offset || h.fuzz));
  if (drift.length) {
    parts.push(`drift[` + drift.map(h => `#${h.index + 1}:off${h.offset}/fuzz${h.fuzz}`).join(",") + `]`);
  }
  return `${applyResult.ok ? "clean" : "with rejects"}: ${parts.join(", ")}`;
}

module.exports = { diffPreview, renderTransaction, renderApply };
