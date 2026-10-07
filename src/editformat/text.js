"use strict";
// ================= Text utilities for the edit-format layer =================
// Shared, dependency-free helpers for splitting, normalizing and comparing the
// text that language models emit. The edit-format parsers and the locator all
// speak in terms of the primitives defined here so that whitespace, line-ending
// and indentation handling is consistent (and testable) in one place.
//
// Normalization is layered: each `NORMALIZERS` entry is strictly weaker than the
// one before it, so the locator can escalate — exact first, then the gentlest
// repair that makes a block match. The name of the level that succeeded is the
// human-readable record of what had to be repaired.

/**
 * Detect the dominant end-of-line sequence used by a text.
 * @param {string} text
 * @returns {"\r\n"|"\n"|"\r"} the EOL to re-emit with (defaults to "\n")
 */
function detectEOL(text) {
  if (typeof text !== "string" || text.length === 0) return "\n";
  let crlf = 0;
  let lf = 0;
  let cr = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 10) { // \n
      if (i > 0 && text.charCodeAt(i - 1) === 13) crlf++;
      else lf++;
    } else if (c === 13 && text.charCodeAt(i + 1) !== 10) {
      cr++;
    }
  }
  if (crlf >= lf && crlf >= cr && crlf > 0) return "\r\n";
  if (cr > lf && cr > 0) return "\r";
  return "\n";
}

/**
 * Convert all line endings to "\n". Returns the normalized text and the EOL that
 * was dominant beforehand so it can be restored on write.
 * @param {string} text
 * @returns {{ text: string, eol: "\r\n"|"\n"|"\r" }}
 */
function normalizeEOL(text) {
  const eol = detectEOL(text);
  const out = String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return { text: out, eol };
}

/**
 * Restore a chosen EOL onto text that uses "\n" internally.
 * @param {string} text
 * @param {"\r\n"|"\n"|"\r"} eol
 * @returns {string}
 */
function applyEOL(text, eol) {
  if (eol === "\n" || !eol) return text;
  return String(text).replace(/\n/g, eol);
}

/**
 * Split text into lines WITHOUT dropping information: the trailing-newline state
 * is reported separately, matching src/patch/diff.splitLines semantics so the two
 * layers interoperate.
 * @param {string} text
 * @returns {{ lines: string[], noEOL: boolean }}
 */
function toLines(text) {
  if (text === "") return { lines: [], noEOL: false };
  const noEOL = !text.endsWith("\n");
  const body = noEOL ? text : text.slice(0, -1);
  return { lines: body.split("\n"), noEOL };
}

/**
 * Inverse of {@link toLines}.
 * @param {string[]} lines
 * @param {boolean} noEOL
 * @returns {string}
 */
function fromLines(lines, noEOL) {
  if (lines.length === 0) return "";
  return lines.join("\n") + (noEOL ? "" : "\n");
}

/** Strip trailing spaces/tabs/CR from a single line. */
function rstrip(line) {
  return line.replace(/[ \t\r]+$/, "");
}

/** Count the leading whitespace (spaces counted as 1, tabs expanded to `tabw`). */
function indentWidth(line, tabw) {
  tabw = tabw || 4;
  let w = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === " ") w++;
    else if (c === "\t") w += tabw;
    else break;
  }
  return w;
}

/** Remove ALL leading whitespace from a line. */
function stripIndent(line) {
  return line.replace(/^[ \t]+/, "");
}

/** Replace leading tabs with spaces (tabw each), leaving the rest of the line intact. */
function tabsToSpaces(line, tabw) {
  tabw = tabw || 4;
  const m = /^[ \t]+/.exec(line);
  if (!m) return line;
  let expanded = "";
  for (const c of m[0]) expanded += c === "\t" ? " ".repeat(tabw) : c;
  return expanded + line.slice(m[0].length);
}

