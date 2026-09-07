"use strict";
// ============================= Darknode Nexus Engine — Public API =============================
// const { planner, intent, verify } = require("nexus");

// ---- Core Agent Systems ----
const intent        = require("./src/intent");
const reasoning     = require("./src/reasoning");
const planner       = require("./src/planner");
const multiAgent    = require("./src/multi-agent");
const pipelines     = require("./src/pipelines");
const loop          = require("./src/loop");

// ---- Context & Memory ----
const context       = require("./src/context");
const knowledgeGraph = require("./src/knowledge-graph");
const deepMemory    = require("./src/deep-memory");
const sessions      = require("./src/sessions");
const memory        = require("./src/memory");
const thoughtStream = require("./src/thought-stream");
const timeTravel    = require("./src/time-travel");

// ---- Intelligence ----
const promptEngine  = require("./src/prompt-engine");
const metacognition = require("./src/metacognition");
const workspace     = require("./src/workspace");
const skillForge    = require("./src/skill-forge");
const worldModel    = require("./src/world-model");
const learner       = require("./src/learner");
const cowork        = require("./src/cowork");

// ---- Execution ----
const sandbox       = require("./src/sandbox");
const codemod       = require("./src/codemod");
const codeActions   = require("./src/code-actions");
const verification  = require("./src/verification");
const nxp           = require("./src/nxp");

// ---- Quality ----
const evaluate      = require("./src/eval");
const review        = require("./src/review");
const codeReview    = require("./src/code-review-auto");
const codeRadar     = require("./src/code-radar");
const smartTest     = require("./src/smart-test");
const diffExplain   = require("./src/code-diff-explain");
const ghostAgents   = require("./src/ghost-agents");

// ---- Infrastructure ----
const engines       = require("./src/engines");
const ollama        = require("./src/ollama");
const mcpBridge     = require("./src/mcp-bridge");
const mcpCatalog    = require("./src/mcp-catalog");
const modeler3d     = require("./src/mcp-3d-modeler");
const errorRecovery = require("./src/error-recovery");

// ---- Ops ----
const telemetry     = require("./src/telemetry");
const plugins       = require("./src/plugins");
const bgjobs        = require("./src/bgjobs");
const pricing       = require("./src/pricing");
const costsave      = require("./src/costsave");
const gitIntel      = require("./src/git-intelligence");

// ---- Utilities ----
const codestats     = require("./src/codestats");
const deps          = require("./src/deps");
const envaudit      = require("./src/envaudit");
const todos         = require("./src/todos");
const tools         = require("./src/tools");
const changelog     = require("./src/changelog");
const parsers       = require("./src/parsers");
const bootstrap     = require("./src/project-bootstrap");

const { version }   = require("./package.json");

module.exports = {
  version,
  // Core
  intent, reasoning, planner, multiAgent, pipelines, loop,
  // Context & Memory
  context, knowledgeGraph, deepMemory, sessions, memory, thoughtStream, timeTravel,
  // Intelligence
  promptEngine, metacognition, workspace, skillForge, worldModel, learner, cowork,
  // Execution
  sandbox, codemod, codeActions, verification, nxp,
  // Quality
  evaluate, review, codeReview, codeRadar, smartTest, diffExplain, ghostAgents,
  // Infrastructure
  engines, ollama, mcpBridge, mcpCatalog, modeler3d, errorRecovery,
  // Ops
  telemetry, plugins, bgjobs, pricing, costsave, gitIntel,
  // Utilities
  codestats, deps, envaudit, todos, tools, changelog, parsers, bootstrap,
};
