"use strict";
// ================= SEARCH-block locator + self-repair =================
// Finds where a SEARCH block sits inside the real file and classifies HOW it was
// found, so the caller can either apply confidently or hand the model a precise
// diagnosis for a retry. The escalation ladder is:
//
//   exact            -> the block is present verbatim (safe to apply)
//   trailing-ws      -> matched after ignoring trailing whitespace      (repair)
//   tabs             -> matched after normalizing tabs to spaces         (repair)
//   indent           -> matched after ignoring leading indentation       (repair)
//   inner-ws         -> matched after collapsing interior whitespace     (repair)
//   fuzzy            -> matched only by similarity (OPT-IN; never silent)
//
// The whitespace/indent levels are deterministic structural matches and are safe
// to apply automatically. Content-level fuzzy matching is a guess: it is applied
// ONLY when the caller opts in AND the match is both strong and unambiguous.
// Otherwise the locator reports "not-found"/"ambiguous" with ranked candidates.

const t = require("./text");

/** Default similarity required for an opt-in fuzzy application. */
const FUZZY_THRESHOLD = 0.75;
/** Minimum lead the best fuzzy candidate must have over the runner-up. */
const FUZZY_MARGIN = 0.08;

/**
 * Locate a SEARCH block within file content.
 * @param {string} content - current file content
 * @param {string[]} searchLines - the SEARCH block, split into lines
 * @param {object} [opts]
 * @param {boolean} [opts.allowFuzzy=false] - allow a content-fuzzy match to count
 * @param {number} [opts.fuzzyThreshold]
 * @param {number} [opts.maxCandidates=3] - candidates to include in diagnosis
 * @returns {{
 *   status: "exact"|"repaired"|"ambiguous"|"not-found"|"empty",
 *   start?: number, end?: number,          // 0-based [start,end) line range
 *   matched?: string[],                    // actual file lines that matched
 *   normalizer?: string, repair?: string,  // how it was found
 *   searchIndent?: number, matchIndent?: string,
 *   candidates?: Array<{start: number, similarity: number, excerpt: string}>,
 *   diagnosis?: object
 * }}
 */
function locate(content, searchLines, opts) {
  opts = opts || {};
  const threshold = opts.fuzzyThreshold == null ? FUZZY_THRESHOLD : opts.fuzzyThreshold;
  const maxCandidates = opts.maxCandidates == null ? 3 : opts.maxCandidates;

  if (searchLines.length === 0 || searchLines.every((l) => l.trim() === "")) {
    return { status: "empty" };
  }

  const fileLines = t.toLines(content).lines;
  const len = searchLines.length;
  if (fileLines.length < len) {
    return notFound(content, searchLines, fileLines, threshold, maxCandidates,
      "SEARCH block is longer than the target file");
  }

  // Escalate through the normalization ladder; the first level with exactly one
  // match wins. More than one match at any level is reported as ambiguous.
  for (const norm of t.NORMALIZERS) {
    const needle = searchLines.map(norm.fn);
    const matches = [];
    for (let s = 0; s + len <= fileLines.length; s++) {
      const window = [];
      let ok = true;
      for (let k = 0; k < len; k++) {
        const nl = norm.fn(fileLines[s + k]);
        if (nl !== needle[k]) { ok = false; break; }
        window.push(fileLines[s + k]);
      }
      if (ok) matches.push(s);
      if (matches.length > 1) break; // ambiguity is enough to stop this level
    }

    if (matches.length === 1) {
      const s = matches[0];
      const matched = fileLines.slice(s, s + len);
      return {
        status: norm.level === "exact" ? "exact" : "repaired",
        start: s,
        end: s + len,
        matched,
        normalizer: norm.level,
        repair: norm.level === "exact" ? null : norm.label,
        searchIndent: t.commonIndent(searchLines),
        matchIndent: leadingWhitespace(fileLines[firstNonBlank(matched, s, fileLines)]),
      };
    }
    if (matches.length > 1) {
      // Re-scan fully to enumerate all ambiguous locations for the report.
      const all = [];
      for (let s = 0; s + len <= fileLines.length; s++) {
        let ok = true;
        for (let k = 0; k < len; k++) {
          if (norm.fn(fileLines[s + k]) !== needle[k]) { ok = false; break; }
        }
        if (ok) all.push(s);
      }
      return {
        status: "ambiguous",
        normalizer: norm.level,
        candidates: all.slice(0, Math.max(maxCandidates, all.length)).map((s) => ({
          start: s,
          line: s + 1,
          similarity: 1,
          excerpt: excerptOf(fileLines, s, len),
        })),
        diagnosis: {
          reason: "ambiguous",
          message: `SEARCH block matches ${all.length} locations` +
            (norm.level === "exact" ? "" : ` (after ${norm.label})`) +
            "; add surrounding context to disambiguate",
          count: all.length,
          lines: all.map((s) => s + 1),
        },
      };
    }
  }

  // No structural match at any level — fall back to similarity ranking.
  return maybeFuzzy(content, searchLines, fileLines, threshold, maxCandidates, opts.allowFuzzy);
}

