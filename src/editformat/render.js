"use strict";
// ================= Rendering — changes -> canonical edit blocks =================
// The inverse of the parsers: given a set of {path, before, after} changes, emit
// well-formed edit text in any supported format. Nexus uses this to SHOW a change
// to the user, to re-emit a change canonically, or to construct few-shot examples.
//
// The SEARCH/REPLACE renderer derives its blocks from src/patch's own diff engine
// (one block per hunk, context included) so that render -> parse -> validate round
// -trips back to the same result on the original file.

const diff = require("../patch/diff");
const patchApply = require("../patch/apply");

const DEFAULT_FENCE = "```";

/**
 * Render SEARCH/REPLACE blocks for one change.
 * @param {{path: string, before?: string, after?: string, search?: string, replace?: string}} change
 * @param {object} [opts]
 * @param {boolean} [opts.fence=true] - wrap in a code fence
 * @param {string} [opts.lang=""] - fence language tag
 * @param {number} [opts.context=3] - context lines per block (before/after mode)
 * @returns {string}
 */
function renderSearchReplace(change, opts) {
  opts = opts || {};
  const fence = opts.fence !== false;
  const lang = opts.lang || "";
  const out = [];
  const open = fence ? (DEFAULT_FENCE + (lang ? lang : "")) : null;

  // Explicit search/replace pair.
  if (change.search != null || change.replace != null) {
    out.push(change.path);
    if (open) out.push(open);
    out.push("<<<<<<< SEARCH");
    if (change.search) out.push(...diff.splitLines(change.search).lines);
    out.push("=======");
    if (change.replace) out.push(...diff.splitLines(change.replace).lines);
    out.push(">>>>>>> REPLACE");
    if (open) out.push(DEFAULT_FENCE);
    return out.join("\n") + "\n";
  }

  const before = change.before == null ? "" : change.before;
  const after = change.after == null ? "" : change.after;

  // Creation: empty SEARCH, whole content as REPLACE.
  if (before === "") {
    out.push(change.path);
    if (open) out.push(open);
    out.push("<<<<<<< SEARCH");
    out.push("=======");
    out.push(...diff.splitLines(after).lines);
    out.push(">>>>>>> REPLACE");
    if (open) out.push(DEFAULT_FENCE);
    return out.join("\n") + "\n";
  }

  // One block per hunk, carrying context, so matches are unambiguous.
  const ud = diff.createUnifiedDiff(before, after, { context: opts.context == null ? 3 : opts.context });
  const parsed = diff.parseUnifiedDiff(ud);
  out.push(change.path);
  const hunks = parsed.length ? parsed[0].hunks : [];
  for (let i = 0; i < hunks.length; i++) {
    const { pre, post } = patchApply.hunkImages(hunks[i]);
    if (open) out.push(open);
    out.push("<<<<<<< SEARCH");
    out.push(...pre);
    out.push("=======");
    out.push(...post);
    out.push(">>>>>>> REPLACE");
    if (open) out.push(DEFAULT_FENCE);
  }
  return out.join("\n") + (out.length ? "\n" : "");
}

/**
 * Render a unified diff for one change. Delegates to src/patch's diff writer.
 * @param {{path: string, before?: string, after?: string}} change
 * @param {object} [opts] - { context, gitHeader }
 * @returns {string}
 */
function renderUnifiedDiff(change, opts) {
  opts = opts || {};
  const before = change.before == null ? "" : change.before;
  const after = change.after == null ? "" : change.after;
  const oldPath = before === "" ? "/dev/null" : "a/" + change.path;
  const newPath = after === "" ? "/dev/null" : "b/" + change.path;
  const body = diff.createUnifiedDiff(before, after, {
    oldPath, newPath, context: opts.context == null ? 3 : opts.context,
  });
  if (!body) return "";
  if (opts.gitHeader) {
    return `diff --git a/${change.path} b/${change.path}\n` + body;
  }
  return body;
}

/**
 * Render a whole-file block for one change.
 * @param {{path: string, after: string}} change
 * @param {object} [opts] - { lang, header=true, fence='```' }
 * @returns {string}
 */
function renderWholeFile(change, opts) {
  opts = opts || {};
  const fence = opts.fence || DEFAULT_FENCE;
  const lang = opts.lang || "";
  const out = [];
  if (opts.header !== false) out.push(change.path);
  out.push(fence + (lang ? lang : ""));
  const content = change.after == null ? "" : change.after;
  out.push(...diff.splitLines(content).lines);
  out.push(fence);
  return out.join("\n") + "\n";
}

/**
 * Render many changes in a chosen format.
 * @param {Array} changes - [{path, before, after}]
 * @param {object} [opts] - { format: "search-replace"|"unified-diff"|"whole-file", ...rendererOpts }
 * @returns {string}
 */
function render(changes, opts) {
  opts = opts || {};
  const format = opts.format || "search-replace";
  const fn = format === "unified-diff" ? renderUnifiedDiff
    : format === "whole-file" ? renderWholeFile
    : renderSearchReplace;
  return changes.map((c) => fn(c, opts)).filter(Boolean).join("\n");
}

module.exports = { render, renderSearchReplace, renderUnifiedDiff, renderWholeFile };
