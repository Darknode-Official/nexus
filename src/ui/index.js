"use strict";
// ============================================================================
// Nexus terminal UI — the single entry point every render path imports.
// One palette, one renderer (UI-011). Nothing outside src/ui/ should contain a
// raw escape sequence or a literal color value; import from here instead.
// ============================================================================

const theme = require("./theme");
const width = require("./width");
const symbols = require("./symbols");
const box = require("./box");
const highlight = require("./highlight");
const render = require("./render");
const composer = require("./composer");
const plan = require("./plan");
const spinner = require("./spinner");
const accessibility = require("./accessibility");

// Initialise from environment + accessibility flags at import time.
accessibility.apply();

// A thin writer so commands never touch process.stdout formatting directly.
function out(str = "") { process.stdout.write(str + "\n"); }
function write(str = "") { process.stdout.write(str); }

module.exports = {
  theme, width, symbols, box, highlight, render, composer, plan, spinner, accessibility,
  // Convenience re-exports of the most-used builders.
  configure: theme.configure,
  getTheme: theme.get,
  paint: (text, token, o) => theme.get().paint(text, token, o),
  roleLine: render.roleLine,
  toolCall: render.toolCall,
  meterLine: render.meterLine,
  diff: render.diff,
  markdown: render.markdown,
  renderComposer: composer.renderComposer,
  renderCompletion: composer.renderCompletion,
  errorBlock: accessibility.errorBlock,
  out, write,
};
