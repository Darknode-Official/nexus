"use strict";
// ===================== Retrieval — Chunker =====================
// Retrieval granularity is a trade-off: whole files are too coarse (one 1000-line
// file drowns the one relevant function and blows the token budget), single lines
// are too fine (no context). The sweet spot for code is the *symbol* — a function,
// method or class. This chunker prefers symbol-aware chunks by reusing the
// codegraph parser's symbol table, and falls back to fixed-size sliding windows
// for files whose language codegraph can't parse (or that have no top-level
// symbols). Every chunk carries a STABLE id and an exact 1-based line span.
//
// Why reuse codegraph rather than re-parse: it already masks strings/comments and
// extracts symbols with precise line numbers across JS/TS/Python/Go/Ruby, with
// zero dependencies — exactly what "symbol-aware chunking" needs.
//
// Stable ids: a chunk id is `${file}::${name}~${ordinal}` where `ordinal`
// disambiguates repeated names in a file. It is derived from symbol *identity and
// order*, NOT absolute line numbers, so inserting code above a function does not
// change its chunk id (only its line span updates). This keeps the persisted
// index stable across edits and keeps provider prompt-cache keys steady.

const parse = require("../codegraph/parse");

const DEFAULTS = {
  maxLines: 120,      // symbol chunks larger than this are sub-split into windows
  windowLines: 60,    // sliding-window size for fallback / oversized symbols
  overlapLines: 10,   // overlap between consecutive windows (context continuity)
  minChunkChars: 1,   // drop empty chunks
};

function lineCount(text) {
  const s = String(text == null ? "" : text);
  if (s.length === 0) return 0;
  return s.split("\n").length;
}

// Slice 1-based inclusive line range [start, end] out of `lines`.
function sliceLines(lines, start, end) {
  return lines.slice(start - 1, end).join("\n");
}

// Build sliding windows over an inclusive line range. Returns [{startLine,endLine}].
function windowSpans(start, end, size, overlap) {
  const spans = [];
  const step = Math.max(1, size - overlap);
  for (let s = start; s <= end; s += step) {
    const e = Math.min(end, s + size - 1);
    spans.push({ startLine: s, endLine: e });
    if (e >= end) break;
  }
  return spans;
}

/**
 * Chunk a single source file into retrieval units.
 * @param {string} file - path/identifier (determines language + id prefix)
 * @param {string} source - full file text
 * @param {object} [opts] - see DEFAULTS
 * @returns {Array<object>} chunks: { id, file, lang, kind, name, startLine,
 *   endLine, content, nLines, symbols[] }
 */
function chunkFile(file, source, opts) {
  opts = Object.assign({}, DEFAULTS, opts || {});
  const text = String(source == null ? "" : source);
  const lines = text.split("\n");
  const total = text.length ? lines.length : 0;
  if (total === 0) return [];

  const parsed = parse.supported(file) ? safeParse(text, file) : null;
  const lang = parsed ? parsed.lang : (parse.detectLang(file) || "text");

  // Anchors: top-level symbols (parent == null) sorted by line. These define the
  // boundaries between symbol chunks. Methods (parent != null) ride inside their
  // class chunk; we record their names for the structural signal.
  const anchors = parsed
    ? (parsed.symbols || [])
        .filter((s) => s.parent == null && s.line >= 1 && s.line <= total)
        .sort((a, b) => a.line - b.line || (a.name < b.name ? -1 : 1))
    : [];

  if (anchors.length === 0) {
    // No symbols → sliding-window fallback (unknown language or data file).
    return windowSpans(1, total, opts.windowLines, opts.overlapLines).map((sp, k) =>
      makeChunk(file, lang, "window", null, sp.startLine, sp.endLine, lines, "win", k, [])
    );
  }

  // De-duplicate anchors sharing a start line (e.g. `export const x = () =>` may
  // be matched by two patterns); keep the first by name order.
  const uniqAnchors = [];
  let lastLine = -1;
  for (const a of anchors) {
    if (a.line === lastLine) continue;
    uniqAnchors.push(a);
    lastLine = a.line;
  }

  const chunks = [];
  const nameOrd = new Map(); // name -> next ordinal (stable ids for repeats)
  const nextOrd = (name) => { const o = nameOrd.get(name) || 0; nameOrd.set(name, o + 1); return o; };

  // Preamble: everything before the first symbol (imports, file header). Indexed
  // so import-only queries and license/header lookups can hit.
  const firstLine = uniqAnchors[0].line;
  if (firstLine > 1) {
    const content = sliceLines(lines, 1, firstLine - 1);
    if (content.trim().length >= opts.minChunkChars) {
      chunks.push(makeChunk(file, lang, "preamble", null, 1, firstLine - 1, lines, "pre", 0,
        symbolsInRange(parsed, 1, firstLine - 1)));
    }
  }

  for (let a = 0; a < uniqAnchors.length; a++) {
    const sym = uniqAnchors[a];
    const start = sym.line;
    const end = a + 1 < uniqAnchors.length ? uniqAnchors[a + 1].line - 1 : total;
    const span = Math.max(1, end - start + 1);
    const ord = nextOrd(sym.name);

    if (span <= opts.maxLines) {
      chunks.push(makeChunk(file, lang, sym.kind, sym.name, start, end, lines, sym.name, ord,
        symbolsInRange(parsed, start, end)));
    } else {
      // Oversized symbol: sub-split into windows but keep the symbol name/kind so
      // the hybrid signal and the "why" explanation still attribute it correctly.
      const wins = windowSpans(start, end, opts.windowLines, opts.overlapLines);
      wins.forEach((sp, w) => {
        chunks.push(makeChunk(file, lang, sym.kind, sym.name, sp.startLine, sp.endLine, lines,
          sym.name, ord, symbolsInRange(parsed, sp.startLine, sp.endLine), w));
      });
    }
  }

  return chunks.filter((c) => c.content.trim().length >= opts.minChunkChars);
}

function safeParse(text, file) {
  try { return parse.parseSource(text, file); } catch (_) { return null; }
}

// Names of every symbol (incl. methods) whose definition line falls in [s, e].
function symbolsInRange(parsed, s, e) {
  if (!parsed) return [];
  return (parsed.symbols || [])
    .filter((sym) => sym.line >= s && sym.line <= e)
    .map((sym) => ({ name: sym.name, kind: sym.kind, line: sym.line, parent: sym.parent || null }));
}

function makeChunk(file, lang, kind, name, startLine, endLine, lines, idName, ord, symbols, winIdx) {
  const content = sliceLines(lines, startLine, endLine);
  let id = file + "::" + idName + "~" + ord;
  if (winIdx != null) id += "#w" + winIdx;
  return {
    id, file, lang, kind,
    name: name || null,
    startLine, endLine,
    nLines: endLine - startLine + 1,
    content,
    symbols: symbols || [],
  };
}

/**
 * Chunk many files at once.
 * @param {Array<{file,source}>} fileObjs
 * @param {object} [opts]
 * @returns {Array<object>} all chunks across files
 */
function chunkFiles(fileObjs, opts) {
  const out = [];
  for (const fo of fileObjs || []) {
    for (const c of chunkFile(fo.file, fo.source, opts)) out.push(c);
  }
  return out;
}

module.exports = { chunkFile, chunkFiles, windowSpans, lineCount, DEFAULTS };
