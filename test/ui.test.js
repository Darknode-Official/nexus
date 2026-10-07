"use strict";
// Deterministic tests for the terminal UI subsystem (UI-001..UI-011).
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const theme = require("../src/ui/theme");
const width = require("../src/ui/width");
const render = require("../src/ui/render");
const box = require("../src/ui/box");
const composer = require("../src/ui/composer");
const plan = require("../src/ui/plan");
const symbols = require("../src/ui/symbols");

const T = (depth, bg = "dark", unicode = true) => theme.makeTheme({ depth, background: bg, unicode, motion: false });

// --- UI-001: depth resolution -----------------------------------------------
test("depth resolves from terminal capability", () => {
  assert.equal(theme.resolveDepth({ COLORTERM: "truecolor" }, { isTTY: true }), "truecolor");
  assert.equal(theme.resolveDepth({ TERM: "xterm-256color" }, { isTTY: true }), "256");
  assert.equal(theme.resolveDepth({ TERM: "xterm" }, { isTTY: true }), "16");
  assert.equal(theme.resolveDepth({ COLORTERM: "truecolor" }, { isTTY: false }), "none", "piped → none");
  assert.equal(theme.resolveDepth({ NO_COLOR: "1" }, { isTTY: true }), "none");
  assert.equal(theme.resolveDepth({ TERM: "dumb" }, { isTTY: true }), "none");
  assert.equal(theme.resolveDepth({ FORCE_COLOR: "3" }, { isTTY: false }), "truecolor");
});

// --- UI-002: background resolution ------------------------------------------
test("background resolves (COLORFGBG + OSC11 + default), never assumes dark blindly", () => {
  assert.equal(theme.resolveBackground({ COLORFGBG: "0;15" }), "light");
  assert.equal(theme.resolveBackground({ COLORFGBG: "15;0" }), "dark");
  assert.equal(theme.resolveBackground({}), "dark"); // configurable default
  assert.equal(theme.resolveBackground({}, { default: "light" }), "light");
  assert.equal(theme.parseOSC11("\x1b]11;rgb:ffff/ffff/ffff\x1b\\"), "light");
  assert.equal(theme.parseOSC11("rgb:1a1a/1a1a/1a1a"), "dark");
});

