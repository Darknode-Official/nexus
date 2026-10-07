"use strict";
// ===================== Repo Map — Symbol / Reference Graph =====================
// Builds the weighted directed graph that PageRank ranks. Nodes are files. An edge
// R -> D means "file R references a symbol that file D defines", weighted by how
// strong and how specific that reference is. This is the aider-style "ranked tags"
// construction, reimplemented from first principles over the codegraph parse data:
//
//   definers[name]  = set of files that DEFINE a symbol called `name`
//   for each file R, for each identifier `name` used `c` times in R's body:
//     if `name` is defined somewhere, add an edge R -> D (for every definer D != R)
//     with weight = nameWeight(name) * sqrt(c) / |definers[name]|
//
// The 1/|definers| factor damps ambiguous names (a `run` defined in ten files
// should not dominate), sqrt(c) rewards repeated use with diminishing returns, and
// nameWeight boosts descriptive identifiers (compound / long) over short noise.
//
// On top of that identifier signal we lay an IMPORT BACKBONE: codegraph already
// resolves relative imports to concrete files, so for every resolved dependency
// R -> M we add a small guaranteed edge. That keeps the dependency structure in the
// ranking even when a module is imported but its exported names are re-exported or
// used indirectly.
//
// We also accumulate, per definer file, the incoming reference weight attributed to
// each identifier (`symbolInWeight`). rank.js uses this to split a file's PageRank
// across the individual symbols it defines, so the map can rank *symbols*, not just
// files.

const IMPORT_EDGE_WEIGHT = 2.0; // structural dependency backbone per resolved import

/**
 * @param {Map<string,Object>} extractions - file -> extractFile() result
 * @param {Object} [opts]
 * @param {Object} [opts.cgIndex] - codegraph index (uses .graph.adj for the import backbone)
 * @param {number} [opts.importEdgeWeight]
 * @returns {{
 *   files: string[],
 *   edges: Array<{from:string,to:string,weight:number}>,
 *   definers: Map<string, Set<string>>,
 *   symbolInWeight: Map<string, Map<string, number>>,
 *   stats: Object
 * }}
 */
function buildSymbolGraph(extractions, opts) {
  opts = opts || {};
  const importEdgeWeight = opts.importEdgeWeight == null ? IMPORT_EDGE_WEIGHT : opts.importEdgeWeight;
  const files = [...extractions.keys()].sort();

  // --- definers: identifier -> set of defining files ---
  const definers = new Map();
  for (const file of files) {
    const ex = extractions.get(file);
    for (const name of (ex.defNames || [])) {
      let s = definers.get(name);
      if (!s) { s = new Set(); definers.set(name, s); }
      s.add(file);
    }
  }

  // --- reference edges (aggregated R -> D) ---
  // edgeAcc: "from\u0000to" -> weight
  const edgeAcc = new Map();
  const symbolInWeight = new Map(); // definerFile -> Map ident -> weight
  const addEdge = (from, to, w) => {
    if (from === to || w <= 0) return;
    const key = from + "\u0000" + to;
    edgeAcc.set(key, (edgeAcc.get(key) || 0) + w);
  };
  const addSymbolIn = (file, name, w) => {
    let m = symbolInWeight.get(file);
    if (!m) { m = new Map(); symbolInWeight.set(file, m); }
    m.set(name, (m.get(name) || 0) + w);
  };

  let refEdges = 0;
  for (const file of files) {
    const ex = extractions.get(file);
    const refs = ex.refs || {};
    for (const name of Object.keys(refs)) {
      const defSet = definers.get(name);
      if (!defSet || defSet.size === 0) continue;
      const c = refs[name];
      const w = (nameWeight(name) * Math.sqrt(c)) / defSet.size;
      if (w <= 0) continue;
      for (const definer of defSet) {
        if (definer === file) continue; // local self-reference: no cross edge
        addEdge(file, definer, w);
        addSymbolIn(definer, name, w);
        refEdges++;
      }
      // Even a self-defined symbol that the file uses gets symbol-in weight, so a
      // file's own heavily-used symbol still ranks above an unused one.
      if (defSet.has(file)) addSymbolIn(file, name, w * 0.5);
    }
  }

  // --- import backbone from codegraph's resolved dependency graph ---
  let importEdges = 0;
  const cg = opts.cgIndex;
  if (cg && cg.graph && cg.graph.adj) {
    for (const [from, deps] of cg.graph.adj) {
      if (!extractions.has(from)) continue;
      for (const to of deps) {
        if (!extractions.has(to) || to === from) continue;
        addEdge(from, to, importEdgeWeight);
        importEdges++;
      }
    }
  }

  // --- materialize deterministic edge list ---
  const edges = [];
  for (const key of [...edgeAcc.keys()].sort()) {
    const sep = key.indexOf("\u0000");
    edges.push({ from: key.slice(0, sep), to: key.slice(sep + 1), weight: +edgeAcc.get(key).toFixed(6) });
  }

  return {
    files,
    edges,
    definers,
    symbolInWeight,
    stats: {
      files: files.length,
      names: definers.size,
      ambiguousNames: [...definers.values()].filter((s) => s.size > 1).length,
      refEdges, importEdges, edges: edges.length,
    },
  };
}

// nameWeight(ident): structural specificity of an identifier. Descriptive names
// (compound / long) carry more signal than short or shouty ones. Deterministic.
function nameWeight(name) {
  const len = name.length;
  let w = 1.0;
  if (len <= 3) w *= 0.25;
  else if (len <= 5) w *= 0.7;
  else if (len >= 10) w *= 1.25;
  const camel = /[a-z][A-Z]/.test(name);
  const snake = name.includes("_") && !/^_+$/.test(name);
  if (camel || snake) w *= 1.2;           // multi-word -> more descriptive
  if (/^[A-Z0-9_]+$/.test(name) && len > 1) w *= 0.85; // SHOUTY_CONSTANT: slight damp
  return w;
}

module.exports = { buildSymbolGraph, nameWeight, IMPORT_EDGE_WEIGHT };
