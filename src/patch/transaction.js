"use strict";
// ================= Transactional multi-file apply — atomic commit or full rollback =================
// Stage edits across many files, then commit them atomically. The commit runs in
// two phases:
//   1. VALIDATE — every staged op is computed against an in-memory copy. If any op
//      cannot be produced (e.g. a patch whose context is missing) the transaction
//      aborts BEFORE a single byte is written to disk.
//   2. WRITE — a checkpoint of every touched file is taken, then all writes are
//      flushed. If any write throws mid-flight the checkpoint is restored, leaving
//      the working set exactly as it was.
// This gives all-or-nothing semantics across the whole change set.

const fs = require("fs");
const path = require("path");
const apply = require("./apply");
const diff = require("./diff");

/**
 * Capture the current content (and existence) of a set of files so they can be
 * restored verbatim later.
 * @param {string[]} files - absolute or cwd-relative paths
 * @returns {{createdAt: number, entries: Object<string, {existed: boolean, content: string|null}>}}
 */
function checkpoint(files) {
  const entries = {};
  for (const file of files) {
    const abs = path.resolve(file);
    if (entries[abs]) continue;
    try {
      entries[abs] = { existed: true, content: fs.readFileSync(abs, "utf8") };
    } catch (_) {
      entries[abs] = { existed: false, content: null };
    }
  }
  return { createdAt: Date.now(), entries };
}

/**
 * Restore files to a previously captured checkpoint. Files that did not exist at
 * checkpoint time are removed again; files that existed are rewritten verbatim.
 * @param {ReturnType<typeof checkpoint>} cp
 * @returns {Array<{file: string, action: "restored"|"removed"|"noop"|"failed", error?: string}>}
 */
function restore(cp) {
  const actions = [];
  for (const [abs, snap] of Object.entries(cp.entries)) {
    try {
      if (snap.existed) {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, snap.content);
        actions.push({ file: abs, action: "restored" });
      } else if (fs.existsSync(abs)) {
        fs.unlinkSync(abs);
        actions.push({ file: abs, action: "removed" });
      } else {
        actions.push({ file: abs, action: "noop" });
      }
    } catch (e) {
      actions.push({ file: abs, action: "failed", error: e.message });
    }
  }
  return actions;
}

/**
 * A staged, atomic change set. Build it with the `stage*` methods, then `commit`.
 */
class Transaction {
  /** @param {object} [opts] @param {string} [opts.cwd=process.cwd()] */
  constructor(opts) {
    opts = opts || {};
    this.cwd = opts.cwd || process.cwd();
    this.ops = [];
    this._checkpoint = null;
  }

  _resolve(file) {
    return path.isAbsolute(file) ? file : path.resolve(this.cwd, file);
  }

  /** Stage a full-content write (create or overwrite). */
  stageWrite(file, content) {
    this.ops.push({ kind: "write", file: this._resolve(file), content });
    return this;
  }

  /** Stage deletion of a file. */
  stageDelete(file) {
    this.ops.push({ kind: "delete", file: this._resolve(file) });
    return this;
  }

  /**
   * Stage application of a parsed file-patch (or raw unified diff string) to a file.
   * @param {string} file
   * @param {object|string} patch - parsed file-patch or unified diff text
   * @param {object} [applyOpts] - forwarded to apply.applyPatch (fuzz, maxOffset)
   */
  stagePatch(file, patch, applyOpts) {
    const parsed = typeof patch === "string" ? diff.parseUnifiedDiff(patch)[0] : patch;
    this.ops.push({ kind: "patch", file: this._resolve(file), patch: parsed, applyOpts: applyOpts || {} });
    return this;
  }

  /** The set of files this transaction will touch. */
  touched() {
    return [...new Set(this.ops.map(o => o.file))];
  }

