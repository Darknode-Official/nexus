"use strict";
// ================= Token Accountant / Estimator =================
// A dependency-free, deterministic token estimator plus a savings ledger.
//
// WHY A HEURISTIC: the real tokenizers (tiktoken / the Claude BPE) are large
// data tables we refuse to vendor — this engine ships zero dependencies. For
// BUDGETING (deciding what fits in a context window and attributing savings),
// an estimate within roughly +/-15% is enough, and it is deterministic so the
// context packer and diff builder make stable decisions.
//
// METHOD: byte-pair tokenizers merge frequent character runs into single
// tokens, so a long word rarely costs one-token-per-character. We approximate
// that by splitting text into word runs and "other" characters (punctuation and
// whitespace), estimating each word as ceil(len / charsPerToken), and charging
// the remaining characters at a coarser rate. A per-model-family profile tunes
// the constants. See README.md "Savings methodology" for measured error bars.

// Model-family profiles. `charsPerToken` governs word-run density; `otherDivisor`
// governs how cheaply punctuation/whitespace is charged; `scale` is a final
// correction fitted against published rules of thumb for each family.
const PROFILES = {
  // OpenAI GPT / o-series (cl100k / o200k-ish density).
  gpt:     { charsPerToken: 4.0, otherDivisor: 3.0, scale: 1.00 },
  // Anthropic Claude — historically a slightly denser tokenizer than GPT.
  claude:  { charsPerToken: 3.7, otherDivisor: 2.8, scale: 1.05 },
  // Google Gemini.
  gemini:  { charsPerToken: 4.1, otherDivisor: 3.2, scale: 0.98 },
  // Llama / Mistral / local Ollama models (SentencePiece-style).
  llama:   { charsPerToken: 3.6, otherDivisor: 2.6, scale: 1.04 },
  // Conservative fallback — slightly over-counts so budgets are not blown.
  generic: { charsPerToken: 3.8, otherDivisor: 2.9, scale: 1.03 },
};

// Map a loose model string ("claude-opus-4", "gpt-5", "gemini-2.5-pro",
// "llama3", "qwen2.5-coder") to a profile key. Deterministic, case-insensitive.
function familyOf(model) {
  const m = String(model || "").toLowerCase();
  if (!m) return "generic";
  if (/(claude|anthropic|opus|sonnet|haiku)/.test(m)) return "claude";
  if (/(gpt|o1|o3|o4|codex|openai|davinci)/.test(m)) return "gpt";
  if (/(gemini|palm|bison|google)/.test(m)) return "gemini";
  if (/(llama|mistral|mixtral|qwen|deepseek|phi|gemma|ollama)/.test(m)) return "llama";
  return "generic";
}

function profileOf(model) {
  return PROFILES[familyOf(model)] || PROFILES.generic;
}

/**
 * Estimate the token count of `text` for a given model family.
 * Deterministic: the same input always yields the same number.
 * @param {string} text
 * @param {string} [model] - any model id; mapped to a family profile.
 * @returns {number} estimated tokens (integer, >= 0)
 */
function estimateTokens(text, model) {
  const s = String(text == null ? "" : text);
  if (s.length === 0) return 0;
  const p = profileOf(model);

  // Word runs: letters, digits and the apostrophe inside words.
  const words = s.match(/[A-Za-z0-9]+(?:'[A-Za-z]+)?/g) || [];
  let wordChars = 0;
  let wordTokens = 0;
  for (const w of words) {
    wordChars += w.length;
    wordTokens += Math.max(1, Math.round(w.length / p.charsPerToken));
  }

  // Everything else (punctuation, symbols, whitespace) charged coarsely.
  const otherChars = s.length - wordChars;
  const otherTokens = otherChars > 0 ? Math.ceil(otherChars / p.otherDivisor) : 0;

  return Math.max(1, Math.round((wordTokens + otherTokens) * p.scale));
}

/**
 * Estimate tokens for a provider-style message array. Counts role overhead the
 * way chat APIs do (a few tokens of framing per message).
 * @param {Array<{role?:string, content?:any}>} messages
 * @param {string} [model]
 * @returns {number}
 */
function estimateMessages(messages, model) {
  if (!Array.isArray(messages)) return estimateTokens(messages, model);
  let total = 0;
  for (const msg of messages) {
    total += 3; // per-message framing overhead (role markers, delimiters)
    const c = msg && msg.content;
    if (typeof c === "string") {
      total += estimateTokens(c, model);
    } else if (Array.isArray(c)) {
      for (const block of c) {
        const t = block && (block.text != null ? block.text : block.content);
        total += estimateTokens(typeof t === "string" ? t : JSON.stringify(block), model);
      }
    } else if (c != null) {
      total += estimateTokens(JSON.stringify(c), model);
    }
  }
  return total + 3; // priming overhead for the assistant turn
}

// ================= Savings Ledger =================
// Attributes "tokens saved" to each technique in the engine so the product can
// show a measurable, honest breakdown. Every entry records before/after counts.

class Ledger {
  constructor(model) {
    this.model = model || "generic";
    this.entries = [];
  }

  /**
   * Record a saving. `before`/`after` are token counts (numbers), or pass
   * `beforeText`/`afterText` to have them estimated with this ledger's model.
   * @returns {object} the stored entry
   */
  record(technique, opts) {
    opts = opts || {};
    const before = opts.before != null ? opts.before
      : estimateTokens(opts.beforeText || "", this.model);
    const after = opts.after != null ? opts.after
      : estimateTokens(opts.afterText || "", this.model);
    const saved = Math.max(0, before - after);
    const entry = {
      technique: String(technique || "unknown"),
      before, after, saved,
      savedPct: before > 0 ? +(100 * saved / before).toFixed(1) : 0,
      note: opts.note || "",
      at: Date.now(),
    };
    this.entries.push(entry);
    return entry;
  }

  /** Aggregate saved tokens grouped by technique. */
  byTechnique() {
    const out = {};
    for (const e of this.entries) {
      if (!out[e.technique]) out[e.technique] = { saved: 0, before: 0, after: 0, count: 0 };
      const o = out[e.technique];
      o.saved += e.saved; o.before += e.before; o.after += e.after; o.count++;
    }
    return out;
  }

  /** Total tokens saved across all techniques. */
  totalSaved() {
    return this.entries.reduce((a, e) => a + e.saved, 0);
  }

  /** Total tokens that would have been sent before any technique applied. */
  totalBefore() {
    return this.entries.reduce((a, e) => a + e.before, 0);
  }

  /** Overall percentage of input tokens avoided. */
  overallPct() {
    const b = this.totalBefore();
    return b > 0 ? +(100 * this.totalSaved() / b).toFixed(1) : 0;
  }

  /** Render a compact, human-readable report of attributed savings. */
  report() {
    const by = this.byTechnique();
    const lines = ["Token savings ledger (model family: " + familyOf(this.model) + ")"];
    const names = Object.keys(by).sort((a, b) => by[b].saved - by[a].saved);
    for (const name of names) {
      const o = by[name];
      const pct = o.before > 0 ? (100 * o.saved / o.before).toFixed(1) : "0.0";
      lines.push("  " + name.padEnd(20) + " saved " + o.saved + " tok (" + pct + "%) over " + o.count + " op(s)");
    }
    lines.push("  " + "TOTAL".padEnd(20) + " saved " + this.totalSaved() + " tok (" + this.overallPct() + "%)");
    return lines.join("\n");
  }
}

module.exports = {
  estimateTokens, estimateMessages,
  familyOf, profileOf, PROFILES,
  Ledger,
};
