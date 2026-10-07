"use strict";
// ================= Error Recovery — intelligent retry with strategy escalation =================
// When a tool call, command, or AI request fails, the recovery engine doesn't just
// retry blindly — it classifies the error, picks the right recovery strategy, and
// escalates through increasingly aggressive fixes until it works or gives up.

const STRATEGIES = {
  // Network / transient
  retry:       { label: "Simple retry",       delay: 2000, maxAttempts: 3 },
  backoff:     { label: "Exponential backoff", delay: 1000, maxAttempts: 5, multiplier: 2 },
  // AI-specific
  simplify:    { label: "Simplify prompt",     transform: "reduce" },
  switchModel: { label: "Switch to fallback model", transform: "fallback" },
  splitTask:   { label: "Split into subtasks", transform: "decompose" },
  // Command failures
  fixCommand:  { label: "Auto-fix command",    transform: "fix" },
  installDep:  { label: "Install missing dep", transform: "install" },
  // Terminal
  askHuman:    { label: "Ask for help",        terminal: true },
  giveUp:      { label: "Report failure",      terminal: true },
};

// ---- Error classification ----

const ERROR_PATTERNS = [
  // Network
  { pattern: /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|fetch failed/i, category: "network", strategy: ["backoff", "retry"] },
  { pattern: /rate limit|429|too many requests/i, category: "rate_limit", strategy: ["backoff"] },
  { pattern: /timeout|timed out/i, category: "timeout", strategy: ["retry", "simplify"] },

  // Auth
  { pattern: /401|403|unauthorized|forbidden|invalid.*key|invalid.*token/i, category: "auth", strategy: ["askHuman"] },

  // AI-specific
  { pattern: /context.*length|too many tokens|max.*tokens|content.*too.*long/i, category: "context_overflow", strategy: ["simplify", "splitTask"] },
  { pattern: /model.*not.*found|invalid.*model/i, category: "bad_model", strategy: ["switchModel"] },
  { pattern: /safety|content.*filter|blocked|refused/i, category: "content_filter", strategy: ["simplify"] },
  { pattern: /overloaded|capacity|503|500/i, category: "server_error", strategy: ["backoff", "switchModel"] },

  // Command failures
  { pattern: /command not found|not recognized/i, category: "missing_command", strategy: ["installDep", "fixCommand"] },
  { pattern: /No such file|ENOENT/i, category: "missing_file", strategy: ["fixCommand"] },
  { pattern: /permission denied|EACCES/i, category: "permission", strategy: ["fixCommand", "askHuman"] },
  { pattern: /Cannot find module|ModuleNotFoundError|ImportError/i, category: "missing_dep", strategy: ["installDep"] },
  { pattern: /SyntaxError|IndentationError|unexpected token/i, category: "syntax", strategy: ["fixCommand"] },
  { pattern: /ENOMEM|out of memory|heap/i, category: "resource", strategy: ["simplify", "askHuman"] },
  { pattern: /ENOSPC|no space left|disk (?:is )?full/i, category: "disk_full", strategy: ["askHuman"] },

  // Output integrity (NX-108): a truncated or malformed engine response is a
  // systematic fault to re-request once with a simpler prompt, not to retry blindly.
  { pattern: /unexpected end of (?:JSON|input)|truncat|malformed|incomplete (?:response|output)|JSON\.parse/i, category: "malformed_output", strategy: ["simplify", "retry"] },
  // Network loss mid-run (distinct from an initial refused connection).
  { pattern: /socket hang up|network (?:is )?(?:down|unreachable)|EPIPE|connection (?:lost|closed)/i, category: "network_loss", strategy: ["backoff", "retry"] },

  // Git
  { pattern: /merge conflict|CONFLICT/i, category: "merge_conflict", strategy: ["askHuman"] },
  { pattern: /rejected.*non-fast-forward|push.*rejected/i, category: "git_conflict", strategy: ["fixCommand"] },
];

