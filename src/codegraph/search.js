"use strict";
// ===================== Code Graph — "Find Existing Implementation" =====================
// Given a natural-language description ("parse import statement") or a signature
// ("resolveImport(file, spec)"), rank the functions/methods already in the codebase
// that most likely do it — so the agent reuses them instead of re-implementing
// (directly countering the DRY-violation failure mode). No embeddings, no external
// deps: scoring combines a LEXICAL signal (query terms matched against identifier
// words split from camelCase / snake_case / kebab across the symbol name, signature,
// enclosing class and file path, each field weighted) with a STRUCTURAL signal
// (kind match, exact/prefix name hits, and parameter-count proximity when the query
// is signature-shaped). Transparent and tunable.
const STOP = new Set("a an the to of for in on with and or that this it is get set make fn func function method def".split(" "));

// splitWords("parseImportClause_v2") -> ["parse","import","clause","v2"]
function splitWords(s) {
  return String(s || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/).map((w) => w.toLowerCase()).filter(Boolean);
}

function queryTerms(q) {
  return splitWords(q).filter((w) => !STOP.has(w));
}

function paramCount(sig) {
  if (!sig) return null;
  const m = String(sig).match(/\(([^)]*)\)/);
  if (!m) return null;
  const inner = m[1].trim();
  return inner ? inner.split(",").filter((x) => x.trim()).length : 0;
}

// buildSearchIndex(files) -> { docs } . Indexes only callable symbols.
function buildSearchIndex(files) {
  const docs = [];
  for (const f of files) {
    const pathWords = splitWords(f.file);
    for (const s of (f.symbols || [])) {
      if (s.kind !== "function" && s.kind !== "method") continue;
      docs.push({
        file: f.file, name: s.name, kind: s.kind, line: s.line, parent: s.parent || null,
        exported: !!s.exported, signature: s.signature || "",
        nameWords: splitWords(s.name),
        sigWords: splitWords(s.signature || ""),
        parentWords: splitWords(s.parent || ""),
        pathWords,
        params: paramCount(s.signature),
      });
    }
  }
  return { docs };
}

// matchTerm(term, words) -> 1 exact, 0.6 prefix/contained, 0 none.
function matchTerm(term, words) {
  let best = 0;
  for (const w of words) {
    if (w === term) return 1;
    if (w.startsWith(term) || term.startsWith(w)) best = Math.max(best, 0.6);
    else if (w.includes(term) && term.length >= 4) best = Math.max(best, 0.4);
  }
  return best;
}

// search(index, query, opts) -> ranked [{ score, file, name, line, kind, parent,
//   signature, matched }]. opts.limit (default 10), opts.minScore (default 0.15).
function search(index, query, opts) {
  opts = opts || {};
  const limit = opts.limit || 10, minScore = opts.minScore == null ? 0.15 : opts.minScore;
  const terms = queryTerms(query);
  if (!terms.length) return [];
  const qParams = paramCount(query);
  const W = { name: 3, sig: 1, parent: 1.2, path: 0.5 };
  const results = [];

  for (const d of index.docs) {
    let raw = 0, matched = 0;
    for (const t of terms) {
      const sName = matchTerm(t, d.nameWords) * W.name;
      const sSig = matchTerm(t, d.sigWords) * W.sig;
      const sPar = matchTerm(t, d.parentWords) * W.parent;
      const sPath = matchTerm(t, d.pathWords) * W.path;
      const best = Math.max(sName, sSig, sPar, sPath);
      raw += best;
      if (best > 0) matched++;
    }
    if (matched === 0) continue;
    // coverage: fraction of query terms that hit something at all
    const coverage = matched / terms.length;
    let score = (raw / (terms.length * W.name)) * (0.5 + 0.5 * coverage);
    // structural boosts
    if (d.nameWords.join("") === terms.join("")) score += 0.4; // name == query (word-for-word)
    if (terms.every((t) => d.nameWords.includes(t))) score += 0.2; // all terms in the name
    if (d.exported) score += 0.03;
    if (qParams != null && d.params != null) score += Math.max(0, 0.15 - 0.05 * Math.abs(qParams - d.params));
    if (score >= minScore) {
      results.push({ score: +score.toFixed(4), file: d.file, name: d.name, line: d.line, kind: d.kind, parent: d.parent, signature: d.signature, matched });
    }
  }
  results.sort((a, b) => b.score - a.score || a.name.length - b.name.length);
  return results.slice(0, limit);
}

module.exports = { splitWords, queryTerms, paramCount, buildSearchIndex, search, matchTerm };
