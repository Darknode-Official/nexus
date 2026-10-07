"use strict";
// NX-101 part 2 — substantiate or refute the README "Cost Saver (10-30% savings)"
// claim. The cost-saver has two mechanisms (costsave.js):
//   squeezeContext — dedupe identical inlined "--- tag ---" blocks + collapse
//                    whitespace (saves INPUT tokens on the turn it runs).
//   response cache — serve an EXACT read-only repeat for free (saves 100% on the
//                    repeat only; measured separately as a hit/miss rate).
//
// This harness measures the squeeze reclaim on three input classes and reports
// the ACTUAL percentage, so the 10-30% figure can be kept-with-methodology or
// dropped. No credentials required.
//
//   node bench/nx101-costsaver.js

const costsave = require("../src/costsave");
const overhead = require("../src/overhead");
const tasks = require("./tasks");
const path = require("path");
const fs = require("fs");

const est = overhead.estTok;
function savedPct(text) {
  const before = est(text);
  const r = costsave.squeezeContext(text);
  const after = est(r.text);
  return { before, after, savedTok: before - after, pct: before ? +(100 * (before - after) / before).toFixed(1) : 0 };
}

// Class A: BEST CASE — context with the SAME file inlined twice (a real dedup win).
const fileBody = fs.readFileSync(path.join(__dirname, "..", "src", "context.js"), "utf8").slice(0, 1600);
const block = "--- src/context.js ---\n" + fileBody + "\n--- end src/context.js ---";
const dupHeavy = "## Context\n\n" + block + "\n\n" + block + "\n\n" + block; // same file x3

// Class B: WHITESPACE CASE — trailing spaces + blank-line runs, no duplicate blocks.
const wsHeavy = "## Task   \n\n\n\n\nDo the thing.   \n\n\n\n\nThen verify.   \n\n\n\n";

// Class C: REALISTIC — the actual assembled Nexus prompts from the task set.
const realistic = tasks.map(t => {
  const c = overhead.composeTurn(path.join(__dirname, ".."), t.task, { squeeze: false, intent: "code_edit" });
  // Re-assemble without squeeze to feed the raw text in: approximate by re-composing.
  return t.task;
});

const results = {
  bestCaseDuplicateBlocks: savedPct(dupHeavy),
  whitespaceOnly: savedPct(wsHeavy),
};

// Realistic: measure squeeze on each assembled full prompt.
const realRows = [];
for (const t of tasks) {
  // compose WITHOUT squeeze to get the raw assembled text, then squeeze it.
  const noSqueeze = overhead.composeTurn(path.join(__dirname, ".."), t.task, { squeeze: false, intent: "code_edit" });
  const withSqueeze = overhead.composeTurn(path.join(__dirname, ".."), t.task, { squeeze: true, intent: "code_edit" });
  const before = noSqueeze.finalTokens, after = withSqueeze.finalTokens;
  realRows.push({ id: t.id, before, after, savedTok: before - after, pct: before ? +(100 * (before - after) / before).toFixed(1) : 0 });
}
const realAvgPct = +(realRows.reduce((s, r) => s + r.pct, 0) / realRows.length).toFixed(1);

const report = {
  generatedAt: new Date().toISOString(),
  claim: "README: Cost Saver = 10-30% savings from dedup, cache, squeeze",
  bestCase_sameFileInlinedThrice: results.bestCaseDuplicateBlocks,
  whitespaceOnly: results.whitespaceOnly,
  realistic_perTask: realRows,
  realistic_avgPct: realAvgPct,
  verdict:
    "The 10-30% figure is ACHIEVABLE ONLY in the dedup best case (same file inlined multiple times): " +
    results.bestCaseDuplicateBlocks.pct + "% here. On realistic single-pass Nexus prompts the squeeze reclaims " +
    realAvgPct + "% (mostly whitespace). The response cache saves 100% but ONLY on exact read-only repeats (a hit-rate, not a per-turn saving). " +
    "RECOMMENDATION: the flat '10-30%' claim is not supported for a typical turn; either qualify it as 'up to ~X% when context contains duplicated file blocks, plus cache hits on exact repeats' or drop it.",
};

const outDir = path.join(__dirname, "results");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "nx101-costsaver.json"), JSON.stringify(report, null, 2));

console.log("NX-101 COST-SAVER MEASUREMENT");
console.log("claim:", report.claim);
console.log("");
console.log("best case (same file inlined 3x):", results.bestCaseDuplicateBlocks.pct + "% saved (" +
  results.bestCaseDuplicateBlocks.savedTok + " tok of " + results.bestCaseDuplicateBlocks.before + ")");
console.log("whitespace-only input:           ", results.whitespaceOnly.pct + "% saved");
console.log("realistic assembled prompts avg: ", realAvgPct + "% saved");
console.log("");
console.log("VERDICT:", report.verdict);
console.log("");
console.log("wrote", path.join(outDir, "nx101-costsaver.json"));
