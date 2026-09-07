"use strict";
// ================= Thought Stream — visible AI reasoning with branching =================
//
// UNIQUE CONCEPT: Instead of the AI thinking in a black box and returning a final
// answer, Thought Stream makes the ENTIRE reasoning process visible, pausable,
// and branchable — like a version-controlled thought process.
//
// The user can:
//   - SEE each reasoning step as it happens (not just the final answer)
//   - PAUSE and redirect: "no, consider X instead"
//   - BRANCH: explore two approaches simultaneously
//   - REWIND: go back to step 3 and try a different direction
//   - REPLAY: re-run a thought stream with different inputs
//
// This is NOT chain-of-thought prompting. CoT is invisible and linear.
// Thought Stream is visible, branchable, and interactive.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// ---- Thought Node ----

function createThought(content, type, parentId) {
  return {
    id: "th_" + crypto.randomBytes(4).toString("hex"),
    content,
    type: type || "reason",  // reason | observe | hypothesize | test | conclude | branch | question | action
    parentId: parentId || null,
    children: [],
    status: "active",         // active | paused | abandoned | concluded
    confidence: null,         // 0-1, set by the agent
    evidence: [],             // supporting evidence for this thought
    timestamp: Date.now(),
    metadata: {},
  };
}

// ---- Thought Stream (a tree of thoughts) ----

function createStream(goal) {
  const root = createThought(goal, "observe", null);
  return {
    id: "stream_" + crypto.randomBytes(4).toString("hex"),
    goal,
    root: root.id,
    thoughts: { [root.id]: root },
    activeHead: root.id,      // where the agent is currently thinking
    branches: [root.id],      // branch tips
    status: "thinking",       // thinking | paused | concluded | abandoned
    createdAt: Date.now(),
    conclusions: [],
  };
}

// ---- Stream Operations ----

function addThought(stream, content, type, parentId) {
  const parent = parentId || stream.activeHead;
  const thought = createThought(content, type, parent);
  stream.thoughts[thought.id] = thought;
  if (stream.thoughts[parent]) {
    stream.thoughts[parent].children.push(thought.id);
  }
  stream.activeHead = thought.id;
  return thought;
}

function branch(stream, thoughtId) {
  // Create a branch point — the agent will explore two paths
  const branchPoint = stream.thoughts[thoughtId];
  if (!branchPoint) return null;
  branchPoint.type = "branch";
  stream.branches.push(thoughtId);
  return branchPoint;
}

function switchBranch(stream, thoughtId) {
  if (stream.thoughts[thoughtId]) {
    stream.activeHead = thoughtId;
    return true;
  }
  return false;
}

function rewind(stream, thoughtId) {
  // Abandon everything after this point and restart from here
  if (!stream.thoughts[thoughtId]) return false;

  function markAbandoned(id) {
    const t = stream.thoughts[id];
    if (!t) return;
    if (t.id !== thoughtId) t.status = "abandoned";
    for (const childId of t.children) markAbandoned(childId);
  }

  // Don't abandon the target, just its descendants
  const target = stream.thoughts[thoughtId];
  for (const childId of target.children) markAbandoned(childId);
  stream.activeHead = thoughtId;
  return true;
}

function conclude(stream, conclusion, confidence) {
  const thought = addThought(stream, conclusion, "conclude");
  thought.confidence = confidence || 0.8;
  stream.conclusions.push({ thought: thought.id, content: conclusion, confidence: thought.confidence });
  stream.status = "concluded";
  return thought;
}

function pause(stream) { stream.status = "paused"; }
function resume(stream) { stream.status = "thinking"; }

// ---- Visualization ----

function visualize(stream, options) {
  options = options || {};
  const lines = [];
  const icons = { reason: "💭", observe: "👁", hypothesize: "💡", test: "🧪", conclude: "✅", branch: "🔀", question: "❓", action: "⚡" };
  const statusIcons = { active: "", paused: "⏸", abandoned: "~~", concluded: "✓" };

  function render(id, depth) {
    const t = stream.thoughts[id];
    if (!t) return;
    if (t.status === "abandoned" && !options.showAbandoned) return;

    const indent = "  ".repeat(depth);
    const icon = icons[t.type] || "·";
    const status = t.status !== "active" ? ` [${t.status}]` : "";
    const conf = t.confidence !== null ? ` (${(t.confidence * 100).toFixed(0)}%)` : "";
    const head = t.id === stream.activeHead ? " ◄ HEAD" : "";
    const content = t.content.length > 100 && !options.full ? t.content.slice(0, 97) + "..." : t.content;

    lines.push(`${indent}${icon} ${content}${conf}${status}${head}`);

    for (const childId of t.children) {
      render(childId, depth + 1);
    }
  }

  lines.push(`Stream: ${stream.goal} [${stream.status}]`);
  lines.push("");
  render(stream.root, 0);

  if (stream.conclusions.length) {
    lines.push("", "Conclusions:");
    for (const c of stream.conclusions) {
      lines.push(`  ✅ ${c.content} (${(c.confidence * 100).toFixed(0)}% confidence)`);
    }
  }

  return lines.join("\n");
}

// ---- Prompt Generation (for the AI) ----

function streamPrompt(stream) {
  // Build the visible reasoning history for the AI to continue
  const history = [];
  function collect(id) {
    const t = stream.thoughts[id];
    if (!t || t.status === "abandoned") return;
    history.push({ type: t.type, content: t.content, confidence: t.confidence });
    for (const childId of t.children) collect(childId);
  }
  collect(stream.root);

  const reasoning = history.map(h => `[${h.type.toUpperCase()}] ${h.content}`).join("\n");

  return [
    "You are reasoning through a problem step by step. Your reasoning is VISIBLE to the user.",
    "Each step should be ONE clear thought, labeled with its type.",
    "",
    "Types: OBSERVE (what you see), HYPOTHESIZE (your theory), TEST (how to verify),",
    "       REASON (logical deduction), ACTION (what to do), CONCLUDE (final answer).",
    "",
    "Your reasoning so far:",
    reasoning || "(no steps yet)",
    "",
    "Continue with the SINGLE next thought. Output format:",
    "TYPE: your thought",
    "CONFIDENCE: 0.0-1.0 (how sure you are)",
    "",
    stream.status === "paused" ? "The user paused your reasoning. Address their feedback before continuing." : "Continue reasoning toward the goal.",
  ].join("\n");
}

// ---- Persistence ----

function saveStream(cwd, stream) {
  const dir = path.join(cwd, ".nexus", "streams");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, stream.id + ".json"), JSON.stringify(stream, null, 2));
}

function loadStream(cwd, id) {
  try { return JSON.parse(fs.readFileSync(path.join(cwd, ".nexus", "streams", id + ".json"), "utf8")); }
  catch (_) { return null; }
}

function listStreams(cwd) {
  try {
    const dir = path.join(cwd, ".nexus", "streams");
    return fs.readdirSync(dir).filter(f => f.endsWith(".json")).map(f => {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
        return { id: s.id, goal: s.goal, status: s.status, thoughts: Object.keys(s.thoughts).length, createdAt: s.createdAt };
      } catch (_) { return null; }
    }).filter(Boolean);
  } catch (_) { return []; }
}

module.exports = {
  createThought, createStream,
  addThought, branch, switchBranch, rewind, conclude, pause, resume,
  visualize, streamPrompt,
  saveStream, loadStream, listStreams,
};
