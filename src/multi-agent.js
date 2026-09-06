"use strict";
// ================= Multi-Agent Orchestrator =================
// Spawn independent AI sub-agents that work in parallel on different parts of a task.
// Each agent gets its own isolated context, tool access, and result stream.
// The orchestrator merges results, resolves conflicts, and produces a unified output.
//
// Patterns supported:
//   fan-out    — N agents work on N independent sub-tasks, results merged
//   debate     — N agents propose solutions, a judge picks the best
//   pipeline   — agent A's output feeds agent B's input (sequential chain)
//   review     — one agent writes, another reviews, iterate until approved

const crypto = require("crypto");

function agentId() { return "agent_" + crypto.randomBytes(4).toString("hex"); }

/** @typedef {{ id: string, role: string, prompt: string, status: 'pending'|'running'|'done'|'failed', result: any, error: string|null, tokens: { in: number, out: number }, startedAt: number|null, finishedAt: number|null }} Agent */

function createAgent(role, prompt) {
  return {
    id: agentId(),
    role: String(role || "worker"),
    prompt: String(prompt || ""),
    status: "pending",
    result: null,
    error: null,
    tokens: { in: 0, out: 0 },
    startedAt: null,
    finishedAt: null,
  };
}

// ---- Fan-out: parallel independent agents ----

async function fanOut(tasks, runFn, opts) {
  opts = opts || {};
  const maxConcurrent = opts.maxConcurrent || 5;
  const agents = tasks.map(t => createAgent(t.role || "worker", t.prompt));
  const results = [];

  // Run in batches of maxConcurrent
  for (let i = 0; i < agents.length; i += maxConcurrent) {
    const batch = agents.slice(i, i + maxConcurrent);
    const batchResults = await Promise.allSettled(
      batch.map(async (agent) => {
        agent.status = "running";
        agent.startedAt = Date.now();
        try {
          const res = await runFn(agent);
          agent.result = res.result || res;
          agent.tokens = res.tokens || { in: 0, out: 0 };
          agent.status = "done";
        } catch (e) {
          agent.error = String(e.message || e);
          agent.status = "failed";
        }
        agent.finishedAt = Date.now();
        return agent;
      })
    );
    results.push(...batchResults.map(r => r.value || r.reason));
  }
  return { agents, pattern: "fan-out", totalTokens: agents.reduce((s, a) => s + a.tokens.in + a.tokens.out, 0) };
}

// ---- Debate: agents propose, judge selects ----

async function debate(question, agentCount, runFn, judgeFn, opts) {
  opts = opts || {};
  const maxRounds = opts.maxRounds || 3;
  const agents = [];
  for (let i = 0; i < agentCount; i++) {
    agents.push(createAgent("debater_" + (i + 1), question));
  }

  // Round 1: initial proposals
  for (const agent of agents) {
    agent.status = "running";
    agent.startedAt = Date.now();
    try {
      const res = await runFn(agent, null);
      agent.result = res.result || res;
      agent.tokens = res.tokens || { in: 0, out: 0 };
      agent.status = "done";
    } catch (e) {
      agent.error = String(e.message || e);
      agent.status = "failed";
    }
    agent.finishedAt = Date.now();
  }

  // Rounds 2+: critique and refine
  for (let round = 1; round < maxRounds; round++) {
    const proposals = agents.filter(a => a.status === "done").map(a => ({ role: a.role, proposal: a.result }));
    for (const agent of agents) {
      if (agent.status !== "done") continue;
      const critiquePrompt = `Round ${round + 1}. Other proposals:\n${JSON.stringify(proposals.filter(p => p.role !== agent.role), null, 2)}\n\nRefine your proposal considering the others. Original question: ${question}`;
      try {
        const res = await runFn(agent, critiquePrompt);
        agent.result = res.result || res;
        agent.tokens.in += (res.tokens || {}).in || 0;
        agent.tokens.out += (res.tokens || {}).out || 0;
      } catch (_) { /* keep existing result */ }
    }
  }

  // Judge picks the winner
  const finalProposals = agents.filter(a => a.status === "done").map(a => ({ role: a.role, proposal: a.result }));
  const verdict = await judgeFn(finalProposals);
  return { agents, pattern: "debate", verdict, totalTokens: agents.reduce((s, a) => s + a.tokens.in + a.tokens.out, 0) };
}

// ---- Pipeline: sequential chain ----

async function pipeline(stages, runFn) {
  const agents = stages.map(s => createAgent(s.role || "stage", s.prompt));
  let prevOutput = null;

  for (const agent of agents) {
    const prompt = prevOutput
      ? agent.prompt + "\n\n## Input from previous stage:\n" + (typeof prevOutput === "string" ? prevOutput : JSON.stringify(prevOutput))
      : agent.prompt;
    agent.prompt = prompt;
    agent.status = "running";
    agent.startedAt = Date.now();
    try {
      const res = await runFn(agent);
      agent.result = res.result || res;
      agent.tokens = res.tokens || { in: 0, out: 0 };
      agent.status = "done";
      prevOutput = agent.result;
    } catch (e) {
      agent.error = String(e.message || e);
      agent.status = "failed";
      break; // pipeline stops on failure
    }
    agent.finishedAt = Date.now();
  }

  return { agents, pattern: "pipeline", finalOutput: prevOutput, totalTokens: agents.reduce((s, a) => s + a.tokens.in + a.tokens.out, 0) };
}

// ---- Review loop: writer + reviewer iterate ----

async function reviewLoop(task, writerFn, reviewerFn, opts) {
  opts = opts || {};
  const maxIterations = opts.maxIterations || 4;
  const history = [];
  let draft = null;

  for (let i = 0; i < maxIterations; i++) {
    // Write
    const writePrompt = i === 0 ? task : `Revise based on this feedback:\n${history[history.length - 1]?.review}\n\nOriginal task: ${task}\nPrevious draft:\n${draft}`;
    const writeResult = await writerFn(writePrompt);
    draft = writeResult.result || writeResult;

    // Review
    const reviewResult = await reviewerFn(draft, task);
    const review = reviewResult.result || reviewResult;
    const approved = /\bapproved?\b|\bship\b|\blgtm\b/i.test(String(review));
    history.push({ iteration: i + 1, draft, review, approved });

    if (approved) break;
  }

  return { pattern: "review-loop", iterations: history.length, approved: history[history.length - 1]?.approved || false, finalDraft: draft, history };
}

// ---- Orchestration summary ----

function orchestrationSummary(result) {
  const lines = [`Pattern: ${result.pattern}`];
  if (result.agents) {
    lines.push(`Agents: ${result.agents.length}`);
    for (const a of result.agents) {
      const time = a.startedAt && a.finishedAt ? ` (${((a.finishedAt - a.startedAt) / 1000).toFixed(1)}s)` : "";
      const icon = { pending: "⏳", running: "🔄", done: "✅", failed: "❌" }[a.status];
      lines.push(`  ${icon} ${a.role}: ${a.status}${time} [${a.tokens.in + a.tokens.out} tokens]`);
    }
  }
  if (result.totalTokens) lines.push(`Total tokens: ${result.totalTokens}`);
  if (result.verdict) lines.push(`Verdict: ${result.verdict}`);
  if (result.iterations) lines.push(`Iterations: ${result.iterations}, Approved: ${result.approved}`);
  return lines.join("\n");
}

module.exports = { createAgent, fanOut, debate, pipeline, reviewLoop, orchestrationSummary };