/**
 * Normalization ladder, strongest (most faithful) first. Each `fn` maps one line
 * to its canonical form at that level. `label` is the repair note surfaced to the
 * caller when a level is what finally made a block match.
 * @type {Array<{ level: string, label: string, fn: (s: string) => string }>}
 */
const NORMALIZERS = [
  { level: "exact", label: "exact match", fn: (s) => s },
  { level: "trailing-ws", label: "ignored trailing whitespace", fn: (s) => rstrip(s) },
  { level: "tabs", label: "normalized tabs to spaces", fn: (s) => rstrip(tabsToSpaces(s)) },
  { level: "indent", label: "re-indented to match the file", fn: (s) => rstrip(stripIndent(s)) },
  { level: "inner-ws", label: "collapsed interior whitespace", fn: (s) => rstrip(stripIndent(s)).replace(/[ \t]+/g, " ") },
];

/**
 * Apply a normalizer to an array of lines.
 * @param {string[]} lines
 * @param {(s: string) => string} fn
 * @returns {string[]}
 */
function normalizeLines(lines, fn) {
  return lines.map(fn);
}

/** Compare two line arrays for element-wise equality. */
function linesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Levenshtein edit distance between two strings, capped for performance.
 * Used only for ranking near-misses in diagnostics, never for silent application.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function levenshtein(a, b) {
  if (a === b) return 0;
  const n = a.length;
  const m = b.length;
  if (n === 0) return m;
  if (m === 0) return n;
  let prev = new Array(m + 1);
  let cur = new Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= m; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    const tmp = prev; prev = cur; cur = tmp;
  }
  return prev[m];
}

/**
 * Similarity ratio in [0,1] between two strings (1 == identical).
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function similarity(a, b) {
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

/**
 * Line-block similarity: ratio of lines that match (after trailing-ws + indent
 * normalization) between two equal-length windows, averaged with per-line text
 * similarity so near-identical lines still score well.
 * @param {string[]} a
 * @param {string[]} b
 * @returns {number} in [0,1]
 */
function blockSimilarity(a, b) {
  const len = Math.max(a.length, b.length);
  if (len === 0) return 1;
  let sum = 0;
  for (let i = 0; i < len; i++) {
    const la = a[i] == null ? "" : rstrip(stripIndent(a[i]));
    const lb = b[i] == null ? "" : rstrip(stripIndent(b[i]));
    sum += similarity(la, lb);
  }
  return sum / len;
}

/**
 * Re-indent `replacementLines` so their base indentation matches `targetIndent`,
 * preserving relative nesting. Used when a repair re-indented the SEARCH block to
 * the file's indentation — the REPLACE must shift by the same delta.
 * @param {string[]} lines
 * @param {number} fromBase - common leading indent of the block as written
 * @param {string} targetPrefix - whitespace prefix the block actually sits at
 * @returns {string[]}
 */
function reindent(lines, fromBase, targetPrefix) {
  return lines.map((l) => {
    if (l.trim() === "") return l === "" ? "" : targetPrefix.length ? l : l;
    const cur = /^[ \t]*/.exec(l)[0];
    const rel = cur.length - fromBase;
    const pad = rel > 0 ? cur.slice(cur.length - rel) : "";
    return targetPrefix + pad + l.slice(cur.length);
  });
}

/** Common leading whitespace length shared by all non-blank lines. */
function commonIndent(lines) {
  let min = Infinity;
  for (const l of lines) {
    if (l.trim() === "") continue;
    const w = /^[ \t]*/.exec(l)[0].length;
    if (w < min) min = w;
  }
  return min === Infinity ? 0 : min;
}

module.exports = {
  detectEOL,
  normalizeEOL,
  applyEOL,
  toLines,
  fromLines,
  rstrip,
  indentWidth,
  stripIndent,
  tabsToSpaces,
  NORMALIZERS,
  normalizeLines,
  linesEqual,
  levenshtein,
  similarity,
  blockSimilarity,
  reindent,
  commonIndent,
};
