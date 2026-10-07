"use strict";
// ================= Unified-diff engine — line diff, generate & parse =================
// Zero-dependency implementation of a line-oriented Myers (O(ND)) diff plus a
// faithful unified-diff writer and parser. The output round-trips: a diff produced
// by `createUnifiedDiff` parses back with `parseUnifiedDiff` into hunks that
// `../apply` can re-apply onto the original text.
//
// Design notes:
//  - Lines are compared without their trailing newline; the "no newline at end of
//    file" condition is tracked explicitly and emitted as the standard
//    "\ No newline at end of file" marker so content is never silently corrupted.
//  - The Myers routine stores the full search trace and backtracks, giving a
//    minimal edit script. Memory is O(D^2) which is ample for source files.

/**
 * Split text into lines, remembering whether the final line had a newline.
 * @param {string} text
 * @returns {{ lines: string[], noEOL: boolean }}
 */
function splitLines(text) {
  if (text === "") return { lines: [], noEOL: false };
  const noEOL = !text.endsWith("\n");
  const body = noEOL ? text : text.slice(0, -1);
  return { lines: body.split("\n"), noEOL };
}

/**
 * Re-join lines produced by {@link splitLines}.
 * @param {string[]} lines
 * @param {boolean} noEOL - true if the content must NOT end with a newline
 * @returns {string}
 */
function joinLines(lines, noEOL) {
  if (lines.length === 0) return "";
  return lines.join("\n") + (noEOL ? "" : "\n");
}

/**
 * Minimal line diff via the Myers O(ND) algorithm.
 * @param {string[]} a - original lines
 * @param {string[]} b - updated lines
 * @returns {Array<{type: "equal"|"delete"|"insert", value: string}>} ordered edit script
 */
function diffLines(a, b) {
  const N = a.length;
  const M = b.length;
  const max = N + M;
  // v is keyed by diagonal k; we snapshot it into `trace` at each edit distance d.
  const v = new Map();
  v.set(1, 0);
  const trace = [];
  let reachedD = -1;

  for (let d = 0; d <= max; d++) {
    trace.push(new Map(v));
    let done = false;
    for (let k = -d; k <= d; k += 2) {
      let x;
      const down = k === -d || (k !== d && (v.get(k - 1) || 0) < (v.get(k + 1) || 0));
      if (down) x = v.get(k + 1) || 0; // move down (insertion from b)
      else x = (v.get(k - 1) || 0) + 1; // move right (deletion from a)
      let y = x - k;
      while (x < N && y < M && a[x] === b[y]) { x++; y++; }
      v.set(k, x);
      if (x >= N && y >= M) { done = true; break; }
    }
    if (done) { reachedD = d; break; }
  }

  // Backtrack through the saved traces to recover the edit script.
  const ops = [];
  let x = N;
  let y = M;
  for (let d = reachedD; d > 0; d--) {
    const vPrev = trace[d];
    const k = x - y;
    const down = k === -d || (k !== d && (vPrev.get(k - 1) || 0) < (vPrev.get(k + 1) || 0));
    const prevK = down ? k + 1 : k - 1;
    const prevX = vPrev.get(prevK) || 0;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ type: "equal", value: a[x - 1] });
      x--; y--;
    }
    if (down) { ops.push({ type: "insert", value: b[y - 1] }); y--; }
    else { ops.push({ type: "delete", value: a[x - 1] }); x--; }
  }
  while (x > 0 && y > 0) { ops.push({ type: "equal", value: a[x - 1] }); x--; y--; }
  while (x > 0) { ops.push({ type: "delete", value: a[x - 1] }); x--; }
  while (y > 0) { ops.push({ type: "insert", value: b[y - 1] }); y--; }

  ops.reverse();
  return ops;
}

const NO_NEWLINE = "\\ No newline at end of file";

/**
 * Produce a unified diff between two texts.
 * @param {string} oldText
 * @param {string} newText
 * @param {object} [opts]
 * @param {string} [opts.oldPath="a"] - path for the --- header
 * @param {string} [opts.newPath="b"] - path for the +++ header
 * @param {number} [opts.context=3] - lines of context around each change
 * @returns {string} unified diff text (empty string when inputs are identical)
 */
