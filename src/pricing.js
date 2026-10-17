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

// Exact Anthropic list prices, USD per million tokens, from
// https://platform.claude.com/docs/en/about-claude/pricing (checked 2026-10-17).
// Fields: in = base input, cw5 = 5-minute cache write, cw1h = 1-hour cache
// write, cr = cache hit/refresh, out = output. fast = fast-mode in/out (cache
// multipliers apply on top). Haiku 5.5 has a second tier for prompts over
// 100,000 tokens (input incl. cache reads/writes). Bare aliases resolve to the
// newest model of the family, as Claude Code does.
const CLAUDE_PRICES = {
  "fable 5.1":  { in: 10, cw5: 12.5, cw1h: 20, cr: 0.25, out: 50 },
  "mythos 5.1": { in: 10, cw5: 12.5, cw1h: 20, cr: 0.25, out: 50 },
  "fable 5.0":  { in: 10, cw5: 12.5, cw1h: 20, cr: 1, out: 50 },
  "mythos 5.0": { in: 10, cw5: 12.5, cw1h: 20, cr: 1, out: 50 },
  "opus 5.5":   { in: 4, cw5: 5, cw1h: 8, cr: 0.2, out: 20, fast: { in: 8, out: 40 } },
  "opus 5.0":   { in: 5, cw5: 6.25, cw1h: 10, cr: 0.5, out: 25, fast: { in: 10, out: 50 } },
  "opus 4.8":   { in: 5, cw5: 6.25, cw1h: 10, cr: 0.5, out: 25, fast: { in: 10, out: 50 } },
  "opus 4.7":   { in: 5, cw5: 6.25, cw1h: 10, cr: 0.5, out: 25 },
  "opus 4.6":   { in: 5, cw5: 6.25, cw1h: 10, cr: 0.5, out: 25 },
  "opus 4.5":   { in: 5, cw5: 6.25, cw1h: 10, cr: 0.5, out: 25 },
  "opus 4.1":   { in: 15, cw5: 18.75, cw1h: 30, cr: 1.5, out: 75 },
  "opus 4.0":   { in: 15, cw5: 18.75, cw1h: 30, cr: 1.5, out: 75 },
  "sonnet 5.5": { in: 2, cw5: 2.5, cw1h: 4, cr: 0.1, out: 10 },
  "sonnet 5.0": { in: 2, cw5: 2.5, cw1h: 4, cr: 0.2, out: 10 },
  "sonnet 4.6": { in: 3, cw5: 3.75, cw1h: 6, cr: 0.3, out: 15 },
  "sonnet 4.5": { in: 3, cw5: 3.75, cw1h: 6, cr: 0.3, out: 15 },
  "sonnet 4.0": { in: 3, cw5: 3.75, cw1h: 6, cr: 0.3, out: 15 },
  "haiku 5.5":  { in: 0.1, cw5: 0.125, cw1h: 0.2, cr: 0.01, out: 0.5, over100k: { in: 0.5, cw5: 0.625, cw1h: 1, cr: 0.05, out: 2.5 } },
  "haiku 4.5":  { in: 1, cw5: 1.25, cw1h: 2, cr: 0.1, out: 5 },
  "haiku 3.5":  { in: 0.8, cw5: 1, cw1h: 1.6, cr: 0.08, out: 4 },
};
const CLAUDE_LATEST = { opus: "opus 5.5", sonnet: "sonnet 5.5", haiku: "haiku 5.5", fable: "fable 5.1", mythos: "mythos 5.1" };
const PRICING_SOURCE = "https://platform.claude.com/docs/en/about-claude/pricing";
const PRICING_CHECKED = "2026-10-17";

// "claude-opus-5-5", "claude-opus-5-5[1m]", "Opus 5.5", "opus" -> "opus 5.5";
// "claude-opus-4-20250514" -> "opus 4.0"; "claude-3-5-haiku-..." -> "haiku 3.5".
// Returns { key, known } or null when the name is not a Claude model.
function claudeKey(m) {
  const s = String(m || "").toLowerCase();
  const FAM = "opus|sonnet|haiku|fable|mythos";
  let fam = null, maj = null, min = null;
  let x = s.match(new RegExp("(\\d)[-.](\\d)-(" + FAM + ")"));
  if (x) { fam = x[3]; maj = x[1]; min = x[2]; }
  else if ((x = s.match(new RegExp("(" + FAM + ")[-_. ]?(\\d)(?!\\d)(?:[-_.](\\d)(?!\\d))?")))) { fam = x[1]; maj = x[2]; min = x[3] || "0"; }
  else if ((x = s.match(new RegExp("\\b(" + FAM + ")\\b")))) return { key: CLAUDE_LATEST[x[1]], known: true, alias: true };
  else return null;
  const key = fam + " " + maj + "." + min;
  if (CLAUDE_PRICES[key]) return { key, known: true };
  return { key: CLAUDE_LATEST[fam], known: false };
}