function classifyError(error) {
  const msg = String(error?.message || error || "");
  for (const { pattern, category, strategy } of ERROR_PATTERNS) {
    if (pattern.test(msg)) {
      return { category, strategies: strategy, message: msg, classified: true };
    }
  }
  return { category: "unknown", strategies: ["retry", "giveUp"], message: msg, classified: false };
}

// ---- Recovery executor ----

/**
 * Attempt recovery from an error.
 * @param {object} error - the error
 * @param {object} context - { attempt, maxAttempts, originalInput, engine, model }
 * @param {object} handlers - { retry, simplify, switchModel, splitTask, fixCommand, installDep }
 * @returns {Promise<{ recovered: boolean, result: any, strategy: string, attempts: number }>}
 */
async function recover(error, context, handlers) {
  const classification = classifyError(error);
  const history = [];

  for (const strategyName of classification.strategies) {
    const strategy = STRATEGIES[strategyName];
    if (!strategy) continue;
    if (strategy.terminal) {
      history.push({ strategy: strategyName, result: "terminal", message: strategy.label });
      return { recovered: false, result: null, strategy: strategyName, classification, history };
    }

    const handler = handlers[strategyName];
    if (!handler) continue;

    // Retry with delay
    if (strategy.delay) {
      const maxAttempts = Math.min(strategy.maxAttempts || 3, (context.maxAttempts || 5) - (context.attempt || 0));
      let delay = strategy.delay;
      for (let i = 0; i < maxAttempts; i++) {
        await new Promise(r => setTimeout(r, delay));
        try {
          const result = await handler(context);
          history.push({ strategy: strategyName, attempt: i + 1, result: "success" });
          return { recovered: true, result, strategy: strategyName, classification, history };
        } catch (retryError) {
          history.push({ strategy: strategyName, attempt: i + 1, result: "failed", error: String(retryError.message || retryError).slice(0, 200) });
          if (strategy.multiplier) delay *= strategy.multiplier;
        }
      }
    }

    // Transform strategies
    if (strategy.transform) {
      try {
        const result = await handler(context, strategy.transform);
        history.push({ strategy: strategyName, result: "success" });
        return { recovered: true, result, strategy: strategyName, classification, history };
      } catch (transformError) {
        history.push({ strategy: strategyName, result: "failed", error: String(transformError.message || transformError).slice(0, 200) });
      }
    }
  }

  return { recovered: false, result: null, strategy: "exhausted", classification, history };
}

// ---- Prompt simplification helpers ----

function simplifyPrompt(prompt, level) {
  let text = String(prompt || "");
  if (level >= 1) {
    // Remove code blocks that are just examples
    text = text.replace(/```[\s\S]*?```/g, "[code block removed for brevity]");
  }
  if (level >= 2) {
    // Truncate long sections
    text = text.split("\n").filter(l => l.trim().length > 0).slice(0, 50).join("\n");
  }
  if (level >= 3) {
    // Keep only the core question
    const lines = text.split("\n");
    const questionLines = lines.filter(l => /\?|fix|create|build|explain|find|review/i.test(l));
    text = questionLines.length ? questionLines.join("\n") : lines.slice(0, 10).join("\n");
  }
  return text;
}

function recoverySummary(result) {
  const lines = [`Error: ${result.classification.category} (${result.classification.classified ? "classified" : "unknown"})`];
  for (const h of result.history) {
    lines.push(`  ${h.result === "success" ? "✅" : "❌"} ${h.strategy}${h.attempt ? " (attempt " + h.attempt + ")" : ""}${h.error ? " — " + h.error : ""}`);
  }
  lines.push(result.recovered ? `Recovered via: ${result.strategy}` : `Failed — all strategies exhausted`);
  return lines.join("\n");
}

module.exports = { classifyError, recover, simplifyPrompt, recoverySummary, STRATEGIES, ERROR_PATTERNS };
