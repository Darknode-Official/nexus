"use strict";
// ================= Intent Router — classify what the user wants, route to the right system =================
// Instead of the AI guessing what tool to use, the intent router classifies the user's
// message into an action category and routes it to the optimal handler — whether that's
// a direct tool call, a multi-step plan, a multi-agent fan-out, or a simple chat response.
// This is the "brain" that makes Nexus feel intelligent rather than reactive.

const INTENTS = [
  // Code modification
  { id: "code_edit",       keywords: ["fix", "change", "edit", "update", "modify", "refactor", "rename", "move", "delete line", "add function", "implement"],
    handler: "planner", description: "Edit or modify existing code" },
  { id: "code_create",     keywords: ["create", "build", "make", "write", "scaffold", "generate", "new file", "new project", "bootstrap", "init"],
    handler: "planner", description: "Create new code or projects" },

  // Understanding
  { id: "explain",         keywords: ["explain", "what does", "how does", "why does", "what is", "describe", "walk through", "trace", "understand"],
    handler: "context_query", description: "Explain code or concepts" },
  { id: "find",            keywords: ["find", "search", "where is", "locate", "grep", "which file", "look for", "show me"],
    handler: "search", description: "Find code, files, or patterns" },

  // Analysis
  { id: "review",          keywords: ["review", "check", "audit", "inspect", "analyze", "examine", "assess", "evaluate", "critique"],
    handler: "multi_agent", description: "Review code quality, security, performance" },
  { id: "debug",           keywords: ["debug", "fix bug", "error", "crash", "broken", "not working", "fails", "exception", "traceback", "stack trace"],
    handler: "planner", description: "Diagnose and fix bugs" },
  { id: "test",            keywords: ["test", "write tests", "unit test", "coverage", "spec", "assert", "verify"],
    handler: "planner", description: "Write or run tests" },

  // Operations
  { id: "run",             keywords: ["run", "execute", "start", "launch", "deploy", "build", "compile", "install", "serve"],
    handler: "direct_tool", description: "Run commands or scripts" },
  { id: "git",             keywords: ["commit", "push", "pull", "merge", "branch", "rebase", "stash", "diff", "log", "blame"],
    handler: "direct_tool", description: "Git operations" },

  // Meta
  { id: "plan",            keywords: ["plan", "strategy", "approach", "how should", "best way", "architecture", "design"],
    handler: "planner", description: "Plan an approach or architecture" },
  { id: "remember",        keywords: ["remember", "note", "save", "convention", "preference", "always", "never", "from now on"],
    handler: "memory", description: "Save a project convention or preference" },
  { id: "status",          keywords: ["status", "progress", "what's running", "background", "jobs", "tasks"],
    handler: "status", description: "Check running jobs or project status" },

  // Conversation
  { id: "chat",            keywords: [],
    handler: "chat", description: "General conversation or questions" },
];

/**
 * Classify user input into an intent.
 * @param {string} input - the user's message
 * @returns {{ intent: object, confidence: number, alternatives: object[] }}
 */
function classify(input) {
  const lower = String(input || "").toLowerCase().trim();
  const words = lower.split(/\s+/);

  const scored = INTENTS.map(intent => {
    let score = 0;
    for (const kw of intent.keywords) {
      // Exact word match
      if (words.includes(kw)) score += 3;
      // Phrase match
      else if (lower.includes(kw)) score += 2;
      // Fuzzy: word starts with keyword
      else if (words.some(w => w.startsWith(kw.slice(0, 4)))) score += 1;
    }
    // Boost for being at the start of the message (imperative commands)
    if (intent.keywords.some(kw => lower.startsWith(kw))) score += 2;
    return { intent, score };
  }).sort((a, b) => b.score - a.score);

  const best = scored[0];
  const fallback = INTENTS.find(i => i.id === "chat");
  if (best.score === 0) return { intent: fallback, confidence: 0.3, alternatives: [] };

  const maxScore = best.intent.keywords.length * 3;
  const confidence = Math.min(1, best.score / Math.max(maxScore, 3));
  const alternatives = scored.slice(1, 4).filter(s => s.score > 0).map(s => s.intent);

  return { intent: best.intent, confidence, alternatives };
}

/**
 * Build the routing decision: what systems to engage for this intent.
 * @param {{ intent: object, confidence: number }} classification
 * @param {object} projectState - { hasGit, hasMCP, engineCount, ... }
 * @returns {{ handler: string, strategy: string, parallel: boolean, tools: string[] }}
 */
function route(classification, projectState) {
  const { intent, confidence } = classification;
  projectState = projectState || {};

  const decision = {
    handler: intent.handler,
    strategy: "single",  // single | planned | fan-out | pipeline
    parallel: false,
    tools: [],
    reasoning: "",
  };

  // Escalate to multi-step when confidence is high and task is complex
  if (intent.handler === "planner" && confidence > 0.5) {
    decision.strategy = "planned";
    decision.tools = ["read_file", "write_file", "edit_file", "run_command", "search"];
    decision.reasoning = "Complex task — decomposing into steps with dependency tracking";
  } else if (intent.handler === "multi_agent" && confidence > 0.4) {
    decision.strategy = "fan-out";
    decision.parallel = true;
    decision.tools = ["read_file", "search", "run_command"];
    decision.reasoning = "Multi-dimensional analysis — parallel agents for speed";
  } else if (intent.handler === "search") {
    decision.strategy = "single";
    decision.tools = ["search", "find", "read_file", "list_dir"];
    decision.reasoning = "Direct search — fast, no planning needed";
  } else if (intent.handler === "direct_tool") {
    decision.strategy = "single";
    decision.tools = ["run_command"];
    decision.reasoning = "Direct execution — single command";
  } else if (intent.handler === "context_query") {
    decision.strategy = "single";
    decision.tools = ["read_file", "search"];
    decision.reasoning = "Read and explain — context engine gathers relevant files";
  }

  return decision;
}

module.exports = { INTENTS, classify, route };
