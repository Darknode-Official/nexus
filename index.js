"use strict";
// ============================= Darknode Nexus Engine v2.2.0 — Public API =============================

// Core Agent Systems
const intent         = require("./src/intent");
const reasoning      = require("./src/reasoning");
const planner        = require("./src/planner");
const multiAgent     = require("./src/multi-agent");
const budget         = require("./src/budget");
const pipelines      = require("./src/pipelines");
const loop           = require("./src/loop");

// Context & Memory
const context        = require("./src/context");
const knowledgeGraph = require("./src/knowledge-graph");
const deepMemory     = require("./src/deep-memory");
const sessions       = require("./src/sessions");
const memory         = require("./src/memory");
const thoughtStream  = require("./src/thought-stream");
const timeTravel     = require("./src/time-travel");
const steering       = require("./src/steering");

// Intelligence
const promptEngine   = require("./src/prompt-engine");
const metacognition  = require("./src/metacognition");
const workspace      = require("./src/workspace");
const skillForge     = require("./src/skill-forge");
const worldModel     = require("./src/world-model");
const learner        = require("./src/learner");
const cowork         = require("./src/cowork");
const darknodeAI     = require("./src/darknode-ai");
const securityRAG    = require("./src/security-rag");
const learningEngine = require("./src/learning-engine");

// Execution
const sandbox        = require("./src/sandbox");
const capability     = require("./src/capability");
const codemod        = require("./src/codemod");
const codeActions    = require("./src/code-actions");
const verification   = require("./src/verification");
const nxp            = require("./src/nxp");

// Quality
const evaluate       = require("./src/eval");
const review         = require("./src/review");
const codeReview     = require("./src/code-review-auto");
const codeRadar      = require("./src/code-radar");
const smartTest      = require("./src/smart-test");
const diffExplain    = require("./src/code-diff-explain");
const ghostAgents    = require("./src/ghost-agents");

// Security
const attackPlanner  = require("./src/attack-planner");
const ctfAssist      = require("./src/ctf-assist");
const reportGen      = require("./src/report-gen");
const compliance     = require("./src/compliance");
const threatModel    = require("./src/threat-model");
const vulnScanner    = require("./src/vuln-scanner");

// Infrastructure
const engines        = require("./src/engines");
const ollama         = require("./src/ollama");
const localPreflight = require("./src/local-preflight");
const mcpBridge      = require("./src/mcp-bridge");
const mcpCatalog     = require("./src/mcp-catalog");
const modeler3d      = require("./src/mcp-3d-modeler");
const errorRecovery  = require("./src/error-recovery");
const loopDetect     = require("./src/loop-detect");

// Ops
const telemetry      = require("./src/telemetry");
const ledger         = require("./src/ledger");
const plugins        = require("./src/plugins");
const bgjobs         = require("./src/bgjobs");
const pricing        = require("./src/pricing");
const costsave       = require("./src/costsave");
const overhead       = require("./src/overhead");
const gitIntel       = require("./src/git-intelligence");

// Utilities
const config         = require("./src/config");
const autocorrect    = require("./src/autocorrect");
const codestats      = require("./src/codestats");
const deps           = require("./src/deps");
const envaudit       = require("./src/envaudit");
const todos          = require("./src/todos");
const tools          = require("./src/tools");
const changelog      = require("./src/changelog");
const parsers        = require("./src/parsers");
const bootstrap      = require("./src/project-bootstrap");

// Expansion subsystems (token-saving, repo intelligence, code security, performance, patching)
const tokensave      = require("./src/tokensave");
const codegraph      = require("./src/codegraph");
const sectools       = require("./src/sectools");
const perf           = require("./src/perf");
const patch          = require("./src/patch");

// Wave-2 subsystems (semantic intelligence, retrieval, refactoring, test intelligence)
const lsp            = require("./src/lsp");
const retrieval      = require("./src/retrieval");
const refactor       = require("./src/refactor");
const testintel      = require("./src/testintel");

// Wave-3 subsystems (repo map, edit protocol, shell intelligence)
const repomap        = require("./src/repomap");
const editformat     = require("./src/editformat");
const shellplan      = require("./src/shellplan");

const { version }    = require("./package.json");

module.exports = {
  version,
  // Core
  intent, reasoning, planner, multiAgent, budget, pipelines, loop,
  // Context & Memory
  context, knowledgeGraph, deepMemory, sessions, memory, thoughtStream, timeTravel, steering,
  // Intelligence
  promptEngine, metacognition, workspace, skillForge, worldModel, learner, cowork,
  darknodeAI, securityRAG, learningEngine,
  // Execution
  sandbox, capability, codemod, codeActions, verification, nxp,
  // Quality
  evaluate, review, codeReview, codeRadar, smartTest, diffExplain, ghostAgents,
  // Security
  attackPlanner, ctfAssist, reportGen, compliance, threatModel, vulnScanner,
  // Infrastructure
  engines, ollama, localPreflight, mcpBridge, mcpCatalog, modeler3d, errorRecovery, loopDetect,
  // Ops
  telemetry, ledger, plugins, bgjobs, pricing, costsave, overhead, gitIntel,
  // Utilities
  config, autocorrect,
  codestats, deps, envaudit, todos, tools, changelog, parsers, bootstrap,
  // Expansion subsystems
  tokensave, codegraph, sectools, perf, patch,
  // Wave-2 subsystems
  lsp, retrieval, refactor, testintel,
  // Wave-3 subsystems
  repomap, editformat, shellplan,
};
