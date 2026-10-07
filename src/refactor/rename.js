"use strict";
// ===================== Refactor — Rename symbol across files =====================
// Scope-aware, cross-file rename of a top-level function / class / const / let / var
// (and, within its own file, a class method). Built on the codegraph symbol table
// (to find which files import the symbol and under what local name) and the patch
// Transaction engine (to apply every file atomically with rollback).
//
// Scope-awareness: within the declaring file we never touch an occurrence that is
// shadowed by an inner binder of the same name (a nested const/param/function), and
// we never touch an unrelated same-named symbol in another file that does NOT import
// ours. Cross-file, we follow real import bindings: direct imports are renamed in
// place, aliased imports (`import {old as a}`) have only the imported side renamed,
// and namespace/default-object imports have their `ns.old` member accesses renamed.
//
// Language coverage: JavaScript / TypeScript. Other languages are refused honestly.

const u = require("./util");
const plan = require("./plan");
const { detectLang } = require("../codegraph/parse");

/**
 * Plan a rename.
 * @param {object} args
 * @param {Array<{file:string, source:string}>} args.files - the project files
 * @param {string} args.oldName
 * @param {string} args.newName
 * @param {string} [args.file] - declaring file (disambiguates same-named symbols)
 * @param {number} [args.line] - declaration line (disambiguates overloads)
 * @param {boolean} [args.force] - proceed past soft warnings (e.g. method rename)
 * @returns {import('./plan').RefactorPlan}
 */
function planRename(args) {
  const { oldName, newName } = args;
  const files = args.files || [];

  if (!u.isValidIdentifier(newName)) {
    return plan.refuse("rename", ["'" + newName + "' is not a valid identifier"]);
  }
  if (oldName === newName) {
    return plan.refuse("rename", ["old and new names are identical"]);
  }
  for (const f of files) {
    if (detectLang(f.file) !== "javascript" && detectLang(f.file) !== "typescript") {
      // Mixed projects are fine; only JS/TS files participate. A non-JS declaring
      // file is refused below.
    }
  }

  const idx = u.indexSources(files.map((f) => ({ file: f.file, source: f.source })));
  const srcByFile = new Map(files.map((f) => [norm(f.file), f.source]));

  // Locate the declaration.
  const candidates = idx.symbol(oldName).filter((c) => c.symbol.parent == null);
  let decl = pickDeclaration(candidates, args);
  if (!decl) {
    // Maybe it's a method (parent != null).
    const methods = idx.symbol(oldName).filter((c) => c.symbol.parent != null);
    if (methods.length && (args.file || args.line)) {
      return planMethodRename(args, idx, srcByFile, methods);
    }
    // Fallback: codegraph indexes functions/classes/methods but not plain
    // variable declarations, so locate a module-scope binder directly.
    decl = findVariableDeclaration(files, srcByFile, oldName, args);
    if (!decl && methods.length) {
      return plan.refuse("rename", [
        "'" + oldName + "' resolves to a class method; cross-file method rename is unsafe (dynamic dispatch). Pass {file,line} to rename it within its class only.",
      ]);
    }
    if (!decl) return plan.refuse("rename", ["symbol '" + oldName + "' not found among the given files"]);
  }

  const declFile = norm(decl.file);
  const declLang = detectLang(declFile);
  if (declLang !== "javascript" && declLang !== "typescript") {
    return plan.refuse("rename", ["declaring file is " + declLang + "; only JS/TS rename is supported"]);
  }

  const edits = new Map();   // file -> new content
  const before = new Map();  // file -> original content
  const warnings = [];
  const touched = [];

  // --- 1. The declaring file: scope-aware whole-word rename. ---
  const declSource = srcByFile.get(declFile);
  const declRes = renameInDeclaringFile(declSource, oldName, newName, decl.symbol);
  if (!declRes.ok) return plan.refuse("rename", declRes.reasons);
  if (declRes.count > 0) {
    edits.set(declFile, declRes.text);
    before.set(declFile, declSource);
    touched.push({ file: declFile, occurrences: declRes.count, role: "declaration" });
  }

  // --- 2. Every other file that imports the symbol from declFile. ---
  for (const rec of idx.files) {
    const f = norm(rec.file);
    if (f === declFile) continue;
    const source = srcByFile.get(f);
    if (source == null) continue;
    const r = renameImporter(rec, source, declFile, oldName, newName, idx);
    if (r.collision) {
      return plan.refuse("rename", [
        "name collision: '" + newName + "' already exists in " + f + " where '" + oldName + "' is used",
      ]);
    }
    if (r.count > 0) {
      edits.set(f, r.text);
      before.set(f, source);
      touched.push({ file: f, occurrences: r.count, role: r.role });
    }
    for (const w of r.warnings) warnings.push(w);
  }

  // Collision check in the declaring file itself.
  if (declRes.collision) {
    return plan.refuse("rename", ["name collision: '" + newName + "' already declared in " + declFile]);
  }

  if (edits.size === 0) {
    return plan.refuse("rename", ["no occurrences of '" + oldName + "' found to rename"]);
  }

  return {
    refactoring: "rename",
    ok: true,
    safety: plan.safety(true, [], warnings),
    edits, before,
    details: { oldName, newName, declFile, files: touched },
  };
}

