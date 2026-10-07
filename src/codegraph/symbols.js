"use strict";
// ===================== Code Graph — Symbol Table & Cross-file Resolution =====================
// Turns per-file parse results into a project-wide symbol graph:
//   • byName   — every definition indexed by name (for fast lookup / ambiguity)
//   • defs     — definitions per file
//   • exportsByFile — each file's exported name -> what it points at (local symbol
//                     or a re-export source), so named/star re-exports and aliases
//                     resolve transitively
//   • bindings — each file's imported local name -> the concrete {file, name,
//                symbol} it resolves to, or an external package marker
// resolveExport follows `export {x} from './y'` and `export * from './y'` chains
// (with cycle guarding) so an import lands on the real definition even across hops.
const { resolveImport, normalize } = require("./depgraph");

function buildSymbolTable(files) {
  const known = new Set(files.map((f) => normalize(f.file)));
  const fileMap = new Map(); // normalized path -> record
  const byName = new Map();  // name -> [{ file, symbol }]
  const defs = new Map();    // file -> [symbols]
  const exportsByFile = new Map(); // file -> Map name -> entry

  for (const f of files) {
    const file = normalize(f.file);
    fileMap.set(file, f);
    defs.set(file, f.symbols || []);
    for (const s of (f.symbols || [])) {
      (byName.get(s.name) || byName.set(s.name, []).get(s.name)).push({ file, symbol: s });
    }
    const em = new Map();
    for (const e of (f.exports || [])) {
      em.set(e.name, { local: e.local || e.name, kind: e.kind, source: e.source || null, line: e.line });
    }
    exportsByFile.set(file, em);
  }

  // resolveExport(file, name, seen) -> { file, symbol } | null
  function resolveExport(file, name, seen) {
    file = normalize(file); seen = seen || new Set();
    const key = file + "#" + name;
    if (seen.has(key)) return null; seen.add(key);
    const em = exportsByFile.get(file);
    if (!em) return null;
    const entry = em.get(name);
    if (entry) {
      if (entry.source) { // re-export: follow to source module
        const rec = fileMap.get(file);
        const target = resolveImport(file, entry.source, rec ? rec.lang : "javascript", known);
        if (target) { const r = resolveExport(target, entry.local, seen); if (r) return r; }
        return null;
      }
      const local = findLocal(file, entry.local);
      if (local) return { file, symbol: local };
    }
    // star re-exports: export * from './other'
    for (const [, ent] of em) {
      if (ent.kind === "reexport-all" && ent.source) {
        const rec = fileMap.get(file);
        const target = resolveImport(file, ent.source, rec ? rec.lang : "javascript", known);
        if (target) { const r = resolveExport(target, name, seen); if (r) return r; }
      }
    }
    // fall back: a top-level symbol flagged exported
    const local = findLocal(file, name);
    if (local && local.exported) return { file, symbol: local };
    return null;
  }

  function findLocal(file, name) {
    const list = defs.get(normalize(file)) || [];
    return list.find((s) => s.name === name && s.parent == null) || null;
  }

  // bindings: for each file, map every imported local name to its resolved target.
  const bindings = new Map();
  for (const f of files) {
    const file = normalize(f.file);
    const bm = new Map();
    for (const imp of (f.imports || [])) {
      const target = resolveImport(file, imp.source, f.lang, known);
      const addBinding = (localName, importedName) => {
        if (target) {
          const r = resolveExport(target, importedName, new Set());
          bm.set(localName, r ? { kind: "internal", file: r.file, name: importedName, symbol: r.symbol }
                               : { kind: "internal-file", file: target, name: importedName, symbol: null });
        } else {
          bm.set(localName, { kind: "external", package: imp.source });
        }
      };
      if (imp.default) addBinding(imp.default, "default");
      if (imp.namespace) bm.set(imp.namespace, target ? { kind: "namespace", file: target } : { kind: "external", package: imp.source });
      for (const nm of (imp.names || [])) addBinding(nm.local, nm.imported);
      if (imp.alias) addBinding(imp.alias, imp.alias);
    }
    bindings.set(file, bm);
  }

  // lookup(name) -> definitions array (possibly empty)
  function lookup(name) { return byName.get(name) || []; }

  return { fileMap, byName, defs, exportsByFile, bindings, resolveExport, findLocal, lookup,
    stats: { files: files.length, symbols: [...byName.values()].reduce((a, v) => a + v.length, 0), names: byName.size } };
}

module.exports = { buildSymbolTable };
