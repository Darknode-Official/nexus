"use strict";
// ================= Metacognition Engine — AI that reasons about its own reasoning =================
//
// WHAT THIS IS:
// Most AI agents blindly generate output. This module makes the agent AWARE of its own
// cognitive state: confidence, uncertainty, knowledge boundaries, and reasoning quality.
// It decides WHEN to proceed vs ask for help, WHEN to verify vs trust its output, and
// WHEN to switch strategies because the current approach isn't working.
//
// RESEARCH BASIS:
// - Reflexion (Shinn et al. 2023): agents that reflect on failures and adjust
// - Calibration research: LLMs are poorly calibrated — confidence ≠ accuracy
// - Metacognitive monitoring: know-what-you-know, know-what-you-don't-know
// - Cognitive load theory: when the task exceeds working capacity, quality drops
//
// THE KEY INSIGHT:
// Instead of asking "what should I do?" the agent also asks:
//   "How confident am I?"
//   "Am I stuck in a loop?"
//   "Is my approach actually working?"
//   "Should I try something completely different?"
//   "Do I need information I don't have?"

// ---- Confidence Estimation ----

const UNCERTAINTY_SIGNALS = [
  // Linguistic hedging in the agent's own output
  { pattern: /\b(maybe|perhaps|might|could be|not sure|uncertain|possibly|I think|I believe|it seems)\b/gi, weight: 0.15 },
  // Self-contradiction
  { pattern: /\b(actually|wait|no,|correction|I was wrong|on second thought)\b/gi, weight: 0.25 },
  // Vague quantifiers
  { pattern: /\b(some|few|many|often|sometimes|usually|generally)\b/gi, weight: 0.05 },
  // Questions to self
  { pattern: /\?\s*$/gm, weight: 0.1 },
  // Excessive alternatives listed
  { pattern: /\b(alternatively|another option|or we could|option [A-D])\b/gi, weight: 0.1 },
];

/**
 * Estimate confidence from the agent's own generated text.
 * Low confidence → should verify, ask for help, or try different approach.
 * @param {string} agentOutput - what the agent generated
 * @returns {{ confidence: number, signals: string[], shouldVerify: boolean, shouldAsk: boolean }}
 */
function estimateConfidence(agentOutput) {
  const text = String(agentOutput || "");
  if (!text.trim()) return { confidence: 0, signals: ["empty output"], shouldVerify: true, shouldAsk: true };

  let totalPenalty = 0;
  const signals = [];

  for (const { pattern, weight } of UNCERTAINTY_SIGNALS) {
    pattern.lastIndex = 0;
    const matches = text.match(pattern) || [];
    if (matches.length > 0) {
      const penalty = Math.min(weight * matches.length, weight * 5); // cap per-signal
      totalPenalty += penalty;
      signals.push(`${matches.length}× ${pattern.source.slice(0, 30)}...`);
    }
  }

  // Length-based adjustment: very short answers on complex questions = low confidence
  const wordCount = text.split(/\s+/).length;
  if (wordCount < 20) { totalPenalty += 0.2; signals.push("very short response"); }
  if (wordCount > 2000) { totalPenalty += 0.05; signals.push("very long response (may be unfocused)"); }

  // Code vs prose ratio: code-heavy = likely more concrete/confident
  const codeBlocks = (text.match(/```[\s\S]*?```/g) || []).length;
  if (codeBlocks > 0) totalPenalty -= 0.1; // bonus for concrete code

  const confidence = Math.max(0, Math.min(1, 1 - totalPenalty));
  return {
    confidence,
    signals,
    shouldVerify: confidence < 0.7,
    shouldAsk: confidence < 0.4,
  };
}

// ---- Stuck Detection ----

/**
 * Detect if the agent is stuck in a loop or making no progress.
 * @param {Array<{action, result, timestamp}>} history - recent action history
 * @returns {{ stuck: boolean, reason: string, suggestion: string }}
 */