  /**
   * Phase 1: compute the resulting content of every file in memory, validating
   * that all patches apply cleanly. Does not write anything.
   * @returns {{ok: boolean, results: Array, errors: Array}}
   */
  plan() {
    // Model the final state per file, threading sequential ops on the same file.
    const state = new Map(); // abs -> { content: string|null, deleted: bool }
    const results = [];
    const errors = [];

    const readBase = (abs) => {
      if (state.has(abs)) return state.get(abs);
      let content = null;
      try { content = fs.readFileSync(abs, "utf8"); } catch (_) { content = null; }
      const s = { content, deleted: false };
      state.set(abs, s);
      return s;
    };

    for (const op of this.ops) {
      const s = readBase(op.file);
      if (op.kind === "write") {
        const before = s.content;
        s.content = op.content;
        s.deleted = false;
        results.push({ kind: "write", file: op.file, before, after: op.content });
      } else if (op.kind === "delete") {
        const before = s.content;
        if (before === null && !s.deleted) {
          errors.push({ file: op.file, kind: "delete", reason: "file does not exist" });
          continue;
        }
        s.content = null;
        s.deleted = true;
        results.push({ kind: "delete", file: op.file, before });
      } else if (op.kind === "patch") {
        if (s.content === null) {
          errors.push({ file: op.file, kind: "patch", reason: "target file missing" });
          continue;
        }
        const res = apply.applyPatch(s.content, op.patch, op.applyOpts);
        if (!res.ok) {
          errors.push({ file: op.file, kind: "patch", reason: "hunk(s) rejected", detail: res.hunks.filter(h => !h.applied) });
          continue;
        }
        const before = s.content;
        s.content = res.text;
        results.push({ kind: "patch", file: op.file, before, after: res.text, applyReport: res.hunks });
      }
    }

    return { ok: errors.length === 0, results, errors };
  }

  /**
   * Preview the transaction as unified diffs without touching disk.
   * @returns {{ok: boolean, errors: Array, files: Array<{file, action, diff, additions, deletions}>}}
   */
  preview() {
    const planned = this.plan();
    const files = planned.results.map(r => {
      const rel = path.relative(this.cwd, r.file);
      if (r.kind === "delete") {
        const d = diff.createUnifiedDiff(r.before || "", "", { oldPath: rel, newPath: "/dev/null" });
        return { file: rel, action: "delete", diff: d, additions: 0, deletions: diff.splitLines(r.before || "").lines.length };
      }
      const d = diff.createUnifiedDiff(r.before || "", r.after, { oldPath: r.before === null ? "/dev/null" : rel, newPath: rel });
      const stat = diff.diffStat(d);
      return { file: rel, action: r.before === null ? "create" : "modify", diff: d, additions: stat.additions, deletions: stat.deletions };
    });
    return { ok: planned.ok, errors: planned.errors, files };
  }

  /**
   * Commit the transaction. Validates first (phase 1); on any validation error
   * nothing is written. On a write-time failure the whole set is rolled back.
   * @param {object} [opts]
   * @param {boolean} [opts.dryRun=false] - validate + preview only
   * @returns {{ok: boolean, committed: boolean, dryRun?: boolean, errors?: Array,
   *            written?: string[], rolledBack?: boolean, checkpoint?: object}}
   */
  commit(opts) {
    opts = opts || {};
    const planned = this.plan();
    if (!planned.ok) {
      return { ok: false, committed: false, errors: planned.errors };
    }
    if (opts.dryRun) {
      return { ok: true, committed: false, dryRun: true, preview: this.preview() };
    }

    const cp = checkpoint(this.touched());
    this._checkpoint = cp;
    const written = [];
    try {
      for (const r of planned.results) {
        if (r.kind === "delete") {
          if (fs.existsSync(r.file)) fs.unlinkSync(r.file);
        } else {
          fs.mkdirSync(path.dirname(r.file), { recursive: true });
          fs.writeFileSync(r.file, r.after);
        }
        written.push(r.file);
      }
      return { ok: true, committed: true, written, checkpoint: cp };
    } catch (e) {
      const rollbackActions = restore(cp);
      return { ok: false, committed: false, rolledBack: true, error: e.message, rollbackActions };
    }
  }
}

/** Factory for a fresh {@link Transaction}. */
function begin(opts) { return new Transaction(opts); }

module.exports = { Transaction, begin, checkpoint, restore };
