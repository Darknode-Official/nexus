"use strict";
// ===================== Repo Map — Rendering =====================
// Turns ranked files + symbols into the human/agent-readable map, in two modes:
//
//   renderTree()     — the full map (every ranked file + its symbols), a readable
//                      directory tree with per-file importance.
//   renderBudgeted() — the same tree, but trimmed to fit a token budget. Highest-
//                      ranked symbols are filled first; as the budget shrinks, each
//                      file keeps fewer of its symbols and low-rank files drop out
//                      entirely (graceful degradation). The returned map is
//                      GUARANTEED to estimate at or under the budget: a final
//                      verification pass trims the lowest-ranked lines until the
//                      measured token count fits, so the engine can trust the bound.
//
// Token costs come from tokensave's estimator (the same one the context packer and
// diff builder use), so the map's accounting is consistent with the rest of Nexus.
// Selection is a value-density greedy over symbol score with a lazy per-file header
// charge — a file only "pays" for its header line once its first symbol is kept.

const { estimateTokens } = require("../tokensave/estimator");

const BAR_WIDTH = 10;
const DEFAULT_MAX_PER_FILE = 40;

/**
 * Full (unbudgeted) map render.
 * @param {Array<Object>} rankedFiles
 * @param {Array<Object>} rankedSymbols
 * @param {Object} [opts] - { model, title, maxPerFile, showEmpty }
 * @returns {{ map:string, tokens:number, files:number, symbols:number }}
 */
function renderTree(rankedFiles, rankedSymbols, opts) {
  opts = opts || {};
  const r = renderBudgeted(rankedFiles, rankedSymbols, Object.assign({ budget: Infinity }, opts));
  return { map: r.map, tokens: r.tokens, files: r.includedFiles.length, symbols: r.includedSymbols };
}

/**
 * Budget-bounded map render.
 * @param {Array<Object>} rankedFiles - [{ file, score, lang, loc, symbolCount }]
 * @param {Array<Object>} rankedSymbols - [{ file, name, kind, parent, line, exported, score, signature }]
 * @param {Object} opts
 * @param {number} opts.budget - token budget (Infinity for full map)
 * @param {string} [opts.model] - model family for token estimation
 * @param {string} [opts.title]
 * @param {number} [opts.maxPerFile=40] - cap symbols kept per file
 * @returns {{
 *   map:string, tokens:number, budget:number, degraded:boolean,
 *   includedFiles:string[], includedSymbols:number, droppedSymbols:number
 * }}
 */
