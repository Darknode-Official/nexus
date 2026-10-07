"use strict";
// ===================== Refactor — Shared utilities =====================
// Lexical, scope and offset helpers shared by every refactoring. Everything here
// is pure (string in, data out) so the refactorings themselves stay small and the
// tricky bits (masking strings/comments, whole-word code occurrences, block-scoped
// shadow detection, free-variable analysis) live in one tested place.
//
// We lean on the codegraph tokenizer (mask/lineIndex/locAt) and block scanner so
// identifiers inside strings/comments are never misread and brace scopes are real,
// not regex-guessed. Zero third-party dependencies.

const { mask, lineIndex, locAt } = require("../codegraph/tokenizer");
const { scanBlocks, walkBlocks } = require("../codegraph/blocks");

const ID_START = /[A-Za-z_$]/;
const ID_CHAR = /[A-Za-z0-9_$]/;
const ID_RE = /[A-Za-z_$][\w$]*/g;

// Reserved words / common globals that are never treated as free variables or
// rename targets by the heuristics. Conservative on purpose.
const KEYWORDS = new Set([
  "break", "case", "catch", "class", "const", "continue", "debugger", "default",
  "delete", "do", "else", "export", "extends", "finally", "for", "function", "if",
  "import", "in", "instanceof", "new", "return", "super", "switch", "this", "throw",
  "try", "typeof", "var", "void", "while", "with", "yield", "let", "static", "await",
  "async", "of", "as", "from", "get", "set", "true", "false", "null", "undefined",
]);

const GLOBALS = new Set([
  "console", "require", "module", "exports", "process", "Buffer", "global",
  "globalThis", "__dirname", "__filename", "setTimeout", "setInterval",
  "clearTimeout", "clearInterval", "Promise", "Array", "Object", "String",
  "Number", "Boolean", "Math", "JSON", "Date", "RegExp", "Error", "TypeError",
  "RangeError", "Map", "Set", "WeakMap", "WeakSet", "Symbol", "Reflect", "Proxy",
  "parseInt", "parseFloat", "isNaN", "isFinite", "encodeURIComponent",
  "decodeURIComponent", "structuredClone", "queueMicrotask", "fetch", "URL",
]);

/** A legal JS/TS identifier (not a reserved keyword). */
function isValidIdentifier(name) {
  return typeof name === "string" && /^[A-Za-z_$][\w$]*$/.test(name) && !KEYWORDS.has(name);
}

/** mask() for JS/TS: strings + comments blanked to spaces, length preserved. */
function maskJs(source) {
  return mask(source, "javascript").masked;
}

/**
 * mask() that KEEPS string contents (comments still blanked, length preserved).
 * Use when matching module specifiers (which are string literals) so the spec text
 * survives while offsets stay aligned with the original source.
 */
function maskJsSpecs(source) {
  return mask(source, "javascript", { keepStrings: true }).masked;
}

/** 1-based line/column of a character offset within `source`. */
function locOf(source, offset) {
  return locAt(lineIndex(source), offset);
}

/** Array of char offsets where each 1-based line begins (index 0 unused). */
function lineStarts(source) {
  return lineIndex(source);
}

/** Offset at the start of 1-based `line`. Clamped to source length. */
function offsetOfLine(source, line) {
  const starts = lineIndex(source);
  if (line <= 1) return 0;
  if (line >= starts.length) return source.length;
  return starts[line];
}

/** Offset just past the end of 1-based `line` (before its trailing newline removal). */
function offsetAfterLine(source, line) {
  const starts = lineIndex(source);
  if (line + 1 < starts.length) return starts[line + 1];
  return source.length;
}

/**
 * Whole-word occurrences of `name` that live in CODE (not strings/comments).
 * @param {string} source
 * @param {string} name
 * @param {object} [opts] - { skipProperty=true } skip `.name` member accesses;
 *   { masked } pass a precomputed mask to avoid recomputation.
 * @returns {Array<{offset:number, line:number, col:number, afterDot:boolean}>}
 */
