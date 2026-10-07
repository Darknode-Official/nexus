"use strict";
// ================= Prompt-Cache Planner =================
// Structures a message array so the provider's PROMPT CACHE hits as often as
// possible. Prompt caching reuses the compute for a stable PREFIX of the request;
// a cached prefix is billed at a large discount (and is faster). The planner:
//   1. Partitions segments into a stable prefix (system, tools, pinned context)
//      and a dynamic tail (the live user turn), preserving given order.
//   2. Emits provider-specific cache controls:
//        - Anthropic: explicit `cache_control: { type: "ephemeral" }` breakpoints
//          on up to 4 segment boundaries (the API's hard limit). Everything up to
//          and including a breakpoint is cached.
//        - OpenAI: caching is AUTOMATIC for identical prefixes >= ~1024 tokens, so
//          there are no breakpoints — the win comes purely from putting stable
//          content first and keeping it byte-identical across calls. The planner
//          reports whether the stable prefix is large enough to qualify.
//   3. Reports estimated cacheable tokens and any ordering problems that would
//      defeat caching (dynamic content ahead of stable content).
//
// A segment is { role, content, stable?, kind?, cacheable? }. `kind` is a hint
// ("system" | "tools" | "context" | "instructions" | "user" | ...). Anything with
// stable === true, or a kind in STABLE_KINDS, is treated as prefix-stable.

const { estimateTokens, estimateMessages } = require("./estimator");

const STABLE_KINDS = new Set(["system", "tools", "context", "instructions", "docs", "schema", "examples"]);

// Minimum prefix tokens at which OpenAI-style automatic caching engages.
const OPENAI_MIN_CACHE_TOKENS = 1024;
// Anthropic allows at most 4 cache_control breakpoints per request.
const ANTHROPIC_MAX_BREAKPOINTS = 4;

function isStable(seg) {
  if (seg.stable === true) return true;
  if (seg.stable === false) return false;
  return STABLE_KINDS.has(String(seg.kind || "").toLowerCase());
}

function normalizeProvider(provider) {
  const p = String(provider || "").toLowerCase();
  if (/(anthropic|claude|opus|sonnet|haiku)/.test(p)) return "anthropic";
  if (/(openai|gpt|o1|o3|o4|codex)/.test(p)) return "openai";
  return "generic";
}

/**
 * Plan a cache-optimized message array.
 * @param {Array<object>} segments
 * @param {object} [opts] - { provider?, model? }
 * @returns {{ provider, messages, breakpoints, stablePrefixTokens, dynamicTokens,
 *             estimatedCacheableTokens, qualifies, reordered, notes }}
 */