/** Locate a module-scope variable declaration not tracked by codegraph. */
function findVariableDeclaration(files, srcByFile, oldName, args) {
  const hits = [];
  for (const f of files) {
    const nf = norm(f.file);
    if (args.file && nf !== norm(args.file)) continue;
    if (detectLang(f.file) !== "javascript" && detectLang(f.file) !== "typescript") continue;
    const binders = u.findBinders(f.source, oldName).filter((b) => b.range[0] === 0); // module scope
    if (binders.length) hits.push({ file: nf, binder: binders[0] });
  }
  if (!hits.length) return null;
  if (hits.length > 1 && !args.file) return null; // ambiguous; require {file}
  const hit = hits[0];
  const { line, col } = u.locOf(srcByFile.get(hit.file), hit.binder.offset);
  return { file: hit.file, symbol: { name: oldName, line, col, parent: null, exported: false } };
}

/** Choose the declaration from candidates using file/line hints. */
function pickDeclaration(candidates, args) {
  if (!candidates.length) return null;
  let pool = candidates;
  if (args.file) pool = pool.filter((c) => norm(c.file) === norm(args.file));
  if (args.line) {
    const exact = pool.filter((c) => c.symbol.line === args.line);
    if (exact.length) pool = exact;
  }
  if (pool.length === 1) return pool[0];
  if (pool.length > 1 && !args.line) return null; // ambiguous -> caller must disambiguate
  return pool[0] || null;
}

/**
 * Scope-aware set of offsets of `oldName` governed by a chosen target binder:
 * occurrences inside the target's scope, minus ranges governed by nested binders of
 * the same name (shadows). `chooseTarget(binders)` selects which binder is the one
 * being renamed.
 * @returns {{offsets:number[], target:object|null}}
 */
function scopeAwareOffsets(source, oldName, masked, chooseTarget) {
  masked = masked || u.maskJs(source);
  const binders = u.findBinders(source, oldName);
  if (!binders.length) {
    return { offsets: u.occurrences(source, oldName, { masked }).map((o) => o.offset), target: null };
  }
  const target = chooseTarget(binders);
  if (!target) return { offsets: [], target: null };
  const [ts, te] = target.range;
  const holes = binders
    .filter((b) => b !== target && b.range[0] >= ts && b.range[1] <= te && !(b.range[0] === ts && b.range[1] === te))
    .map((b) => b.range);
  const offsets = [];
  for (const o of u.occurrences(source, oldName, { masked })) {
    if (o.offset < ts || o.offset >= te) continue;
    if (holes.some((h) => o.offset >= h[0] && o.offset < h[1])) continue;
    offsets.push(o.offset);
  }
  return { offsets, target };
}

