"use strict";
// ============================================================================
// Grid-correct width + grapheme handling (UI-008).
// Mis-measured width is the top cause of broken terminal layout: every wrap,
// truncate, box, table, and the composer itself measures through here.
// Dependency-free. Handles CJK/fullwidth (2 cols), combining & zero-width
// marks (0 cols), variation selectors, emoji ZWJ sequences, skin-tone
// modifiers, and regional-indicator flag pairs.
// ============================================================================

// --- Zero-width: combining marks, ZWJ/ZWSP, variation selectors, etc. --------
function isZeroWidth(cp) {
  return (
    cp === 0x200b ||                       // zero-width space
    cp === 0x200d ||                       // zero-width joiner
    cp === 0xfeff ||                       // BOM / zero-width no-break space
    (cp >= 0x0300 && cp <= 0x036f) ||      // combining diacritical marks
    (cp >= 0x0483 && cp <= 0x0489) ||
    (cp >= 0x0591 && cp <= 0x05bd) ||
    (cp >= 0x0610 && cp <= 0x061a) ||
    (cp >= 0x064b && cp <= 0x065f) ||
    (cp >= 0x06d6 && cp <= 0x06dc) ||
    (cp >= 0x0e31 && cp <= 0x0e3a) ||
    (cp >= 0x0e47 && cp <= 0x0e4e) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||      // combining diacritical marks supplement
    (cp >= 0x20d0 && cp <= 0x20ff) ||      // combining marks for symbols
    (cp >= 0xfe00 && cp <= 0xfe0f) ||      // variation selectors (default; VS16 handled separately)
    (cp >= 0xfe20 && cp <= 0xfe2f) ||      // combining half marks
    (cp >= 0xe0100 && cp <= 0xe01ef)       // variation selectors supplement
  );
}

// --- Wide: East Asian Wide/Fullwidth + emoji ranges (2 cols) -----------------
function isWide(cp) {
  return (
    cp === 0x1100 ||
    (cp >= 0x1100 && cp <= 0x115f) ||      // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) ||      // CJK radicals .. Kangxi
    (cp >= 0x3041 && cp <= 0x33ff) ||      // Hiragana .. CJK symbols
    (cp >= 0x3400 && cp <= 0x4dbf) ||      // CJK Ext A
    (cp >= 0x4e00 && cp <= 0x9fff) ||      // CJK Unified
    (cp >= 0xa000 && cp <= 0xa4cf) ||      // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) ||      // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) ||      // CJK compatibility
    (cp >= 0xfe10 && cp <= 0xfe19) ||      // vertical forms
    (cp >= 0xfe30 && cp <= 0xfe6f) ||      // CJK compat forms / small forms
    (cp >= 0xff00 && cp <= 0xff60) ||      // fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||      // fullwidth signs
    (cp >= 0x1f300 && cp <= 0x1f64f) ||    // emoji + symbols
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||    // supplemental symbols/emoji
    (cp >= 0x1fa70 && cp <= 0x1faff) ||    // symbols and pictographs ext A
    (cp >= 0x1f680 && cp <= 0x1f6ff) ||    // transport & map
    (cp >= 0x20000 && cp <= 0x3fffd)       // CJK Ext B+ / supplementary ideographic
  );
}

function isRegionalIndicator(cp) { return cp >= 0x1f1e6 && cp <= 0x1f1ff; }
function isSkinToneModifier(cp) { return cp >= 0x1f3fb && cp <= 0x1f3ff; }
function isControl(cp) { return cp === 0 || (cp >= 0x01 && cp <= 0x1f) || (cp >= 0x7f && cp <= 0x9f); }

// Strip SGR / CSI / OSC escape sequences so measurement counts glyphs only.
const ANSI_RE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;
function stripAnsi(str) { return String(str).replace(ANSI_RE, ""); }

// Width of a single code point (0, 1, or 2).
function codePointWidth(cp) {
  if (cp == null) return 0;
  if (isZeroWidth(cp)) return 0;
  if (isControl(cp)) return 0;
  return isWide(cp) ? 2 : 1;
}

