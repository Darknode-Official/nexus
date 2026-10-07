"use strict";
// ================= Prompt Compressor =================
// Local, deterministic, ZERO-TOKEN prompt compression (no LLM calls). Reduces
// the input tokens of a prompt by removing filler, collapsing whitespace and
// boilerplate, and de-duplicating repeated instructions.
//
// SAFETY CONTRACT (never broken at any aggressiveness level): content inside
// fenced code blocks, inline code spans, URLs, file paths, quoted strings, and
// technical identifiers is treated as OPAQUE and is restored byte-for-byte. We
// achieve this by masking every protected span with an unforgeable sentinel
// before any transformation, then unmasking afterwards. Transformations only
// ever see plain prose and sentinel placeholders.
//
// AGGRESSIVENESS LEVELS:
//   0 — whitespace/boilerplate only (lossless for meaning).
//   1 — level 0 + filler-word removal (please, kindly, basically, ...).
//   2 — level 1 + redundant-sentence de-duplication + politeness-phrase cuts.
//   3 — level 2 + low-information connective trimming (most aggressive).

const { estimateTokens } = require("./estimator");

// Sentinel wrapping protected spans. Uses NUL bytes, which never occur in source
// prompts, so it cannot collide with user content.
const SENTINEL_OPEN = "\u0000\u0001";
const SENTINEL_CLOSE = "\u0001\u0000";

