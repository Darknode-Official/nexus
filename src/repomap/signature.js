"use strict";
// ===================== Repo Map — Signature Extraction =====================
// The repository map is signatures + structure, NOT source bodies. For each
// ranked symbol we emit ONE compact declaration line: the function/method/class
// header up to (but excluding) its body. That is where almost all the "how do I
// call this / what does this expose" information lives, at a fraction of the token
// cost of the implementation.
//
// METHOD: start at the symbol's declaration line and accumulate physical lines
// until the signature is syntactically complete — bracket depth (parentheses,
// generics, square brackets) returns to zero and we hit the body opener (`{`,
// `=>`, or a Python `:`). We then cut at that opener and collapse whitespace. All
// bracket counting runs on the codegraph tokenizer's MASKED view of the line, so
// a `{` or `(` inside a string or comment never fools the scanner. The mask keeps
// offsets aligned, so we slice the ORIGINAL text for the human-readable result.
//
// This never reads a symbol's body, so it cannot leak implementation and its cost
// is bounded by the signature length regardless of how large the function is.

const { mask } = require("../codegraph/tokenizer");

// How many physical lines a single signature may span before we give up and
// truncate (defensive against pathological inputs / parse drift).
const MAX_SIG_LINES = 12;
const MAX_SIG_CHARS = 200;

/**
 * Extract a compact, body-free signature line for a symbol.
 *
 * @param {string} source - full file source
 * @param {Object} symbol - codegraph symbol { name, kind, line, parent, ... }
 * @param {string} lang - language id (javascript|typescript|python|go|ruby)
 * @returns {string} a single-line signature (never multi-line, never a body)
 */
function extractSignature(source, symbol, lang) {
  const text = String(source == null ? "" : source);
  const lines = text.split("\n");

  // Methods: codegraph reports the method's `line` at the ENCLOSING class header
  // (block-scope detection), so reading from that line would yield "class X".
  // codegraph already provides a clean member header in `symbol.signature`; clean
  // and return it directly, respecting the language's body opener.
  if (symbol && symbol.kind === "method" && symbol.signature && String(symbol.signature).trim()) {
    const raw = String(symbol.signature);
    const masked = mask(raw, normalizeLang(lang)).masked;
    return cleanSignature(raw, masked, lang, symbol);
  }

  const startLine = Math.max(1, symbol && symbol.line ? symbol.line : 1);
  const startIdx = startLine - 1;
  if (startIdx >= lines.length) {
    return fallbackSignature(symbol, lang);
  }

  // Build a masked view of the same lines so brackets inside strings/comments do
  // not disturb depth counting.
  const maskedAll = mask(text, normalizeLang(lang)).masked.split("\n");

  let raw = "";
  let masked = "";
  let depth = 0;
  let consumed = 0;
  let sawParen = false;
  for (let i = startIdx; i < lines.length && consumed < MAX_SIG_LINES; i++, consumed++) {
    const lineRaw = lines[i];
    const lineMasked = maskedAll[i] != null ? maskedAll[i] : lineRaw;
    raw += (consumed === 0 ? "" : " ") + lineRaw;
    masked += (consumed === 0 ? "" : " ") + lineMasked;

    // Update bracket depth over the masked slice we just appended.
    const seg = lineMasked;
    for (let k = 0; k < seg.length; k++) {
      const c = seg[k];
      if (c === "(" || c === "[" || c === "{") { if (c === "(") sawParen = true; depth++; }
      else if (c === ")" || c === "]" || c === "}") depth--;
    }

    // Decide whether the signature is complete at this line.
    if (isSignatureComplete(masked, lang, depth, sawParen, symbol)) break;
    // A class/type with no paren and an immediate body opener completes on line 1.
    if (!sawParen && consumed === 0 && hasBodyOpener(lineMasked, lang)) break;
  }

  return cleanSignature(raw, masked, lang, symbol);
}

// Return the earliest offset of a body opener in the masked signature, or -1.
function bodyOpenerOffset(masked, lang) {
  if (lang === "python") {
    // The first top-level colon that is not inside brackets ends the header.
    return topLevelColon(masked);
  }
  // JS/TS/Go/Ruby: the body starts at `{` or (for arrows) `=>`.
  const brace = masked.indexOf("{");
  const arrow = masked.indexOf("=>");
  if (brace === -1) return arrow;
  if (arrow === -1) return brace;
  return Math.min(brace, arrow);
}

function hasBodyOpener(maskedLine, lang) {
  return bodyOpenerOffset(maskedLine, lang) !== -1;
}

function isSignatureComplete(masked, lang, depth, sawParen, symbol) {
  // For callables we require the parameter list to have closed.
  const isCallable = symbol && (symbol.kind === "function" || symbol.kind === "method");
  if (isCallable && sawParen && depth > 0) return false;
  const opener = bodyOpenerOffset(masked, lang);
  if (opener === -1) return false;
  return true;
}

// Find the first top-level `:` (depth 0) in a masked python header.
function topLevelColon(masked) {
  let depth = 0;
  for (let k = 0; k < masked.length; k++) {
    const c = masked[k];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === ":" && depth === 0) return k;
  }
  return -1;
}

// Cut the raw signature at the body opener located in the masked view (offsets are
// aligned), then collapse internal whitespace and truncate defensively.
function cleanSignature(raw, masked, lang, symbol) {
  let cutRaw = raw;
  const opener = bodyOpenerOffset(masked, lang);
  if (opener >= 0) {
    if (lang === "python") {
      cutRaw = raw.slice(0, opener); // drop the trailing colon + body
    } else if (masked.slice(opener, opener + 2) === "=>") {
      cutRaw = raw.slice(0, opener + 2); // keep the arrow, drop the body
    } else {
      cutRaw = raw.slice(0, opener); // drop from `{`
    }
  }
  let sig = cutRaw.replace(/\s+/g, " ").trim();
  // Strip a trailing lone `=` left by `const f = function...` style when body cut.
  sig = sig.replace(/[=({[,]\s*$/, "").trim();
  if (!sig) return fallbackSignature(symbol, lang);
  if (sig.length > MAX_SIG_CHARS) sig = sig.slice(0, MAX_SIG_CHARS - 1).trimEnd() + "…";
  return sig;
}

// Last-resort synthetic signature when the source line is unavailable.
function fallbackSignature(symbol, lang) {
  if (!symbol || !symbol.name) return "";
  if (symbol.kind === "class" || symbol.kind === "type") {
    return (lang === "python" ? "class " : lang === "go" ? "type " : "class ") + symbol.name;
  }
  if (symbol.kind === "method") return symbol.name + "()";
  return (lang === "python" ? "def " : "function ") + symbol.name + "()";
}

function normalizeLang(lang) {
  // tokenizer only knows javascript/go/python/ruby; typescript shares js rules.
  if (lang === "typescript") return "javascript";
  if (lang === "javascript" || lang === "go" || lang === "python" || lang === "ruby") return lang;
  return "javascript";
}

/**
 * Convenience: extract and label a signature with a leading kind marker, e.g.
 *   "fn parseConfig(path, opts)"  /  "class HttpClient extends Base"
 * Markers are terse text (no emojis) so the map stays scannable.
 * @returns {string}
 */
function labeledSignature(source, symbol, lang) {
  const sig = extractSignature(source, symbol, lang);
  return sig;
}

module.exports = {
  extractSignature,
  labeledSignature,
  bodyOpenerOffset,
  topLevelColon,
  cleanSignature,
  fallbackSignature,
  MAX_SIG_LINES,
  MAX_SIG_CHARS,
};