function renderBudgeted(rankedFiles, rankedSymbols, opts) {
  opts = opts || {};
  const model = opts.model;
  const budget = opts.budget == null ? Infinity : opts.budget;
  const maxPerFile = opts.maxPerFile || DEFAULT_MAX_PER_FILE;
  const title = opts.title || "Repository map";

  const fileOrder = rankedFiles.map((f) => f.file);
  const fileInfo = new Map(rankedFiles.map((f) => [f.file, f]));
  const totalRankOf = (f) => (fileInfo.get(f) ? fileInfo.get(f).score : 0);

  // Group symbols by file, sorted by score desc (fill priority) then line asc.
  const byFile = new Map();
  for (const s of rankedSymbols) {
    if (!byFile.has(s.file)) byFile.set(s.file, []);
    byFile.get(s.file).push(s);
  }
  for (const list of byFile.values()) {
    list.sort((a, b) => (b.score - a.score) || (a.line - b.line)
      || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  // Candidate symbol items in global value order (score desc), capped per file.
  const perFileCount = new Map();
  const candidates = rankedSymbols.slice().sort((a, b) => (b.score - a.score)
    || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) || (a.line - b.line));

  // --- greedy fill under budget with lazy header charge ---
  const reserve = isFinite(budget) ? Math.min(Math.ceil(budget * 0.08) + 4, 60) : 0;
  const cap = isFinite(budget) ? Math.max(0, budget - reserve) : Infinity;
  const includedByFile = new Map(); // file -> Set(symbol ref)
  const headerCounted = new Set();
  let used = 0;

  for (const sym of candidates) {
    const n = perFileCount.get(sym.file) || 0;
    if (n >= maxPerFile) continue;
    const lineCost = symbolLineCost(sym, model);
    let cost = lineCost;
    if (!headerCounted.has(sym.file)) cost += headerCost(sym.file, totalRankOf(sym.file), model);
    if (used + cost > cap) continue; // skip; a cheaper later symbol may still fit
    if (!includedByFile.has(sym.file)) includedByFile.set(sym.file, new Set());
    includedByFile.get(sym.file).add(sym);
    headerCounted.add(sym.file);
    perFileCount.set(sym.file, n + 1);
    used += cost;
  }

  // Render, then verify and trim to the hard bound.
  let result = assemble(title, fileOrder, fileInfo, includedByFile, rankedFiles, model);
  let tokens = estimateTokens(result, model);
  let droppedSymbols = rankedSymbols.length - countIncluded(includedByFile);

  if (isFinite(budget)) {
    // Trim lowest-score included symbols until the MEASURED map fits the budget.
    while (tokens > budget) {
      const victim = lowestIncluded(includedByFile);
      if (!victim) { // nothing left to trim: emit at most the title (or empty)
        const titleLine = title + " (0 files, over budget)";
        if (estimateTokens(titleLine, model) <= budget) { result = titleLine; tokens = estimateTokens(result, model); }
        else { result = ""; tokens = 0; }
        break;
      }
      const set = includedByFile.get(victim.file);
      set.delete(victim.sym);
      if (set.size === 0) includedByFile.delete(victim.file);
      droppedSymbols++;
      result = assemble(title, fileOrder, fileInfo, includedByFile, rankedFiles, model);
      tokens = estimateTokens(result, model);
    }
  }

  const includedFiles = [...includedByFile.keys()];
  const includedSymbols = countIncluded(includedByFile);
  return {
    map: result,
    tokens,
    budget,
    degraded: isFinite(budget) && droppedSymbols > 0,
    includedFiles,
    includedSymbols,
    droppedSymbols: rankedSymbols.length - includedSymbols,
  };
}

// ---- cost helpers ----
function symbolLineCost(sym, model) {
  return estimateTokens(symbolLine(sym) + "\n", model);
}
function headerCost(file, score, model) {
  return estimateTokens(fileHeaderLine(file, score) + "\n", model);
}

// ---- line formatting ----
function symbolLine(sym) {
  const sig = sym.signature && sym.signature.trim() ? sym.signature.trim() : synthSig(sym);
  return "    " + sig;
}
function synthSig(sym) {
  if (sym.kind === "class" || sym.kind === "type") return "class " + sym.name;
  if (sym.kind === "method") return (sym.parent ? sym.parent + "." : "") + sym.name + "()";
  return "function " + sym.name + "()";
}
function fileHeaderLine(file, score) {
  const base = file.slice(file.lastIndexOf("/") + 1);
  return "  " + base + "  " + importanceBar(score) + " " + (100 * score).toFixed(2) + "%";
}
function importanceBar(score, maxScore) {
  // Bar relative to the given max (defaults to treating score as an absolute
  // fraction of 1 scaled so the top file is near-full). Deterministic ASCII.
  const ref = maxScore && maxScore > 0 ? maxScore : 0.2;
  let filled = Math.round((score / ref) * BAR_WIDTH);
  if (filled < 0) filled = 0; if (filled > BAR_WIDTH) filled = BAR_WIDTH;
  return "[" + "#".repeat(filled) + "-".repeat(BAR_WIDTH - filled) + "]";
}

// ---- tree assembly ----
function assemble(title, fileOrder, fileInfo, includedByFile, rankedFiles, model) {
  const files = [...includedByFile.keys()];
  if (files.length === 0) return title + " (0 files)";

  const maxScore = Math.max(...files.map((f) => (fileInfo.get(f) ? fileInfo.get(f).score : 0)), 1e-9);

  // Group files by directory for a readable tree. Directories sorted
  // alphabetically; files within a directory by score desc.
  const dirs = new Map(); // dir -> [file]
  for (const f of files) {
    const slash = f.lastIndexOf("/");
    const dir = slash < 0 ? "." : f.slice(0, slash);
    if (!dirs.has(dir)) dirs.set(dir, []);
    dirs.get(dir).push(f);
  }
  const dirNames = [...dirs.keys()].sort();

  const lines = [];
  const totalSyms = countIncluded(includedByFile);
  lines.push(title + " (" + files.length + " files, " + totalSyms + " symbols)");

  for (const dir of dirNames) {
    lines.push(dir + "/");
    const inDir = dirs.get(dir).sort((a, b) => {
      const sa = fileInfo.get(a) ? fileInfo.get(a).score : 0;
      const sb = fileInfo.get(b) ? fileInfo.get(b).score : 0;
      return (sb - sa) || (a < b ? -1 : 1);
    });
    for (const f of inDir) {
      const info = fileInfo.get(f) || { score: 0 };
      const base = f.slice(f.lastIndexOf("/") + 1);
      lines.push("  " + base + "  " + importanceBar(info.score, maxScore) + " " + (100 * info.score).toFixed(2) + "%");
      // symbols for this file, sorted by line for readability
      const syms = [...includedByFile.get(f)].sort((a, b) => (a.line - b.line)
        || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const s of syms) lines.push(symbolLine(s));
    }
  }
  return lines.join("\n");
}

function countIncluded(includedByFile) {
  let n = 0; for (const set of includedByFile.values()) n += set.size; return n;
}

// Find the lowest-score included symbol across all files (for trimming).
function lowestIncluded(includedByFile) {
  let best = null;
  for (const [file, set] of includedByFile) {
    for (const sym of set) {
      if (!best || sym.score < best.sym.score
        || (sym.score === best.sym.score && (file > best.file
          || (file === best.file && sym.line > best.sym.line)))) {
        best = { file, sym };
      }
    }
  }
  return best;
}

module.exports = {
  renderTree, renderBudgeted,
  symbolLine, fileHeaderLine, importanceBar, synthSig,
  BAR_WIDTH, DEFAULT_MAX_PER_FILE,
};
