"use strict";
// Environment-variable hygiene. Scans source for process.env references and
// cross-references them with .env.example (and friends) to surface:
//   • used-but-undocumented  vars used in code but not in any .env template
//     (an onboarding gap and a place secrets get missed / hard-coded)
//   • documented-but-unused  keys in a template no code reads (stale config)
// scanEnvRefs / parseEnvFile / auditEnv are pure + unit-tested; the tree/file
// walkers do I/O.
const fs = require("fs"), path = require("path");

const CODE = /\.(js|jsx|ts|tsx|mjs|cjs|py|rb|go|sh|bash)$/i;
const SKIP = /(^|\/)(\.git|node_modules|\.nexus|dist|build|\.cache|\.next|target|__pycache__|vendor)(\/|$)/;
// process.env.NAME  |  process.env["NAME"] / ['NAME']  |  os.environ.get("NAME") (python)
const REF_RE = /process\.env\.([A-Za-z_][A-Za-z0-9_]*)|process\.env\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\]|os\.environ(?:\.get)?\(?\s*\[?\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/g;
// Framework/runtime conventions that don't belong in a project's .env.example.
const COMMON = new Set(["NODE_ENV", "PORT", "HOST", "HOME", "PATH", "PWD", "USER", "SHELL", "LANG", "TERM", "TMPDIR", "CI", "DEBUG", "NODE_OPTIONS", "TZ"]);
const ENV_FILES = [".env.example", ".env.sample", ".env.template", ".env.defaults", ".env.dist", ".env"];

// scanEnvRefs(text) -> [names] referenced in this file.
function scanEnvRefs(text) {
  const out = new Set(); text = String(text == null ? "" : text); REF_RE.lastIndex = 0;
  let m; while ((m = REF_RE.exec(text))) out.add(m[1] || m[2] || m[3]);
  return [...out];
}

// parseEnvFile(text) -> declared keys (KEY=…, honoring `export`, skipping comments).
function parseEnvFile(text) {
  const out = [];
  for (const line of String(text == null ? "" : text).split("\n")) {
    const t = line.trim(); if (!t || t[0] === "#") continue;
    const m = t.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m) out.push(m[1]);
  }
  return out;
}

// auditEnv({ used, declared, ignoreCommon }) -> { used, declared, undocumented, unused }
function auditEnv(o) {
  o = o || {};
  const used = [...new Set(o.used || [])].sort();
  const declared = [...new Set(o.declared || [])].sort();
  const ds = new Set(declared), us = new Set(used);
  const ignore = o.ignoreCommon === false ? new Set() : COMMON;
  return {
    used, declared,
    undocumented: used.filter((u) => !ds.has(u) && !ignore.has(u)),
    unused: declared.filter((d) => !us.has(d)),
  };
}

// readEnvFiles(cwd) -> { declared, files } from the first-class .env templates present.
function readEnvFiles(cwd) {
  const declared = new Set(), files = [];
  for (const f of ENV_FILES) {
    try { const t = fs.readFileSync(path.join(cwd, f), "utf8"); for (const k of parseEnvFile(t)) declared.add(k); files.push(f); } catch (_) {}
  }
  return { declared: [...declared], files };
}

// scanEnvTree(cwd, opts) -> { used, files } from source files.
function scanEnvTree(cwd, opts) {
  opts = opts || {};
  const maxFiles = opts.maxFiles || 8000, maxBytes = opts.maxBytes || 1000000;
  const set = new Set(); let files = 0;
  const walk = (d) => {
    if (files >= maxFiles) return;
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      if (files >= maxFiles) return;
      const fp = path.join(d, e.name);
      if (SKIP.test(fp)) continue;
      if (e.isDirectory()) walk(fp);
      else if (CODE.test(e.name)) { try { if (fs.statSync(fp).size > maxBytes) continue; files++; for (const n of scanEnvRefs(fs.readFileSync(fp, "utf8"))) set.add(n); } catch (_) {} }
    }
  };
  walk(cwd);
  return { used: [...set], files };
}

module.exports = { COMMON, scanEnvRefs, parseEnvFile, auditEnv, readEnvFiles, scanEnvTree };
