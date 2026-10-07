"use strict";
// ===================== Refactor — Move symbol between files =====================
// Relocate a top-level function / class / const declaration from one module to
// another and repair the import/export graph on both sides:
//   * the declaration text is removed from the source file and appended to the
//     destination, rendered for the destination's module system (ESM `export` vs
//     CommonJS `module.exports`);
//   * every other file that imported the symbol from the old module is rewritten to
//     import it from the new one (splitting a multi-name import when needed);
//   * if the source file still references the symbol, an import from the new module
//     is added to it;
//   * if the moved declaration references other top-level symbols of the old module,
//     imports for them are added to the destination (and a warning is emitted if any
//     are not exported there).
//
// Applied as one atomic transaction. Honest limits: top-level named declarations in
// JS/TS only; default exports and re-export chains are refused.

const path = require("path");
const u = require("./util");
const plan = require("./plan");
const { detectLang } = require("../codegraph/parse");
const { normalize, resolveImport } = require("../codegraph/depgraph");
const { relSpec, renderImport } = require("./imports");

/**
 * @param {object} args
 * @param {Array<{file:string,source:string}>} args.files
 * @param {string} args.fromFile
 * @param {string} args.name
 * @param {string} args.toFile  - may be an existing file or a new one
 * @returns {import('./plan').RefactorPlan}
 */
function planMove(args) {
  const files = args.files || [];
  const fromFile = normalize(args.fromFile);
  const toFile = normalize(args.toFile);
  const name = args.name;
  if (fromFile === toFile) return plan.refuse("move", ["source and destination are the same file"]);

  const srcByFile = new Map(files.map((f) => [normalize(f.file), f.source]));
  const fromSource = srcByFile.get(fromFile);
  if (fromSource == null) return plan.refuse("move", ["source file '" + fromFile + "' not among the given files"]);
  if (detectLang(fromFile) !== "javascript" && detectLang(fromFile) !== "typescript") {
    return plan.refuse("move", ["move supports JS/TS only"]);
  }

  const idx = u.indexSources(files.map((f) => ({ file: f.file, source: f.source })));
  const known = new Set(idx.files.map((x) => normalize(x.file)));

  const decl = idx.symbol(name).find((c) => normalize(c.file) === fromFile && c.symbol.parent == null);
  if (!decl) return plan.refuse("move", ["top-level symbol '" + name + "' not found in " + fromFile]);
  if (name === "default") return plan.refuse("move", ["moving the default export is not supported"]);

  const fromMasked = u.maskJs(fromSource);
  const range = declRange(fromSource, fromMasked, decl.symbol);
  if (!range) return plan.refuse("move", ["could not determine the declaration range of '" + name + "'"]);
  let declText = fromSource.slice(range.start, range.end).replace(/\n+$/, "");

  const edits = new Map();
  const before = new Map();
  const warnings = [];

  // --- Source file: remove the declaration + any standalone export of it. ---
  let newFrom = fromSource.slice(0, range.start) + fromSource.slice(range.end);
  newFrom = stripExportsOf(newFrom, name);

  // Does the source file still use the symbol after removal?
  const stillUsed = u.occurrences(newFrom, name, {}).length > 0;

  // --- Destination module system + rendered declaration. ---
  const toSource = srcByFile.get(toFile) != null ? srcByFile.get(toFile) : "";
  const toSystem = moduleSystem(toSource) || moduleSystem(fromSource) || "esm";
  const renderedDecl = renderDecl(declText, name, toSystem);

  // --- Dependencies the moved decl pulls from the source module. ---
  const fromTopLevel = new Set((idx.symtab.defs.get(fromFile) || []).filter((s) => s.parent == null).map((s) => s.name));
  fromTopLevel.delete(name);
  const declRefs = new Set();
  for (const id of u.identifiers(declText, {})) {
    if (id.afterDot) continue;
    if (fromTopLevel.has(id.name)) declRefs.add(id.name);
  }
  const depImports = [];
  for (const dep of declRefs) {
    const sym = (idx.symtab.defs.get(fromFile) || []).find((s) => s.name === dep && s.parent == null);
    const exported = sym && (sym.exported || (idx.symtab.exportsByFile.get(fromFile) || new Map()).has(dep));
    if (!exported) warnings.push("'" + name + "' uses '" + dep + "' from " + fromFile + " which is not exported there; add `export`/`module.exports` for it");
    depImports.push(dep);
  }

  // --- Compose destination content. ---
  let newTo = toSource;
  const depSpec = relSpec(toFile, fromFile);
  if (depImports.length) newTo = addImport(newTo, toSystem, depSpec, depImports);
  newTo = newTo.replace(/\s*$/, "") + (newTo.trim() ? "\n\n" : "") + renderedDecl + "\n";

  // --- Source file: add an import of the symbol from destination if still used. ---
  if (stillUsed) {
    newFrom = addImport(newFrom, moduleSystem(fromSource) || "esm", relSpec(fromFile, toFile), [name]);
  }

  edits.set(fromFile, newFrom); before.set(fromFile, fromSource);
  edits.set(toFile, newTo); before.set(toFile, toSource);

  // --- Rewrite every other importer. ---
  for (const rec of idx.files) {
    const f = normalize(rec.file);
    if (f === fromFile || f === toFile) continue;
    const source = srcByFile.get(f);
    const r = rewriteImporter(rec, source, fromFile, toFile, name, known);
    if (r && r.text !== source) { edits.set(f, r.text); before.set(f, source); }
  }

  return {
    refactoring: "move",
    ok: true,
    safety: plan.safety(true, [], warnings),
    edits, before,
    details: { name, fromFile, toFile, toSystem, stillUsed, deps: depImports, importersRewritten: [...edits.keys()].filter((k) => k !== fromFile && k !== toFile) },
  };
}