/**
 * Rename within the declaring file, skipping occurrences shadowed by inner binders
 * of the same name. Returns the new text and the count of renamed occurrences.
 */
function renameInDeclaringFile(source, oldName, newName, declSymbol) {
  const masked = u.maskJs(source);
  const collision = u.findBinders(source, newName).length > 0;
  const declOffset = u.offsetOfLine(source, declSymbol.line) + Math.max(0, (declSymbol.col || 1) - 1);
  const { offsets } = scopeAwareOffsets(source, oldName, masked, (binders) => {
    let target = null;
    for (const b of binders) if (!target || Math.abs(b.offset - declOffset) < Math.abs(target.offset - declOffset)) target = b;
    return target;
  });
  const text = replaceAt(source, offsets, oldName, newName);
  return { ok: true, count: offsets.length, text, collision };
}

/** Pick the module-scope binder (governs the whole file), else the outermost one. */
function moduleScopeTarget(binders) {
  const mod = binders.filter((b) => b.range[0] === 0);
  if (mod.length) return mod.reduce((a, b) => (b.range[1] > a.range[1] ? b : a));
  // widest range = outermost
  return binders.reduce((a, b) => ((b.range[1] - b.range[0]) > (a.range[1] - a.range[0]) ? b : a));
}

/**
 * Rename usages in a file that IMPORTS the symbol from declFile. Handles direct,
 * aliased and namespace/default-object imports. Returns new text + count.
 */
