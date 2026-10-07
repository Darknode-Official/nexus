"use strict";
// ===================== Code Graph — Python parser =====================
// Covers .py. Python scope is indentation-based, so we track an indent stack to
// attach `def`s to their enclosing `class` (method vs. free function) and to know
// what is top-level. Runs on MASKED source so triple-quoted docstrings/strings and
// `#` comments never produce false `def`/`class`/`import` hits. Extracts functions,
// classes (+ bases), methods, imports (import / from-import, incl. relative and
// parenthesized multi-line forms) and exports (top-level public names + __all__).
const { mask, lineIndex, locAt } = require("../tokenizer");

const RE_DEF   = /^(\s*)(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/;
const RE_CLASS = /^(\s*)class\s+([A-Za-z_][\w]*)\s*(?:\(([^)]*)\))?\s*:/;
const RE_DECOR = /^\s*@/;

function indentOf(s) { const m = s.match(/^(\s*)/); let w = 0; for (const ch of m[1]) w += ch === "\t" ? 8 : 1; return w; }

function parseFile(source, opts) {
  opts = opts || {};
  const { masked } = mask(source, "python");
  const lines = masked.split("\n");
  const starts = lineIndex(masked);
  const symbols = [], imports = [], exports = [];
  // scope stack of { indent, kind, name } for every open class/def block, so a def
  // is a "method" only when its immediately enclosing scope is a class (a def
  // nested inside another def is a plain nested function).
  const stack = [];
  const topScope = () => (stack.length ? stack[stack.length - 1] : null);
  const allNames = new Set();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || RE_DECOR.test(line)) continue;
    const ind = indentOf(line);
    // pop scopes we've dedented out of
    while (stack.length && ind <= stack[stack.length - 1].indent) stack.pop();

    const cm = line.match(RE_CLASS);
    if (cm) {
      const col = line.indexOf("class") + 1;
      const encl = topScope();
      const parent = encl && encl.kind === "class" ? encl.name : null;
      symbols.push({ name: cm[2], kind: "class", line: i + 1, col, exported: isPublic(cm[2]) && !parent, parent, bases: splitBases(cm[3]) });
      stack.push({ indent: ind, kind: "class", name: cm[2] });
      continue;
    }
    const dm = line.match(RE_DEF);
    if (dm) {
      const col = line.indexOf("def") + 1;
      const encl = topScope();
      const parent = encl && encl.kind === "class" ? encl.name : null;
      symbols.push({ name: dm[2], kind: parent ? "method" : "function", line: i + 1, col, exported: isPublic(dm[2]) && !parent, parent, signature: line.trim().slice(0, 120) });
      stack.push({ indent: ind, kind: "def", name: dm[2] });
      continue;
    }
    // __all__ = ["a", "b"]  (names live in ORIGINAL source — read from there)
    if (/^\s*__all__\s*=/.test(line)) {
      const realBlock = grabList(source.split("\n"), i);
      for (const nm of realBlock) allNames.add(nm);
    }
    parseImportLine(source.split("\n"), lines, i, locAt.bind(null, starts), imports);
  }

  // Exports: explicit __all__ wins; else top-level public symbols.
  if (allNames.size) {
    for (const nm of allNames) exports.push({ name: nm, kind: "all", line: 0 });
    for (const s of symbols) s.exported = s.parent == null && allNames.has(s.name);
  } else {
    for (const s of symbols) if (s.parent == null && s.exported) exports.push({ name: s.name, kind: "public", line: s.line });
  }
  return { lang: "python", symbols, imports, exports };
}

function isPublic(name) { return !name.startsWith("_"); }
function splitBases(s) { return s ? s.split(",").map((x) => x.trim().split("=")[0].trim()).filter(Boolean) : []; }

// grabList(origLines, startIdx) -> string names inside a [...] possibly spanning lines.
function grabList(origLines, startIdx) {
  let text = origLines[startIdx] || "";
  let depth = (text.match(/\[/g) || []).length - (text.match(/\]/g) || []).length;
  let j = startIdx;
  while (depth > 0 && j + 1 < origLines.length) { j++; text += "\n" + origLines[j]; depth += (origLines[j].match(/\[/g) || []).length - (origLines[j].match(/\]/g) || []).length; }
  const out = []; let m; const re = /["']([^"']+)["']/g;
  while ((m = re.exec(text))) out.push(m[1]);
  return out;
}

// Handles `import a, b.c as d` and `from pkg import (a, b as c)` incl. relative.
function parseImportLine(origLines, maskedLines, i, loc, out) {
  const m = maskedLines[i];
  const impM = m.match(/^\s*import\s+(.+)$/);
  if (impM) {
    for (const part of impM[1].split(",")) {
      const p = part.trim(); if (!p) continue;
      const asM = p.match(/^([\w.]+)\s+as\s+([\w]+)$/);
      const mod = asM ? asM[1] : (p.match(/^([\w.]+)/) || [])[1];
      if (!mod) continue;
      out.push({ source: mod, kind: "import", line: i + 1, names: [], alias: asM ? asM[2] : undefined });
    }
    return;
  }
  const fromM = m.match(/^\s*from\s+([.\w]+)\s+import\s+(.+)$/);
  if (fromM) {
    let names = fromM[2];
    // multi-line parenthesized: accumulate from ORIGINAL lines for accuracy
    if (/\(/.test(names) && !/\)/.test(names)) {
      let j = i, depth = 1, acc = names.replace("(", "");
      while (depth > 0 && j + 1 < origLines.length) { j++; const l = origLines[j]; acc += " " + l; depth += (l.match(/\(/g) || []).length - (l.match(/\)/g) || []).length; }
      names = acc.replace(/\)/g, "");
    }
    names = names.replace(/[()]/g, "");
    const list = [];
    for (const part of names.split(",")) {
      const p = part.trim(); if (!p || p === "*") { if (p === "*") list.push({ imported: "*", local: "*" }); continue; }
      const asM = p.match(/^([\w]+)\s+as\s+([\w]+)$/);
      if (asM) list.push({ imported: asM[1], local: asM[2] });
      else { const id = p.match(/^([\w]+)/); if (id) list.push({ imported: id[1], local: id[1] }); }
    }
    out.push({ source: fromM[1], kind: "from", line: i + 1, names: list });
  }
}

module.exports = { parseFile, indentOf, splitBases };
