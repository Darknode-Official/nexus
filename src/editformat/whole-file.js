"use strict";
// ================= Whole-file / fenced-code format =================
// Handles the "here is the full new file" style of response, where the model
// returns an entire file's contents inside a fenced code block instead of an
// edit. The hard part is inferring WHICH file:
//   1. the fence info string:           ```js src/app.js
//   2. a path header just above:        ### src/app.js   /   **src/app.js**
//   3. a lead-in sentence:              "Here is the updated src/app.js:"
//   4. a path comment on the first code line:  // src/app.js   /   # app.py
//
// A block is only treated as a whole-file edit when a path can be inferred AND the
// block is not itself a SEARCH/REPLACE or unified-diff payload (the detector gates
// that). This module also enumerates fenced blocks, which the detector reuses.

const sr = require("./search-replace");
const ud = require("./unified-diff");

const FENCE_OPEN_RE = /^(\s*)(`{3,}|~{3,})(.*)$/;

/**
 * Enumerate fenced code blocks in a message.
 * @param {string} text
 * @returns {Array<{info: string, content: string, lines: string[],
 *   startLine: number, endLine: number, fence: string, indent: string,
 *   preceding: string[]}>}
 */
function enumerateFences(text) {
  const lines = String(text).split("\n");
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const m = FENCE_OPEN_RE.exec(lines[i]);
    if (!m) { i++; continue; }
    const indent = m[1];
    const token = m[2];
    const info = m[3].trim();
    const closeToken = token[0];
    const body = [];
    let j = i + 1;
    let closed = false;
    for (; j < lines.length; j++) {
      const cm = FENCE_OPEN_RE.exec(lines[j]);
      if (cm && cm[2][0] === closeToken && cm[2].length >= token.length && cm[3].trim() === "") {
        closed = true;
        break;
      }
      body.push(lines[j]);
    }
    const preceding = [];
    for (let p = i - 1; p >= 0 && i - p <= 5; p--) preceding.unshift(lines[p]);
    blocks.push({
      info,
      content: body.join("\n"),
      lines: body,
      startLine: i + 1,
      endLine: (closed ? j : lines.length - 1) + 1,
      fence: token,
      indent,
      preceding,
      closed,
    });
    i = closed ? j + 1 : j;
  }
  return blocks;
}

/**
 * Infer the target path for a fenced block from (in priority order) the fence
 * info string, a preceding header/sentence, or a leading path comment.
 * @param {{info: string, preceding: string[], lines: string[]}} block
 * @returns {{path: string|null, source: string|null}}
 */
function inferPath(block) {
  // 1. Fence info string.
  const fromInfo = sr.pathFromFenceInfo(block.info);
  if (fromInfo) return { path: fromInfo, source: "fence-info" };

  // 2. Preceding header / bold / inline-code / lead-in sentence.
  for (let i = block.preceding.length - 1; i >= 0; i--) {
    const raw = block.preceding[i];
    if (raw == null || raw.trim() === "") continue;
    const direct = sr.extractPathHeader(raw);
    if (direct) return { path: direct, source: "header" };
    const sentence = pathFromSentence(raw);
    if (sentence) return { path: sentence, source: "sentence" };
    break; // only inspect the nearest non-blank preceding line
  }

  // 3. Leading path comment on the first code line.
  const firstReal = block.lines.find((l) => l.trim() !== "");
  if (firstReal) {
    const c = pathFromComment(firstReal);
    if (c) return { path: c, source: "comment" };
  }
  return { path: null, source: null };
}

/**
 * Extract a path from a lead-in sentence such as "Here's the updated `src/app.js`:"
 * or "File src/app.js:".
 * @param {string} line
 * @returns {string|null}
 */
function pathFromSentence(line) {
  // Prefer a backtick-quoted token.
  const bt = /`([^`\s]+)`/.exec(line);
  if (bt) { const p = sr.extractPathHeader(bt[1]); if (p) return p; }
  // Otherwise scan tokens for the first path-like one.
  const toks = line.split(/\s+/);
  for (const t of toks) {
    const cleaned = t.replace(/[:.,;)]+$/, "");
    const p = sr.extractPathHeader(cleaned);
    if (p) return p;
  }
  return null;
}

/**
 * Extract a path from a leading code comment: "// path", "# path", "/* path *\/",
 * "<!-- path -->".
 * @param {string} line
 * @returns {string|null}
 */
function pathFromComment(line) {
  const s = line.trim();
  let m;
  if ((m = /^\/\/\s*(.+?)\s*$/.exec(s))) return sr.extractPathHeader(m[1]);
  if ((m = /^#\s*(.+?)\s*$/.exec(s))) return sr.extractPathHeader(m[1]);
  if ((m = /^\/\*\s*(.+?)\s*\*\/$/.exec(s))) return sr.extractPathHeader(m[1]);
  if ((m = /^<!--\s*(.+?)\s*-->$/.exec(s))) return sr.extractPathHeader(m[1]);
  if ((m = /^--\s*(.+?)\s*$/.exec(s))) return sr.extractPathHeader(m[1]); // sql/lua
  return null;
}

/**
 * Does a fenced block's content carry edit-protocol markers (so it is NOT a
 * whole-file payload)?
 * @param {{content: string}} block
 * @returns {boolean}
 */
function looksLikeEditPayload(block) {
  return sr.has(block.content) || ud.has(block.content);
}

/**
 * Parse whole-file edits from a message. Only fenced blocks that (a) are not edit
 * payloads and (b) have an inferable path become edits.
 * @param {string} text
 * @param {object} [opts]
 * @param {string} [opts.defaultPath]
 * @param {boolean} [opts.requirePath=true] - when false, blocks without a path
 *        still yield an edit with path=null (caller must resolve)
 * @returns {{ edits: Array, errors: Array<{line: number, message: string}>, blocks: Array }}
 */
function parse(text, opts) {
  opts = opts || {};
  const blocks = enumerateFences(text);
  const edits = [];
  const errors = [];
  for (const block of blocks) {
    if (looksLikeEditPayload(block)) continue;
    const { path, source } = inferPath(block);
    const resolved = path || opts.defaultPath || null;
    if (!resolved && opts.requirePath !== false) {
      // Not an error on its own — just not a confident whole-file edit.
      continue;
    }
    // If the path came from a leading comment, keep the comment; it is part of the
    // file. Content is emitted verbatim.
    let content = block.content;
    if (content !== "" && !content.endsWith("\n")) content += "\n";
    edits.push({
      type: "whole-file",
      format: "whole-file",
      path: resolved,
      content,
      pathSource: source,
      loc: { line: block.startLine },
      closed: block.closed,
    });
    if (!block.closed) {
      errors.push({ line: block.startLine, message: "fenced block was not closed before EOF" });
    }
  }
  return { edits, errors, blocks };
}

module.exports = {
  parse,
  enumerateFences,
  inferPath,
  pathFromSentence,
  pathFromComment,
  looksLikeEditPayload,
};
