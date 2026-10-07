"use strict";
// Shared helpers for refactor tests: temp fixture projects on disk (for apply /
// rollback / verify paths) and quick in-memory session builders. The filename has no
// "test" token so the node:test runner does not execute it as a suite.

const fs = require("fs");
const os = require("os");
const path = require("path");
const refactor = require("../../src/refactor");

/** Create a temp dir and write { relPath: content } into it. Returns the dir. */
function mkProject(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-refactor-"));
  for (const rel of Object.keys(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, files[rel]);
  }
  return dir;
}

/** Best-effort recursive remove. */
function rmProject(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

/** An in-memory Refactorer session from { relPath: content }. */
function session(files) {
  const list = Object.keys(files).map((file) => ({ file, source: files[file] }));
  return new refactor.Refactorer({ files: list });
}

/** Read a file from a temp project. */
function read(dir, rel) { return fs.readFileSync(path.join(dir, rel), "utf8"); }

module.exports = { mkProject, rmProject, session, read, refactor };
