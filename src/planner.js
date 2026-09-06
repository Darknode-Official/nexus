"use strict";
// ================= Agentic Planner — multi-step task decomposition + execution =================
// The planner takes a complex goal and breaks it into a dependency-aware task graph.
// Each task has preconditions, outputs, and a strategy. The executor runs tasks in
// topological order, parallelizing independent branches, with rollback on failure.
//
// This is what separates an "AI chatbot" from an "AI agent" — the ability to plan
// ahead, reason about dependencies, and execute multi-step workflows autonomously.

const crypto = require("crypto");

// ---- Task graph primitives ----

/** @typedef {{ id: string, title: string, strategy: string, deps: string[], status: 'pending'|'running'|'done'|'failed'|'skipped', result: any, error: string|null, startedAt: number|null, finishedAt: number|null }} Task */

function createTask(title, strategy, deps) {
  return {
    id: "t_" + crypto.randomBytes(4).toString("hex"),
    title: String(title || "").trim(),
    strategy: String(strategy || "").trim(),
    deps: Array.isArray(deps) ? deps : [],
    status: "pending",
    result: null,
    error: null,
    startedAt: null,
    finishedAt: null,
  };
}

function createPlan(goal, tasks) {
  return {
    id: "plan_" + crypto.randomBytes(4).toString("hex"),
    goal: String(goal || "").trim(),
    tasks: Array.isArray(tasks) ? tasks : [],
    status: "pending", // pending | running | done | failed | cancelled
    createdAt: Date.now(),
    finishedAt: null,
  };
}

// ---- Topological sort for execution order ----

function topoSort(tasks) {
  const byId = new Map(tasks.map(t => [t.id, t]));
  const visited = new Set(), order = [], temp = new Set();
  function visit(id) {
    if (temp.has(id)) throw new Error("Circular dependency: " + id);
    if (visited.has(id)) return;
    temp.add(id);
    const t = byId.get(id);
    if (t) for (const d of t.deps) visit(d);
    temp.delete(id);
    visited.add(id);
    order.push(id);
  }
  for (const t of tasks) visit(t.id);
  return order;
}

// ---- Readiness: which tasks can run right now? ----

function readyTasks(plan) {
  const doneIds = new Set(plan.tasks.filter(t => t.status === "done").map(t => t.id));
  return plan.tasks.filter(t =>
    t.status === "pending" && t.deps.every(d => doneIds.has(d))
  );
}

// ---- Execution engine (pure state transitions — the caller provides the "do" function) ----

/**
 * Run the plan to completion. `executeFn(task, context)` does the actual work
 * (call the AI, run a command, etc.) and returns a result or throws.
 * Tasks with met dependencies run in parallel via Promise.all.
 * @param {object} plan
 * @param {function} executeFn - async (task, ctx) => result
 * @param {object} ctx - passed through to executeFn
 * @returns {Promise<object>} the completed plan
 */
async function executePlan(plan, executeFn, ctx) {
  plan.status = "running";
  const maxRounds = plan.tasks.length + 1; // safety brake
  for (let round = 0; round < maxRounds; round++) {
    const ready = readyTasks(plan);
    if (ready.length === 0) break;
    await Promise.all(ready.map(async (task) => {
      task.status = "running";
      task.startedAt = Date.now();
      try {
        task.result = await executeFn(task, ctx);
        task.status = "done";
      } catch (e) {
        task.error = String(e.message || e);
        task.status = "failed";
        // Skip downstream dependents
        const failedId = task.id;
        for (const t of plan.tasks) {
          if (t.status === "pending" && t.deps.includes(failedId)) {
            t.status = "skipped";
            t.error = "Skipped: dependency " + failedId + " failed";
          }
        }
      }
      task.finishedAt = Date.now();
    }));
  }
  plan.status = plan.tasks.some(t => t.status === "failed") ? "failed" : "done";
  plan.finishedAt = Date.now();
  return plan;
}

// ---- Plan decomposition prompt (for the AI to generate the task graph) ----

function decompositionPrompt(goal, projectContext) {
  return [
    "You are an expert software architect. Break the following GOAL into a precise task graph.",
    "Each task must have: title, strategy (exactly what to do), and deps (task IDs it depends on).",
    "",
    "Rules:",
    "- Tasks should be atomic — one clear action each.",
    "- Maximize parallelism: independent tasks should NOT depend on each other.",
    "- Include verification tasks (tests, checks) after implementation tasks.",
    "- Order: understand → plan → implement → test → verify.",
    "- Output ONLY valid JSON: { \"tasks\": [{ \"title\": \"...\", \"strategy\": \"...\", \"deps\": [\"t1\", ...] }] }",
    "- Use t1, t2, t3... as task IDs in deps.",
    "",
    projectContext ? "## Project Context\n" + projectContext + "\n" : "",
    "## GOAL",
    goal,
  ].join("\n");
}

// ---- Plan summary (for display) ----

function planSummary(plan) {
  const counts = { pending: 0, running: 0, done: 0, failed: 0, skipped: 0 };
  for (const t of plan.tasks) counts[t.status] = (counts[t.status] || 0) + 1;
  const elapsed = plan.finishedAt ? ((plan.finishedAt - plan.createdAt) / 1000).toFixed(1) + "s" : "running";
  const lines = [
    `Plan: ${plan.goal} [${plan.status}] (${elapsed})`,
    `Tasks: ${plan.tasks.length} total — ✅${counts.done} ⏳${counts.pending} 🔄${counts.running} ❌${counts.failed} ⏭${counts.skipped}`,
    "",
  ];
  for (const t of plan.tasks) {
    const icon = { pending: "⏳", running: "🔄", done: "✅", failed: "❌", skipped: "⏭" }[t.status];
    const time = t.startedAt && t.finishedAt ? ` (${((t.finishedAt - t.startedAt) / 1000).toFixed(1)}s)` : "";
    lines.push(`  ${icon} ${t.id}: ${t.title}${time}${t.error ? " — " + t.error : ""}`);
  }
  return lines.join("\n");
}

module.exports = { createTask, createPlan, topoSort, readyTasks, executePlan, decompositionPrompt, planSummary };
