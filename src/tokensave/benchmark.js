"use strict";
// ================= Token-Saving Engine — Benchmark =================
// Runnable, dependency-free demonstration of each technique on sample inputs.
// Prints before/after token counts and the attributed savings ledger.
//
//   node src/tokensave/benchmark.js            # default model family (generic)
//   node src/tokensave/benchmark.js claude     # estimate for a model family
//
// Numbers are HEURISTIC token estimates (see README "Savings methodology").
// The goal is a measurable, honest before/after — not a billing-grade figure.

const { createEngine } = require("./index");
const { estimateTokens } = require("./estimator");

const model = process.argv[2] || "generic";
const eng = createEngine({ model });

function hr() { console.log("-".repeat(70)); }
function pct(before, after) { return before > 0 ? (100 * (before - after) / before).toFixed(1) + "%" : "0%"; }

console.log("Token-Saving Engine benchmark — model family: " + model + "\n");

// ---- 1. Prompt compressor ----
hr();
console.log("1. PROMPT COMPRESSOR (safe: code/paths/URLs/strings/identifiers preserved)");
const verbose = [
  "I would like you to please kindly fix the authentication bug.",
  "Basically, the issue is that the token really just does not refresh.",
  "Could you please make sure that you update the file ./src/auth/session.js",
  "and also please check the endpoint at https://api.example.com/v1/refresh too.",
  "In order to verify, run `npm test` and confirm the refreshToken() path passes.",
  "I would like you to please kindly fix the authentication bug.", // redundant repeat
].join("\n");
for (const level of [0, 1, 2, 3]) {
  const c = require("./compressor").compress(verbose, { level, model });
  console.log("  level " + level + ": " + c.before + " -> " + c.after + " tok (" + c.savedPct + "% saved, " + c.protectedRegions + " protected regions)");
}
const c2 = eng.compress(verbose, 2);
console.log("  compressed (level 2) output:\n");
console.log(c2.text.split("\n").map((l) => "    " + l).join("\n"));

// ---- 2. Semantic cache ----
hr();
console.log("2. NEAR-DUPLICATE SEMANTIC CACHE (SimHash + LSH)");
const cache = createEngine({ model, cache: { maxHamming: 10 } });
const q1 = "how do I scan a host for open ports and running services";
cache.cacheSet(q1, "Use nmap -sV <host> to fingerprint services on open ports.", { tokens: estimateTokens(q1, model) });
const variants = [
  "how do I scan a host for open ports and running services",      // exact
  "how do I scan a host for open ports and running services please", // near-duplicate (filler added)
  "what is the boiling point of water at sea level",              // unrelated
];
for (const v of variants) {
  const r = cache.cacheGet(v);
  console.log("  " + (r.hit ? "HIT  (sim " + r.similarity + ")" : "MISS") + "  <- \"" + v.slice(0, 45) + "...\"");
}
console.log("  cache stats: " + JSON.stringify(cache.cache.stats) + " hitRate=" + cache.cache.hitRate());

// ---- 3. Context packer ----
hr();
console.log("3. CONTEXT PACKER (knapsack under a token budget)");
const chunks = [
  { id: "auth.js", content: "y ".repeat(300), relevance: 0.95 },
  { id: "session.js", content: "y ".repeat(250), relevance: 0.80 },
  { id: "utils.js", content: "y ".repeat(600), relevance: 0.30 },
  { id: "README.md", content: "y ".repeat(900), relevance: 0.10 },
  { id: "config.js", content: "y ".repeat(120), relevance: 0.55 },
];
const budget = 400;
const packed = eng.pack(chunks, budget);
console.log("  budget " + budget + " tok (" + packed.strategy + "):");
console.log(packed.report.split("\n").map((l) => "  " + l).join("\n"));

// ---- 4. Diff-context ----
hr();
console.log("4. DIFF-CONTEXT (changed hunk + neighborhood vs whole file)");
const bigFile = Array.from({ length: 800 }, (_, i) => "  const line" + i + " = compute(" + i + ");").join("\n");
const edited = bigFile.replace("const line400 = compute(400);", "const line400 = compute(400, { retry: true });");
const d = eng.diff(bigFile, edited, { neighbors: 3 });
console.log("  file: " + d.lines.total + " lines / " + d.fullTokens + " tok");
console.log("  minimal context: " + d.lines.shown + " lines / " + d.contextTokens + " tok");
console.log("  saved " + d.saved + " tok (" + d.savedPct + "%)");

// ---- 5. Prompt-cache planner ----
hr();
console.log("5. PROMPT-CACHE PLANNER");
for (const provider of ["claude-opus-4", "gpt-5"]) {
  const plan = createEngine({ model: provider, provider }).planCache([
    { kind: "system", content: "y ".repeat(1500) },
    { kind: "tools", content: "y ".repeat(900) },
    { kind: "user", content: "fix the bug in auth" },
  ]);
  console.log("  " + provider + " -> " + plan.provider + ": qualifies=" + plan.qualifies +
    ", cacheable prefix=" + plan.estimatedCacheableTokens + " tok, breakpoints=" + plan.breakpoints.length);
}

// ---- Ledger ----
hr();
console.log("ATTRIBUTED SAVINGS LEDGER");
console.log(eng.ledger.report().split("\n").map((l) => "  " + l).join("\n"));
console.log("\n  " + eng.summary());
hr();
console.log("Note: token counts are heuristic estimates (" + pct(100, 70) + " example). See README.md.");