function occurrences(source, name, opts) {
  opts = opts || {};
  const skipProperty = opts.skipProperty !== false;
  const masked = opts.masked || maskJs(source);
  const out = [];
  const L = name.length;
  let i = 0;
  const n = masked.length;
  while (i <= n - L) {
    if (
      masked.startsWith(name, i) &&
      !ID_CHAR.test(masked[i - 1] || "") &&
      !ID_CHAR.test(masked[i + L] || "")
    ) {
      // `masked` blanks strings/comments, so a hit here is genuine code.
      let k = i - 1;
      while (k >= 0 && (masked[k] === " " || masked[k] === "\t")) k--;
      const afterDot = masked[k] === ".";
      if (!(skipProperty && afterDot)) {
        const { line, col } = locOf(source, i);
        out.push({ offset: i, line, col, afterDot });
      }
      i += L;
    } else {
      i++;
    }
  }
  return out;
}

/** All identifier tokens in CODE regions of `source`. */
function identifiers(source, opts) {
  opts = opts || {};
  const masked = opts.masked || maskJs(source);
  const out = [];
  let m;
  ID_RE.lastIndex = 0;
  while ((m = ID_RE.exec(masked))) {
    const name = m[0];
    const i = m.index;
    let k = i - 1;
    while (k >= 0 && (masked[k] === " " || masked[k] === "\t")) k--;
    const afterDot = masked[k] === ".";
    out.push({ name, offset: i, afterDot });
  }
  return out;
}

/** Deepest brace block whose body contains `offset`, or null (module scope). */
function enclosingBlock(root, offset) {
  let best = null;
  walkBlocks(root, (b) => {
    if (b.open >= 0 && offset > b.open && offset < b.bodyEnd) {
      if (!best || b.open > best.open) best = b;
    }
  });
  return best;
}

/** True when a block header looks like a function / method / arrow scope. */
function isFunctionBlock(block) {
  if (!block) return false;
  const h = block.header;
  return (
    /\bfunction\b/.test(h) ||
    /=>\s*$/.test(h) ||
    /\)\s*$/.test(h) || // `method(args) {` or `(args) {`
    /\bget\b|\bset\b/.test(h)
  );
}

/** Nearest enclosing function-ish block for `offset` (for var/function scope). */
function enclosingFunctionBlock(root, offset) {
  let best = null;
  walkBlocks(root, (b) => {
    if (b.open >= 0 && offset > b.open && offset < b.bodyEnd && isFunctionBlock(b)) {
      if (!best || b.open > best.open) best = b;
    }
  });
  return best;
}

/**
 * Find binders (declarations) of `name` in `source`, each with the source range it
 * governs. const/let/class are block-scoped (nearest block); var/function are
 * function-scoped (nearest function block); parameters govern their function body.
 * @returns {Array<{offset:number, kind:string, range:[number,number]}>}
 */
function findBinders(source, name) {
  const masked = maskJs(source);
  const root = scanBlocks(masked);
  const fileRange = [0, source.length];
  const binders = [];
  const push = (offset, kind, scopeOffset, fnScoped) => {
    let range;
    const block = fnScoped
      ? enclosingFunctionBlock(root, scopeOffset)
      : enclosingBlock(root, scopeOffset);
    range = block ? [block.open, block.bodyEnd] : fileRange.slice();
    binders.push({ offset, kind, range });
  };

  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // const/let/var NAME  and class NAME (block scoped, except var)
  let re = new RegExp("(?:^|[^.\\w$])(const|let|var|class)\\s+(" + esc + ")\\b", "g");
  let m;
  while ((m = re.exec(masked))) {
    const declKw = m[1];
    const off = m.index + m[0].indexOf(name, m[0].indexOf(declKw));
    push(off, declKw, off, declKw === "var");
  }
  // function NAME (function scoped / hoisted)
  re = new RegExp("(?:^|[^.\\w$])function\\s*\\*?\\s*(" + esc + ")\\b", "g");
  while ((m = re.exec(masked))) {
    const off = m.index + m[0].indexOf(name);
    push(off, "function", off, true);
  }
  // destructured binders: const { NAME } = / const [NAME] =  (approximate, block)
  // Scope is determined from the declaration keyword (before the pattern braces),
  // NOT the name offset — the destructuring `{ }` is a literal, not a real scope.
  re = new RegExp("(?:^|[^.\\w$])(const|let|var)\\s*[\\[{][^\\]}]*\\b(" + esc + ")\\b", "g");
  while ((m = re.exec(masked))) {
    const off = m.index + m[0].lastIndexOf(name);
    const kwOff = m.index + m[0].indexOf(m[1]);
    // Avoid double-counting a plain `const NAME` already captured.
    if (!binders.some((b) => b.offset === off)) push(off, "destructure", kwOff, m[1] === "var");
  }
  // function parameters: scan function/arrow headers containing NAME
  walkBlocks(root, (b) => {
    if (!isFunctionBlock(b)) return;
    const header = masked.slice(b.headerStart, b.open);
    const paren = header.lastIndexOf("(");
    if (paren < 0) return;
    const close = header.indexOf(")", paren);
    if (close < 0) return;
    const params = header.slice(paren + 1, close);
    const pre = new RegExp("(?:^|[^.\\w$])(" + esc + ")\\b");
    const pm = params.match(pre);
    if (pm) {
      const off = b.headerStart + paren + 1 + pm.index + pm[0].indexOf(name);
      // Range spans the header (so the parameter's own declaration token is inside
      // its scope) through the function body.
      binders.push({ offset: off, kind: "param", range: [b.headerStart, b.bodyEnd] });
    }
  });
  // catch (NAME)
  re = new RegExp("catch\\s*\\(\\s*(" + esc + ")\\b", "g");
  while ((m = re.exec(masked))) {
    const off = m.index + m[0].indexOf(name);
    const block = enclosingBlock(root, off);
    // governs the catch block that follows
    const catchBlock = findFollowingBlock(root, off);
    binders.push({ offset: off, kind: "catch", range: catchBlock ? [catchBlock.open, catchBlock.bodyEnd] : (block ? [block.open, block.bodyEnd] : fileRange.slice()) });
  }

  return binders.sort((a, b) => a.offset - b.offset);
}

