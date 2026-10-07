"use strict";
// ================= Structured codemods — scoped, identifier-aware transforms =================
// These are pure string->string transforms built on a small zero-dependency
// scanner that understands C-family/JS lexical structure: it knows when it is
// inside a string, template literal, or comment, so an identifier rename never
// corrupts a string that merely contains the word. This is the safe alternative
// to a naive global `String.replace`.
//
// Every codemod returns { text, changes } so callers can preview before writing.
// `runOnFiles` wires codemods to disk through a Transaction for atomic, previewable
// application.

const fs = require("fs");
const path = require("path");
const diff = require("./diff");
const transaction = require("./transaction");

const ID_CHAR = /[A-Za-z0-9_$]/;

/**
 * Lexically scan source into regions, tagging each character position with its
 * lexical state. Returns a mask array: mask[i] is true when position i is CODE
 * (i.e. not inside a string, template, or comment) and therefore eligible for
 * identifier-level transforms.
 * @param {string} text
 * @param {object} [opts]
 * @param {boolean} [opts.hashComments=false] - treat `#` as a line comment (py/sh/rb)
 * @returns {boolean[]} code mask, one entry per character
 */
function codeMask(text, opts) {
  opts = opts || {};
  const hashComments = !!opts.hashComments;
  const n = text.length;
  const mask = new Array(n).fill(true);
  let i = 0;
  const State = { CODE: 0, LINE: 1, BLOCK: 2, SQ: 3, DQ: 4, TPL: 5 };
  let state = State.CODE;

  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (state === State.CODE) {
      if (c === "/" && d === "/") { state = State.LINE; mask[i] = mask[i + 1] = false; i += 2; continue; }
      if (c === "/" && d === "*") { state = State.BLOCK; mask[i] = mask[i + 1] = false; i += 2; continue; }
      if (hashComments && c === "#") { state = State.LINE; mask[i] = false; i++; continue; }
      if (c === "'") { state = State.SQ; mask[i] = false; i++; continue; }
      if (c === '"') { state = State.DQ; mask[i] = false; i++; continue; }
      if (c === "`") { state = State.TPL; mask[i] = false; i++; continue; }
      i++;
      continue;
    }
    // Inside a non-code region: mark and look for the terminator.
    mask[i] = false;
    if (state === State.LINE) {
      if (c === "\n") state = State.CODE;
      i++;
      continue;
    }
    if (state === State.BLOCK) {
      if (c === "*" && d === "/") { mask[i + 1] = false; i += 2; state = State.CODE; continue; }
      i++;
      continue;
    }
    // String / template: honor backslash escapes.
    if (c === "\\") { if (i + 1 < n) mask[i + 1] = false; i += 2; continue; }
    if (state === State.SQ && c === "'") { state = State.CODE; i++; continue; }
    if (state === State.DQ && c === '"') { state = State.CODE; i++; continue; }
    if (state === State.TPL && c === "`") { state = State.CODE; i++; continue; }
    i++;
  }
  return mask;
}

/** Column/line of a char offset, for change reports. */
function locate(text, offset) {
  let line = 1;
  let col = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === "\n") { line++; col = 1; } else col++;
  }
  return { line, col };
}

/**
 * Rename an identifier everywhere it appears as a *whole word in code* (not inside
 * strings/comments, not as a substring of a larger identifier).
 * @param {string} text
 * @param {string} oldName
 * @param {string} newName
 * @param {object} [opts] - { hashComments, includeStrings:false }
 * @returns {{text: string, changes: Array<{line, col, offset}>}}
 */
function renameIdentifier(text, oldName, newName, opts) {
  opts = opts || {};
  if (!oldName) return { text, changes: [] };
  const mask = opts.includeStrings ? null : codeMask(text, opts);
  const changes = [];
  let out = "";
  let i = 0;
  const n = text.length;
  const L = oldName.length;
  while (i < n) {
    if (
      text.startsWith(oldName, i) &&
      (!ID_CHAR.test(text[i - 1] || "")) &&
      (!ID_CHAR.test(text[i + L] || "")) &&
      (mask === null || mask[i])
    ) {
      changes.push({ ...locate(text, i), offset: i });
      out += newName;
      i += L;
    } else {
      out += text[i];
      i++;
    }
  }
  return { text: out, changes };
}

/**
 * Find the index just past the balanced closing paren that starts at `open`.
 * Honors the code mask so parens inside strings/comments do not count.
 * @returns {number} index of the matching ")" or -1
 */