function renameImporter(rec, source, declFile, oldName, newName, idx) {
  const warnings = [];
  const masked = u.maskJs(source);
  // Which imports in this file point at declFile and reference oldName?
  const resolve = (spec) => {
    const { resolveImport, normalize } = require("../codegraph/depgraph");
    const known = new Set(idx.files.map((x) => normalize(x.file)));
    return resolveImport(normalize(rec.file), spec, rec.lang, known);
  };

  let direct = null;      // import { oldName } (local === imported === oldName)
  let aliased = null;     // import { oldName as alias }
  const nsVars = [];      // namespace/default-object local names bound to declFile
  for (const imp of (rec.imports || [])) {
    if (resolve(imp.source) !== declFile) continue;
    for (const nm of (imp.names || [])) {
      if (nm.imported === oldName) {
        if (nm.local === oldName) direct = nm;
        else aliased = nm;
      }
    }
    if (imp.default) nsVars.push(imp.default);      // CJS `const ns = require(...)`
    if (imp.namespace) nsVars.push(imp.namespace);  // ESM `import * as ns`
  }

  // Collision: newName already a binder/usage target in this file.
  const collision = u.findBinders(source, newName).length > 0;

  const offsets = [];
  let role = "importer";

  if (direct) {
    // Scope-aware: rename occurrences governed by the module-scope import binding,
    // skipping any inner local that shadows it (this includes the import token).
    const { offsets: scoped } = scopeAwareOffsets(source, oldName, masked, moduleScopeTarget);
    for (const off of scoped) offsets.push(off);
    role = "import-direct";
  } else if (aliased) {
    // Rename ONLY the imported identifier inside the import statement.
    const importRe = /\bimport\b[\s\S]*?\bfrom\b|\brequire\s*\(/g; // locate import region loosely
    // Simplest robust approach: find `oldName` immediately followed by whitespace+`as`.
    const re = new RegExp("\\b" + escapeRe(oldName) + "\\b(\\s+as\\s+)", "g");
    let m;
    while ((m = re.exec(masked))) offsets.push(m.index);
    role = "import-aliased";
    warnings.push(rec.file + ": aliased import — only the imported name was renamed, alias usages kept");
    void importRe;
  }

  if (nsVars.length) {
    // Rename `ns.oldName` member accesses for each namespace var bound to declFile.
    for (const ns of nsVars) {
      const re = new RegExp("\\b" + escapeRe(ns) + "\\s*\\.\\s*" + escapeRe(oldName) + "\\b", "g");
      let m;
      while ((m = re.exec(masked))) {
        const dot = masked.indexOf(".", m.index);
        let p = dot + 1;
        while (masked[p] === " " || masked[p] === "\t") p++;
        offsets.push(p); // offset of oldName after the dot
      }
    }
    if (role === "importer") role = "import-namespace";
  }

  if (offsets.length === 0) return { count: 0, text: source, warnings, collision: false, role };
  const uniq = [...new Set(offsets)].sort((a, b) => a - b);
  const text = replaceAt(source, uniq, oldName, newName);
  return { count: uniq.length, text, warnings, collision, role };
}

/** Rename a method within its declaring class only (same file). */
function planMethodRename(args, idx, srcByFile, methods) {
  const { oldName, newName } = args;
  let pool = methods;
  if (args.file) pool = pool.filter((c) => norm(c.file) === norm(args.file));
  if (args.line) {
    const exact = pool.filter((c) => c.symbol.line === args.line);
    if (exact.length) pool = exact;
  }
  if (pool.length !== 1) {
    return plan.refuse("rename", ["method '" + oldName + "' is ambiguous; pass {file,line}"]);
  }
  const m = pool[0];
  const file = norm(m.file);
  const source = srcByFile.get(file);
  const masked = u.maskJs(source);
  const root = u.scanBlocks(masked);

  // Find class blocks that actually contain a definition of the method. The codegraph
  // method line is approximate, so locate the class by its body content (and use the
  // requested line only to disambiguate when several classes define the same name).
  const classBlocks = [];
  u.walkBlocks(root, (b) => { if (/\bclass\b/.test(b.header)) classBlocks.push(b); });
  const containsMethod = (b) => u.occurrences(source, oldName, { masked, skipProperty: false })
    .some((o) => o.offset > b.open && o.offset < b.bodyEnd);
  let hits = classBlocks.filter(containsMethod);
  if (args.line) {
    const lineOff = u.offsetOfLine(source, args.line);
    const byLine = hits.filter((b) => lineOff > b.open && lineOff < b.bodyEnd);
    if (byLine.length) hits = byLine;
  }
  if (!hits.length) return plan.refuse("rename", ["could not locate the class body for method '" + oldName + "'"]);
  // Innermost matching class.
  const classBlock = hits.reduce((a, b) => (b.open > a.open ? b : a));

  // Rename: the method definition + `this.oldName` references within the class body.
  const offsets = [];
  for (const o of u.occurrences(source, oldName, { masked, skipProperty: false })) {
    if (o.offset <= classBlock.open || o.offset >= classBlock.bodyEnd) continue;
    offsets.push(o.offset);
  }
  if (offsets.length === 0) return plan.refuse("rename", ["no method occurrences found"]);
  const text = replaceAt(source, offsets, oldName, newName);
  const edits = new Map([[file, text]]);
  const before = new Map([[file, source]]);
  return {
    refactoring: "rename",
    ok: true,
    safety: plan.safety(true, [], [
      file + ": method rename is class-scoped only; external call sites (obj." + oldName + "()) are NOT updated — review dynamic callers.",
    ]),
    edits, before,
    details: { oldName, newName, declFile: file, kind: "method", files: [{ file, occurrences: offsets.length, role: "method" }] },
  };
}

/** Replace `oldName` with `newName` at exact code offsets. */
function replaceAt(source, offsets, oldName, newName) {
  const edits = [...new Set(offsets)].sort((a, b) => a - b).map((off) => ({ start: off, end: off + oldName.length, text: newName }));
  return u.applyEdits(source, edits);
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function norm(p) { return require("../codegraph/depgraph").normalize(p); }

module.exports = { planRename };
