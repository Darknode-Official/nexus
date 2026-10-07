"use strict";
// Shared temp-directory helpers for patch-engine tests. Every test sandbox lives
// under the OS temp dir and is removed afterwards — nothing is written inside the
// worktree. (Filename has no "test" token so the runner does not execute it.)

const fs = require("fs");
const os = require("os");
const path = require("path");

/** Create a fresh temp dir and return its absolute path. */
function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nexus-patch-"));
}

/** Recursively remove a temp dir (best-effort). */
function rmTmp(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

/** Write a file (creating parent dirs) inside a sandbox. */
function write(dir, rel, content) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

/** Read a file as utf8. */
function read(abs) {
  return fs.readFileSync(abs, "utf8");
}

module.exports = { mkTmp, rmTmp, write, read };
