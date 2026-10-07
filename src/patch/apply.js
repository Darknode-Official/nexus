"use strict";
// ================= Fuzzy patch apply — context matching with drift tolerance =================
// Applies parsed unified-diff hunks onto a text buffer. When line numbers have
// drifted (edits above the hunk, generated against an older revision, etc.) the
// engine searches outward from the expected position and, if needed, relaxes
// leading/trailing context by a bounded "fuzz" factor — exactly like GNU patch.
//
// Guarantees:
//  - Never a silent half-apply. `applyPatch` computes every hunk against a working
//    copy first; if ANY hunk fails it returns ok:false with the ORIGINAL text and a
//    per-hunk rejection report. Callers opt into partial application explicitly.
//  - Every success reports the offset (lines of drift) and fuzz actually used.

const diff = require("./diff");

/**
 * Split a hunk's lines into the pre-image (context + deletions) and post-image
 * (context + additions), recording how many pure-context lines bookend it.
 * @param {{lines: Array<{type: string, content: string}>}} hunk
 */
function hunkImages(hunk) {
  const pre = [];
  const post = [];
  for (const l of hunk.lines) {
    if (l.type === " ") { pre.push(l.content); post.push(l.content); }
    else if (l.type === "-") { pre.push(l.content); }
    else if (l.type === "+") { post.push(l.content); }
  }
  let lead = 0;
  while (lead < hunk.lines.length && hunk.lines[lead].type === " ") lead++;
  let trail = 0;
  for (let i = hunk.lines.length - 1; i >= 0 && hunk.lines[i].type === " "; i--) trail++;
  return { pre, post, lead, trail };
}

/**
 * Check whether `needle` matches `fileLines` starting at index `pos`.
 */
function matchesAt(fileLines, pos, needle) {
  if (pos < 0 || pos + needle.length > fileLines.length) return false;
  for (let i = 0; i < needle.length; i++) {
    if (fileLines[i + pos] !== needle[i]) return false;
  }
  return true;
}

/**
 * Attempt to locate a single hunk in the current buffer, tolerating drift and fuzz.
 * @returns {{found: boolean, at?: number, offset?: number, fuzz?: number,
 *            pre?: string[], post?: string[], reason?: string}}
 */
function locateHunk(fileLines, hunk, expectedStart, opts) {
  const maxFuzz = opts.fuzz == null ? 2 : opts.fuzz;
  const maxOffset = opts.maxOffset == null ? fileLines.length : opts.maxOffset;
  const { pre, post, lead, trail } = hunkImages(hunk);

  // Pure insertion (no context, no deletions): place at the expected line.
  if (pre.length === 0) {
    const at = Math.max(0, Math.min(expectedStart, fileLines.length));
    return { found: true, at, offset: at - expectedStart, fuzz: 0, pre: [], post };
  }

  for (let f = 0; f <= maxFuzz; f++) {
    const trimLead = Math.min(f, lead);
    const trimTrail = Math.min(f, trail);
    // When fuzz exceeds available context we would be searching an empty/over-
    // trimmed window; skip levels that do not actually relax anything new.
    if (f > 0 && trimLead === 0 && trimTrail === 0) break;
    const searchPre = pre.slice(trimLead, pre.length - trimTrail);
    const searchPost = post.slice(trimLead, post.length - trimTrail);
    if (searchPre.length === 0) continue; // nothing anchoring the match — too risky
    const anchor = expectedStart + trimLead;

    // Search outward: 0, +1, -1, +2, -2, ... bounded by maxOffset.
    for (let d = 0; d <= maxOffset; d++) {
      const candidates = d === 0 ? [anchor] : [anchor + d, anchor - d];
      for (const cand of candidates) {
        if (matchesAt(fileLines, cand, searchPre)) {
          return {
            found: true,
            at: cand,
            offset: cand - anchor,
            fuzz: f,
            pre: searchPre,
            post: searchPost,
          };
        }
      }
    }
  }
  return { found: false, reason: `context not found within fuzz ${maxFuzz} / offset ${maxOffset}` };
}

/**
 * Apply all hunks of one parsed file-patch onto `originalText`.
 * @param {string} originalText
 * @param {{hunks: Array}} filePatch - one element of {@link diff.parseUnifiedDiff}
 * @param {object} [opts]
 * @param {number} [opts.fuzz=2] - max context lines to relax per edge
 * @param {number} [opts.maxOffset] - max drift to search (defaults to file length)
 * @param {boolean} [opts.partial=false] - if true, apply what fits and report rejects;
 *        if false (default) a single rejection aborts with the text untouched
 * @returns {{ok: boolean, text: string, applied: number, rejected: number,
 *            hunks: Array<{index, applied, offset?, fuzz?, reason?}>}}
 */
function applyPatch(originalText, filePatch, opts) {
  opts = opts || {};
  const src = diff.splitLines(originalText);
  let work = src.lines.slice();
  let noEOL = src.noEOL;
  const report = [];
  let cursor = 0; // cumulative line delta applied so far
  let applied = 0;
  let rejected = 0;

  for (let hi = 0; hi < filePatch.hunks.length; hi++) {
    const hunk = filePatch.hunks[hi];
    const expectedStart = Math.max(0, hunk.oldStart - 1 + cursor);
    const loc = locateHunk(work, hunk, expectedStart, opts);
    if (!loc.found) {
      rejected++;
      report.push({ index: hi, applied: false, reason: loc.reason, oldStart: hunk.oldStart });
      if (!opts.partial) {
        return { ok: false, text: originalText, applied: 0, rejected, hunks: report };
      }
      continue;
    }
    // Splice: remove the matched pre-image, insert the post-image.
    work.splice(loc.at, loc.pre.length, ...loc.post);
    cursor += loc.post.length - loc.pre.length;
    applied++;
    report.push({ index: hi, applied: true, at: loc.at, offset: loc.offset, fuzz: loc.fuzz });

    // Track EOL state if this hunk touched the final line.
    const lastLine = hunk.lines[hunk.lines.length - 1];
    if (lastLine && lastLine.noEOL) noEOL = true;
  }

  return {
    ok: rejected === 0,
    text: diff.joinLines(work, noEOL),
    applied,
    rejected,
    hunks: report,
  };
}

/**
 * Convenience wrapper: parse a raw unified diff and apply its first file-patch.
 * @param {string} originalText
 * @param {string} unifiedDiff
 * @param {object} [opts] - forwarded to {@link applyPatch}
 */
function applyUnifiedDiff(originalText, unifiedDiff, opts) {
  const files = diff.parseUnifiedDiff(unifiedDiff);
  if (files.length === 0) {
    return { ok: false, text: originalText, applied: 0, rejected: 0, hunks: [], reason: "no hunks" };
  }
  return applyPatch(originalText, files[0], opts);
}

/**
 * Render a `.rej`-style report for hunks that could not be applied.
 * @param {{hunks: Array}} applyResult - output of {@link applyPatch}
 * @returns {string}
 */
function formatRejects(applyResult) {
  const rej = applyResult.hunks.filter(h => !h.applied);
  if (rej.length === 0) return "";
  return rej.map(h => `hunk #${h.index + 1} @ old line ${h.oldStart}: ${h.reason}`).join("\n");
}

module.exports = { applyPatch, applyUnifiedDiff, locateHunk, hunkImages, formatRejects };
