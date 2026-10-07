"use strict";
// ===================== Refactor — Organize / fix imports =====================
// Three deterministic passes over a file's imports:
//   1. remove unused — drop imported names that are never referenced in code; drop a
//      whole import statement when nothing it introduces is used (side-effect imports
//      `import 'x'` are kept).
//   2. add missing — for identifiers used but neither declared, imported nor global,
//      look them up in the project symbol table (codegraph). When exactly one file
//      exports the name, add an import for it (merged into an existing import from the
//      same module when present).
//   3. sort / group — reorder the leading import block into node-builtin, external and
//      relative groups, each sorted by module specifier, with a blank line between
//      groups. Only the contiguous leading import block is reordered (imports buried
//      in code are left in place), so execution order of side effects is preserved.
//
// Supports ESM `import` and CommonJS top-level `const x = require('y')`. Language
// coverage: JavaScript / TypeScript.

const path = require("path");
const u = require("./util");
const plan = require("./plan");
const { detectLang } = require("../codegraph/parse");
const { normalize } = require("../codegraph/depgraph");

const BUILTINS = new Set(require("module").builtinModules || []);

/**
 * @param {object} args
 * @param {string} args.file
 * @param {string} args.source
 * @param {Array<{file:string,source:string}>} [args.files] - project (for add-missing)
 * @param {object} [args.opts] - { removeUnused=true, addMissing=true, sort=true }
 * @returns {import('./plan').RefactorPlan}
 */
