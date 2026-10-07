"use strict";
// ============================================================================
// Deterministic visual-evidence generator (UI-009 verification discipline).
// "Looks good on my terminal" is not verification. This renders every panel and
// output type to text at each color depth, both backgrounds, and widths
// 80/100/120/200, writing an .ansi file (raw escapes) and a .txt file (escapes
// stripped, human/diff-readable) per configuration into docs/ui-evidence/.
// Deterministic: fixed inputs, no timestamps. Run: node tools/ui-snapshot.js
// ============================================================================

const fs = require("fs");
const path = require("path");
const ui = require("../src/ui");
const { stripAnsi } = require("../src/ui/width");

const OUT = path.join(__dirname, "..", "docs", "ui-evidence");
fs.mkdirSync(OUT, { recursive: true });

// --- Fixed sample data (deterministic) --------------------------------------
const SAMPLE = {
  diff: [
    "diff --git a/server.js b/server.js",
    "--- a/server.js",
    "+++ b/server.js",
    "@@ -1,6 +1,8 @@",
    " const express = require('express');",
    " const app = express();",
    "+const rateLimit = require('express-rate-limit');",
    "+app.use(rateLimit({ windowMs: 60000, max: 100 }));",
    " app.use(express.json());",
    "-app.listen(3000);",
    "+app.listen(process.env.PORT || 3000);",
    " // end",
  ].join("\n"),
  md: [
    "# Nexus report",
    "",
    "Added a **token-bucket** limiter and `3 tests`. See the [spec](https://x.io/spec).",
    "",
    "## Changes",
    "",
    "- Rate limiting on all `/api` routes",
    "- Port now reads from the environment",
    "",
    "| file | change | tests |",
    "| --- | --- | --- |",
    "| server.js | +4 -1 | pass |",
    "| config.js | +2 -0 | pass |",
    "",
    "```js",
    "app.use(rateLimit({ windowMs: 60000, max: 100 })); // guard the API",
    "const port = process.env.PORT || 3000;",
    "```",
  ].join("\n"),
};

// --- The scene: every renderable type, in order -----------------------------
function scene(theme, width) {
  const R = ui.render, P = ui.plan, C = ui.composer, B = ui.box;
  const L = [];
  const h = (label) => L.push("", B.labeledRule(theme, label, width), "");

  h("roles");
  L.push(R.roleLine("user", "add rate limiting to the API and run the tests", { width }, theme));
  L.push(R.roleLine("agent", "I'll add a token-bucket limiter, then run the suite.", { width }, theme));
  L.push(R.roleLine("system", "thinking (ctrl+o to show)", { width, indent: 0 }, theme));
  L.push(R.toolCall({ name: "Read", args: "server.js", status: "ok", durationMs: 200 }, { width }, theme));
  L.push(R.toolCall({ name: "Update", args: "server.js", status: "ok", durationMs: 400 }, { width }, theme));
  L.push(R.toolCall({ name: "Bash", args: "npm test", status: "fail", durationMs: 3100, output: "FAIL test/api.js\n  expected 200, received 500\n  at Object.<anonymous> (test/api.js:14:7)" }, { width }, theme));
  L.push(R.roleLine("agent", "Fixed the missing middleware order; tests are green now.", { width }, theme));
  L.push(R.meterLine({ files: 2, cmds: 1, up: 12400, down: 380, cost: 0.03, seconds: 6.2, undo: 1 }, { width }, theme));

  h("diff");
  L.push(R.diff(SAMPLE.diff, { width }, theme));

  h("markdown");
  L.push(R.markdown(SAMPLE.md, { width }, theme));

  L.push("");
  L.push(P.plan([
    { title: "Read server.js and locate the route table", state: "done" },
    { title: "Add a token-bucket rate limiter to /api", state: "running" },
    { title: "Run the test suite", state: "pending" },
    { title: "Deploy to staging", state: "skipped" },
  ], { width, current: 1 }, theme));

  L.push("");
  L.push(P.agentTracks([
    { id: "scout", state: "done", line: "indexed 142 files, 8 hotspots" },
    { id: "builder", state: "running", line: "editing src/api/limiter.js" },
    { id: "tester", state: "pending", line: "queued behind builder" },
  ], { width, focus: "builder" }, theme));

  h("confirmations");
  L.push(P.confirm({ question: "run `npm test`?", destructive: false }, { width }, theme));
  L.push("");
  L.push(P.confirm({ question: "delete 3 files?", detail: "src/old.js\nsrc/dead.js\ntest/stale.js", destructive: true }, { width }, theme));

  h("error");
  L.push(ui.errorBlock({ message: "ENOENT: no such file or directory, open 'config.json'", during: "loading project configuration", next: ["check the file exists at ./config.json", "run `nexus init` to scaffold one"], code: "CFG-404" }, { width }, theme));

  h("composer — awaiting");
  L.push(C.renderComposer({ text: "", status: { model: "opus-4-8", ctxPct: 6, up: 12400, down: 380, cost: 0.03, mode: "auto-accept" } }, { width }, theme));

  h("composer — multiline, working");
  L.push(C.renderComposer({ text: "explain how this sharding strategy holds up under write-heavy load, and whether consistent hashing would reduce rebalancing", working: true, status: { model: "opus-4-8", ctxPct: 72, cost: 0.11, mode: "plan" } }, { width }, theme));

  h("completion overlay (drawn above the composer)");
  L.push(C.renderCompletion([
    { label: "/race", hint: "ask several engines, compare answers" },
    { label: "/review", hint: "cross-engine second opinion" },
    { label: "/diff", hint: "show pending changes" },
    { label: "/commit", hint: "stage and commit with a message" },
  ], 0, { width }, theme));

  return L.join("\n");
}

