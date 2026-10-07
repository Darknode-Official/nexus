"use strict";
// ================= Validation + self-repair =================
// Turns a list of normalized edits into a concrete, per-file change plan by
// resolving every edit against the REAL current file content. It:
//   * verifies each SEARCH block exists (exact, then whitespace/indent repair,
//     then opt-in fuzzy) via the locator,
//   * reconciles sloppy unified diffs against the file via src/patch's fuzzy
//     applier (line numbers are recovered, not trusted),
//   * threads multiple edits to the same file in order,
//   * re-indents a REPLACE when its SEARCH had to be re-indented to match,
//   * preserves the file's original line-ending and trailing-newline state,
//   * and produces a structured diagnosis for any edit it cannot safely place,
//     WITHOUT ever applying a guess.
//
// The output is consumed by ./apply, which stages it as a single atomic
// src/patch transaction. Application correctness (atomicity, rollback, preview,
// verify) is delegated entirely to src/patch.

const fs = require("fs");
const path = require("path");
const t = require("./text");
const { locate } = require("./locate");
const patchApply = require("../patch/apply");

/**
 * Default file reader: reads from disk relative to cwd, returns null if absent.
 * @param {string} cwd
 * @returns {(p: string) => string|null}
 */
function diskReader(cwd) {
  return (p) => {
    const abs = path.isAbsolute(p) ? p : path.resolve(cwd || process.cwd(), p);
    try { return fs.readFileSync(abs, "utf8"); } catch (_) { return null; }
  };
}

/**
 * Validate and resolve a set of edits into a per-file change plan.
 * @param {Array} edits - normalized edits from ./detect
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @param {(p: string) => string|null} [opts.readFile] - content source
 * @param {Object<string,string|null>} [opts.files] - in-memory file map (overrides readFile)
 * @param {boolean} [opts.allowFuzzy=false] - permit content-fuzzy SEARCH matching
 * @param {number} [opts.fuzz=2] - fuzz for unified-diff application
 * @returns {{
 *   ok: boolean,
 *   files: Array<{path: string, action: "create"|"modify"|"delete", before: string|null, after: string|null, edits: number}>,
 *   results: Array<{edit: object, status: string, repair?: string, diagnosis?: object}>,
 *   diagnoses: Array<{path: string|null, line: number, reason: string, message: string, candidates?: Array}>
 * }}
 */
function validate(edits, opts) {
  opts = opts || {};
  const cwd = opts.cwd || process.cwd();
  const read = opts.files
    ? (p) => (Object.prototype.hasOwnProperty.call(opts.files, p) ? opts.files[p] : diskReader(cwd)(p))
    : (opts.readFile || diskReader(cwd));

  const results = [];
  const diagnoses = [];

  // Group edits by path, preserving order; edits without a path are an error.
  const byFile = new Map();
  const order = [];
  for (const e of edits) {
    if (!e.path) {
      const d = { path: null, line: e.loc ? e.loc.line : 0, reason: "no-path",
        message: `${e.format} edit has no resolvable file path` };
      diagnoses.push(d);
      results.push({ edit: e, status: "no-path", diagnosis: d });
      continue;
    }
    if (!byFile.has(e.path)) { byFile.set(e.path, []); order.push(e.path); }
    byFile.get(e.path).push(e);
  }

  const files = [];
  for (const p of order) {
    const fileEdits = byFile.get(p);
    const before = read(p);
    const fileExisted = before != null;
    const eol = fileExisted ? t.detectEOL(before) : "\n";
    let contentStr = fileExisted ? t.normalizeEOL(before).text : "";
    let noEOL = fileExisted ? t.toLines(before).noEOL : false;
    let deleted = false;
    let created = !fileExisted;
    let applied = 0;
    let failed = false;

    for (const e of fileEdits) {
      if (deleted) {
        const d = diag(p, e, "after-delete", "edit targets a file already deleted in this change set");
        diagnoses.push(d); results.push({ edit: e, status: "error", diagnosis: d });
        failed = true; break;
      }

      if (e.type === "delete") {
        if (!fileExisted) {
          const d = diag(p, e, "missing", "cannot delete a file that does not exist");
          diagnoses.push(d); results.push({ edit: e, status: "error", diagnosis: d });
          failed = true; break;
        }
        deleted = true; applied++;
        results.push({ edit: e, status: "delete" });
        continue;
      }

      if (e.type === "whole-file") {
        const norm = t.normalizeEOL(e.content);
        contentStr = norm.text;
        noEOL = t.toLines(e.content).noEOL;
        applied++;
        results.push({ edit: e, status: fileExisted ? "overwrite" : "create" });
        continue;
      }

      if (e.type === "unified-diff") {
        if (!fileExisted && !e.isCreate) {
          const d = diag(p, e, "missing", "unified diff targets a file that does not exist");
          diagnoses.push(d); results.push({ edit: e, status: "error", diagnosis: d });
          failed = true; break;
        }
        const res = patchApply.applyPatch(contentStr, e.filePatch, { fuzz: opts.fuzz });
        if (!res.ok) {
          const rej = res.hunks.filter((h) => !h.applied);
          const d = diag(p, e, "hunk-rejected",
            `unified diff could not be applied: ${rej.length} hunk(s) rejected`,
            { rejects: rej });
          diagnoses.push(d); results.push({ edit: e, status: "error", diagnosis: d });
          failed = true; break;
        }
        contentStr = res.text;
        noEOL = t.toLines(res.text).noEOL;
        applied++;
        results.push({ edit: e, status: "applied", applyReport: res.hunks });
        continue;
      }

      // search-replace ---------------------------------------------------------
      const srOutcome = applySearchReplace(contentStr, noEOL, e, { allowFuzzy: opts.allowFuzzy });
      if (!srOutcome.ok) {
        const d = {
          path: p, line: e.loc ? e.loc.line : 0,
          reason: srOutcome.diagnosis.reason,
          message: srOutcome.diagnosis.message,
          candidates: srOutcome.candidates,
        };
        diagnoses.push(d);
        results.push({ edit: e, status: srOutcome.status, diagnosis: d });
        failed = true; break;
      }
      contentStr = srOutcome.content;
      noEOL = srOutcome.noEOL;
      applied++;
      results.push({ edit: e, status: srOutcome.status, repair: srOutcome.repair });
    }

    if (failed) {
      files.push({ path: p, action: "error", before, after: null, edits: fileEdits.length });
      continue;
    }

    if (deleted) {
      files.push({ path: p, action: "delete", before, after: null, edits: applied });
      continue;
    }

    const after = t.applyEOL(t.toLines(contentStr).noEOL === noEOL
      ? contentStr
      : enforceEOLState(contentStr, noEOL), eol);
    files.push({
      path: p,
      action: created ? "create" : "modify",
      before,
      after,
      edits: applied,
    });
  }

  const ok = diagnoses.length === 0 && files.every((f) => f.action !== "error");
  return { ok, files, results, diagnoses };
}

