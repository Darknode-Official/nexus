"use strict";
// ===================== Code Graph — JavaScript / TypeScript parser =====================
// Covers .js .jsx .mjs .cjs .ts .tsx. Extracts functions (declarations, arrow and
// function-expression consts, generators, async), classes (+ extends), class
// methods (via real brace-scope tracking so only genuine members are reported),
// imports (ESM + CommonJS require + dynamic import) and exports (named, default,
// re-export, module.exports). All scanning runs on the MASKED source from the
// tokenizer, so keywords inside strings/comments are never misread, and every
// offset maps back to an exact line/column. Heuristic but scope-aware — not a
// toy regex: methods are confirmed against the class block they live in.
const { mask, lineIndex, locAt } = require("../tokenizer");
const { scanBlocks, walkBlocks } = require("../blocks");

// Identifiers that look like a method call `kw(` but are control flow, not members.
const NON_METHODS = new Set([
  "if", "for", "while", "switch", "catch", "return", "function", "typeof", "do",
  "else", "await", "yield", "new", "delete", "void", "in", "of", "case", "with",
]);

function reExec(re, text, fn) { let m; re.lastIndex = 0; while ((m = re.exec(text))) fn(m); }

// ---- Declaration patterns (run on masked source) ----
const RE_FUNC  = /(?:^|[^.\w$])(export\s+)?(?:default\s+)?(?:(async)\s+)?function\s*(\*)?\s*([A-Za-z_$][\w$]*)/g;
const RE_ARROW = /(?:^|[^.\w$])(export\s+)?(?:default\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*(?::\s*[^=;{]+)?=>/g;
const RE_FNEXP = /(?:^|[^.\w$])(export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function\b/g;
const RE_CLASS = /(?:^|[^.\w$])(export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)(?:\s+extends\s+([A-Za-z_$][\w$.]*))?/g;
// Class-member signature at the head of a class-body block.
const RE_METHOD = /^(?:(?:public|private|protected|static|readonly|abstract|override|async|get|set)\s+)*\*?\s*(#?[A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/;

function parseFile(source, opts) {
  opts = opts || {};
  const { masked } = mask(source, "javascript");
  const starts = lineIndex(masked);
  const loc = (off) => locAt(starts, off);
  const symbols = [], imports = [], exports = [];
  const seen = new Set(); // dedupe name@line
  const add = (name, kind, off, extra) => {
    const { line, col } = loc(off);
    const key = kind + ":" + name + ":" + line + ":" + (extra && extra.parent || "");
    if (seen.has(key)) return;
    seen.add(key);
    symbols.push(Object.assign({ name, kind, line, col, exported: false, parent: null, signature: "" }, extra));
  };

  // Functions, arrows, function-expressions.
  reExec(RE_FUNC, masked, (m) => {
    const off = m.index + m[0].indexOf("function");
    add(m[4], "function", off, { exported: !!m[1], async: !!m[2], generator: !!m[3] });
  });
  reExec(RE_ARROW, masked, (m) => add(m[2], "function", m.index + m[0].search(/const|let|var/), { exported: !!m[1] }));
  reExec(RE_FNEXP, masked, (m) => add(m[2], "function", m.index + m[0].search(/const|let|var/), { exported: !!m[1] }));

  // Classes + their methods (scope-aware via brace blocks).
  const classBlocks = [];
  const root = scanBlocks(masked);
  reExec(RE_CLASS, masked, (m) => {
    const off = m.index + m[0].indexOf("class");
    add(m[2], "class", off, { exported: !!m[1], extends: m[3] || null });
  });
  walkBlocks(root, (b) => { if (/(?:^|[^.\w$])class\s+[A-Za-z_$]/.test(b.header)) classBlocks.push(b); });
  for (const cb of classBlocks) {
    const cname = (cb.header.match(/class\s+([A-Za-z_$][\w$]*)/) || [])[1] || null;
    for (const member of cb.children) {
      const mm = member.header.match(RE_METHOD);
      if (!mm) continue;
      const name = mm[1];
      if (NON_METHODS.has(name)) continue;
      add(name, name === "constructor" ? "method" : "method", member.headerStart + member.header.indexOf(name === "constructor" ? "constructor" : name.replace(/^#/, "")) , { parent: cname, signature: member.header.slice(0, 120) });
    }
  }

  // Imports/exports are scanned on a comments-only mask so module specifiers
  // (which are string literals) survive; offsets stay aligned with `masked`.
  const specMask = mask(source, "javascript", { keepStrings: true }).masked;
  parseImports(specMask, loc, imports);
  parseExports(specMask, loc, exports);
  // propagate exported flag from `export {name}` statements onto symbols
  const exportedNames = new Set(exports.filter((e) => e.kind !== "reexport-all").map((e) => e.name));
  for (const s of symbols) if (exportedNames.has(s.name) && s.parent == null) s.exported = true;
  return { lang: "javascript", symbols, imports, exports };
}

// ---- Imports ----
function parseImports(masked, loc, out) {
  // ESM: import ... from "x"  /  import "x"
  reExec(/\bimport\b([^;'"]*?)\bfrom\s*["']([^"']+)["']/g, masked, (m) => {
    out.push(Object.assign({ source: m[2], kind: "import", line: loc(m.index).line }, parseImportClause(m[1])));
  });
  reExec(/\bimport\s*["']([^"']+)["']/g, masked, (m) => {
    out.push({ source: m[1], kind: "import", line: loc(m.index).line, names: [], sideEffect: true });
  });
  // dynamic import("x")
  reExec(/\bimport\(\s*["']([^"']+)["']\s*\)/g, masked, (m) => {
    out.push({ source: m[1], kind: "dynamic", line: loc(m.index).line, names: [] });
  });
  // CommonJS: const X = require("y") / const {a,b} = require("y")
  reExec(/(?:const|let|var)\s+(\{[^}]*\}|[A-Za-z_$][\w$]*)\s*=\s*require\(\s*["']([^"']+)["']\s*\)/g, masked, (m) => {
    const rec = { source: m[2], kind: "require", line: loc(m.index).line, names: [] };
    if (m[1][0] === "{") rec.names = destructureNames(m[1]);
    else rec.default = m[1];
    out.push(rec);
  });
  // bare require("y") (side effect)
  reExec(/(?:^|[^.\w$])require\(\s*["']([^"']+)["']\s*\)/g, masked, (m) => {
    if (!out.some((o) => o.source === m[1] && o.line === loc(m.index).line)) out.push({ source: m[1], kind: "require", line: loc(m.index).line, names: [], sideEffect: true });
  });
}

// parseImportClause(" defaultName, { a, b as c }, * as ns ") -> {names,default,namespace}
function parseImportClause(clause) {
  const res = { names: [] };
  const brace = clause.match(/\{([^}]*)\}/);
  if (brace) res.names = destructureNames("{" + brace[1] + "}");
  const ns = clause.match(/\*\s*as\s+([A-Za-z_$][\w$]*)/);
  if (ns) res.namespace = ns[1];
  // default import = first bare identifier before a comma/brace
  const head = clause.replace(/\{[^}]*\}/g, "").replace(/\*\s*as\s+[A-Za-z_$][\w$]*/g, "").replace(/,/g, " ").trim();
  const def = head.match(/^([A-Za-z_$][\w$]*)/);
  if (def) res.default = def[1];
  return res;
}

// destructureNames("{ a, b as c, default: d }") -> [{imported, local}]
function destructureNames(brace) {
  const inner = brace.replace(/^\{|\}$/g, "");
  const out = [];
  for (let part of inner.split(",")) {
    part = part.trim(); if (!part) continue;
    const asM = part.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
    const colonM = part.match(/^([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)$/);
    if (asM) out.push({ imported: asM[1], local: asM[2] });
    else if (colonM) out.push({ imported: colonM[1], local: colonM[2] });
    else { const id = part.match(/^([A-Za-z_$][\w$]*)/); if (id) out.push({ imported: id[1], local: id[1] }); }
  }
  return out;
}

// ---- Exports ----
function parseExports(masked, loc, out) {
  // export { a, b as c } [from "x"]
  reExec(/\bexport\s*\{([^}]*)\}\s*(?:from\s*["']([^"']+)["'])?/g, masked, (m) => {
    const src = m[2] || undefined;
    for (const part of m[1].split(",")) {
      const p = part.trim(); if (!p) continue;
      const asM = p.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
      if (asM) out.push({ name: asM[2], local: asM[1], line: loc(m.index).line, kind: src ? "reexport" : "named", source: src });
      else { const id = p.match(/^([A-Za-z_$][\w$]*)/); if (id) out.push({ name: id[1], local: id[1], line: loc(m.index).line, kind: src ? "reexport" : "named", source: src }); }
    }
  });
  // export * [as ns] from "x"
  reExec(/\bexport\s*\*\s*(?:as\s+([A-Za-z_$][\w$]*)\s+)?from\s*["']([^"']+)["']/g, masked, (m) => {
    out.push({ name: m[1] || "*", line: loc(m.index).line, kind: "reexport-all", source: m[2] });
  });
  // export default <expr>
  reExec(/\bexport\s+default\b/g, masked, (m) => out.push({ name: "default", line: loc(m.index).line, kind: "default" }));
  // export const/function/class name  (name captured elsewhere; record export entry)
  reExec(/\bexport\s+(?:async\s+)?(?:const|let|var|function\s*\*?|class)\s+([A-Za-z_$][\w$]*)/g, masked, (m) => {
    out.push({ name: m[1], local: m[1], line: loc(m.index).line, kind: "named" });
  });
  // CommonJS: module.exports.name = / exports.name =
  reExec(/\b(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/g, masked, (m) => out.push({ name: m[1], line: loc(m.index).line, kind: "cjs" }));
  // module.exports = { a, b } — record each key
  reExec(/\bmodule\.exports\s*=\s*\{([^}]*)\}/g, masked, (m) => {
    for (const part of m[1].split(",")) {
      const id = part.trim().match(/^([A-Za-z_$][\w$]*)/);
      if (id) out.push({ name: id[1], line: loc(m.index).line, kind: "cjs" });
    }
  });
  return out;
}

module.exports = { parseFile, parseImports, parseExports, parseImportClause, destructureNames };
