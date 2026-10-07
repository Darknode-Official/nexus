"use strict";
// ================= SEARCH/REPLACE block parser =================
// Parses the fenced "search/replace" edit format that most coding models emit:
//
//     path/to/file.js
//     ```js
//     <<<<<<< SEARCH
//     old code
//     =======
//     new code
//     >>>>>>> REPLACE
//     ```
//
// Tolerances (deliberately generous, because model output is messy):
//   * Marker runs of 5-9 characters ("<<<<<<<" .. "<<<<<<<<<"), optional label
//     casing, trailing text after the label.
//   * The filename may sit on the line above the fence, on the fence info string
//     (```js path/to/file.js), inside the fence just above SEARCH, or as a
//     markdown header (## path) / bold (**path**) / inline code (`path`).
//   * Fences in ``` or ~~~ of any length >= 3, or no fence at all.
//   * Multiple blocks per file and multiple files in one message.
//   * Leading/trailing blank lines inside SEARCH / REPLACE are preserved.
//
// Every block carries a precise source location (1-based line of its SEARCH
// marker) so malformed blocks can be reported back to the model exactly.

/** @typedef {import("./types").SearchReplaceEdit} SearchReplaceEdit */

const SEARCH_RE = /^\s*<{5,9}\s*SEARCH\b.*$/i;
const DIVIDER_RE = /^\s*={5,9}\s*$/;
const REPLACE_RE = /^\s*>{5,9}\s*REPLACE\b.*$/i;
const FENCE_RE = /^\s*(`{3,}|~{3,})(.*)$/;

/**
 * Decide whether a lone line plausibly names a file path (as opposed to prose).
 * Used to recover the filename that precedes a SEARCH marker.
 * @param {string} line
 * @returns {string|null} the cleaned path, or null if it does not look like one
 */
function extractPathHeader(line) {
  if (line == null) return null;
  let s = line.trim();
  if (s === "") return null;
  // Strip markdown header / list / emphasis decoration.
  s = s.replace(/^#{1,6}\s+/, "");
  s = s.replace(/^[-*+]\s+/, "");
  s = s.replace(/^\*\*(.+)\*\*$/, "$1").trim();
  s = s.replace(/^__(.+)__$/, "$1").trim();
  // Strip a trailing colon ("File: path") and a leading "File"/"In" label.
  s = s.replace(/^(?:file|path|in|edit|update|modify)\s*[:=]\s*/i, "");
  s = s.replace(/:$/, "");
  // Unwrap inline code / quotes.
  s = s.replace(/^`+([^`]+)`+$/, "$1").trim();
  s = s.replace(/^["'<]([^"'>]+)[">']$/, "$1").trim();
  if (s === "") return null;
  // Reject obvious prose: spaces are allowed only inside a quoted-looking path,
  // which we have already unwrapped, so a remaining space means prose.
  if (/\s/.test(s)) return null;
  // Looks like a path if it has a separator, an extension, or is a dotfile.
  if (/[\/\\]/.test(s)) return s;
  if (/^\.?[\w.-]+\.[A-Za-z0-9]{1,8}$/.test(s)) return s;
  if (/^\.[\w.-]+$/.test(s)) return s; // .gitignore, .env
  return null;
}

/**
 * Pull a filename out of a fence info string, e.g. "```js src/app.js" or
 * "```python title=foo.py".
 * @param {string} info - text after the backticks on the opening fence line
 * @returns {string|null}
 */
function pathFromFenceInfo(info) {
  if (!info) return null;
  const cleaned = info.trim();
  if (cleaned === "") return null;
  // title="x" / filename=x forms.
  const kv = /(?:title|filename|file|name)\s*[:=]\s*["']?([^\s"']+)["']?/i.exec(cleaned);
  if (kv && extractPathHeader(kv[1])) return extractPathHeader(kv[1]);
  // Otherwise take the last whitespace-separated token if it looks like a path.
  const toks = cleaned.split(/\s+/);
  for (let i = toks.length - 1; i >= 0; i--) {
    const p = extractPathHeader(toks[i]);
    if (p) return p;
  }
  return null;
}

/**
 * Search upward from `fromIdx` (exclusive) for the nearest line that names a file.
 * Skips blank lines, fence lines and a single "SEARCH"-adjacent decoration.
 * @param {string[]} lines
 * @param {number} fromIdx
 * @returns {string|null}
 */
function findPrecedingPath(lines, fromIdx) {
  let seenFence = false;
  for (let i = fromIdx - 1; i >= 0 && fromIdx - i <= 6; i--) {
    const raw = lines[i];
    if (raw == null) continue;
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    const fence = FENCE_RE.exec(raw);
    if (fence) {
      // An opening fence may carry the path in its info string.
      const p = pathFromFenceInfo(fence[2]);
      if (p) return p;
      if (seenFence) return null; // crossed two fences — different block
      seenFence = true;
      continue;
    }
    const p = extractPathHeader(raw);
    if (p) return p;
    // A non-path, non-fence, non-blank line that is not itself a header ends the
    // search unless it is clearly a lead-in sentence ending with a colon.
    if (/[:]\s*$/.test(trimmed)) continue;
    return null;
  }
  return null;
}

/**
 * Parse all SEARCH/REPLACE blocks in a message.
 * @param {string} text - raw model output (prose allowed around the blocks)
 * @param {object} [opts]
 * @param {string} [opts.defaultPath] - path to attach when none can be inferred
 * @returns {{ edits: SearchReplaceEdit[], errors: Array<{line: number, message: string}> }}
 */
function parse(text, opts) {
  opts = opts || {};
  const lines = String(text).split("\n");
  const edits = [];
  const errors = [];
  let lastPath = opts.defaultPath || null;

  let i = 0;
  while (i < lines.length) {
    if (!SEARCH_RE.test(lines[i])) { i++; continue; }

    const searchLine = i; // 0-based index of the SEARCH marker
    const path = findPrecedingPath(lines, searchLine) || lastPath;

    // Collect SEARCH body up to the divider.
    const searchBody = [];
    let j = i + 1;
    let dividerAt = -1;
    for (; j < lines.length; j++) {
      if (DIVIDER_RE.test(lines[j])) { dividerAt = j; break; }
      if (SEARCH_RE.test(lines[j])) break; // another SEARCH before a divider
      if (REPLACE_RE.test(lines[j])) break; // REPLACE before a divider
      searchBody.push(lines[j]);
    }
    if (dividerAt === -1) {
      errors.push({
        line: searchLine + 1,
        message: "SEARCH block has no '=======' divider before the next marker or EOF",
      });
      i = j;
      continue;
    }

    // Collect REPLACE body up to the REPLACE marker.
    const replaceBody = [];
    let k = dividerAt + 1;
    let replaceAt = -1;
    for (; k < lines.length; k++) {
      if (REPLACE_RE.test(lines[k])) { replaceAt = k; break; }
      if (SEARCH_RE.test(lines[k]) || DIVIDER_RE.test(lines[k])) break;
      replaceBody.push(lines[k]);
    }
    if (replaceAt === -1) {
      errors.push({
        line: dividerAt + 1,
        message: "'=======' divider has no matching '>>>>>>> REPLACE' marker",
      });
      i = k;
      continue;
    }

    // A trailing closing fence that got swept into REPLACE body is stripped.
    const cleanReplace = stripTrailingFence(replaceBody);
    const cleanSearch = searchBody;

    const edit = {
      type: "search-replace",
      format: "search-replace",
      path: path || null,
      search: cleanSearch.join("\n"),
      replace: cleanReplace.join("\n"),
      searchLines: cleanSearch,
      replaceLines: cleanReplace,
      loc: { line: searchLine + 1 },
      isCreate: cleanSearch.length === 0 || cleanSearch.every((l) => l.trim() === ""),
    };
    if (!edit.path) {
      errors.push({
        line: searchLine + 1,
        message: "SEARCH/REPLACE block has no inferable file path",
      });
    } else {
      lastPath = edit.path;
    }
    edits.push(edit);
    i = replaceAt + 1;
  }

  return { edits, errors };
}

/**
 * If the last lines of a REPLACE body are a closing code fence (and nothing of
 * substance follows), drop them — models frequently include the fence inside the
 * block boundary.
 * @param {string[]} body
 * @returns {string[]}
 */
function stripTrailingFence(body) {
  const out = body.slice();
  while (out.length && out[out.length - 1].trim() === "") out.pop();
  if (out.length && FENCE_RE.test(out[out.length - 1]) && /^\s*(`{3,}|~{3,})\s*$/.test(out[out.length - 1])) {
    out.pop();
    while (out.length && out[out.length - 1].trim() === "") out.pop();
  }
  return out;
}

/**
 * Quick predicate: does this text contain at least one SEARCH marker?
 * @param {string} text
 * @returns {boolean}
 */
function has(text) {
  return String(text).split("\n").some((l) => SEARCH_RE.test(l));
}

module.exports = {
  parse,
  has,
  extractPathHeader,
  pathFromFenceInfo,
  findPrecedingPath,
  SEARCH_RE,
  DIVIDER_RE,
  REPLACE_RE,
  FENCE_RE,
};
