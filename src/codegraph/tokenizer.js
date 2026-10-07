"use strict";
// ===================== Code Graph — Tokenizer / Masker =====================
// The structural foundation for every language parser. Symbol extraction with
// bare regexes is fragile: a `function` keyword inside a string or comment is a
// false positive, and an unbalanced brace inside a string breaks scope tracking.
// To avoid that, we run a real character-level scanner (a small state machine
// per language) that recognizes strings and comments and *masks* their contents
// — replacing every masked character with a space while preserving newlines and
// total length. The result is a same-length "masked" view of the source in which
// only code (identifiers, keywords, brackets) survives, so a downstream scanner
// can match on it and map any offset straight back to a line/column in the
// original file. This is the piece that makes the parsers robust rather than toy.
//
// mask() is pure and language-driven via a small config table (LANG_RULES).
// lineIndex()/locAt() turn offsets into 1-based line/column positions.

// Per-language lexical rules. `line` = line-comment openers, `block` = [open,
// close] block-comment pairs, `strings` = string delimiters with flags:
//   { q: delimiter, esc: supports backslash escapes, raw: no escapes,
//     multi: may span newlines }
const LANG_RULES = {
  javascript: {
    line: ["//"],
    block: [["/*", "*/"]],
    strings: [
      { q: '"', esc: true }, { q: "'", esc: true },
      { q: "`", esc: true, multi: true }, // template literal (contents masked whole)
    ],
  },
  go: {
    line: ["//"],
    block: [["/*", "*/"]],
    strings: [
      { q: '"', esc: true }, { q: "'", esc: true },
      { q: "`", raw: true, multi: true }, // raw string literal
    ],
  },
  python: {
    line: ["#"],
    block: [],
    // Order matters: triple-quoted forms are tried before single so `"""` is not
    // mis-read as an empty "" followed by a string.
    strings: [
      { q: '"""', esc: true, multi: true }, { q: "'''", esc: true, multi: true },
      { q: '"', esc: true }, { q: "'", esc: true },
    ],
  },
  ruby: {
    line: ["#"],
    block: [["=begin", "=end"]], // only valid at column 0; handled below
    strings: [
      { q: '"', esc: true }, { q: "'", esc: true },
    ],
  },
};

function rulesFor(lang) { return LANG_RULES[lang] || LANG_RULES.javascript; }

// mask(source, lang, opts) -> { masked, original }
// `masked` has the exact same length and newline positions as `source`; every
// character that was inside a comment or string literal is turned into a space.
// opts.keepStrings=true preserves string CONTENTS (still scanning past them so a
// `//` inside a string is not mistaken for a comment) — used for import/export
// scanning, where the module specifier itself is a string literal.
function mask(source, lang, opts) {
  const src = String(source == null ? "" : source);
  const keepStrings = !!(opts && opts.keepStrings);
  const rules = rulesFor(lang);
  const buf = new Array(src.length);
  const n = src.length;
  let i = 0;
  const blank = (from, to) => { for (let k = from; k < to && k < n; k++) buf[k] = src[k] === "\n" ? "\n" : " "; };
  const atLineStart = (pos) => { let k = pos - 1; while (k >= 0 && (src[k] === " " || src[k] === "\t")) k--; return k < 0 || src[k] === "\n"; };

  while (i < n) {
    const c = src[i];

    // Ruby =begin/=end block comments (only when =begin starts a line).
    if (lang === "ruby" && c === "=" && atLineStart(i) && src.startsWith("=begin", i)) {
      let end = src.indexOf("\n=end", i);
      end = end === -1 ? n : src.indexOf("\n", end + 1);
      if (end === -1) end = n;
      blank(i, end); i = end; continue;
    }

    // Line comments.
    let matchedLine = false;
    for (const op of rules.line) {
      if (src.startsWith(op, i)) {
        let end = src.indexOf("\n", i); if (end === -1) end = n;
        blank(i, end); i = end; matchedLine = true; break;
      }
    }
    if (matchedLine) continue;

    // Block comments.
    let matchedBlock = false;
    for (const [op, cl] of rules.block) {
      if (op === "=begin") continue; // handled above for ruby
      if (src.startsWith(op, i)) {
        let end = src.indexOf(cl, i + op.length);
        end = end === -1 ? n : end + cl.length;
        blank(i, end); i = end; matchedBlock = true; break;
      }
    }
    if (matchedBlock) continue;

    // String literals.
    let matchedStr = false;
    for (const s of rules.strings) {
      if (!src.startsWith(s.q, i)) continue;
      const start = i;
      let j = i + s.q.length;
      while (j < n) {
        if (s.esc && src[j] === "\\") { j += 2; continue; }
        if (src.startsWith(s.q, j)) { j += s.q.length; break; }
        if (src[j] === "\n" && !s.multi) break; // unterminated single-line string
        j++;
      }
      if (keepStrings) { for (let k = start; k < j && k < n; k++) buf[k] = src[k]; } else blank(start, j);
      i = j; matchedStr = true; break;
    }
    if (matchedStr) continue;

    buf[i] = c; i++;
  }
  return { masked: buf.join(""), original: src };
}

// lineIndex(text) -> array of character offsets where each 1-based line begins.
// lineStarts[1] is always 0; used for O(log n) offset -> line lookups.
function lineIndex(text) {
  const starts = [0, 0]; // index 0 unused; line 1 starts at offset 0
  const s = String(text == null ? "" : text);
  for (let k = 0; k < s.length; k++) if (s[k] === "\n") starts.push(k + 1);
  return starts;
}

// locAt(lineStarts, offset) -> { line, col } (both 1-based). Binary search.
function locAt(lineStarts, offset) {
  if (offset < 0) offset = 0;
  let lo = 1, hi = lineStarts.length - 1, line = 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lineStarts[mid] <= offset) { line = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return { line, col: offset - lineStarts[line] + 1 };
}

module.exports = { LANG_RULES, rulesFor, mask, lineIndex, locAt };