// --- UI-001: paint output per depth -----------------------------------------
test("paint emits the right escapes per depth and nothing for NO_COLOR", () => {
  assert.equal(T("none").paint("x", "semantic.accent"), "x");
  assert.match(T("truecolor").paint("x", "semantic.accent"), /^\x1b\[38;2;0;212;255m/);
  assert.match(T("256").paint("x", "semantic.accent"), /^\x1b\[38;5;45m/);
  assert.match(T("16").paint("x", "semantic.accent"), /^\x1b\[96m/);
  assert.throws(() => T("truecolor").paint("x", "nonexistent.token"));
});

test("every token is defined in both backgrounds and all mapping tables", () => {
  const tokens = Object.keys(theme.DARK);
  assert.deepEqual(new Set(Object.keys(theme.LIGHT)), new Set(tokens), "light defines every dark token");
  for (const d of ["truecolor", "256", "16"]) {
    for (const bg of ["dark", "light"]) {
      const th = T(d, bg);
      for (const tok of tokens) assert.doesNotThrow(() => th.paint("x", tok), `${tok} @ ${d}/${bg}`);
    }
  }
});

// --- UI-001/UI-011: no escape or color value outside the theme module -------
test("no raw escape sequence outside src/ui/theme.js", () => {
  const files = walk(path.join(__dirname, "..", "src"));
  const offenders = [];
  for (const f of files) {
    if (f.endsWith(path.join("ui", "theme.js"))) continue;
    const src = fs.readFileSync(f, "utf8");
    if (/\\x1b|\\u001b|\\033|\x1b/.test(src)) offenders.push(path.relative(path.join(__dirname, ".."), f));
  }
  assert.deepEqual(offenders, [], "escape sequences found outside the theme module: " + offenders.join(", "));
});

test("no literal hex color inside src/ui except the theme module", () => {
  const files = walk(path.join(__dirname, "..", "src", "ui"));
  const offenders = [];
  for (const f of files) {
    if (f.endsWith("theme.js")) continue;
    const src = fs.readFileSync(f, "utf8");
    if (/#[0-9a-fA-F]{6}\b/.test(src)) offenders.push(path.basename(f));
  }
  assert.deepEqual(offenders, [], "literal colors in UI modules outside theme.js: " + offenders.join(", "));
});

// --- UI-008: width / grapheme handling --------------------------------------
test("display width handles CJK, emoji, flags, combining marks", () => {
  assert.equal(width.stringWidth("hello"), 5);
  assert.equal(width.stringWidth("你好"), 4);          // fullwidth = 2 each
  assert.equal(width.stringWidth("👍🏽"), 2);          // emoji + skin tone = one cluster, width 2
  assert.equal(width.stringWidth("🇯🇵"), 2);          // regional-indicator flag pair = 2
  assert.equal(width.stringWidth("e\u0301"), 1);       // combining accent = 0 width
  assert.equal(width.stringWidth("a\x1b[31mb\x1b[0m"), 2); // ANSI ignored
});

test("truncate never splits a grapheme cluster; wrap respects word boundaries", () => {
  assert.equal(width.stringWidth(width.truncate("你好世界你好", 5)), 5); // 2+2+ellipsis(1)
  assert.deepEqual(width.wrap("the quick brown fox", 9), ["the quick", "brown fox"]);
  // A word longer than the line hard-breaks by clusters without overflow.
  for (const ln of width.wrap("supercalifragilistic", 8)) assert.ok(width.stringWidth(ln) <= 8);
});

// --- UI-005: output rendering -----------------------------------------------
test("tool calls collapse on success and expand on failure", () => {
  const ok = render.toolCall({ name: "Read", args: "a.js", status: "ok", durationMs: 100 }, { width: 80 }, T("none"));
  assert.equal(ok.split("\n").length, 1, "success is one line");
  const bad = render.toolCall({ name: "Bash", args: "t", status: "fail", output: "line1\nline2" }, { width: 80 }, T("none"));
  assert.ok(bad.split("\n").length > 1, "failure expands output");
});

test("diff colors add/remove lines and keeps within width", () => {
  const d = render.diff("@@ -1 +1 @@\n-old\n+new", { width: 40 }, T("truecolor"));
  assert.match(d, /38;2;46;230;166/, "added line uses success color");
  assert.match(d, /38;2;255;92;108/, "removed line uses error color");
});

test("markdown table degrades to key:value past width", () => {
  const md = "| a | b |\n| --- | --- |\n| 1 | 2 |";
  const wide = render.markdown(md, { width: 80 }, T("none"));
  assert.ok(wide.split("\n").length >= 3, "renders header + separator + row");
  assert.match(wide, /[|│]/, "uses a column separator");
  const narrow = render.markdown(md, { width: 6 }, T("none"));
  assert.match(narrow, /a:/, "degrades to key:value when too narrow");
});

test("inline markup survives NO_COLOR as ASCII markers", () => {
  const out = render.markdown("a **b** and `c`", { width: 40 }, T("none"));
  assert.match(out, /\*\*b\*\*/);
  assert.match(out, /`c`/);
});

// --- UI-003: borders ---------------------------------------------------------
test("panel lines are all exactly the requested width (unicode + ascii)", () => {
  for (const uni of [true, false]) {
    const th = T("none", "dark", uni);
    const p = box.panel(th, ["short", "a somewhat longer line of text here"], { width: 50, title: "demo" });
    for (const ln of p.split("\n")) assert.equal(width.stringWidth(ln), 50, (uni ? "unicode" : "ascii") + " row width");
  }
});

// --- UI-004: composer --------------------------------------------------------
test("composer model: editing, kill-to-eol, history preserves partial draft", () => {
  const m = new composer.ComposerModel({ history: ["first", "second"] });
  m.insert("hello world");
  m.wordLeft(); assert.equal(m.cursor, "hello ".length);
  m.killToEnd(); assert.equal(m.text, "hello ");
  m.insert("there");
  m.historyPrev(); assert.equal(m.text, "second");
  m.historyPrev(); assert.equal(m.text, "first");
  m.historyNext(); m.historyNext(); assert.equal(m.text, "hello there", "partial draft restored");
});

test("composer: large paste collapses to a summary line", () => {
  const m = new composer.ComposerModel();
  const res = m.paste("x\n".repeat(50));
  assert.ok(res.collapsed);
  assert.match(m.text, /\[pasted \d+ lines/);
});

test("composer frame rows all match the requested width", () => {
  const th = T("none");
  const frame = composer.renderComposer({ text: "a longer message that will certainly wrap across the inner width of the box", status: { model: "opus-4-8", ctxPct: 50, cost: 0.1, mode: "plan" } }, { width: 60 }, th);
  const rows = frame.split("\n");
  // All rows except the status line are box rows of exact width.
  for (const ln of rows.slice(0, -1)) assert.equal(width.stringWidth(ln), 60);
});

// --- UI-006: plan / confirm --------------------------------------------------
test("destructive confirm is visually distinct from routine", () => {
  const th = T("truecolor");
  const routine = plan.confirm({ question: "run tests?" }, { width: 60 }, th);
  const danger = plan.confirm({ question: "delete?", destructive: true }, { width: 60 }, th);
  assert.match(danger, /DESTRUCTIVE/);
  assert.ok(!/DESTRUCTIVE/.test(routine));
  assert.match(danger, /38;2;255;92;108/, "destructive uses the error color");
});

test("plan step glyphs are symbol-distinct (survive NO_COLOR)", () => {
  const s = symbols.make(true);
  const states = ["done", "running", "failed", "skipped", "pending"].map((st) => plan.stepGlyph(st, s).sym);
  assert.equal(new Set(states).size, states.length, "each state has a distinct symbol");
});

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (e.name.endsWith(".js")) out.push(full);
  }
  return out;
}
