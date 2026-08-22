"use strict";
// Codebase overview: files, lines, and bytes by language, plus the largest files.
// Gives the agent (and you) situational awareness of a project at a glance.
// summarizeStats is pure; scanStats walks the tree. Both are unit-tested.
const fs = require("fs"), path = require("path");

const LANGS = {
  js: "JavaScript", jsx: "JavaScript", mjs: "JavaScript", cjs: "JavaScript",
  ts: "TypeScript", tsx: "TypeScript", py: "Python", rb: "Ruby", go: "Go",
  rs: "Rust", java: "Java", c: "C", h: "C", cpp: "C++", cc: "C++", hpp: "C++",
  cs: "C#", php: "PHP", swift: "Swift", kt: "Kotlin", sh: "Shell", bash: "Shell",
  css: "CSS", scss: "SCSS", html: "HTML", vue: "Vue", json: "JSON", md: "Markdown",
  yml: "YAML", yaml: "YAML", toml: "TOML", sql: "SQL",
};
const SKIP = /(^|\/)(\.git|node_modules|\.nexus|dist|build|\.cache|\.next|target|__pycache__|vendor)(\/|$)/;

function langOf(file) {
  const ext = (String(file == null ? "" : file).match(/\.([a-z0-9]+)$/i) || [])[1];
  return ext ? (LANGS[ext.toLowerCase()] || null) : null;
}

// summarizeStats(entries) — entries: [{ file, lines, bytes, lang }] -> aggregates.
function summarizeStats(entries) {
  const s = { totalFiles: 0, totalLines: 0, totalBytes: 0, byLang: {}, largest: [] };
  for (const e of entries) {
    if (!e.lang) continue;
    s.totalFiles++; s.totalLines += e.lines || 0; s.totalBytes += e.bytes || 0;
    const b = s.byLang[e.lang] || (s.byLang[e.lang] = { files: 0, lines: 0, bytes: 0 });
    b.files++; b.lines += e.lines || 0; b.bytes += e.bytes || 0;
  }
  s.largest = entries.filter((e) => e.lang).slice()
    .sort((a, b) => (b.lines - a.lines) || a.file.localeCompare(b.file))
    .slice(0, 8).map((e) => ({ file: e.file, lines: e.lines }));
  return s;
}

// rankedLangs(summary) -> [[lang, {files,lines,bytes}], …] biggest by lines first.
function rankedLangs(s) {
  return Object.keys(s.byLang).map((k) => [k, s.byLang[k]]).sort((a, b) => (b[1].lines - a[1].lines) || (b[1].files - a[1].files));
}

// scanStats(cwd, opts) -> entries[]. Skips vendored/build dirs, source files only.
function scanStats(cwd, opts) {
  opts = opts || {};
  const maxFiles = opts.maxFiles || 12000, maxBytes = opts.maxBytes || 2000000;
  const entries = [];
  const walk = (d) => {
    if (entries.length >= maxFiles) return;
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      if (entries.length >= maxFiles) return;
      const fp = path.join(d, e.name);
      if (SKIP.test(fp)) continue;
      if (e.isDirectory()) walk(fp);
      else { const lang = langOf(e.name); if (!lang) continue; try { const st = fs.statSync(fp); if (st.size > maxBytes) continue; const txt = fs.readFileSync(fp, "utf8"); entries.push({ file: path.relative(cwd, fp), lines: txt.length ? txt.split("\n").length : 0, bytes: st.size, lang }); } catch (_) {} }
    }
  };
  walk(cwd);
  return entries;
}

module.exports = { LANGS, langOf, summarizeStats, rankedLangs, scanStats };