function planOrganizeImports(args) {
  const { file, source } = args;
  const opts = Object.assign({ removeUnused: true, addMissing: true, sort: true }, args.opts || {});
  const lang = detectLang(file);
  if (lang !== "javascript" && lang !== "typescript") return plan.refuse("organize-imports", ["organize-imports supports JS/TS only"]);

  const masked = u.maskJs(source);
  let imports = collectImports(source, u.maskJsSpecs(source));
  if (imports.length === 0 && !opts.addMissing) {
    return plan.refuse("organize-imports", ["no imports found"]);
  }

  // Usage counts outside import statements.
  const importRanges = imports.map((i) => [i.start, i.end]);
  const usedOutside = (name) => countUsage(source, masked, name, importRanges) > 0;

  const details = { removed: [], added: [], reordered: false };
  const edits = [];

  // ---- 1. remove unused ----
  if (opts.removeUnused) {
    for (const imp of imports) {
      if (imp.sideEffect) continue;
      const keptNames = (imp.names || []).filter((nm) => usedOutside(nm.local));
      const keepDefault = imp.default && usedOutside(imp.default);
      const keepNs = imp.namespace && usedOutside(imp.namespace);
      for (const nm of (imp.names || [])) if (!keptNames.includes(nm)) details.removed.push(nm.local);
      if (imp.default && !keepDefault) details.removed.push(imp.default);
      if (imp.namespace && !keepNs) details.removed.push(imp.namespace);
      imp._keep = { names: keptNames, default: keepDefault ? imp.default : null, namespace: keepNs ? imp.namespace : null };
      imp._empty = keptNames.length === 0 && !keepDefault && !keepNs;
    }
  } else {
    for (const imp of imports) imp._keep = { names: imp.names || [], default: imp.default || null, namespace: imp.namespace || null };
  }

  // ---- 2. add missing ----
  const additions = []; // {source, names:[{imported,local}]}
  if (opts.addMissing && args.files && args.files.length) {
    const idx = u.indexSources(args.files.map((f) => ({ file: f.file, source: f.source })));
    const declared = new Set();
    for (const b of u.findBindersAll(source)) declared.add(b);
    for (const imp of imports) {
      if (imp.default) declared.add(imp.default);
      if (imp.namespace) declared.add(imp.namespace);
      for (const nm of (imp.names || [])) declared.add(nm.local);
    }
    const missing = new Set();
    for (const id of u.identifiers(source, { masked })) {
      if (id.afterDot) continue;
      if (u.KEYWORDS.has(id.name) || u.GLOBALS.has(id.name)) continue;
      if (declared.has(id.name)) continue;
      if (inRange(id.offset, importRanges)) continue;
      missing.add(id.name);
    }
    const nf = normalize(file);
    for (const name of missing) {
      const hits = idx.symbol(name).filter((c) => c.symbol.parent == null && (c.symbol.exported || isExported(idx, c.file, name)) && normalize(c.file) !== nf);
      if (hits.length !== 1) continue;
      const spec = relSpec(nf, normalize(hits[0].file));
      additions.push({ source: spec, name });
      details.added.push(name + " from " + spec);
    }
  }

  // ---- Rebuild import text ----
  // Render kept imports + merge additions.
  const rendered = new Map(); // source spec -> {names:Set, default, namespace, sideEffect, style}
  const order = [];
  const ensure = (spec, style) => {
    if (!rendered.has(spec)) { rendered.set(spec, { names: [], default: null, namespace: null, sideEffect: false, style }); order.push(spec); }
    return rendered.get(spec);
  };
  for (const imp of imports) {
    if (imp.sideEffect) { const e = ensure(imp.source, imp.style); e.sideEffect = true; continue; }
    if (imp._empty) continue;
    const e = ensure(imp.source, imp.style);
    if (imp._keep.default) e.default = imp._keep.default;
    if (imp._keep.namespace) e.namespace = imp._keep.namespace;
    for (const nm of imp._keep.names) if (!e.names.some((x) => x.local === nm.local && x.imported === nm.imported)) e.names.push(nm);
  }
  const defaultStyle = imports.some((i) => i.style === "cjs") && !imports.some((i) => i.style === "esm") ? "cjs" : "esm";
  for (const add of additions) {
    const e = ensure(add.source, defaultStyle);
    if (!e.names.some((x) => x.local === add.name)) e.names.push({ imported: add.name, local: add.name });
  }

  // Which imports form the contiguous leading block (reorderable)?
  const leading = leadingBlock(imports, source, masked);
  const leadingSpecs = new Set(leading.map((i) => i.source));

  // Render statements.
  const statementsFor = (spec) => renderImport(spec, rendered.get(spec));
  let newLeadingText = "";
  if (opts.sort && leading.length) {
    const specs = [...new Set(leading.map((i) => i.source))].filter((s) => rendered.has(s) && (renderImport(s, rendered.get(s)) !== null || additions.some((a) => a.source === s)));
    // include additions whose source is relative/external in the leading block
    for (const a of additions) if (!specs.includes(a.source)) specs.push(a.source);
    const groups = groupSort(specs);
    details.reordered = true;
    const parts = [];
    for (const g of groups) {
      const lines = g.map(statementsFor).filter(Boolean);
      if (lines.length) parts.push(lines.join("\n"));
    }
    newLeadingText = parts.join("\n\n");
  }

  // Compose edits.
  if (opts.sort && leading.length) {
    // Replace the whole leading region with the sorted block.
    const regionStart = leading[0].start;
    const regionEnd = leading[leading.length - 1].end;
    edits.push({ start: regionStart, end: regionEnd, text: newLeadingText });
    // Non-leading imports: apply unused-removal in place.
    for (const imp of imports) {
      if (leadingSpecs.has(imp.source) && leading.includes(imp)) continue;
      applyInPlace(imp, edits, source);
    }
    // additions not in leading region are already included in newLeadingText.
  } else {
    // No sort: edit each import in place; append additions after last import.
    for (const imp of imports) applyInPlace(imp, edits, source);
    if (additions.length) {
      const insAt = imports.length ? imports[imports.length - 1].end : 0;
      const addLines = [];
      const addSpecs = [...new Set(additions.map((a) => a.source))];
      for (const s of addSpecs) { const line = renderImport(s, rendered.get(s)); if (line) addLines.push(line); }
      edits.push({ start: insAt, end: insAt, text: (insAt > 0 ? "" : "") + addLines.join("\n") + "\n" });
    }
  }

  // Nothing changed?
  let newContent;
  try { newContent = u.applyEdits(source, edits); }
  catch (e) { return plan.refuse("organize-imports", ["internal edit conflict: " + e.message]); }
  if (newContent === source) return plan.refuse("organize-imports", ["imports already organized; no changes needed"]);

  const nf = normalize(file);
  return {
    refactoring: "organize-imports",
    ok: true,
    safety: plan.safety(true, [], additions.length ? [] : []),
    edits: new Map([[nf, newContent]]),
    before: new Map([[nf, source]]),
    details,
  };
}

/** Apply unused-removal to a single import statement, editing in place. */
function applyInPlace(imp, edits, source) {
  if (imp.sideEffect) return;
  if (imp._empty) {
    let end = imp.end;
    while (end < source.length && (source[end] === "\n" || source[end] === "\r")) { end++; break; }
    edits.push({ start: imp.start, end, text: "" });
    return;
  }
  const line = renderImport(imp.source, { names: imp._keep.names, default: imp._keep.default, namespace: imp._keep.namespace, sideEffect: false, style: imp.style });
  if (line !== null && line !== source.slice(imp.start, imp.end)) edits.push({ start: imp.start, end: imp.end, text: line });
}