// --- Configurations to capture ----------------------------------------------
const DEPTHS = ["truecolor", "256", "16", "none"];
const configs = [];
// Primary: all four depths, dark, 100 cols.
for (const d of DEPTHS) configs.push({ name: `${d}-dark-100`, depth: d, background: "dark", width: 100, unicode: true });
// Backgrounds: truecolor + none, light, 100 cols.
configs.push({ name: "truecolor-light-100", depth: "truecolor", background: "light", width: 100, unicode: true });
configs.push({ name: "none-light-100", depth: "none", background: "light", width: 100, unicode: true });
// Width reflow: no-color, dark, 80/120/200.
for (const w of [80, 120, 200]) configs.push({ name: `none-dark-${w}`, depth: "none", background: "dark", width: w, unicode: true });
// ASCII fallback (non-UTF-8 locale), no-color, 80 cols.
configs.push({ name: "none-dark-80-ascii", depth: "none", background: "dark", width: 80, unicode: false });
// 16-color on a light background (hardest legibility case).
configs.push({ name: "16-light-100", depth: "16", background: "light", width: 100, unicode: true });

const index = [];
for (const cfg of configs) {
  const theme = ui.theme.makeTheme({ depth: cfg.depth, background: cfg.background, unicode: cfg.unicode, motion: false });
  const body = scene(theme, cfg.width);
  const header =
    `NEXUS TERMINAL UI — visual evidence\n` +
    `config: depth=${cfg.depth} background=${cfg.background} width=${cfg.width} unicode=${cfg.unicode}\n` +
    `${"=".repeat(Math.min(cfg.width, 100))}\n`;
  fs.writeFileSync(path.join(OUT, cfg.name + ".ansi"), header + body + "\n");
  fs.writeFileSync(path.join(OUT, cfg.name + ".txt"), stripAnsi(header + body) + "\n");
  index.push(cfg.name);
}

fs.writeFileSync(path.join(OUT, "INDEX.txt"),
  "Visual evidence generated by tools/ui-snapshot.js (deterministic).\n" +
  "For each config: <name>.ansi has raw escapes (cat in a real terminal to view\n" +
  "color); <name>.txt has escapes stripped (structure, alignment, diff review).\n\n" +
  index.map((n) => "  " + n).join("\n") + "\n");

console.log("Wrote " + configs.length + " configs (" + configs.length * 2 + " files) to docs/ui-evidence/");
