"use strict";
// ================= Application — validated edits -> atomic patch transaction =================
// This is the bridge to src/patch. It never writes files itself: it builds a
// single src/patch transaction from a validated change plan and lets that engine
// provide the guarantees that matter — all-or-nothing commits, checkpoint-based
// rollback, unified-diff previews, and the apply -> verify -> revert harness.
//
// Flow:  detect -> validate (locate + self-repair) -> stage -> commit/preview/verify.
// If validation finds ANY edit it cannot safely place, nothing is staged: the whole
// change set is refused and the diagnoses are returned for a model-retry loop.

const transaction = require("../patch/transaction");
const verify = require("../patch/verify");
const diff = require("../patch/diff");
const { validate } = require("./validate");

/**
 * Build (but do not commit) a src/patch transaction from a validated plan.
 * @param {ReturnType<typeof validate>} plan
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @returns {{tx: transaction.Transaction, staged: Array}}
 */
function stage(plan, opts) {
  opts = opts || {};
  const tx = transaction.begin({ cwd: opts.cwd });
  const staged = [];
  for (const f of plan.files) {
    if (f.action === "error") continue;
    if (f.action === "delete") {
      tx.stageDelete(f.path);
      staged.push({ path: f.path, action: "delete" });
    } else {
      // create and modify both become a full-content write; the transaction's
      // preview turns before/after into a clean unified diff for display.
      tx.stageWrite(f.path, f.after);
      staged.push({ path: f.path, action: f.action });
    }
  }
  return { tx, staged };
}

/**
 * Render a dry-run preview (unified diffs) directly from a validated plan.
 * @param {ReturnType<typeof validate>} plan
 * @returns {{ok: boolean, files: Array<{file, action, diff, additions, deletions}>}}
 */
function previewFromPlan(plan) {
  const files = [];
  for (const f of plan.files) {
    if (f.action === "error") continue;
    if (f.action === "delete") {
      const d = diff.createUnifiedDiff(f.before || "", "", { oldPath: "a/" + f.path, newPath: "/dev/null" });
      files.push({ file: f.path, action: "delete", diff: d, additions: 0, deletions: diff.diffStat(d).deletions });
      continue;
    }
    const oldPath = f.before == null ? "/dev/null" : "a/" + f.path;
    const d = diff.createUnifiedDiff(f.before || "", f.after || "", { oldPath, newPath: "b/" + f.path });
    const stat = diff.diffStat(d);
    files.push({ file: f.path, action: f.action, diff: d, additions: stat.additions, deletions: stat.deletions });
  }
  return { ok: plan.ok, files };
}

/**
 * End-to-end: validate edits and either preview or commit them atomically.
 * @param {Array} edits - normalized edits (from ./detect)
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @param {(p: string)=>string|null} [opts.readFile]
 * @param {Object<string,string|null>} [opts.files] - in-memory file map (for tests/dry runs)
 * @param {boolean} [opts.allowFuzzy=false]
 * @param {number} [opts.fuzz=2]
 * @param {boolean} [opts.dryRun=false] - validate + preview only, touch nothing
 * @returns {{ok: boolean, phase: string, plan: object, preview?: object,
 *            committed?: boolean, written?: string[], diagnoses?: Array, staged?: Array}}
 */
function applyEdits(edits, opts) {
  opts = opts || {};
  const plan = validate(edits, {
    cwd: opts.cwd,
    readFile: opts.readFile,
    files: opts.files,
    allowFuzzy: opts.allowFuzzy,
    fuzz: opts.fuzz,
  });

  if (!plan.ok) {
    return { ok: false, phase: "validate", plan, diagnoses: plan.diagnoses };
  }

  const { tx, staged } = stage(plan, { cwd: opts.cwd });

  if (opts.dryRun) {
    // Build the preview from the validated plan (before/after already resolved
    // against the configured content source) rather than re-reading disk, so the
    // preview is correct for in-memory file maps as well as the working tree.
    const preview = previewFromPlan(plan);
    return { ok: preview.ok, phase: "preview", plan, preview, staged };
  }

  const commit = tx.commit();
  if (!commit.ok) {
    return { ok: false, phase: "commit", plan, staged, error: commit.error, detail: commit };
  }
  return { ok: true, phase: "commit", plan, staged, committed: true, written: commit.written, checkpoint: commit.checkpoint };
}

/**
 * Validate, apply, run a verify command, and auto-revert if it fails.
 * Delegates the apply->verify->revert machinery to src/patch/verify.
 * @param {Array} edits
 * @param {object} args
 * @param {string|function} args.verify - shell command or predicate
 * @param {object} [args.opts] - { cwd, readFile, files, allowFuzzy, fuzz, onDirty, timeout, dryRun }
 * @returns {object} verify-revert result (plus the validation plan)
 */
function applyEditsVerified(edits, args) {
  args = args || {};
  const opts = args.opts || {};
  const plan = validate(edits, {
    cwd: opts.cwd, readFile: opts.readFile, files: opts.files,
    allowFuzzy: opts.allowFuzzy, fuzz: opts.fuzz,
  });
  if (!plan.ok) {
    return { ok: false, phase: "validate", plan, diagnoses: plan.diagnoses };
  }
  const { tx } = stage(plan, { cwd: opts.cwd });
  const result = verify.applyVerifyRevert({
    transaction: tx,
    verify: args.verify,
    opts: { cwd: opts.cwd, onDirty: opts.onDirty, timeout: opts.timeout, dryRun: opts.dryRun },
  });
  result.plan = plan;
  return result;
}

module.exports = { applyEdits, applyEditsVerified, stage, previewFromPlan };