/** Collect ESM imports and CJS top-level requires with exact char ranges. */
function collectImports(source, masked) {
  const out = [];
  // ESM: import ... from 'x';  and  import 'x';
  let re = /\bimport\b[^;\n]*?from\s*(['"])([^'"]+)\1\s*;?/g;
  let m;
  while ((m = re.exec(masked))) {
    const text = source.slice(m.index, m.index + m[0].length);
    out.push(Object.assign(parseEsm(text), { start: m.index, end: m.index + m[0].length, source: m[2], style: "esm" }));
  }
  re = /\bimport\s*(['"])([^'"]+)\1\s*;?/g;
  while ((m = re.exec(masked))) {
    // skip if this offset is already part of a from-import
    if (out.some((o) => m.index >= o.start && m.index < o.end)) continue;
    out.push({ start: m.index, end: m.index + m[0].length, source: m[2], style: "esm", sideEffect: true, names: [] });
  }
  // CJS: const X = require('y');  const {a,b} = require('y');
  re = /\b(?:const|let|var)\s+(\{[^}]*\}|[A-Za-z_$][\w$]*)\s*=\s*require\(\s*(['"])([^'"]+)\2\s*\)\s*;?/g;
  while ((m = re.exec(masked))) {
    const text = source.slice(m.index, m.index + m[0].length);
    const rec = { start: m.index, end: m.index + m[0].length, source: m[3], style: "cjs", names: [] };
    if (m[1][0] === "{") rec.names = destructure(m[1]);
    else rec.default = m[1];
    out.push(Object.assign({ names: [] }, rec));
  }
  return out.sort((a, b) => a.start - b.start);
}

function parseEsm(text) {
  const res = { names: [], default: null, namespace: null, sideEffect: false };
  const clause = text.replace(/^\s*import\s*/, "").replace(/\s*from[\s\S]*$/, "");
  const brace = clause.match(/\{([^}]*)\}/);
  if (brace) res.names = destructure("{" + brace[1] + "}");
  const ns = clause.match(/\*\s*as\s+([A-Za-z_$][\w$]*)/);
  if (ns) res.namespace = ns[1];
  const head = clause.replace(/\{[^}]*\}/g, "").replace(/\*\s*as\s+[A-Za-z_$][\w$]*/g, "").replace(/,/g, " ").trim();
  const def = head.match(/^([A-Za-z_$][\w$]*)/);
  if (def) res.default = def[1];
  return res;
}

function destructure(brace) {
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

/** Render an import record back to a single statement, or null if nothing to emit. */
function renderImport(spec, rec) {
  if (!rec) return null;
  if (rec.sideEffect && !rec.default && !rec.namespace && (!rec.names || rec.names.length === 0)) {
    return rec.style === "cjs" ? "require('" + spec + "');" : "import '" + spec + "';";
  }
  const names = (rec.names || []).slice().sort((a, b) => a.imported.localeCompare(b.imported));
  if (rec.style === "cjs") {
    if (rec.default) return "const " + rec.default + " = require('" + spec + "');";
    if (names.length) {
      const inner = names.map((n) => (n.imported === n.local ? n.imported : n.imported + ": " + n.local)).join(", ");
      return "const { " + inner + " } = require('" + spec + "');";
    }
    return null;
  }
  const parts = [];
  if (rec.default) parts.push(rec.default);
  if (rec.namespace) parts.push("* as " + rec.namespace);
  if (names.length) parts.push("{ " + names.map((n) => (n.imported === n.local ? n.imported : n.imported + " as " + n.local)).join(", ") + " }");
  if (!parts.length) return null;
  return "import " + parts.join(", ") + " from '" + spec + "';";
}

/** Group specs into [builtins, external, relative], each sorted. */
function groupSort(specs) {
  const builtins = [], external = [], relative = [];
  for (const s of [...new Set(specs)]) {
    if (/^[./]/.test(s)) relative.push(s);
    else if (BUILTINS.has(s) || s.startsWith("node:") || BUILTINS.has(s.replace(/^node:/, ""))) builtins.push(s);
    else external.push(s);
  }
  const by = (a, b) => a.localeCompare(b);
  return [builtins.sort(by), external.sort(by), relative.sort(by)].filter((g) => g.length);
}

/** The contiguous leading import block (imports before the first real statement). */
function leadingBlock(imports, source, masked) {
  if (!imports.length) return [];
  const leading = [];
  for (const imp of imports) {
    const between = masked.slice(leading.length ? leading[leading.length - 1].end : 0, imp.start);
    // Only whitespace/comments allowed between leading imports.
    if (between.trim() === "") leading.push(imp);
    else break;
  }
  return leading;
}

function countUsage(source, masked, name, importRanges) {
  let count = 0;
  for (const o of u.occurrences(source, name, { masked })) {
    if (inRange(o.offset, importRanges)) continue;
    count++;
  }
  return count;
}

function inRange(offset, ranges) { return ranges.some((r) => offset >= r[0] && offset < r[1]); }

function isExported(idx, file, name) {
  const em = idx.symtab.exportsByFile.get(normalize(file));
  return !!(em && em.has(name));
}

/** Relative module specifier from file A to file B (extension stripped for JS). */
function relSpec(fromFile, toFile) {
  const dir = path.posix.dirname(fromFile);
  let rel = path.posix.relative(dir, toFile);
  rel = rel.replace(/\.(jsx?|tsx?|mjs|cjs|mts|cts)$/, "");
  rel = rel.replace(/\/index$/, "");
  if (!rel.startsWith(".")) rel = "./" + rel;
  return rel;
}

module.exports = { planOrganizeImports, collectImports, groupSort, relSpec, renderImport };