function createUnifiedDiff(oldText, newText, opts) {
  opts = opts || {};
  const context = opts.context == null ? 3 : opts.context;
  const oldPath = opts.oldPath || "a";
  const newPath = opts.newPath || "b";
  const A = splitLines(oldText);
  const B = splitLines(newText);
  const ops = diffLines(A.lines, B.lines);
  if (!ops.some(o => o.type !== "equal")) return "";

  // Build per-side line indices so we can compute hunk headers.
  const rows = [];
  let ai = 0;
  let bi = 0;
  for (const op of ops) {
    if (op.type === "equal") rows.push({ type: " ", value: op.value, a: ai++, b: bi++ });
    else if (op.type === "delete") rows.push({ type: "-", value: op.value, a: ai++, b: -1 });
    else rows.push({ type: "+", value: op.value, a: -1, b: bi++ });
  }

  // Group changes into hunks with `context` surrounding equal lines.
  const changedIdx = rows.map((r, i) => (r.type !== " " ? i : -1)).filter(i => i >= 0);
  const hunks = [];
  let gi = 0;
  while (gi < changedIdx.length) {
    let start = changedIdx[gi];
    let end = changedIdx[gi];
    gi++;
    // Extend while subsequent changes are within 2*context of each other.
    while (gi < changedIdx.length && changedIdx[gi] - end <= context * 2) {
      end = changedIdx[gi];
      gi++;
    }
    const from = Math.max(0, start - context);
    const to = Math.min(rows.length - 1, end + context);
    hunks.push({ from, to });
  }

  const out = [];
  out.push(`--- ${oldPath}`);
  out.push(`+++ ${newPath}`);
  for (const h of hunks) {
    const slice = rows.slice(h.from, h.to + 1);
    let oldStart = null;
    let newStart = null;
    let oldCount = 0;
    let newCount = 0;
    for (const r of slice) {
      if (r.type === " " || r.type === "-") { if (oldStart === null) oldStart = r.a; oldCount++; }
      if (r.type === " " || r.type === "+") { if (newStart === null) newStart = r.b; newCount++; }
    }
    // Header line numbers are 1-based; empty side is represented as start 0.
    const oh = oldCount === 0 ? 0 : oldStart + 1;
    const nh = newCount === 0 ? 0 : newStart + 1;
    out.push(`@@ -${oh},${oldCount} +${nh},${newCount} @@`);
    for (const r of slice) {
      out.push(r.type + r.value);
      const isLastOld = r.type !== "+" && r.a === A.lines.length - 1;
      const isLastNew = r.type !== "-" && r.b === B.lines.length - 1;
      if ((isLastOld && r.type === "-" && A.noEOL) ||
          (isLastNew && r.type === "+" && B.noEOL) ||
          (r.type === " " && isLastOld && isLastNew && A.noEOL && B.noEOL)) {
        out.push(NO_NEWLINE);
      }
    }
  }
  return out.join("\n") + "\n";
}

/**
 * Parse a unified diff into structured file patches.
 * Accepts multi-file diffs (multiple ---/+++ blocks) and bare hunk streams.
 * @param {string} text
 * @returns {Array<{oldPath: string, newPath: string, hunks: Array<{
 *   oldStart: number, oldLines: number, newStart: number, newLines: number,
 *   lines: Array<{type: " "|"-"|"+", content: string, noEOL?: boolean}> }>}>}
 */
function parseUnifiedDiff(text) {
  const lines = String(text).split("\n");
  const files = [];
  let current = null;
  let hunk = null;

  const headerRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("--- ")) {
      current = { oldPath: line.slice(4).trim(), newPath: "", hunks: [] };
      files.push(current);
      hunk = null;
      continue;
    }
    if (line.startsWith("+++ ")) {
      if (current) current.newPath = line.slice(4).trim();
      continue;
    }
    const m = headerRe.exec(line);
    if (m) {
      if (!current) {
        current = { oldPath: "a", newPath: "b", hunks: [] };
        files.push(current);
      }
      hunk = {
        oldStart: parseInt(m[1], 10),
        oldLines: m[2] === undefined ? 1 : parseInt(m[2], 10),
        newStart: parseInt(m[3], 10),
        newLines: m[4] === undefined ? 1 : parseInt(m[4], 10),
        lines: [],
      };
      current.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (line === NO_NEWLINE || line === "\\ No newline at end of file") {
      const last = hunk.lines[hunk.lines.length - 1];
      if (last) last.noEOL = true;
      continue;
    }
    const tag = line[0];
    if (tag === " " || tag === "-" || tag === "+") {
      hunk.lines.push({ type: tag, content: line.slice(1) });
    }
    // A truly empty line ("") is the artifact of the diff's own trailing newline
    // or a separator — a genuine empty context line is encoded as " " (a single
    // space) and is handled above. Any other prefix ("diff --git", "index ...",
    // "\\ No newline...") is handled earlier or ignored here.
  }
  return files;
}

/**
 * Count added/removed lines in a parsed patch or diff text.
 * @param {string|Array} diff - diff text or output of {@link parseUnifiedDiff}
 * @returns {{ additions: number, deletions: number, hunks: number, files: number }}
 */
function diffStat(diff) {
  const files = typeof diff === "string" ? parseUnifiedDiff(diff) : diff;
  let additions = 0;
  let deletions = 0;
  let hunks = 0;
  for (const f of files) {
    for (const h of f.hunks) {
      hunks++;
      for (const l of h.lines) {
        if (l.type === "+") additions++;
        else if (l.type === "-") deletions++;
      }
    }
  }
  return { additions, deletions, hunks, files: files.length };
}

module.exports = {
  splitLines,
  joinLines,
  diffLines,
  createUnifiedDiff,
  parseUnifiedDiff,
  diffStat,
  NO_NEWLINE,
};
