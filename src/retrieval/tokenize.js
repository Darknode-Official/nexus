"use strict";
// ===================== Retrieval — Code-aware Tokenizer =====================
// BM25 and TF-IDF are only as good as their tokens. Natural-language tokenizers
// throw away exactly the structure that matters in code: they split on
// whitespace, so `parseHTTPResponse` becomes one opaque token that never matches
// a query for "parse response", and they discard operators (`=>`, `===`, `&&`)
// that often ARE the query. This tokenizer is code-aware:
//
//   • Identifiers are split on camelCase, snake_case, kebab-case, dotted member
//     access and digit boundaries (`parseHTTPResponse` -> parse http response),
//     while ALSO keeping the whole lowercased identifier so an exact-identifier
//     query still lands a direct hit.
//   • A curated set of multi-character operators is preserved as tokens.
//   • Natural-language stop words are dropped; programming keywords are KEPT
//     (they are frequently what a developer searches for).
//   • Long digit/hex runs (hashes, ids) are dropped; short numerics are kept.
//
// Everything here is pure and deterministic: identical input always yields an
// identical token stream, which is what makes the downstream rankers stable.

// Natural-language stop words. Deliberately small — we keep code keywords like
// `class`, `return`, `async`, `import` because developers search for them.
const STOP = new Set((
  "a an and are as at be but by для for from has have if in into is it its of on " +
  "or that the their then there these this to was were will with your you we"
).split(" ").filter(Boolean));

// Multi-character operators worth indexing as their own tokens. Ordered longest
// first so the scanner is greedy (so `===` is one token, not `==` + `=`).
const OPERATORS = [
  "===", "!==", "<<=", ">>=", "**=", "...", "->", "=>", "::", "==", "!=", "<=",
  ">=", "&&", "||", "??", "++", "--", "+=", "-=", "*=", "/=", "%=", "|=", "&=",
  "^=", "<<", ">>", "**",
].sort((a, b) => b.length - a.length);

const OP_FIRST = new Set(OPERATORS.map((o) => o[0]));
const MAX_NUMERIC_LEN = 4; // keep short numbers (ports, codes), drop long id/hash runs

/**
 * Split a single identifier/word into its lowercase sub-words.
 * Handles camelCase, PascalCase, ACRONYMFollowedByWord, snake_case, kebab-case
 * and digit boundaries.
 * @param {string} s
 * @returns {string[]} lowercase sub-words (no separators, no empties)
 */
function splitIdentifier(s) {
  return String(s == null ? "" : s)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")   // fooBar     -> foo Bar
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2") // HTTPServer -> HTTP Server
    .replace(/([A-Za-z])([0-9])/g, "$1 $2")   // utf8       -> utf 8
    .replace(/([0-9])([A-Za-z])/g, "$1 $2")   // 3d         -> 3 d
    .split(/[^A-Za-z0-9]+/)
    .map((w) => w.toLowerCase())
    .filter(Boolean);
}

// Should a numeric token be kept? Short decimals yes; long runs (likely ids/
// hashes) no.
function keepNumeric(tok) {
  return /^[0-9]+$/.test(tok) ? tok.length <= MAX_NUMERIC_LEN : true;
}

/**
 * Tokenize arbitrary source/text into an ordered token stream for indexing.
 * The stream preserves repetition (term frequency) and ordering.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {boolean} [opts.keepOperators=true] - emit operator tokens.
 * @param {boolean} [opts.keepFullIdentifiers=true] - also emit the whole
 *   lowercased identifier (in addition to its sub-words) when it is compound.
 * @param {Set<string>} [opts.stop=STOP] - stop-word set to drop.
 * @returns {string[]} ordered tokens
 */
function tokenize(text, opts) {
  opts = opts || {};
  const keepOps = opts.keepOperators !== false;
  const keepFull = opts.keepFullIdentifiers !== false;
  const stop = opts.stop || STOP;
  const s = String(text == null ? "" : text);
  const out = [];
  const n = s.length;
  let i = 0;

  while (i < n) {
    const c = s[i];

    // Identifier / word run: letters, digits, underscore, and inner separators
    // that denote one logical identifier (., -). We greedily consume a run then
    // split it so dotted/kebab members become multiple tokens.
    if (/[A-Za-z0-9_$]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(s[j])) j++;
      const raw = s.slice(i, j);
      const parts = splitIdentifier(raw);
      const full = raw.replace(/[_$]+/g, "").toLowerCase();
      for (const p of parts) {
        if (stop.has(p)) continue;
        if (!keepNumeric(p)) continue;
        out.push(p);
      }
      // Keep the collapsed full identifier when it is compound and informative,
      // so exact-identifier queries match directly.
      if (keepFull && full && parts.length > 1 && !stop.has(full) && full.length <= 64) {
        out.push(full);
      }
      i = j;
      continue;
    }

    // Operators (greedy, longest-first).
    if (keepOps && OP_FIRST.has(c)) {
      let matched = null;
      for (const op of OPERATORS) {
        if (s.startsWith(op, i)) { matched = op; break; }
      }
      if (matched) { out.push(matched); i += matched.length; continue; }
    }

    i++;
  }
  return out;
}

/**
 * Tokenize into a term-frequency Map (unique term -> count). Convenience wrapper
 * used by the index and the TF-IDF scorer.
 * @param {string} text
 * @param {object} [opts] - forwarded to tokenize()
 * @returns {Map<string, number>}
 */
function termFrequencies(text, opts) {
  const tf = new Map();
  for (const t of tokenize(text, opts)) tf.set(t, (tf.get(t) || 0) + 1);
  return tf;
}

/**
 * Tokenize a query. Same pipeline as documents, with duplicates removed (a query
 * term contributes once to ranking) while preserving first-seen order.
 * @param {string} query
 * @param {object} [opts]
 * @returns {string[]} unique query terms, in first-seen order
 */
function queryTerms(query, opts) {
  const seen = new Set();
  const out = [];
  for (const t of tokenize(query, opts)) {
    if (!seen.has(t)) { seen.add(t); out.push(t); }
  }
  return out;
}

module.exports = {
  STOP, OPERATORS, MAX_NUMERIC_LEN,
  splitIdentifier, tokenize, termFrequencies, queryTerms, keepNumeric,
};
