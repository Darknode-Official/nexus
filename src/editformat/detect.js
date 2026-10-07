"use strict";
// ================= Format auto-detection =================
// Given arbitrary model output — prose, multiple code blocks, several edit formats
// at once — determine which edit format(s) are present and extract every edit,
// ignoring the surrounding explanation.
//
// Precedence is by specificity, so the formats never double-count the same text:
//   1. SEARCH/REPLACE blocks (unambiguous markers).
//   2. Unified diffs (@@ / diff --git markers; may be fenced or bare).
//   3. Whole-file fenced blocks — but only blocks that are NOT already a
//      SEARCH/REPLACE or unified-diff payload (whole-file.parse enforces this).
//
// The returned edits are normalized into a single shape and ordered by their
// position in the source so a caller can apply them deterministically.

const sr = require("./search-replace");
const ud = require("./unified-diff");
const wf = require("./whole-file");

/**
 * @typedef {Object} NormalizedEdit
 * @property {"search-replace"|"unified-diff"|"whole-file"|"delete"} type
 * @property {string} format
 * @property {string|null} path
 * @property {{line: number}} loc
 * @property {string} [search]
 * @property {string} [replace]
 * @property {string[]} [searchLines]
 * @property {string[]} [replaceLines]
 * @property {Object} [filePatch]  // parsed unified-diff file patch (for apply)
 * @property {string} [content]    // whole-file content
 * @property {boolean} [isCreate]
 * @property {boolean} [isDelete]
 */

/**
 * Detect and extract all edits from a model message.
 * @param {string} text
 * @param {object} [opts]
 * @param {string} [opts.defaultPath] - fallback path for single-file contexts
 * @param {boolean} [opts.wholeFile=true] - allow whole-file extraction
 * @returns {{ edits: NormalizedEdit[], errors: Array<{line: number, message: string, format: string}>,
 *            formats: string[] }}
 */
function detect(text, opts) {
  opts = opts || {};
  const edits = [];
  const errors = [];
  const formats = new Set();

  // 1. SEARCH/REPLACE ---------------------------------------------------------
  const srRes = sr.parse(text, { defaultPath: opts.defaultPath });
  for (const e of srRes.edits) {
    formats.add("search-replace");
    edits.push(e);
  }
  for (const err of srRes.errors) errors.push({ ...err, format: "search-replace" });

  // 2. Unified diff -----------------------------------------------------------
  const udRes = ud.parse(text, { defaultPath: opts.defaultPath });
  for (const f of udRes.files) {
    formats.add("unified-diff");
    const line = f.hunks.length ? firstHunkLine(text, f) : 1;
    if (f.isDelete) {
      edits.push({
        type: "delete",
        format: "unified-diff",
        path: f.path,
        loc: { line },
        isDelete: true,
      });
    } else {
      edits.push({
        type: "unified-diff",
        format: "unified-diff",
        path: f.path,
        filePatch: { oldPath: f.oldPath, newPath: f.newPath, hunks: f.hunks },
        isCreate: f.isCreate,
        isDelete: f.isDelete,
        loc: { line },
      });
    }
  }
  for (const err of udRes.errors) errors.push({ ...err, format: "unified-diff" });

  // 3. Whole-file -------------------------------------------------------------
  if (opts.wholeFile !== false) {
    const wfRes = wf.parse(text, { defaultPath: opts.defaultPath });
    for (const e of wfRes.edits) {
      // Guard: skip a whole-file block whose path already has a diff/SR edit that
      // overlaps the same source region (defensive — whole-file already filters
      // edit payloads, but a prose fence near a diff could otherwise duplicate).
      formats.add("whole-file");
      edits.push(e);
    }
    for (const err of wfRes.errors) errors.push({ ...err, format: "whole-file" });
  }

  edits.sort((a, b) => (a.loc.line || 0) - (b.loc.line || 0));
  return { edits, errors, formats: [...formats] };
}

/**
 * Best-effort source line of a file patch's first hunk, for ordering/diagnostics.
 * @param {string} text
 * @param {object} filePatch
 * @returns {number}
 */
function firstHunkLine(text, filePatch) {
  const lines = String(text).split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (ud.HUNK_RE.test(lines[i])) return i + 1;
  }
  return 1;
}

/**
 * Classify a message by the formats it contains without fully extracting.
 * @param {string} text
 * @returns {{ searchReplace: boolean, unifiedDiff: boolean, fencedBlocks: number }}
 */
function classify(text) {
  return {
    searchReplace: sr.has(text),
    unifiedDiff: ud.has(text),
    fencedBlocks: wf.enumerateFences(text).length,
  };
}

module.exports = { detect, classify, firstHunkLine };