function plan(segments, opts) {
  opts = opts || {};
  const provider = normalizeProvider(opts.provider || opts.model);
  const model = opts.model;
  const segs = (segments || []).map((s, i) => ({ ...s, _index: i }));

  // Partition preserving original order within each group.
  const stable = segs.filter(isStable);
  const dynamic = segs.filter((s) => !isStable(s));
  const ordered = [...stable, ...dynamic];

  // Did we have to move anything? (dynamic appearing before stable originally)
  let reordered = false;
  for (let i = 0; i < segs.length; i++) {
    if (segs[i]._index !== ordered[i]._index) { reordered = true; break; }
  }

  const stablePrefixTokens = stable.reduce((a, s) => a + segTokens(s, model), 0);
  const dynamicTokens = dynamic.reduce((a, s) => a + segTokens(s, model), 0);

  const notes = [];
  let breakpoints = [];
  let messages;

  if (provider === "anthropic") {
    // Place cache breakpoints at the end of the stable prefix, favoring the
    // largest stable segments so the biggest reusable chunks are cached. Up to 4.
    // Always keep a breakpoint at the final stable segment (caches the full
    // prefix), then fill the remaining slots with the largest stable segments.
    const bpSet = new Set();
    if (stable.length) bpSet.add(stable.length - 1);
    const ranked = stable
      .map((s, i) => ({ i, t: segTokens(s, model) }))
      .sort((a, b) => b.t - a.t || a.i - b.i);
    for (const r of ranked) {
      if (bpSet.size >= ANTHROPIC_MAX_BREAKPOINTS) break;
      bpSet.add(r.i);
    }

    messages = ordered.map((s, i) => {
      const inStablePrefix = i < stable.length;
      const out = { role: s.role || (isStable(s) ? "system" : "user"), content: s.content };
      if (s.kind) out._kind = s.kind;
      if (inStablePrefix && bpSet.has(i)) {
        out.cache_control = { type: "ephemeral" };
        breakpoints.push({ index: i, kind: s.kind || null, tokens: segTokens(s, model) });
      }
      return out;
    });
    notes.push("Anthropic: " + breakpoints.length + " cache_control breakpoint(s) on the stable prefix (max " + ANTHROPIC_MAX_BREAKPOINTS + ").");
    if (!stable.length) notes.push("No stable segments — nothing to cache. Mark system/tools/context segments stable.");
  } else if (provider === "openai") {
    // No breakpoints; automatic. Just order stable-first and report eligibility.
    messages = ordered.map((s) => {
      const out = { role: s.role || (isStable(s) ? "system" : "user"), content: s.content };
      if (s.kind) out._kind = s.kind;
      return out;
    });
    if (stablePrefixTokens >= OPENAI_MIN_CACHE_TOKENS) {
      notes.push("OpenAI: stable prefix is " + stablePrefixTokens + " tok (>= " + OPENAI_MIN_CACHE_TOKENS + ") — qualifies for automatic prefix caching.");
    } else {
      notes.push("OpenAI: stable prefix is only " + stablePrefixTokens + " tok (< " + OPENAI_MIN_CACHE_TOKENS + ") — below the automatic-cache threshold; cache is unlikely to engage.");
    }
  } else {
    messages = ordered.map((s) => ({ role: s.role || (isStable(s) ? "system" : "user"), content: s.content, _kind: s.kind }));
    notes.push("Generic provider: ordered stable-first; no provider-specific cache controls emitted.");
  }

  if (reordered) notes.push("Reordered segments so all stable content precedes dynamic content (prefix stability is required for any cache hit).");

  const qualifies = provider === "anthropic" ? breakpoints.length > 0
    : provider === "openai" ? stablePrefixTokens >= OPENAI_MIN_CACHE_TOKENS
    : false;

  // Estimated tokens eligible to be served from cache on a repeat call.
  const estimatedCacheableTokens = qualifies ? stablePrefixTokens : 0;

  return {
    provider,
    messages,
    breakpoints,
    stablePrefixTokens,
    dynamicTokens,
    estimatedCacheableTokens,
    qualifies,
    reordered,
    notes,
  };
}

function segTokens(seg, model) {
  const c = seg.content;
  if (typeof c === "string") return estimateTokens(c, model);
  if (Array.isArray(c)) return estimateMessages([{ role: seg.role, content: c }], model);
  return estimateTokens(JSON.stringify(c == null ? "" : c), model);
}

/** Human-readable description of a provider's prompt-cache behavior. */
function describe(provider) {
  const p = normalizeProvider(provider);
  if (p === "anthropic") {
    return "Anthropic prompt caching: opt-in via cache_control:{type:'ephemeral'} on up to 4 content blocks. " +
      "Everything from the start of the request up to and including a breakpoint is cached and reused on subsequent " +
      "calls with an identical prefix (default ~5 min TTL). Put system prompt, tool definitions, and large static " +
      "context first, then set breakpoints at their boundaries. Cache reads are billed at a fraction of input price.";
  }
  if (p === "openai") {
    return "OpenAI prompt caching: automatic for identical prefixes of ~1024+ tokens; no API flags. The reused span " +
      "is the longest matching prefix, so keep system/tool/context content first and byte-identical across calls, and " +
      "place only the volatile user turn at the end. Cached prefix tokens are billed at a discount.";
  }
  return "Generic: order stable content (system, tools, context) first and keep it identical across calls so any " +
    "prefix-cache the provider offers can engage. The volatile user turn goes last.";
}

module.exports = {
  plan, describe, normalizeProvider, isStable,
  STABLE_KINDS, OPENAI_MIN_CACHE_TOKENS, ANTHROPIC_MAX_BREAKPOINTS,
};
