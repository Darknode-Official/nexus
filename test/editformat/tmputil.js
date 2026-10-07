"use strict";
// Shared temp-directory helpers for edit-format tests. Sandboxes live under the OS
// temp dir and are removed afterwards; nothing is written inside the worktree.
// (Filename carries no "test" token so the runner does not execute it.)

const fs = require("fs");
const os = require("os");
const path = require("path");

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nexus-editformat-"));
}

function rmTmp(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

function write(dir, rel, content) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

function read(abs) {
  return fs.readFileSync(abs, "utf8");
}

module.exports = { mkTmp, rmTmp, write, read };
