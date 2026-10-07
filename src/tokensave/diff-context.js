"use strict";
// ================= Diff-Context Builder =================
// Instead of sending a whole file to the model, send only the hunks that changed
// plus a configurable neighborhood and the nearest enclosing symbol header. For
// a 1200-line file with a three-line edit this is the difference between paying
// for 1200 lines and paying for ~15 — and it measures exactly how much it saved.
//
// Two entry points:
//   changedLineRanges(oldText, newText) — line-level diff (LCS) -> changed ranges
//   buildContext(fileText, ranges, opts) — expand ranges, attach symbol headers,
//                                          render, and measure tokens vs the full
//                                          file.
// fromEdit(oldText, newText, opts) composes both.

const { estimateTokens } = require("./estimator");

// Lines that plausibly open an enclosing symbol/scope; used to attach a header
// line so the model knows which function/class a hunk lives in.
const SYMBOL_RE = /^\s*(?:export\s+)?(?:default\s+)?(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*(?:function\b|class\b|def\b|interface\b|struct\b|enum\b|impl\b|module\b|namespace\b|type\b|const\s+\w+\s*=\s*(?:async\s*)?\(|[\w.]+\s*[:=]\s*(?:async\s*)?(?:function\b|\()|(?!(?:if|for|while|switch|catch|return|do|else)\b)[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{)/;

// Line-level LCS between two arrays of lines -> length table, used to derive the
// changed ranges in the NEW text. O(n*m) which is fine for source files.
function lcsTable(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  return dp;
}

/**
 * Compute changed line ranges in `newText` versus `oldText`.
 * @returns {Array<{start:number, end:number}>} 1-based inclusive line ranges that
 *          are added or modified in newText (sorted, merged where adjacent).
 */
function changedLineRanges(oldText, newText) {
  const a = String(oldText || "").split("\n");
  const b = String(newText || "").split("\n");
  const dp = lcsTable(a, b);
  // Walk the diff; collect indices of b-lines that are NOT part of the common
  // subsequence (i.e. inserted/changed lines in the new file).
  const changed = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { i++; }       // line removed from old
    else { changed.push(j); j++; }                        // line added in new
  }
  while (j < b.length) { changed.push(j); j++; }           // trailing additions

  // Convert 0-based indices to merged 1-based ranges.
  const ranges = [];
  for (const idx of changed) {
    const line = idx + 1;
    const last = ranges[ranges.length - 1];
    if (last && line <= last.end + 1) last.end = line;
    else ranges.push({ start: line, end: line });
  }
  return ranges;
}

// Find the nearest enclosing symbol header line (1-based) at or above `line`.
function enclosingSymbol(lines, line) {
  for (let i = Math.min(line, lines.length) - 1; i >= 0; i--) {
    if (SYMBOL_RE.test(lines[i])) return i + 1;
  }
  return 0;
}

// Merge overlapping/adjacent ranges after neighbor expansion.
function mergeRanges(ranges) {
  const sorted = ranges.slice().sort((a, b) => a.start - b.start || a.end - b.end);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + 1) last.end = Math.max(last.end, r.end);
    else out.push({ start: r.start, end: r.end });
  }
  return out;
}

/**
 * Build minimal context around a set of changed ranges.
 * @param {string} fileText - the full (new) file content
 * @param {Array<{start,end}>} ranges - 1-based inclusive changed ranges
 * @param {object} [opts] - { neighbors?:number=3, includeSymbols?:boolean=true,
 *                            model?, lineNumbers?:boolean=true }
 * @returns {{ context, hunks, fullTokens, contextTokens, saved, savedPct, lines }}
 */
function buildContext(fileText, ranges, opts) {
  opts = opts || {};
  const neighbors = opts.neighbors == null ? 3 : Math.max(0, opts.neighbors | 0);
  const includeSymbols = opts.includeSymbols !== false;
  const lineNumbers = opts.lineNumbers !== false;
  const model = opts.model;

  const lines = String(fileText || "").split("\n");
  const totalLines = lines.length;

  // Expand each changed range by the neighborhood, clamped to file bounds.
  let expanded = (ranges || []).map((r) => ({
    start: Math.max(1, r.start - neighbors),
    end: Math.min(totalLines, r.end + neighbors),
    changedStart: r.start,
    changedEnd: r.end,
  }));
  expanded = mergeRanges(expanded);

  const hunks = [];
  const out = [];
  let shownLines = 0;
  let prevEnd = 0;

  for (const r of expanded) {
    // Optionally prepend the enclosing symbol header if it falls outside the hunk.
    let headerLine = 0;
    if (includeSymbols) {
      headerLine = enclosingSymbol(lines, r.start);
      if (headerLine && headerLine < r.start && headerLine > prevEnd) {
        out.push(fmtLine(headerLine, lines[headerLine - 1], lineNumbers));
        out.push("    ... (" + (r.start - headerLine - 1) + " lines omitted) ...");
        shownLines += 1;
      } else {
        headerLine = 0;
      }
    }
    if (r.start > prevEnd + 1 && out.length) {
      // gap marker between hunks
      out.push("    ... (" + (r.start - prevEnd - 1) + " lines omitted) ...");
    }
    for (let ln = r.start; ln <= r.end; ln++) {
      out.push(fmtLine(ln, lines[ln - 1], lineNumbers));
      shownLines++;
    }
    hunks.push({ start: r.start, end: r.end, symbolLine: headerLine || null });
    prevEnd = r.end;
  }
  if (prevEnd < totalLines && out.length) {
    out.push("    ... (" + (totalLines - prevEnd) + " lines omitted) ...");
  }

  const context = out.join("\n");
  const fullTokens = estimateTokens(fileText, model);
  const contextTokens = estimateTokens(context, model);
  // Savings only accrue when there is actually a hunk to send minimally instead
  // of the whole file. With no changes there is nothing to send, so saved is 0.
  const saved = hunks.length ? Math.max(0, fullTokens - contextTokens) : 0;

  return {
    context,
    hunks,
    fullTokens,
    contextTokens,
    saved,
    savedPct: fullTokens > 0 ? +(100 * saved / fullTokens).toFixed(1) : 0,
    lines: { total: totalLines, shown: shownLines },
  };
}

function fmtLine(n, text, withNumbers) {
  return withNumbers ? (String(n).padStart(5) + "  " + (text == null ? "" : text)) : (text == null ? "" : text);
}

/**
 * Convenience: diff two versions and build minimal context for the new one.
 * @returns the buildContext result plus `ranges`.
 */
function fromEdit(oldText, newText, opts) {
  const ranges = changedLineRanges(oldText, newText);
  const res = buildContext(newText, ranges, opts);
  res.ranges = ranges;
  return res;
}

module.exports = {
  changedLineRanges, buildContext, fromEdit,
  enclosingSymbol, mergeRanges, SYMBOL_RE,
};