// Protected-span matchers, applied IN ORDER. Earlier matchers mask their spans
// first so later matchers never reach inside them.
const PROTECTORS = [
  // Fenced code blocks (``` or ~~~), including the fences and language tag.
  { name: "fenced", re: /(`{3,}|~{3,})[\s\S]*?\1/g },
  // Inline code spans.
  { name: "inline_code", re: /`[^`\n]+`/g },
  // URLs (http/https and bare www.).
  { name: "url", re: /\b(?:https?:\/\/|www\.)[^\s<>()[\]{}"']+/gi },
  // Double- and single-quoted strings (single-line).
  { name: "quoted", re: /"[^"\n]*"|'[^'\n]*'/g },
  // File paths: absolute, relative (./ ../), or any token containing a slash
  // with a filename-ish segment, plus bare filenames with a short extension.
  { name: "path", re: /(?:\.{0,2}\/)[\w.\-/]+|\b[\w\-]+\.[A-Za-z0-9]{1,8}\b/g },
  // Technical identifiers: dotted (a.b.c), namespaced (a::b), snake_case,
  // CONSTANT_CASE, and camelCase.
  { name: "identifier", re: /\b[A-Za-z_$][\w$]*(?:[.:]{1,2}[\w$]+)+\b|\b[A-Za-z_$]*[a-z0-9][A-Z][\w$]*\b|\b[a-z0-9]+_[\w]+\b/g },
];

// Filler words safe to drop in prose (level >= 1). Word-boundary matched,
// case-insensitive, and only in plain text (code/strings are already masked).
const FILLER_WORDS = [
  "basically", "actually", "really", "very", "quite", "just", "simply",
  "essentially", "literally", "obviously", "certainly", "definitely",
  "absolutely", "totally", "completely", "honestly", "frankly", "truly",
  "kindly", "please",
];

// Multi-word politeness / boilerplate phrases removed at level >= 2. Each is a
// case-insensitive regex -> replacement.
const FILLER_PHRASES = [
  { re: /\bi\s+would\s+like\s+you\s+to\b/gi, to: "" },
  { re: /\bi\s+want\s+you\s+to\b/gi, to: "" },
  { re: /\bi'?d\s+like\s+you\s+to\b/gi, to: "" },
  { re: /\bcould\s+you\s+(?:please\s+)?/gi, to: "" },
  { re: /\bcan\s+you\s+(?:please\s+)?/gi, to: "" },
  { re: /\bwould\s+you\s+(?:please\s+)?/gi, to: "" },
  { re: /\bplease\s+go\s+ahead\s+and\b/gi, to: "" },
  { re: /\bmake\s+sure\s+(?:that\s+)?(?:you\s+)?/gi, to: "" },
  { re: /\bin\s+order\s+to\b/gi, to: "to" },
  { re: /\bdue\s+to\s+the\s+fact\s+that\b/gi, to: "because" },
  { re: /\bat\s+this\s+point\s+in\s+time\b/gi, to: "now" },
  { re: /\ba\s+number\s+of\b/gi, to: "several" },
  { re: /\bit\s+is\s+important\s+to\s+note\s+that\b/gi, to: "" },
];

// Low-information connectives trimmed at level 3 (sentence-leading only).
const CONNECTIVE_LEADS = /^(?:so|well|now|then|also|additionally|furthermore|moreover|that said|in addition)[,:]?\s+/i;

/**
 * Mask every protected span. Returns { masked, spans } where `spans` is the
 * ordered list of original substrings keyed by their placeholder index.
 */
function mask(text) {
  const spans = [];
  let masked = text;
  for (const p of PROTECTORS) {
    masked = masked.replace(p.re, (m) => {
      // Do not re-mask a region that is already (or contains) a sentinel.
      if (m.indexOf("\u0000") !== -1 || m.indexOf("\u0001") !== -1) return m;
      const idx = spans.length;
      spans.push(m);
      return SENTINEL_OPEN + idx + SENTINEL_CLOSE;
    });
  }
  return { masked, spans };
}

/** Restore masked spans byte-for-byte. */
function unmask(masked, spans) {
  return masked.replace(/\u0000\u0001(\d+)\u0001\u0000/g, (m, n) => {
    const i = Number(n);
    return i >= 0 && i < spans.length ? spans[i] : m;
  });
}

// Collapse whitespace/boilerplate without touching sentinels.
function collapseWhitespace(text) {
  return text
    .replace(/[ \t]+\n/g, "\n")      // trailing spaces
    .replace(/\n{3,}/g, "\n\n")       // 3+ blank lines -> one blank line
    .replace(/[ \t]{2,}/g, " ")       // runs of spaces/tabs -> single space
    .replace(/^\s+|\s+$/g, "");       // trim ends
}

function removeFillerWords(text) {
  const re = new RegExp("\\b(?:" + FILLER_WORDS.join("|") + ")\\b", "gi");
  return text
    .replace(re, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1"); // tidy space left before punctuation
}

function removeFillerPhrases(text) {
  let out = text;
  for (const f of FILLER_PHRASES) out = out.replace(f.re, f.to);
  return out.replace(/[ \t]{2,}/g, " ").replace(/\s+([,.;:!?])/g, "$1");
}

/**
 * De-duplicate redundant instruction sentences. Splits on line and sentence
 * boundaries, normalizes (lowercase, strip punctuation/placeholders/whitespace),
 * and drops later exact-duplicate sentences while keeping the first occurrence
 * and the original separators. Short fragments (< 15 normalized chars) are never
 * dropped (avoids collapsing things like list bullets or "Yes.").
 */
function dedupeSentences(text) {
  const parts = text.split(/(\n+|(?<=[.!?])\s+)/); // keep separators
  const seen = new Set();
  const out = [];
  for (const part of parts) {
    if (/^\s*$/.test(part) || /^\n+$/.test(part)) { out.push(part); continue; }
    const norm = part
      .replace(/\u0000\u0001\d+\u0001\u0000/g, " ") // ignore masked content in the key
      .toLowerCase().replace(/[^a-z0-9 ]+/g, "").replace(/\s+/g, " ").trim();
    if (norm.length >= 15 && seen.has(norm)) continue; // drop redundant repeat
    if (norm.length >= 15) seen.add(norm);
    out.push(part);
  }
  return out.join("").replace(/\n{3,}/g, "\n\n");
}

function trimConnectives(text) {
  return text.split("\n").map((line) => {
    // Apply per sentence within the line.
    return line.split(/(?<=[.!?])\s+/).map((s) => s.replace(CONNECTIVE_LEADS, "")).join(" ");
  }).join("\n");
}

/**
 * Compress a prompt.
 * @param {string} input
 * @param {object} [opts] - { level?: 0..3, model?: string }
 * @returns {{ text, before, after, saved, savedPct, level, protectedRegions, model }}
 */
function compress(input, opts) {
  opts = opts || {};
  const level = Math.max(0, Math.min(3, opts.level == null ? 2 : opts.level | 0));
  const model = opts.model;
  const original = String(input == null ? "" : input);
  const before = estimateTokens(original, model);

  const { masked, spans } = mask(original);
  let work = masked;

  work = collapseWhitespace(work);                 // level 0+
  if (level >= 1) work = removeFillerWords(work);  // level 1+
  if (level >= 2) { work = removeFillerPhrases(work); work = dedupeSentences(work); } // level 2+
  if (level >= 3) work = trimConnectives(work);    // level 3
  work = collapseWhitespace(work);                 // final tidy

  const text = unmask(work, spans);
  const after = estimateTokens(text, model);
  const saved = Math.max(0, before - after);

  return {
    text,
    before, after, saved,
    savedPct: before > 0 ? +(100 * saved / before).toFixed(1) : 0,
    level,
    protectedRegions: spans.length,
    model: model || "generic",
  };
}

module.exports = {
  compress, mask, unmask,
  collapseWhitespace, removeFillerWords, removeFillerPhrases, dedupeSentences, trimConnectives,
  FILLER_WORDS, FILLER_PHRASES, PROTECTORS,
};
