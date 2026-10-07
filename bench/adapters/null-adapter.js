"use strict";
// Reference engine adapter for the NX-110 eval harness. The harness calls
// adapter.run() to execute a task on an engine and adapter.score() to grade the
// output. This NULL adapter runs NO engine: it estimates the input tokens via the
// repo's overhead module and returns correctness = null (unscored). It exists so
// the harness is verifiably runnable end-to-end without credentials.
//
// To get REAL numbers, copy this file and implement run()/score() against an
// authenticated engine (claude/gemini/codex CLI or an API), then point the
// harness at it:  NEXUS_EVAL_ADAPTER=./bench/adapters/my-adapter.js node bench/nx110-eval.js

const path = require("path");
const overhead = require("../../src/overhead");

module.exports = {
  name: "null (no live engine)",

  // Return { output, tokensIn, tokensOut, latencyMs, cost } for one task+engine+seed.
  async run({ task, engine, seed }) {
    const t0 = Date.now();
    const composed = overhead.composeTurn(path.join(__dirname, "..", ".."), task, { intent: "code_edit" });
    return {
      output: null,                 // no engine ran
      tokensIn: composed.finalTokens,
      tokensOut: 0,                 // unknown without a live run
      latencyMs: Date.now() - t0,
      cost: 0,
      live: false,
    };
  },

  // Return true/false (correct?) or null when correctness cannot be scored.
  async score(/* task, output */) {
    return null; // unscored — a real adapter compares output to the task's rubric
  },
};