function detectStuck(history) {
  if (!history || history.length < 3) return { stuck: false, reason: "too few actions", suggestion: "" };

  // 1. Repeating the same action
  const lastActions = history.slice(-5).map(h => h.action);
  const uniqueActions = new Set(lastActions);
  if (uniqueActions.size <= 1 && lastActions.length >= 3) {
    return { stuck: true, reason: "Repeating the same action " + lastActions.length + " times", suggestion: "Try a completely different approach. Step back and reconsider the problem." };
  }

  // 2. Oscillating between two states
  if (lastActions.length >= 4) {
    const isOscillating = lastActions.every((a, i) => a === lastActions[i % 2]);
    if (isOscillating) {
      return { stuck: true, reason: "Oscillating between two actions", suggestion: "Break the cycle. Try a third, unrelated approach or ask for clarification." };
    }
  }

  // 3. Consecutive failures
  const lastResults = history.slice(-4).map(h => h.result);
  const consecutiveFailures = lastResults.filter(r => r === "error" || r === "failed").length;
  if (consecutiveFailures >= 3) {
    return { stuck: true, reason: consecutiveFailures + " consecutive failures", suggestion: "The current strategy isn't working. Try: 1) Simplify the task, 2) Gather more information, 3) Ask the user for guidance." };
  }

  // 4. Time-based: spending too long on one sub-task
  if (history.length >= 2) {
    const elapsed = (history[history.length - 1].timestamp || 0) - (history[0].timestamp || 0);
    if (elapsed > 300000 && history.length > 10) { // 5 min + 10 actions
      return { stuck: true, reason: "Spent 5+ minutes with 10+ actions on this sub-task", suggestion: "This sub-task is taking too long. Consider decomposing it further or marking it as blocked." };
    }
  }

  return { stuck: false, reason: "making progress", suggestion: "" };
}

// ---- Strategy Evaluation ----

/**
 * Evaluate whether the current strategy is working.
 * @param {Array<{action, result, timestamp, progress}>} history
 * @returns {{ effective: boolean, progressRate: number, recommendation: string }}
 */
function evaluateStrategy(history) {
  if (!history || history.length < 2) return { effective: true, progressRate: 1, recommendation: "continue" };

  const successes = history.filter(h => h.result === "success" || h.result === "ok").length;
  const total = history.length;
  const successRate = total > 0 ? successes / total : 0;

  // Check if progress is being made (actions producing new information or changes)
  const progressActions = history.filter(h => h.progress && h.progress > 0).length;
  const progressRate = total > 0 ? progressActions / total : 0;

  let recommendation;
  if (successRate > 0.7 && progressRate > 0.5) {
    recommendation = "continue";
  } else if (successRate > 0.5 && progressRate > 0.3) {
    recommendation = "refine";
  } else if (successRate > 0.3) {
    recommendation = "pivot";
  } else {
    recommendation = "abandon";
  }

  return {
    effective: recommendation === "continue" || recommendation === "refine",
    progressRate,
    successRate,
    recommendation,
    detail: {
      continue: "Strategy is working — keep going",
      refine: "Partially working — adjust the approach but keep the general direction",
      pivot: "Not effective — try a fundamentally different approach",
      abandon: "Failing — stop, reassess the problem, or ask for help",
    }[recommendation],
  };
}

// ---- Knowledge Boundary Detection ----

/**
 * Detect when the agent is operating outside its knowledge boundaries.
 * @param {string} task - what's being asked
 * @param {object} workspace - project workspace profile
 * @returns {{ withinBounds: boolean, unknowns: string[], suggestions: string[] }}
 */
function detectKnowledgeBoundary(task, workspace) {
  const lower = String(task || "").toLowerCase();
  const unknowns = [];
  const suggestions = [];

  // Domain-specific knowledge the agent may lack
  const specializedDomains = [
    { domain: "hardware", re: /\b(fpga|verilog|vhdl|pcb|firmware|microcontroller|arduino|embedded)\b/i },
    { domain: "ML/AI training", re: /\b(train|fine-?tune|dataset|epoch|batch size|learning rate|gradient|backprop)\b/i },
    { domain: "blockchain", re: /\b(solidity|smart contract|ethereum|web3|defi|nft|consensus)\b/i },
    { domain: "game engine", re: /\b(unity|unreal|godot|shader|vertex|mesh|collision|rigidbody)\b/i },
    { domain: "mobile native", re: /\b(swift ?ui|kotlin|jetpack compose|react native|flutter|xcode|android studio)\b/i },
    { domain: "infrastructure", re: /\b(terraform|kubernetes|helm|istio|service mesh|load balancer)\b/i },
    { domain: "data engineering", re: /\b(spark|hadoop|kafka|airflow|dbt|data lake|etl|data pipeline)\b/i },
  ];

  for (const { domain, re } of specializedDomains) {
    if (re.test(lower)) {
      unknowns.push(domain);
      suggestions.push(`Consider using MCP servers or documentation tools for ${domain}-specific knowledge`);
    }
  }

  // Check if the project uses technologies the agent hasn't seen in context
  if (workspace) {
    const lang = workspace.primaryLanguage;
    if (lang && !["javascript", "typescript", "python"].includes(lang)) {
      unknowns.push(`${lang} (less common — may need language-specific references)`);
      suggestions.push(`Use context7 MCP server for up-to-date ${lang} documentation`);
    }
  }

  // Check for external system dependencies
  if (/\b(api|endpoint|webhook|external service|third-party)\b/i.test(lower)) {
    suggestions.push("May need to fetch external API documentation — use the fetch MCP tool");
  }

  return {
    withinBounds: unknowns.length === 0,
    unknowns,
    suggestions,
    confidence: unknowns.length === 0 ? 0.9 : Math.max(0.3, 0.9 - unknowns.length * 0.15),
  };
}