/** First block whose header starts at/after `offset` (for catch/for bodies). */
function findFollowingBlock(root, offset) {
  let best = null;
  walkBlocks(root, (b) => {
    if (b.open > offset && (!best || b.open < best.open)) best = b;
  });
  return best;
}

/** Every locally-declared name in a file (const/let/var/function/class/param). */
function findBindersAll(source) {
  const masked = maskJs(source);
  const names = new Set();
  let m;
  const re1 = /(?:^|[^.\w$])(?:const|let|var|function\s*\*?|class)\s+([A-Za-z_$][\w$]*)/g;
  while ((m = re1.exec(masked))) names.add(m[1]);
  const re2 = /(?:const|let|var)\s*[[{]([^\]}]*)[\]}]\s*=/g;
  while ((m = re2.exec(masked))) {
    for (const part of m[1].split(",")) { const id = part.trim().match(/([A-Za-z_$][\w$]*)\s*$/); if (id) names.add(id[1]); }
  }
  const root = scanBlocks(masked);
  walkBlocks(root, (b) => {
    if (!isFunctionBlock(b)) return;
    const header = masked.slice(b.headerStart, b.open);
    const paren = header.lastIndexOf("(");
    if (paren < 0) return;
    const close = header.indexOf(")", paren);
    const params = header.slice(paren + 1, close < 0 ? header.length : close);
    let pm;
    const pr = /([A-Za-z_$][\w$]*)/g;
    while ((pm = pr.exec(params))) names.add(pm[1]);
  });
  return [...names];
}

/** Build a codegraph in-memory index over {file, source} records. */
function indexSources(fileObjs) {
  const codegraph = require("../codegraph");
  return codegraph.indexFiles(fileObjs);
}

/** Replace a set of [start,end,text] edits on a string (non-overlapping). */
function applyEdits(source, edits) {
  const sorted = edits.slice().sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  for (const e of sorted) {
    if (e.start < cursor) throw new Error("overlapping edit at " + e.start);
    out += source.slice(cursor, e.start) + e.text;
    cursor = e.end;
  }
  out += source.slice(cursor);
  return out;
}

/** Leading whitespace (indentation) of the line containing `offset`. */
function indentAt(source, offset) {
  let s = offset;
  while (s > 0 && source[s - 1] !== "\n") s--;
  let e = s;
  while (e < source.length && (source[e] === " " || source[e] === "\t")) e++;
  return source.slice(s, e);
}

module.exports = {
  ID_START, ID_CHAR, KEYWORDS, GLOBALS,
  isValidIdentifier, maskJs, maskJsSpecs, locOf, lineStarts, offsetOfLine, offsetAfterLine,
  occurrences, identifiers, enclosingBlock, enclosingFunctionBlock, isFunctionBlock,
  findBinders, findBindersAll, findFollowingBlock, indexSources, applyEdits, indentAt,
  scanBlocks, walkBlocks,
};
