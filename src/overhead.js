"use strict";
// ================= NX-101 Token-Overhead Accounting =================
// Nexus is a WRAPPER. Every layer it adds (auto-gathered context, prompt-engine
// template + chain-of-thought, knowledge-graph hints, MCP tool defs, session
// resume re-sends) is ADDITIVE input that the underlying engine would not have
// received from a bare `claude -p "<task>"` / `gemini -p "<task>"` invocation.
//
// This module is the single, honest composition point that models what the
// runner sends per turn, so the real additive overhead can be MEASURED rather
// than asserted. It deliberately reuses the repo's own modules (context,
// prompt-engine, costsave) so the measurement tracks real code paths.
//
// HONESTY NOTE ON UNITS: token counts here use the repo's own 1-token ~= 4-char
// estimator (context.estimateTokens). It is an estimator, NOT a real BPE
// tokenizer, so absolute numbers are approximate. RATIOS between the Nexus path
// and the bare path are robust to the estimator because both use the same unit.
//
// WHAT THIS CAN AND CANNOT MEASURE (read before quoting any number):
//   CAN  (deterministic, no credentials): the input tokens Nexus ADDS before the
//        engine ever runs, and how much the cost-saver (squeeze + cache) claws
//        back of that overhead.
//   CANNOT (needs live engine runs with credentials): the engine's OWN lazy
//        context gathering, output tokens, and real dollar billing. A full
//        "Nexus vs direct engine" dollar figure requires those live runs; see
//        bench/README.md for the run instructions and the credential list.

const context = require("./context");
const promptEngine = require("./prompt-engine");
const costsave = require("./costsave");

const estTok = context.estimateTokens; // ceil(len/4) — same unit Nexus uses internally

// Compose what the Nexus runner sends to the engine for ONE turn, and account
// every token to the subsystem that produced it.
//
// opts:
//   intent        — prompt-engine template id (default: derived is left to caller)
//   budget        — context token budget (default 6000, same as context.gather)
//   gatherContext — run the Context Engine auto-gather (default true)
//   knowledgeGraph— inject a knowledge-graph hint block (default true)
//   squeeze       — apply the cost-saver squeeze pass (default true)
//   lean          — opt-out fast path: no auto-gather, no KG, no CoT. Overrides
//                   gatherContext/knowledgeGraph to false and strips CoT.
//   mcpServers    — MCP server map whose tool defs get injected per turn
//   workspace     — workspace intel object
function composeTurn(cwd, task, opts) {
  opts = opts || {};
  const lean = !!opts.lean;
  const doGather = lean ? false : opts.gatherContext !== false;
  const doKG = lean ? false : opts.knowledgeGraph !== false;
  const doSqueeze = opts.squeeze !== false;

  const bareTokens = estTok(task); // what `engine -p "<task>"` sends as the prompt body

  // 1. Context Engine auto-gather (the single largest additive source)
  let contextText = "";
  if (doGather) {
    try {
      const gathered = context.gather(cwd, task, { budget: opts.budget || 6000 });
      contextText = context.format(gathered);
    } catch (_) { contextText = ""; }
  }

  // 2. Knowledge-graph hint block (relationship-aware file hints)
  let kgText = "";
  if (doKG) {
    try {
      const kg = require("./knowledge-graph");
      const graph = kg.loadGraph(cwd) || kg.buildGraph(cwd);
      const hits = kg.queryFiles(graph, task).slice(0, 8);
      if (hits.length) {
        kgText = "## Knowledge Graph (related files)\n" +
          hits.map(h => "- " + h.file + " (relevance " + h.score + ")").join("\n");
      }
    } catch (_) { kgText = ""; }
  }

  // 3. MCP tool definitions injected per turn
  let mcpText = "";
  if (opts.mcpServers) {
    try { mcpText = promptEngine.formatMCPTools(opts.mcpServers); } catch (_) { mcpText = ""; }
  }

  // 4. Prompt-engine assembly (template role/rules/output-format + CoT wrapper).
  //    In lean mode we skip CoT by passing the raw task as the task section.
  const intent = opts.intent || "code_edit";
  const template = promptEngine.getTemplate(intent);
  const cotTask = lean ? task : promptEngine.applyCoT(task, promptEngine.selectCoT(task));
  const contextBlock = [contextText, kgText].filter(Boolean).join("\n\n");
  const systemPrompt = promptEngine.structurePrompt({
    role: template.role + (opts.workspace ? "\n\nProject: " + workspaceLine(opts.workspace) : ""),
    rules: template.rules,
    context: contextBlock || undefined,
    reference: mcpText || undefined,
    task: cotTask,
    outputFormat: template.outputFormat,
  });

  // The full input the engine receives = system prompt + user message (the task).
  let assembled = systemPrompt + "\n\n" + task;
  const assembledTokens = estTok(assembled);

  // 5. Cost-saver squeeze pass (dedupe inlined blocks + collapse whitespace)
  let squeezed = assembled, squeezeSaved = 0;
  if (doSqueeze) {
    const r = costsave.squeezeContext(assembled);
    squeezed = r.text; squeezeSaved = r.saved;
  }
  const finalTokens = estTok(squeezed);

  // Per-subsystem attribution (tokens each layer contributed, pre-squeeze)
  const breakdown = {
    bareTask: bareTokens,
    context: estTok(contextText),
    knowledgeGraph: estTok(kgText),
    mcpTools: estTok(mcpText),
    promptTemplate: Math.max(0, estTok(systemPrompt) - estTok(contextBlock) - estTok(mcpText) - estTok(cotTask)),
    cotWrapper: Math.max(0, estTok(cotTask) - bareTokens),
  };

  const overhead = finalTokens - bareTokens; // additive input tokens vs bare direct call
  return {
    lean,
    bareTokens,
    assembledTokens,
    finalTokens,
    squeezeSaved,
    overhead,
    overheadRatio: bareTokens > 0 ? +(finalTokens / bareTokens).toFixed(2) : null,
    breakdown,
  };
}

function workspaceLine(ws) {
  const parts = [];
  if (ws.primaryLanguage) parts.push("Language: " + ws.primaryLanguage);
  if (ws.framework && ws.framework.name) parts.push("Framework: " + ws.framework.name);
  return parts.join(" · ");
}

// Compare full Nexus path vs lean path vs bare direct call for one task.
function compareTask(cwd, task, opts) {
  const full = composeTurn(cwd, task, Object.assign({}, opts, { lean: false }));
  const lean = composeTurn(cwd, task, Object.assign({}, opts, { lean: true }));
  return {
    task: String(task).slice(0, 60),
    bareTokens: full.bareTokens,
    fullTokens: full.finalTokens,
    leanTokens: lean.finalTokens,
    fullOverhead: full.overhead,
    leanOverhead: lean.overhead,
    fullRatio: full.overheadRatio,
    leanRatio: lean.overheadRatio,
    leanSavesVsFull: full.finalTokens - lean.finalTokens,
    breakdown: full.breakdown,
  };
}

module.exports = { composeTurn, compareTask, estTok };
