"use strict";
// Cost model — accurate token counting and billing awareness.
//
// KEY INSIGHT: Most Nexus users are on a SUBSCRIPTION (Claude Max $200/mo,
// Pro $20/mo), NOT paying per-token via API. The cost display must reflect this:
//   - Subscription users: show token count, NOT dollar cost (it's misleading)
//   - API users: show dollar cost
//   - Always show: ACTUAL tokens per turn (not cumulative across all turns)
//
// CUMULATIVE vs PER-TURN:
// The old display showed cumulative input tokens (re-sending context each turn
// makes it look like millions of tokens used). Users see "17M tokens, $12"
// and panic — but they're on a flat subscription and the real unique content
// is maybe 50K tokens.

// Per-million-token USD (input, output) — API pricing only
const MODEL_PRICE = [
  [/opus/i, { in: 15, out: 75 }],
  [/sonnet/i, { in: 3, out: 15 }],
  [/haiku/i, { in: 0.8, out: 4 }],
  [/fable/i, { in: 1, out: 5 }],
  [/gemini.*flash|flash/i, { in: 0.3, out: 2.5 }],
  [/gemini/i, { in: 1.25, out: 10 }],
  [/gpt-5|codex/i, { in: 1.25, out: 10 }],
  [/o4|o3|o1\b/i, { in: 1.1, out: 4.4 }],
  [/gpt-4o|gpt-4\.1|gpt-4/i, { in: 2.5, out: 10 }],
  [/gpt-oss|local|ollama/i, { in: 0, out: 0 }],
];

function priceOf(m) {
  for (const [re, p] of MODEL_PRICE) if (re.test(String(m || ""))) return p;
  return { in: 3, out: 15 };
}

// Billing type detection
const BILLING_TYPES = {
  subscription: "subscription",  // flat monthly (Claude Max/Pro, ChatGPT Plus)
  api: "api",                    // pay-per-token
  free: "free",                  // local models (Ollama)
};

function detectBilling(engine, model) {
  const e = String(engine || "").toLowerCase();
  const m = String(model || "").toLowerCase();

  // Local models = free
  if (e === "ollama" || /local|gpt-oss|hermes|dolphin|llama|qwen|deepseek/i.test(m)) {
    return { type: BILLING_TYPES.free, message: "Free — running locally on your machine" };
  }

  // Claude via Claude Code CLI = subscription
  if (e === "claude" && !process.env.ANTHROPIC_API_KEY) {
    return { type: BILLING_TYPES.subscription, message: "Subscription — included in your Claude plan" };
  }

  // API key present = pay-per-token
  if (process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY) {
    return { type: BILLING_TYPES.api, message: "API — pay-per-token" };
  }

  return { type: BILLING_TYPES.subscription, message: "Subscription" };
}

// Accurate cost tracking per session
function createCostTracker() {
  return {
    turns: 0,
    uniqueInputTokens: 0,    // actual unique content (not cumulative re-sends)
    cumulativeInputTokens: 0, // what the API sees (re-sent context each turn)
    outputTokens: 0,
    contextSize: 0,           // current context window usage
    model: "",
    engine: "",
    billing: null,

    recordTurn(inputTok, outputTok, contextTok, model, engine) {
      this.turns++;
      this.cumulativeInputTokens += inputTok || 0;
      this.outputTokens += outputTok || 0;
      this.contextSize = contextTok || this.contextSize;
      if (model) this.model = model;
      if (engine) this.engine = engine;
      if (!this.billing) this.billing = detectBilling(engine, model);

      // Estimate unique tokens: first turn is all unique, subsequent turns
      // only add the new user message + new output as unique
      if (this.turns === 1) {
        this.uniqueInputTokens = inputTok || 0;
      } else {
        // Approximate: new unique content ≈ output from last turn + new user message
        // The rest is re-sent context
        this.uniqueInputTokens += (outputTok || 0) + Math.min(inputTok || 0, 2000);
      }
    },

    summary() {
      const billing = this.billing || detectBilling(this.engine, this.model);
      const price = priceOf(this.model);
      const apiCost = (this.cumulativeInputTokens / 1e6) * price.in + (this.outputTokens / 1e6) * price.out;

      return {
        turns: this.turns,
        uniqueTokens: this.uniqueInputTokens + this.outputTokens,
        cumulativeTokens: this.cumulativeInputTokens + this.outputTokens,
        inputTokens: this.cumulativeInputTokens,
        outputTokens: this.outputTokens,
        contextUsage: this.contextSize,
        model: this.model,
        engine: this.engine,
        billing: billing.type,

        // Cost display depends on billing type
        displayCost: billing.type === "free"
          ? "$0 (local)"
          : billing.type === "subscription"
          ? "Included in plan"
          : "$" + apiCost.toFixed(4),

        // The accurate number users should see
        displayTokens: this.uniqueInputTokens + this.outputTokens,

        // What would this cost on the API (informational only)
        apiEquivalent: "$" + apiCost.toFixed(4),

        // Warning if context is getting full
        contextWarning: this.contextSize > 80 ? "⚠ Context " + this.contextSize + "% full — use /compact or /clear" : null,
      };
    },

    // Format for status bar display
    statusBar() {
      const s = this.summary();
      const parts = [];

      parts.push(this.turns + " turns");

      // Show unique tokens, not cumulative
      if (s.uniqueTokens > 1000000) parts.push(Math.round(s.uniqueTokens / 1000) + "k tok");
      else if (s.uniqueTokens > 1000) parts.push(Math.round(s.uniqueTokens / 1000) + "k tok");
      else parts.push(s.uniqueTokens + " tok");

      // Cost: depends on billing
      parts.push(s.displayCost);

      // Context warning
      if (s.contextWarning) parts.push(s.contextWarning);

      return parts.join(" · ");
    },
  };
}

// Is a task "mechanical" (cheap — safe to delegate to weak model)?
function isMechanical(text) {
  return /\b(run|execute|test|lint|format|build|compile|install|npm|yarn|pip|cargo|rename|move|copy|delete|mkdir|list|find|grep|read|show|cat|commit|status|diff|log|clean|typecheck|check|verify)\b/i.test(String(text || ""))
    && !/\b(implement|refactor|design|architect|debug|fix the bug|write the|create the|algorithm|optimi[sz]e|redesign|rewrite)\b/i.test(String(text || ""));
}

function shouldDelegate(estOutTok, estInTok, strong, weak) {
  if (!weak || !strong || weak === strong) return false;
  const sp = priceOf(strong), wp = priceOf(weak);
  if (wp.out >= sp.out) return false;
  const saved = (estOutTok / 1e6) * (sp.out - wp.out) + (estInTok / 1e6) * (sp.in - wp.in);
  const overhead = (2000 / 1e6) * (sp.in + wp.in);
  return saved > overhead;
}

module.exports = { MODEL_PRICE, priceOf, isMechanical, shouldDelegate, detectBilling, createCostTracker, BILLING_TYPES };