// --- Grapheme segmentation (pragmatic; covers the UI-008 test corpus) --------
// Groups: base + trailing combining marks, VS15/VS16, ZWJ emoji sequences,
// skin-tone modifiers, and regional-indicator pairs (flags).
function graphemes(str) {
  const clean = stripAnsi(str);
  const cps = Array.from(clean, (c) => c.codePointAt(0));
  const out = [];
  let i = 0;
  while (i < cps.length) {
    let start = i;
    const cp = cps[i];
    if (isRegionalIndicator(cp)) {
      // Pair two regional indicators into one flag cluster.
      i++;
      if (i < cps.length && isRegionalIndicator(cps[i])) i++;
    } else {
      i++;
      // Absorb modifiers / combining / VS / ZWJ-joined sequences.
      while (i < cps.length) {
        const n = cps[i];
        if (n === 0x200d) { // ZWJ → absorb joiner AND the next base
          i++;
          if (i < cps.length) i++;
          continue;
        }
        if (isZeroWidth(n) || isSkinToneModifier(n) || n === 0xfe0e || n === 0xfe0f) { i++; continue; }
        break;
      }
    }
    const codes = cps.slice(start, i);
    out.push({ text: String.fromCodePoint(...codes), codes });
  }
  return out;
}

// Width of a grapheme cluster.
function clusterWidth(cluster) {
  const codes = cluster.codes;
  if (codes.some(isRegionalIndicator)) return 2; // flags render double-wide
  // Emoji presentation (VS16) or any wide base → 2; otherwise base width.
  if (codes.includes(0xfe0f)) return 2;
  let w = 0;
  for (const cp of codes) { const cw = codePointWidth(cp); if (cw > w) w = cw; }
  return w || 1;
}

// Display width of a string (ANSI-safe, grapheme-aware).
function stringWidth(str) {
  let w = 0;
  for (const g of graphemes(str)) w += clusterWidth(g);
  return w;
}

// Grapheme-cluster-aware truncate to `max` columns; appends ellipsis (never
// splits a cluster — UI-008).
function truncate(str, max, ellipsis = "…") {
  if (max <= 0) return "";
  if (stringWidth(str) <= max) return str;
  const ellW = stringWidth(ellipsis);
  const budget = Math.max(0, max - ellW);
  let w = 0, out = "";
  for (const g of graphemes(str)) {
    const gw = clusterWidth(g);
    if (w + gw > budget) break;
    out += g.text; w += gw;
  }
  return out + ellipsis;
}

// Pad a string to `width` columns (display-width aware). align: left|right|center.
function pad(str, width, align = "left", fill = " ") {
  const w = stringWidth(str);
  if (w >= width) return str;
  const gap = width - w;
  if (align === "right") return fill.repeat(gap) + str;
  if (align === "center") {
    const l = Math.floor(gap / 2);
    return fill.repeat(l) + str + fill.repeat(gap - l);
  }
  return str + fill.repeat(gap);
}

// Soft-wrap to `width` columns, respecting word boundaries where possible and
// never splitting a grapheme cluster (UI-004 / UI-005).
function wrap(str, width) {
  if (width <= 0) return [str];
  const lines = [];
  for (const paragraph of String(str).split("\n")) {
    if (paragraph === "") { lines.push(""); continue; }
    const words = paragraph.split(/(\s+)/); // keep the whitespace tokens
    let cur = "", curW = 0;
    const flush = () => { lines.push(cur); cur = ""; curW = 0; };
    for (const token of words) {
      const tW = stringWidth(token);
      if (tW === 0) continue;
      if (/^\s+$/.test(token)) {
        if (curW === 0) continue; // drop leading space on a fresh line
        if (curW + tW > width) { flush(); continue; }
        cur += token; curW += tW; continue;
      }
      if (tW > width) {
        // A single word longer than the line: hard-break by clusters.
        if (curW > 0) flush();
        let piece = "", pieceW = 0;
        for (const g of graphemes(token)) {
          const gw = clusterWidth(g);
          if (pieceW + gw > width) { lines.push(piece); piece = ""; pieceW = 0; }
          piece += g.text; pieceW += gw;
        }
        cur = piece; curW = pieceW;
        continue;
      }
      if (curW + tW > width) flush();
      cur += token; curW += tW;
    }
    flush();
  }
  return lines;
}

module.exports = {
  stringWidth, stripAnsi, truncate, pad, wrap, graphemes, clusterWidth,
  codePointWidth, isWide, isZeroWidth, ANSI_RE,
};