// ---- Cognitive Load Monitor ----

/**
 * Estimate the cognitive load of the current task.
 * High load → decompose further, use stronger model, add verification steps.
 * @param {string} task
 * @param {object} context - { filesInvolved, dependencyDepth, crossCutting }
 * @returns {{ load: 'low'|'medium'|'high'|'extreme', factors: string[], mitigations: string[] }}
 */
function estimateCognitiveLoad(task, context) {
  context = context || {};
  const factors = [];
  let score = 0;

  const lower = String(task || "").toLowerCase();

  // Task complexity signals
  if (lower.length > 500) { score += 1; factors.push("long task description"); }
  if ((lower.match(/\band\b/g) || []).length > 3) { score += 1; factors.push("multiple sub-requirements"); }
  if (/\b(all|every|each|entire|whole|across)\b/.test(lower)) { score += 1; factors.push("broad scope"); }
  if (/\b(without breaking|backward.?compat|don't break|safely)\b/i.test(lower)) { score += 1; factors.push("safety constraints"); }
  if (/\b(concurrent|parallel|async|race|deadlock|atomic)\b/i.test(lower)) { score += 2; factors.push("concurrency reasoning"); }
  if (/\b(migrate|upgrade|port|convert)\b/i.test(lower)) { score += 1; factors.push("migration (state transformation)"); }

  // Context complexity
  if (context.filesInvolved > 10) { score += 1; factors.push(`${context.filesInvolved} files involved`); }
  if (context.filesInvolved > 30) { score += 1; factors.push("very large change surface"); }
  if (context.dependencyDepth > 5) { score += 1; factors.push("deep dependency chain"); }
  if (context.crossCutting) { score += 1; factors.push("cross-cutting concern"); }

  let load, mitigations = [];
  if (score <= 2) {
    load = "low";
  } else if (score <= 4) {
    load = "medium";
    mitigations.push("Break into 2-3 focused sub-tasks");
  } else if (score <= 6) {
    load = "high";
    mitigations.push("Decompose into independent sub-tasks");
    mitigations.push("Use multi-agent fan-out for independent parts");
    mitigations.push("Add verification steps between phases");
  } else {
    load = "extreme";
    mitigations.push("MUST decompose — this is too complex for a single pass");
    mitigations.push("Use planning mode first to map the approach");
    mitigations.push("Route to the strongest available model");
    mitigations.push("Add checkpoints: verify after each major step");
  }

  return { load, score, factors, mitigations };
}

// ---- Metacognitive Prompt Injection ----

/**
 * Generate metacognitive instructions to inject into the agent's system prompt.
 * These make the agent SELF-AWARE of its limitations.
 */
function metacognitivePrompt(task, context) {
  const confidence = context?.confidence || 0.7;
  const load = estimateCognitiveLoad(task, context);
  const boundary = detectKnowledgeBoundary(task, context?.workspace);

  const instructions = [
    "## Self-Monitoring Protocol",
    "Before and during your work, actively monitor these:",
    "",
  ];

  // Confidence-based
  if (confidence < 0.5) {
    instructions.push("⚠ LOW CONFIDENCE: You are uncertain about this task. Prefer:");
    instructions.push("  - Reading code before changing it");
    instructions.push("  - Making small, verifiable changes");
    instructions.push("  - Running tests after each change");
    instructions.push("  - Asking the user if anything is unclear");
  }

  // Load-based
  if (load.load === "high" || load.load === "extreme") {
    instructions.push(`⚠ HIGH COGNITIVE LOAD (${load.factors.join(", ")})`);
    for (const m of load.mitigations) instructions.push("  - " + m);
  }

  // Boundary-based
  if (!boundary.withinBounds) {
    instructions.push("⚠ KNOWLEDGE BOUNDARY: " + boundary.unknowns.join(", "));
    for (const s of boundary.suggestions) instructions.push("  - " + s);
  }

  // Universal
  instructions.push("", "Always check:");
  instructions.push("- Am I making progress, or repeating myself?");
  instructions.push("- Is my current approach working, or should I try something different?");
  instructions.push("- Am I confident in this change, or should I verify it first?");

  return instructions.join("\n");
}

module.exports = {
  estimateConfidence, detectStuck, evaluateStrategy,
  detectKnowledgeBoundary, estimateCognitiveLoad,
  metacognitivePrompt, UNCERTAINTY_SIGNALS,
};