// Non-Anthropic engines: input/output only (not re-verified against each
// vendor's page here; Anthropic rows above are exact).
const OTHER_PRICE = [
  [/gemini.*flash|flash/i, { in: 0.3, out: 2.5 }],
  [/gemini/i, { in: 1.25, out: 10 }],
  [/gpt-5|codex/i, { in: 1.25, out: 10 }],
  [/o4|o3|o1\b/i, { in: 1.1, out: 4.4 }],
  [/gpt-4o|gpt-4\.1|gpt-4/i, { in: 2.5, out: 10 }],
  [/gpt-oss|local|ollama/i, { in: 0, out: 0 }],
];
// Kept for callers that iterate the table: [matcher, {in,out}] rows.
const MODEL_PRICE = Object.keys(CLAUDE_LATEST).map((f) => [new RegExp(f, "i"), CLAUDE_PRICES[CLAUDE_LATEST[f]]]).concat(OTHER_PRICE);
const FALLBACK_PRICE = { in: 3, out: 15, known: false };

// priceOf(model, { fast, promptTokens }) -> { in, out, cw5?, cw1h?, cr?, label, known }.
// fast: fast-mode rates (cache rates scale by the same factor). promptTokens:
// selects Haiku 5.5's over-100k tier.
function priceOf(m, opts) {
  opts = opts || {};
  const ck = claudeKey(m);
  if (ck) {
    let p = CLAUDE_PRICES[ck.key];
    if (p.over100k && opts.promptTokens > 100000) p = Object.assign({}, p, p.over100k);
    if (opts.fast && p.fast) { const k = p.fast.in / p.in; p = Object.assign({}, p, { in: p.fast.in, out: p.fast.out, cw5: p.cw5 * k, cw1h: p.cw1h * k, cr: p.cr * k }); }
    const label = ck.key.replace(/^\w/, (c) => c.toUpperCase()).replace(/\.0$/, "");
    return Object.assign({}, p, { label: (/^(fable|mythos|opus|sonnet|haiku)/.test(ck.key) ? "Claude " : "") + label, known: ck.known });
  }
  for (const [re, p] of OTHER_PRICE) if (re.test(String(m || ""))) return Object.assign({}, p, { label: String(m), known: true });
  return Object.assign({ label: String(m || "unknown") }, FALLBACK_PRICE);
}

// Cost of ONE call, from that call's own tokens.
//
// Exists because the cost figures written alongside per-turn token counts were
// taken from the cumulative tracker, so a record read "210,388 in / 38,127 out
// / $293.38" — a per-turn pair of token counts beside a whole-session dollar
// total, ~49x apart. Any caller logging per-turn tokens should price them with
// this, and anything reporting a session total should say so in the name.
function costOf(inTok, outTok, model) {
  const p = priceOf(model);
  return ((inTok || 0) / 1e6) * p.in + ((outTok || 0) / 1e6) * p.out;
}

// costOfUsage(model, { input, output, cacheWrite5m, cacheWrite1h, cacheRead }, opts)
// -> exact list-price USD with every cache bucket at its own rate.
function costOfUsage(m, u, opts) {
  u = u || {};
  const prompt = (u.input || 0) + (u.cacheWrite5m || 0) + (u.cacheWrite1h || 0) + (u.cacheRead || 0);
  const p = priceOf(m, Object.assign({}, opts, { promptTokens: prompt }));
  const cw5 = p.cw5 != null ? p.cw5 : p.in, cw1h = p.cw1h != null ? p.cw1h : p.in, cr = p.cr != null ? p.cr : p.in;
  return ((u.input || 0) * p.in + (u.output || 0) * p.out + (u.cacheWrite5m || 0) * cw5 + (u.cacheWrite1h || 0) * cw1h + (u.cacheRead || 0) * cr) / 1e6;
}

// Claude Code usage object (stream-json result/assistant) -> costOf buckets.
// cache_creation.{ephemeral_5m,ephemeral_1h}_input_tokens split the writes;
// without the split all writes count as 5-minute writes.
function usageBuckets(u) {
  u = u || {};
  const cc = u.cache_creation || {};
  const w1h = cc.ephemeral_1h_input_tokens || 0;
  const w5 = cc.ephemeral_5m_input_tokens != null ? cc.ephemeral_5m_input_tokens : Math.max(0, (u.cache_creation_input_tokens || 0) - w1h);
  return { input: u.input_tokens || 0, output: u.output_tokens || 0, cacheWrite5m: w5, cacheWrite1h: w1h, cacheRead: u.cache_read_input_tokens || 0 };
}

// Rows for a /pricing table: every current Claude model with exact rates.
function pricingTable() {
  return Object.keys(CLAUDE_PRICES).map((k) => Object.assign({ key: k, label: priceOf(k).label }, CLAUDE_PRICES[k]));
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
      // Session totals. Named `...Cumulative` so it cannot be mistaken for the
      // cost of a single turn — that confusion is what produced $6,039 of
      // reported spend against roughly $240 of real API-equivalent usage.
      const apiCostCumulative = (this.cumulativeInputTokens / 1e6) * price.in
        + (this.outputTokens / 1e6) * price.out;

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
          : "$" + apiCostCumulative.toFixed(4),

        // The accurate number users should see
        displayTokens: this.uniqueInputTokens + this.outputTokens,

        // What would this cost on the API (informational only)
        apiEquivalentCumulative: "$" + apiCostCumulative.toFixed(4),
        // Kept under the old name so existing readers do not break.
        apiEquivalent: "$" + apiCostCumulative.toFixed(4),

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

module.exports = { MODEL_PRICE, CLAUDE_PRICES, PRICING_SOURCE, PRICING_CHECKED, claudeKey, priceOf, costOf, costOfUsage, usageBuckets, pricingTable, isMechanical, shouldDelegate, detectBilling, createCostTracker, BILLING_TYPES };