/**
 * Rank similar windows and either accept an opt-in fuzzy match or return a rich
 * not-found diagnosis.
 */
function maybeFuzzy(content, searchLines, fileLines, threshold, maxCandidates, allowFuzzy) {
  const len = searchLines.length;
  const scored = [];
  for (let s = 0; s + len <= fileLines.length; s++) {
    const window = fileLines.slice(s, s + len);
    const sim = t.blockSimilarity(searchLines, window);
    scored.push({ start: s, similarity: sim });
  }
  scored.sort((a, b) => b.similarity - a.similarity);
  const best = scored[0];
  const second = scored[1];

  const candidates = scored.slice(0, maxCandidates).map((c) => ({
    start: c.start,
    line: c.start + 1,
    similarity: round(c.similarity),
    excerpt: excerptOf(fileLines, c.start, len),
  }));

  if (
    allowFuzzy &&
    best &&
    best.similarity >= threshold &&
    (!second || best.similarity - second.similarity >= FUZZY_MARGIN)
  ) {
    const s = best.start;
    const matched = fileLines.slice(s, s + len);
    return {
      status: "repaired",
      start: s,
      end: s + len,
      matched,
      normalizer: "fuzzy",
      repair: `fuzzy match at similarity ${round(best.similarity)}`,
      similarity: round(best.similarity),
      searchIndent: t.commonIndent(searchLines),
      matchIndent: leadingWhitespace(matched[firstNonBlank(matched, s, fileLines)]),
      candidates,
    };
  }

  // Characterize why it failed, to steer the retry.
  const reason = best && best.similarity >= 0.6 ? "near-miss" : "not-found";
  const whitespaceOnly = best &&
    t.blockSimilarity(searchLines.map((l) => t.rstrip(t.stripIndent(l))),
      fileLines.slice(best.start, best.start + len).map((l) => t.rstrip(t.stripIndent(l)))) > 0.98 &&
    best.similarity < 1;
  return {
    status: "not-found",
    candidates,
    diagnosis: {
      reason,
      message: whitespaceOnly
        ? "SEARCH block differs only in whitespace/indentation from the closest file region; re-copy it verbatim"
        : (best && best.similarity >= 0.6
          ? `SEARCH block not found exactly; closest region is ${round(best.similarity * 100)}% similar at line ${best.start + 1}`
          : "SEARCH block does not appear in the file; re-read the file and copy an exact span"),
      bestSimilarity: best ? round(best.similarity) : 0,
      bestLine: best ? best.start + 1 : null,
      whitespaceOnly: !!whitespaceOnly,
    },
  };
}

/** Build a not-found result when the search can't even fit. */
function notFound(content, searchLines, fileLines, threshold, maxCandidates, message) {
  return {
    status: "not-found",
    candidates: [],
    diagnosis: { reason: "not-found", message, bestSimilarity: 0, bestLine: null },
  };
}

/** Index of the first non-blank line within a matched slice (relative to file). */
function firstNonBlank(matched, start, fileLines) {
  for (let i = 0; i < matched.length; i++) if (matched[i].trim() !== "") return start + i;
  return start;
}

/** Leading whitespace prefix of a line. */
function leadingWhitespace(line) {
  if (line == null) return "";
  const m = /^[ \t]*/.exec(line);
  return m ? m[0] : "";
}

/** A short, single-line excerpt of a window for diagnostics. */
function excerptOf(fileLines, start, len) {
  const first = fileLines[start] == null ? "" : fileLines[start];
  const trimmed = first.length > 80 ? first.slice(0, 77) + "..." : first;
  return trimmed;
}

/** Round to 3 decimals. */
function round(x) {
  return Math.round(x * 1000) / 1000;
}

module.exports = { locate, FUZZY_THRESHOLD, FUZZY_MARGIN };