/** Compute the full char range of a top-level declaration. */
function declRange(source, masked, symbol) {
  let start = lineStart(source, u.offsetOfLine(source, symbol.line));
  // include a leading `export ` on the same line
  const n = masked.length;
  // find first depth-0 `;` and first depth-0 `{` after start
  let depth = 0, brace = -1, semi = -1;
  for (let i = start; i < n; i++) {
    const c = masked[i];
    if ("([".includes(c)) depth++;
    else if (")]".includes(c)) depth--;
    else if (c === "{") { if (depth === 0 && brace === -1) brace = i; depth++; }
    else if (c === "}") depth--;
    else if (c === ";" && depth === 0) { semi = i; break; }
  }
  let end;
  if (brace !== -1 && (semi === -1 || brace < semi)) {
    const close = matchBrace(masked, brace);
    if (close < 0) return null;
    end = close + 1;
    // consume optional trailing `;`
    if (masked[end] === ";") end++;
  } else if (semi !== -1) {
    end = semi + 1;
  } else {
    end = n;
  }
  while (end < source.length && (source[end] === " " || source[end] === "\t")) end++;
  if (source[end] === "\n") end++;
  return { start, end };
}

/** Remove standalone exports of `name` (export { name }, module.exports.name=...). */
function stripExportsOf(source, name) {
  const masked = u.maskJs(source);
  const edits = [];
  // export { ..., name, ... }
  let re = /\bexport\s*\{([^}]*)\}\s*;?/g;
  let m;
  while ((m = re.exec(masked))) {
    const names = m[1].split(",").map((s) => s.trim()).filter(Boolean);
    const kept = names.filter((nm) => nm.split(/\s+as\s+/)[0].trim() !== name && nm !== name);
    if (kept.length === names.length) continue;
    const start = m.index, end = m.index + m[0].length;
    edits.push({ start, end, text: kept.length ? "export { " + kept.join(", ") + " };" : "" });
  }
  // module.exports.name = name;  /  exports.name = ...;
  re = new RegExp("\\b(?:module\\.)?exports\\." + escapeRe(name) + "\\s*=[^;\\n]*;?", "g");
  while ((m = re.exec(masked))) edits.push({ start: m.index, end: m.index + m[0].length, text: "" });
  if (!edits.length) return source;
  let out = u.applyEdits(source, edits);
  // collapse leftover blank lines from removed statements
  return out.replace(/\n[ \t]*\n[ \t]*\n/g, "\n\n");
}

/** Render a declaration for the destination module system. */
function renderDecl(declText, name, system) {
  let text = declText.trim();
  const hasExport = /^\s*export\b/.test(text);
  if (system === "cjs") {
    text = text.replace(/^\s*export\s+/, "");
    return text + "\nmodule.exports." + name + " = " + name + ";";
  }
  // esm
  if (hasExport) return text;
  return "export " + text;
}

