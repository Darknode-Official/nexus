"use strict";
// Tech-debt marker scanner. Finds TODO / FIXME / HACK / BUG / etc. annotations in
// source so they can be reviewed or handed to the agent to fix. scanText is pure
// (one file's text); scanTree walks a project. Both are unit-tested.
const fs = require("fs"), path = require("path");

// Rough severity order (most urgent first) — also the display/rank order.
const TAGS = ["FIXME", "BUG", "XXX", "HACK", "TODO", "OPTIMIZE", "DEPRECATED", "NOTE"];
const MARKER_RE = new RegExp("\\b(" + TAGS.join("|") + ")\\b[:\\-\\s]+(.*)");
const SKIP = /(^|\/)(\.git|node_modules|\.nexus|dist|build|\.cache|\.next|target|__pycache__)(\/|$)/;
const CODE = /\.(js|jsx|ts|tsx|py|rb|go|rs|java|c|h|cpp|cc|cs|php|swift|kt|sh|css|scss|html|json|md|yml|yaml|toml)$/i;

// scanText(text, file) -> [{ file, line, tag, text }]
function scanText(text, file) {
  const out = [];
  const lines = String(text == null ? "" : text).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(MARKER_RE);
    if (m) out.push({ file: file || "", line: i + 1, tag: m[1], text: (m[2] || "").trim().slice(0, 160) });
  }
  return out;
}

// summarizeTodos(items) -> { total, byTag, files }
function summarizeTodos(items) {
  const s = { total: items.length, byTag: {}, files: 0 };
  const seen = new Set();
  for (const it of items) { s.byTag[it.tag] = (s.byTag[it.tag] || 0) + 1; seen.add(it.file); }
  s.files = seen.size;
  return s;
}

// rankTodos(items) -> items sorted by tag severity, then file, then line
function rankTodos(items) {
  const order = {}; TAGS.forEach((t, i) => (order[t] = i));
  return items.slice().sort((a, b) => (order[a.tag] - order[b.tag]) || a.file.localeCompare(b.file) || (a.line - b.line));
}

// scanTree(cwd, opts) -> { items, files }. Walks cwd, skipping vendored/build dirs
// and binaries, scanning only source files up to opts.maxBytes (default 400 KB).
function scanTree(cwd, opts) {
  opts = opts || {};
  const maxItems = opts.maxItems || 2000, maxFiles = opts.maxFiles || 8000, maxBytes = opts.maxBytes || 400000;
  const items = []; let files = 0;
  const walk = (d) => {
    if (items.length >= maxItems || files >= maxFiles) return;
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      if (items.length >= maxItems || files >= maxFiles) return;
      const fp = path.join(d, e.name);
      if (SKIP.test(fp)) continue;
      if (e.isDirectory()) walk(fp);
      else if (CODE.test(e.name)) {
        try { if (fs.statSync(fp).size > maxBytes) continue; files++; for (const it of scanText(fs.readFileSync(fp, "utf8"), path.relative(cwd, fp))) { if (items.length >= maxItems) break; items.push(it); } } catch (_) {}
      }
    }
  };
  walk(cwd);
  return { items, files };
}

module.exports = { TAGS, MARKER_RE, scanText, summarizeTodos, rankTodos, scanTree };
