"use strict";
// Shared helpers for testintel tests: build throwaway fixture projects on disk under
// the OS temp dir and clean them up. Stdlib only.
const fs = require("fs");
const os = require("os");
const path = require("path");

// makeProject(tree) -> { root, cleanup } . tree: { "rel/path": "contents", ... }.
// Directories are created as needed. Returns an absolute root and a cleanup fn.
function makeProject(tree) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-testintel-"));
  for (const rel of Object.keys(tree || {})) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, tree[rel]);
  }
  return { root, cleanup: () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {} } };
}

// withProject(tree, fn) — make, run fn(root), always clean up.
function withProject(tree, fn) {
  const p = makeProject(tree);
  try { return fn(p.root); } finally { p.cleanup(); }
}

module.exports = { makeProject, withProject };
