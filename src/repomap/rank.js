"use strict";
// ===================== Repo Map — Ranking =====================
// Runs Personalized PageRank over the symbol/reference graph, then distributes each
// file's rank across the individual symbols it defines, producing two ranked lists:
// files and symbols, both ordered by structural importance.
//
// PERSONALIZATION (the "focus" feature): when the agent is working on particular
// files or symbols, we bias the random surfer's restart distribution toward them.
// The ranking then answers "what matters *relative to this task*" — the seed files,
// the things they depend on, and the things that depend on them float to the top —
// while an empty focus gives the global, task-agnostic ranking.
//
// SYMBOL RANK: a file's PageRank is split among its defined symbols in proportion to
// the inbound reference weight each symbol attracted (symbolInWeight from the graph
// builder), with a small floor so every definition gets a share and exported/public
// symbols get a modest boost (they are the file's API surface — the most map-worthy
// lines). Per-file symbol scores sum back to the file's PageRank, so symbol and file
// rankings are on one comparable scale.

const { pageRank, ranked } = require("./pagerank");

const FOCUS_FILE_WEIGHT = 5.0;
const FOCUS_SYMBOL_WEIGHT = 3.0;
const EXPORT_BOOST = 1.35;
const SYMBOL_FLOOR = 0.15; // epsilon share so unreferenced defs still appear

/**
 * Rank a repository's files and symbols.
 *
 * @param {Object} graph - buildSymbolGraph() result
 * @param {Map<string,Object>} extractions - file -> extractFile() result
 * @param {Object} [opts]
 * @param {string[]} [opts.focus] - file paths and/or symbol names to bias toward
 * @param {string[]} [opts.exclude] - path substrings to omit from the OUTPUT lists
 * @param {number} [opts.damping=0.85]
 * @param {number} [opts.tol]
 * @param {number} [opts.maxIter]
 * @returns {{
 *   files: Array<Object>, symbols: Array<Object>,
 *   pr: Object, personalization: (Object|null), focusResolved: Object, stats: Object
 * }}
 */
function rankRepo(graph, extractions, opts) {
  opts = opts || {};
  const focusResolved = resolveFocus(opts.focus, graph, extractions);
  const personalization = focusResolved.weights.size ? focusResolved.weights : null;

  const pr = pageRank(
    { nodes: graph.files, edges: graph.edges },
    { damping: opts.damping, tol: opts.tol, maxIter: opts.maxIter, personalization }
  );

  const exclude = normalizeExcludes(opts.exclude);
  const fileRank = pr.rank;

  // --- file ranking ---
  const files = [];
  for (const { id: file, score } of ranked(fileRank)) {
    if (isExcluded(file, exclude)) continue;
    const ex = extractions.get(file) || {};
    files.push({
      file, score,
      lang: ex.lang || null,
      loc: ex.loc || 0,
      symbolCount: (ex.defs || []).length,
    });
  }

  // --- symbol ranking ---
  const symbols = [];
  for (const file of graph.files) {
    if (isExcluded(file, exclude)) continue;
    const ex = extractions.get(file);
    if (!ex || !ex.defs || ex.defs.length === 0) continue;
    const fr = fileRank.get(file) || 0;
    const inW = graph.symbolInWeight.get(file) || new Map();

    // Raw per-symbol weight with floor + export boost.
    let total = 0;
    const raw = ex.defs.map((def) => {
      const base = (inW.get(def.name) || 0) + SYMBOL_FLOOR;
      const boost = def.exported ? EXPORT_BOOST : 1.0;
      const w = base * boost;
      total += w;
      return { def, w };
    });
    for (const { def, w } of raw) {
      const share = total > 0 ? w / total : 1 / raw.length;
      const key = sigLookupKey(def);
      symbols.push({
        file,
        name: def.name,
        kind: def.kind,
        parent: def.parent,
        line: def.line,
        exported: def.exported,
        score: fr * share,
        signature: (ex.signatures && ex.signatures[key]) || "",
      });
    }
  }
  symbols.sort((a, b) => (b.score - a.score)
    || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0)
    || (a.line - b.line));

  return {
    files, symbols,
    pr: { iterations: pr.iterations, converged: pr.converged, delta: pr.delta },
    personalization: personalization ? mapToObject(personalization) : null,
    focusResolved,
    stats: {
      files: files.length,
      symbols: symbols.length,
      focusFiles: focusResolved.files.length,
      focusSymbols: focusResolved.symbols.length,
    },
  };
}

// Mirror of extract.sigKey (kept local to avoid a cycle): the signature map key.
function sigLookupKey(def) {
  return (def.parent ? def.parent + "." : "") + def.name + "#" + def.kind + "@" + def.line;
}

/**
 * Resolve a focus list (file paths and/or symbol names) into a personalization
 * weight map over files, plus the concrete matches for reporting.
 * @returns {{ weights: Map<string,number>, files: string[], symbols: string[], unmatched: string[] }}
 */
function resolveFocus(focus, graph, extractions) {
  const weights = new Map();
  const matchedFiles = new Set();
  const matchedSymbols = new Set();
  const unmatched = [];
  const add = (file, w) => weights.set(file, (weights.get(file) || 0) + w);

  for (const token of (focus || [])) {
    const t = String(token || "").trim();
    if (!t) continue;
    let matched = false;

    // 1) file-path match (exact, suffix, or basename)
    const fileMatches = matchFiles(t, graph.files);
    for (const f of fileMatches) { add(f, FOCUS_FILE_WEIGHT); matchedFiles.add(f); matched = true; }

    // 2) symbol-name match -> bias toward every file defining it
    const defSet = graph.definers.get(t);
    if (defSet && defSet.size) {
      for (const f of defSet) { add(f, FOCUS_SYMBOL_WEIGHT); matchedFiles.add(f); }
      matchedSymbols.add(t);
      matched = true;
    }

    if (!matched) unmatched.push(t);
  }

  return {
    weights,
    files: [...matchedFiles].sort(),
    symbols: [...matchedSymbols].sort(),
    unmatched,
  };
}

// matchFiles(token, files): exact normalized path, else endsWith "/token", else
// basename equality, else substring. Returns all matches (deterministic).
function matchFiles(token, files) {
  const t = token.replace(/\\/g, "/").replace(/^\.\//, "");
  const out = [];
  for (const f of files) {
    if (f === t) { out.push(f); continue; }
    if (f.endsWith("/" + t)) { out.push(f); continue; }
    const base = f.slice(f.lastIndexOf("/") + 1);
    if (base === t) { out.push(f); continue; }
  }
  if (out.length) return out.sort();
  // Last resort: substring (only when nothing exact matched).
  const sub = files.filter((f) => f.includes(t)).sort();
  return sub;
}

function normalizeExcludes(exclude) {
  if (!exclude) return [];
  const arr = Array.isArray(exclude) ? exclude : [exclude];
  return arr.map((x) => String(x || "").replace(/\\/g, "/")).filter(Boolean);
}

function isExcluded(file, excludes) {
  for (const ex of excludes) if (file === ex || file.includes(ex)) return true;
  return false;
}

function mapToObject(m) {
  const o = {};
  for (const [k, v] of m) o[k] = +Number(v).toFixed(4);
  return o;
}

module.exports = {
  rankRepo, resolveFocus, matchFiles,
  FOCUS_FILE_WEIGHT, FOCUS_SYMBOL_WEIGHT, EXPORT_BOOST, SYMBOL_FLOOR,
};
