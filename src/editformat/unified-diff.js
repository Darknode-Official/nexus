"use strict";
// ================= Tolerant unified-diff parser =================
// Models emit unified diffs that no `patch(1)` would accept: invented or omitted
// @@ line numbers, wrong counts, missing ---/+++ headers, stray "diff --git"
// lines, a/ b/ prefixes, fenced blocks, and context lines that silently dropped
// their leading space. This parser recovers a clean, structured patch from that
// mess. It deliberately IGNORES the model's declared line numbers and counts —
// those are recomputed from the actual +/-/space lines, and reconciliation
// against the real file is delegated to src/patch's fuzzy applier downstream.
//
// Output hunks match src/patch/diff.parseUnifiedDiff exactly, so a parsed file
// patch can be handed straight to src/patch apply / transaction layers.

// Grab a hunk line and its interior, tolerating anything (even "@@ ... @@") between
// the fences; the numeric ranges are parsed out of the interior separately.
const HUNK_RE = /^@@+(.*?)@@(.*)$/;
const RANGE_RE = /-(\d+)(?:,(\d+))?\s*\+(\d+)(?:,(\d+))?/;
const FENCE_RE = /^\s*(`{3,}|~{3,})(.*)$/;
const NO_NEWLINE = "\\ No newline at end of file";

/**
 * Strip a leading "a/" or "b/" (or "i/"/"w/"/"c/") diff prefix from a path.
 * @param {string} p
 * @returns {string}
 */
function stripPrefix(p) {
  if (!p) return p;
  let s = p.trim();
  // Unquote paths with spaces: "a/my file.js"
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) s = s.slice(1, -1);
  const m = /^[abciwo]\/(.+)$/.exec(s);
  if (m) return m[1];
  return s;
}

/**
 * Pull the path out of a "diff --git a/x b/x" line.
 * @param {string} line
 * @returns {string|null}
 */
function pathFromGitHeader(line) {
  const m = /^diff --git\s+(\S+)\s+(\S+)/.exec(line.trim());
  if (!m) return null;
  // Prefer the b/ side (destination).
  return stripPrefix(m[2]) || stripPrefix(m[1]);
}

/**
 * Finalize a hunk: recompute counts from its actual lines, so the model's wrong
 * numbers never reach the applier.
 * @param {{oldStart: number, newStart: number, lines: Array}} hunk
 * @returns {object}
 */
function finalizeHunk(hunk) {
  let oldLines = 0;
  let newLines = 0;
  for (const l of hunk.lines) {
    if (l.type === " ") { oldLines++; newLines++; }
    else if (l.type === "-") oldLines++;
    else if (l.type === "+") newLines++;
  }
  hunk.oldLines = oldLines;
  hunk.newLines = newLines;
  return hunk;
}

/**
 * Parse a (possibly fenced, possibly multi-file, possibly sloppy) unified diff.
 * @param {string} text
 * @param {object} [opts]
 * @param {string} [opts.defaultPath]
 * @returns {{ files: Array<{oldPath: string|null, newPath: string|null, path: string|null,
 *            isCreate: boolean, isDelete: boolean, hunks: Array}>,
 *            errors: Array<{line: number, message: string}> }}
 */
function parse(text, opts) {
  opts = opts || {};
  const rawLines = String(text).split("\n");
  const files = [];
  const errors = [];
  let current = null;
  let hunk = null;
  let inFence = false;
  let fenceToken = null;
  let pendingGitPath = null;

  const startFile = (oldPath, newPath) => {
    current = {
      oldPath: oldPath || null,
      newPath: newPath || null,
      path: null,
      isCreate: false,
      isDelete: false,
      hunks: [],
    };
    files.push(current);
    hunk = null;
  };

  for (let idx = 0; idx < rawLines.length; idx++) {
    const line = rawLines[idx];

    // Track fences but do not let them terminate a diff; a diff can span a fence
    // boundary in sloppy output. We only use the fence to know we are "inside" a
    // code block (so we keep reading) and to swallow the fence lines themselves.
    const fence = FENCE_RE.exec(line);
    if (fence) {
      if (!inFence) { inFence = true; fenceToken = fence[1][0]; }
      else if (fence[1][0] === fenceToken) { inFence = false; fenceToken = null; }
      continue;
    }

    if (line.startsWith("diff --git")) {
      pendingGitPath = pathFromGitHeader(line);
      // A new git header starts a new file only once we see its ---/+++ or @@.
      current = null;
      hunk = null;
      continue;
    }
    if (/^(index |old mode |new mode |similarity |rename |copy |deleted file|new file)/.test(line)) {
      if (/^deleted file/.test(line) && current) current.isDelete = true;
      if (/^new file/.test(line) && current) current.isCreate = true;
      continue;
    }

    if (line.startsWith("--- ")) {
      const raw = line.slice(4).trim();
      startFile(raw === "/dev/null" ? "/dev/null" : stripPrefix(raw), null);
      if (pendingGitPath) { current.path = pendingGitPath; pendingGitPath = null; }
      if (raw === "/dev/null") current.isCreate = true;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const raw = line.slice(4).trim();
      if (!current) startFile(null, null);
      current.newPath = raw === "/dev/null" ? "/dev/null" : stripPrefix(raw);
      if (raw === "/dev/null") current.isDelete = true;
      continue;
    }

    const hm = HUNK_RE.exec(line);
    if (hm) {
      if (!current) {
        startFile(pendingGitPath || opts.defaultPath || null, pendingGitPath || opts.defaultPath || null);
        if (pendingGitPath) { current.path = pendingGitPath; pendingGitPath = null; }
      }
      const rm = RANGE_RE.exec(hm[1]);
      hunk = {
        oldStart: rm && rm[1] !== undefined ? parseInt(rm[1], 10) : 1,
        oldLines: rm && rm[2] !== undefined ? parseInt(rm[2], 10) : 0,
        newStart: rm && rm[3] !== undefined ? parseInt(rm[3], 10) : 1,
        newLines: rm && rm[4] !== undefined ? parseInt(rm[4], 10) : 0,
        lines: [],
        declaredOld: rm && rm[2] !== undefined ? parseInt(rm[2], 10) : null,
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
    if (tag === "+" || tag === "-" || tag === " ") {
      hunk.lines.push({ type: tag, content: line.slice(1) });
    } else if (line === "") {
      // A genuinely empty line inside a hunk is a context line whose single
      // leading space was stripped (common when models reflow whitespace). Treat
      // it as blank context — but only while the hunk still expects more lines.
      if (stillExpectingLines(hunk)) {
        hunk.lines.push({ type: " ", content: "" });
      } else {
        hunk = null; // the hunk is complete; a blank line ends it
      }
    } else {
      // Non-diff prose after a hunk terminates it.
      hunk = null;
    }
  }

  // Resolve a single best path per file and finalize counts.
  for (const f of files) {
    for (const h of f.hunks) finalizeHunk(h);
    f.path = resolvePath(f);
    if (f.oldPath === "/dev/null") f.isCreate = true;
    if (f.newPath === "/dev/null") f.isDelete = true;
  }
  const good = files.filter((f) => f.hunks.length > 0 || f.isDelete);
  if (good.length === 0 && /@@|diff --git|^--- /m.test(text)) {
    errors.push({ line: 1, message: "unified-diff markers present but no hunks could be parsed" });
  }
  return { files: good, errors };
}

/**
 * Whether a hunk, judged by its declared old-count, still expects context/removed
 * lines. Used to decide if a stripped blank line belongs to the hunk.
 * @param {object} hunk
 * @returns {boolean}
 */
function stillExpectingLines(hunk) {
  if (hunk.declaredOld == null) return true; // unknown counts — stay greedy
  let old = 0;
  for (const l of hunk.lines) if (l.type === " " || l.type === "-") old++;
  return old < hunk.declaredOld;
}

/**
 * Choose the effective target path for a file patch, preferring the destination.
 * @param {object} f
 * @returns {string|null}
 */
function resolvePath(f) {
  if (f.path) return f.path;
  if (f.newPath && f.newPath !== "/dev/null") return f.newPath;
  if (f.oldPath && f.oldPath !== "/dev/null") return f.oldPath;
  return null;
}

/**
 * Quick predicate: does this text look like it contains a unified diff?
 * @param {string} text
 * @returns {boolean}
 */
function has(text) {
  return String(text).split("\n").some((l) => HUNK_RE.test(l) || l.startsWith("diff --git"));
}

module.exports = {
  parse,
  has,
  stripPrefix,
  pathFromGitHeader,
  finalizeHunk,
  resolvePath,
  HUNK_RE,
};
