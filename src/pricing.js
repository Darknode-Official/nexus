"use strict";
// Cost model — per-million-token USD (input, output) by model name, plus the
// cowork delegation economics. Pure, dependency-free, unit-tested (test/run.js).

// Order matters — first match wins, so keep specific patterns (flash before
// generic gemini) ahead of broad ones.
const MODEL_PRICE = [
  [/opus/i, { in: 15, out: 75 }], [/sonnet/i, { in: 3, out: 15 }], [/haiku/i, { in: 0.8, out: 4 }], [/fable/i, { in: 1, out: 5 }],
  [/gemini.*flash|flash/i, { in: 0.3, out: 2.5 }], [/gemini/i, { in: 1.25, out: 10 }],
  [/gpt-5|codex/i, { in: 1.25, out: 10 }], [/o4|o3|o1\b/i, { in: 1.1, out: 4.4 }], [/gpt-4o|gpt-4\.1|gpt-4/i, { in: 2.5, out: 10 }],
];
function priceOf(m) { for (const [re, p] of MODEL_PRICE) if (re.test(String(m || ""))) return p; return { in: 3, out: 15 }; }
// Is a task "mechanical" (cheap — safe to run on the weak model)?
function isMechanical(text) { return /\b(run|running|execute|exec|test|tests|lint|format|prettier|build|compile|install|npm|yarn|pnpm|pip|cargo|go build|make|rename|move|copy|delete|remove|mkdir|list|find|search|grep|read|show|print|cat|commit|status|diff|log|clean|typecheck|type-check|check|verify)\b/i.test(String(text || "")) && !/\b(implement|refactor|design|architect|debug|fix the bug|write the|create the|algorithm|optimi[sz]e|redesign|rewrite)\b/i.test(String(text || "")); }
// Estimate whether delegating (est output/input tokens) to `weak` beats the fixed overhead of re-sending context.
function shouldDelegate(estOutTok, estInTok, strong, weak) {
  if (!weak || !strong || weak === strong) return false;
  const sp = priceOf(strong), wp = priceOf(weak);
  if (wp.out >= sp.out) return false; // weak isn't actually cheaper
  const saved = (estOutTok / 1e6) * (sp.out - wp.out) + (estInTok / 1e6) * (sp.in - wp.in);
  const overhead = (2000 / 1e6) * (sp.in + wp.in); // extra context round-trip both ways
  return saved > overhead;
}

module.exports = { MODEL_PRICE, priceOf, isMechanical, shouldDelegate };