/**
 * Resolve a single SEARCH/REPLACE edit against the current content.
 * @returns {{ok: boolean, content?: string, noEOL?: boolean, status: string,
 *            repair?: string, diagnosis?: object, candidates?: Array}}
 */
function applySearchReplace(contentStr, noEOL, edit, opts) {
  const searchLines = edit.searchLines || t.toLines(edit.search || "").lines;
  const replaceLines = edit.replaceLines || t.toLines(edit.replace || "").lines;

  // Empty SEARCH => create/insert-whole. Only safe on an empty/new file.
  if (edit.isCreate || searchLines.length === 0 || searchLines.every((l) => l.trim() === "")) {
    if (contentStr.trim() === "") {
      const text = replaceLines.join("\n");
      return { ok: true, content: text === "" ? "" : text + "\n", noEOL: false, status: "create" };
    }
    return {
      ok: false, status: "not-found",
      diagnosis: { reason: "ambiguous",
        message: "empty SEARCH block can only create a new/empty file; target already has content" },
    };
  }

  const loc = locate(contentStr, searchLines, { allowFuzzy: opts.allowFuzzy });
  if (loc.status === "ambiguous" || loc.status === "not-found") {
    return { ok: false, status: loc.status, diagnosis: loc.diagnosis, candidates: loc.candidates };
  }

  // Re-indent REPLACE when the match required dropping/altering leading indent.
  let outReplace = replaceLines;
  if (loc.normalizer === "indent" || loc.normalizer === "fuzzy") {
    const searchBase = t.commonIndent(searchLines);
    const matchBase = (loc.matchIndent || "").length;
    const delta = matchBase - searchBase;
    if (delta !== 0) outReplace = shiftIndent(replaceLines, delta);
  }

  const fileLines = t.toLines(contentStr).lines;
  const next = fileLines.slice(0, loc.start).concat(outReplace, fileLines.slice(loc.end));
  const content = t.fromLines(next, noEOL);
  return {
    ok: true,
    content,
    noEOL,
    status: loc.status,
    repair: loc.repair || undefined,
  };
}

/**
 * Shift the leading indentation of lines by `delta` columns (blank lines kept).
 * Positive adds spaces; negative removes up to `|delta|` leading ws chars
 * (tabs expanded to spaces first so the removal is well-defined).
 * @param {string[]} lines
 * @param {number} delta
 * @returns {string[]}
 */
function shiftIndent(lines, delta) {
  if (delta === 0) return lines;
  return lines.map((l) => {
    if (l.trim() === "") return l;
    if (delta > 0) return " ".repeat(delta) + l;
    const expanded = t.tabsToSpaces(l);
    const lead = /^ */.exec(expanded)[0].length;
    const cut = Math.min(lead, -delta);
    return expanded.slice(cut);
  });
}

/** Force a content string to the desired trailing-newline state. */
function enforceEOLState(contentStr, noEOL) {
  const parts = t.toLines(contentStr);
  return t.fromLines(parts.lines, noEOL);
}

function diag(p, edit, reason, message, extra) {
  return Object.assign({ path: p, line: edit.loc ? edit.loc.line : 0, reason, message }, extra || {});
}

module.exports = { validate, applySearchReplace, shiftIndent, diskReader };