/** Rewrite an importer that pulled `name` from fromFile to use toFile. */
function rewriteImporter(rec, source, fromFile, toFile, name, known) {
  const imp = (rec.imports || []).find((i) => resolveImport(normalize(rec.file), i.source, rec.lang, known) === fromFile && (i.names || []).some((nm) => nm.imported === name));
  if (!imp) return null;
  const masked = u.maskJsSpecs(source);
  const system = rec.lang === "javascript" || rec.lang === "typescript" ? (moduleSystem(source) || "esm") : "esm";
  const newSpec = relSpec(normalize(rec.file), toFile);
  const movedNm = imp.names.find((nm) => nm.imported === name);
  const others = imp.names.filter((nm) => nm.imported !== name);

  // Locate the import statement text range.
  const r = statementRangeFor(source, masked, imp, fromFile);
  if (!r) return null;

  let replacement;
  if (others.length === 0 && !imp.default && !imp.namespace) {
    // Only the moved name — just repoint the spec.
    replacement = renderImport(newSpec, { names: [movedNm], default: null, namespace: null, style: system });
  } else {
    // Keep others importing from fromFile; add a new import for the moved name.
    const keep = renderImport(imp.source, { names: others, default: imp.default || null, namespace: imp.namespace || null, style: system });
    const added = renderImport(newSpec, { names: [movedNm], default: null, namespace: null, style: system });
    replacement = (keep ? keep + "\n" : "") + added;
  }
  const text = source.slice(0, r.start) + replacement + source.slice(r.end);
  return { text };
}

function impSpecOf(imp) { return imp.source; }

/** Find the source-text range of a parsed import statement. */
function statementRangeFor(source, masked, imp, fromFile) {
  const spec = imp.source;
  const esc = escapeRe(spec);
  let re;
  if (imp.kind === "require") re = new RegExp("\\b(?:const|let|var)\\s+[^;]*?=\\s*require\\(\\s*['\"]" + esc + "['\"]\\s*\\)\\s*;?", "g");
  else re = new RegExp("\\bimport\\b[^;\\n]*?from\\s*['\"]" + esc + "['\"]\\s*;?", "g");
  let m;
  while ((m = re.exec(masked))) {
    return { start: m.index, end: m.index + m[0].length };
  }
  return null;
}

/** Add (or merge) an import of `names` from `spec` into a file. */
function addImport(source, system, spec, names) {
  const masked = u.maskJsSpecs(source);
  const esc = escapeRe(spec);
  // Merge into an existing import from the same spec.
  if (system === "cjs") {
    const re = new RegExp("\\b(?:const|let|var)\\s+\\{([^}]*)\\}\\s*=\\s*require\\(\\s*['\"]" + esc + "['\"]\\s*\\)\\s*;?", "g");
    const m = re.exec(masked);
    if (m) {
      const existing = m[1].split(",").map((s) => s.trim()).filter(Boolean);
      for (const n of names) if (!existing.includes(n)) existing.push(n);
      const text = "const { " + existing.join(", ") + " } = require('" + spec + "');";
      return source.slice(0, m.index) + text + source.slice(m.index + m[0].length);
    }
    const line = "const { " + names.join(", ") + " } = require('" + spec + "');\n";
    return insertAfterImports(source, masked, line);
  }
  const re = new RegExp("\\bimport\\s*\\{([^}]*)\\}\\s*from\\s*['\"]" + esc + "['\"]\\s*;?", "g");
  const m = re.exec(masked);
  if (m) {
    const existing = m[1].split(",").map((s) => s.trim()).filter(Boolean);
    for (const n of names) if (!existing.some((e) => e.split(/\s+as\s+/)[0].trim() === n)) existing.push(n);
    const text = "import { " + existing.join(", ") + " } from '" + spec + "';";
    return source.slice(0, m.index) + text + source.slice(m.index + m[0].length);
  }
  const line = "import { " + names.join(", ") + " } from '" + spec + "';\n";
  return insertAfterImports(source, masked, line);
}

/** Insert a line after the leading import block (or at file start). */
function insertAfterImports(source, masked, line) {
  let lastEnd = 0;
  const re = /\b(?:import\b[^;\n]*?from\s*['"][^'"]+['"]\s*;?|import\s*['"][^'"]+['"]\s*;?|(?:const|let|var)\s+[^;]*?=\s*require\([^)]*\)\s*;?)/g;
  let m;
  while ((m = re.exec(masked))) {
    const between = masked.slice(lastEnd, m.index).trim();
    if (lastEnd === 0 || between === "") lastEnd = m.index + m[0].length;
    else break;
  }
  if (lastEnd === 0) return line + source;
  // insert after the newline following lastEnd
  let p = lastEnd;
  if (source[p] === "\n") p++;
  return source.slice(0, p) + line + source.slice(p);
}

function moduleSystem(source) {
  if (!source) return null;
  const masked = u.maskJs(source);
  if (/\b(?:import\b[^;\n]*?from|export\s+(?:default|const|function|class|\{))/.test(masked)) return "esm";
  if (/\brequire\s*\(|module\.exports|\bexports\./.test(masked)) return "cjs";
  return null;
}

function lineStart(s, i) { while (i > 0 && s[i - 1] !== "\n") i--; return i; }
function matchBrace(masked, open) {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === "{") depth++;
    else if (masked[i] === "}") { depth--; if (depth === 0) return i; }
  }
  return -1;
}
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

module.exports = { planMove };