function matchParen(text, open, mask) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (mask && !mask[i]) continue;
    const c = text[i];
    if (c === "(") depth++;
    else if (c === ")") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/**
 * Wrap every call `fnName(...)` as `wrapper(fnName(...))`, balancing nested parens.
 * Useful for instrumentation codemods (e.g. wrap `fetch(...)` in `traced(...)`).
 * @param {string} text
 * @param {string} fnName
 * @param {string} wrapper
 * @param {object} [opts]
 * @returns {{text: string, changes: Array<{line, col}>}}
 */
function wrapCalls(text, fnName, wrapper, opts) {
  opts = opts || {};
  const mask = codeMask(text, opts);
  const changes = [];
  // Collect call sites first (right-to-left apply to keep offsets valid).
  const sites = [];
  let i = 0;
  const n = text.length;
  const L = fnName.length;
  while (i < n) {
    if (
      text.startsWith(fnName, i) &&
      !ID_CHAR.test(text[i - 1] || "") &&
      mask[i]
    ) {
      // Skip whitespace between name and "(".
      let j = i + L;
      while (j < n && /\s/.test(text[j])) j++;
      if (text[j] === "(" && mask[j]) {
        const close = matchParen(text, j, mask);
        if (close !== -1) {
          sites.push({ start: i, end: close + 1 });
          changes.push(locate(text, i));
          i = close + 1;
          continue;
        }
      }
    }
    i++;
  }
  let out = text;
  for (let s = sites.length - 1; s >= 0; s--) {
    const { start, end } = sites[s];
    out = out.slice(0, start) + wrapper + "(" + out.slice(start, end) + ")" + out.slice(end);
  }
  return { text: out, changes };
}

/**
 * Scoped literal replace with optional whole-word and code-only constraints.
 * Unlike a raw regex this can be told to skip strings/comments.
 * @param {string} text
 * @param {string} find
 * @param {string} replacement
 * @param {object} [opts] - { wholeWord:false, codeOnly:false, hashComments }
 * @returns {{text: string, changes: Array<{line, col}>}}
 */
function replaceLiteral(text, find, replacement, opts) {
  opts = opts || {};
  if (!find) return { text, changes: [] };
  const mask = opts.codeOnly ? codeMask(text, opts) : null;
  const changes = [];
  let out = "";
  let i = 0;
  const n = text.length;
  const L = find.length;
  while (i < n) {
    const wordOk = !opts.wholeWord ||
      (!ID_CHAR.test(text[i - 1] || "") && !ID_CHAR.test(text[i + L] || ""));
    if (text.startsWith(find, i) && wordOk && (mask === null || mask[i])) {
      changes.push(locate(text, i));
      out += replacement;
      i += L;
    } else {
      out += text[i];
      i++;
    }
  }
  return { text: out, changes };
}

/**
 * Produce a unified-diff preview of a codemod result against the original.
 * @param {string} before
 * @param {string} after
 * @param {string} [file="file"]
 */
function preview(before, after, file) {
  return diff.createUnifiedDiff(before, after, { oldPath: file || "file", newPath: file || "file" });
}

/**
 * Run a codemod function over a list of files and apply atomically via a
 * {@link transaction.Transaction}. Supports dry-run previews.
 * @param {string[]} files - paths to transform
 * @param {(text: string, file: string) => {text: string, changes: Array}} codemodFn
 * @param {object} [opts] - { cwd, dryRun }
 * @returns {{ok: boolean, changedFiles: Array<{file, changes, diff}>, commit?: object}}
 */
function runOnFiles(files, codemodFn, opts) {
  opts = opts || {};
  const cwd = opts.cwd || process.cwd();
  const tx = transaction.begin({ cwd });
  const changedFiles = [];
  for (const file of files) {
    const abs = path.isAbsolute(file) ? file : path.resolve(cwd, file);
    let before;
    try { before = fs.readFileSync(abs, "utf8"); } catch (_) { continue; }
    const res = codemodFn(before, abs);
    if (!res || res.text === before || !res.changes || res.changes.length === 0) continue;
    changedFiles.push({
      file: path.relative(cwd, abs),
      changes: res.changes.length,
      diff: preview(before, res.text, path.relative(cwd, abs)),
    });
    tx.stageWrite(abs, res.text);
  }
  if (opts.dryRun) {
    return { ok: true, dryRun: true, changedFiles };
  }
  const commit = tx.commit();
  return { ok: commit.ok, changedFiles, commit };
}

module.exports = {
  codeMask,
  renameIdentifier,
  wrapCalls,
  replaceLiteral,
  matchParen,
  preview,
  runOnFiles,
};
