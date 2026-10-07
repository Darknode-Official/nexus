"use strict";
// WCAG 2.1 contrast ratios for the terminal palette (UI-002 acceptance).
// Reproduces the measured numbers cited in docs/UI-MATRIX.md.
// Run: node tools/contrast.js
const { DARK, LIGHT, hexToRgb } = require("../src/ui/theme");

function lin(c) { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
function L(hex) { const [r, g, b] = hexToRgb(hex); return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b); }
function ratio(a, b) { const hi = Math.max(L(a), L(b)), lo = Math.min(L(a), L(b)); return (hi + 0.05) / (lo + 0.05); }

const TOKENS = [
  "text.primary", "text.secondary", "text.muted",
  "semantic.success", "semantic.warning", "semantic.error",
  "semantic.info", "semantic.accent", "semantic.accentAlt", "role.user",
];

function report(pal, name) {
  const bg = pal["surface.base"];
  console.log(`\n== ${name} (vs surface.base ${bg}) ==`);
  let worst = Infinity;
  for (const tok of TOKENS) {
    const r = ratio(pal[tok], bg);
    worst = Math.min(worst, r);
    const grade = r >= 4.5 ? "AA" : r >= 3 ? "AA-large" : "FAIL";
    console.log(`${tok.padEnd(20)} ${r.toFixed(2).padStart(6)}:1  ${grade}`);
  }
  console.log(`worst: ${worst.toFixed(2)}:1 — ${worst >= 4.5 ? "ALL AA" : "below AA"}`);
  return worst;
}

const dw = report(DARK, "DARK");
const lw = report(LIGHT, "LIGHT");
process.exit(dw >= 4.5 && lw >= 4.5 ? 0 : 1);
