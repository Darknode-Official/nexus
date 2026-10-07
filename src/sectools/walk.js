"use strict";
// ================= sectools/walk — shared directory walker =================
// A small, dependency-free file walker used by the scanners and the CLI. It
// honours a default ignore list (VCS, dependency and build directories),
// enforces size/count caps so an audit cannot blow up on a huge tree, and
// skips files that look binary so the text scanners never choke on them.
//
// Everything here is pure stdlib (fs/path) and synchronous — the trees we scan
// are source trees, not multi-gigabyte data lakes, and synchronous code keeps
// the call sites (guards, CLI) trivial to reason about.

const fs = require("fs");
const path = require("path");

// Directories that never contain first-party source worth scanning. Matching is
// done on path segments so "node_modules" anywhere in the tree is skipped.
const DEFAULT_IGNORE_DIRS = new Set([
  ".git", ".hg", ".svn", "node_modules", "bower_components", "vendor",
  "dist", "build", "out", "coverage", ".next", ".nuxt", ".cache",
  "__pycache__", ".pytest_cache", ".mypy_cache", ".tox", "venv", ".venv",
  "env", ".idea", ".vscode", "target", ".gradle", ".terraform", ".serverless",
]);

// File extensions that are binary / generated and should never be text-scanned.
const BINARY_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".svg",
  ".pdf", ".zip", ".gz", ".tar", ".tgz", ".bz2", ".xz", ".7z", ".rar",
  ".mp3", ".mp4", ".mov", ".avi", ".mkv", ".wav", ".flac", ".ogg",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".exe", ".dll", ".so", ".dylib", ".bin", ".class", ".o", ".a",
  ".wasm", ".node", ".pyc", ".pyo", ".lock", ".map",
]);

/**
 * Heuristic binary sniff: a NUL byte in the first chunk, or a high ratio of
 * non-printable bytes, means we treat the file as binary and skip it.
 * @param {Buffer} buf
 * @returns {boolean}
 */
function looksBinary(buf) {
  if (!buf || !buf.length) return false;
  const n = Math.min(buf.length, 8000);
  let suspicious = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b === 0) return true;
    // Allow tab(9), LF(10), CR(13), and printable range; count the rest.
    if (b < 9 || (b > 13 && b < 32)) suspicious++;
  }
  return suspicious / n > 0.3;
}

/**
 * Determine whether a path should be ignored given the ignore-dir set.
 * @param {string} rel relative path using forward slashes
 * @param {Set<string>} ignoreDirs
 */
function isIgnored(rel, ignoreDirs) {
  const parts = rel.split("/");
  for (const p of parts) if (ignoreDirs.has(p)) return true;
  return false;
}

/**
 * Walk a directory tree and return an array of file descriptors
 * `{ path, rel, size }` for text files under `root`.
 *
 * @param {string} root directory (or a single file) to walk
 * @param {object} [opts]
 * @param {Set<string>} [opts.ignoreDirs] override the default ignore set
 * @param {number} [opts.maxFiles=20000] stop after this many files
 * @param {number} [opts.maxBytes=2_000_000] skip files larger than this
 * @param {boolean} [opts.includeBinary=false] include binary files
 * @returns {{files:Array<{path:string,rel:string,size:number}>, scanned:number, skipped:number, truncated:boolean}}
 */
function walk(root, opts) {
  opts = opts || {};
  const ignoreDirs = opts.ignoreDirs || DEFAULT_IGNORE_DIRS;
  const maxFiles = opts.maxFiles || 20000;
  const maxBytes = opts.maxBytes != null ? opts.maxBytes : 2000000;
  const includeBinary = !!opts.includeBinary;

  const out = { files: [], scanned: 0, skipped: 0, truncated: false };

  let rootStat;
  try { rootStat = fs.statSync(root); } catch (_) { return out; }

  // Allow passing a single file directly.
  if (rootStat.isFile()) {
    const ext = path.extname(root).toLowerCase();
    if (!includeBinary && BINARY_EXT.has(ext)) { out.skipped++; return out; }
    out.files.push({ path: root, rel: path.basename(root), size: rootStat.size });
    out.scanned++;
    return out;
  }

  const stack = [root];
  while (stack.length) {
    if (out.files.length >= maxFiles) { out.truncated = true; break; }
    const dir = stack.pop();
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const ent of ents) {
      const full = path.join(dir, ent.name);
      const rel = path.relative(root, full).split(path.sep).join("/");
      if (isIgnored(rel, ignoreDirs)) { out.skipped++; continue; }
      if (ent.isSymbolicLink()) { out.skipped++; continue; }
      if (ent.isDirectory()) { stack.push(full); continue; }
      if (!ent.isFile()) { out.skipped++; continue; }

      const ext = path.extname(ent.name).toLowerCase();
      if (!includeBinary && BINARY_EXT.has(ext)) { out.skipped++; continue; }

      let st;
      try { st = fs.statSync(full); } catch (_) { out.skipped++; continue; }
      if (st.size > maxBytes) { out.skipped++; continue; }

      out.files.push({ path: full, rel, size: st.size });
      out.scanned++;
      if (out.files.length >= maxFiles) { out.truncated = true; break; }
    }
  }
  return out;
}

/**
 * Read a file as UTF-8 text, returning null when it is unreadable or binary.
 * @param {string} file
 * @param {object} [opts]
 * @param {boolean} [opts.includeBinary=false]
 * @returns {string|null}
 */
function readText(file, opts) {
  opts = opts || {};
  let buf;
  try { buf = fs.readFileSync(file); } catch (_) { return null; }
  if (!opts.includeBinary && looksBinary(buf)) return null;
  return buf.toString("utf8");
}

module.exports = {
  DEFAULT_IGNORE_DIRS,
  BINARY_EXT,
  looksBinary,
  isIgnored,
  walk,
  readText,
};
