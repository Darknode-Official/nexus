"use strict";
// ================= Session Manager — persistent conversation context across restarts =================
// Saves and restores agent sessions so work survives terminal closes, crashes, and
// context window exhaustion. Each session tracks: messages, tool calls, file changes,
// cost, and a semantic summary that compresses old context.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const SESSIONS_DIR = ".nexus/sessions";
const MAX_MESSAGES_BEFORE_COMPRESS = 50;

function sessionId() { return "sess_" + Date.now().toString(36) + "_" + crypto.randomBytes(3).toString("hex"); }

function createSession(opts) {
  opts = opts || {};
  return {
    id: sessionId(),
    engine: opts.engine || "unknown",
    model: opts.model || "",
    messages: [],
    toolCalls: [],
    fileChanges: [],
    summaries: [],     // compressed context from older messages
    cost: { inputTokens: 0, outputTokens: 0, dollars: 0 },
    startedAt: Date.now(),
    lastActiveAt: Date.now(),
    goal: opts.goal || "",
    status: "active",  // active | paused | completed | abandoned
  };
}

function addMessage(session, role, content, tokens) {
  session.messages.push({
    role, content: String(content || ""),
    tokens: tokens || 0,
    timestamp: Date.now(),
  });
  session.lastActiveAt = Date.now();
}

function addToolCall(session, tool, input, output, duration) {
  session.toolCalls.push({
    tool, input: String(input || "").slice(0, 500),
    output: String(output || "").slice(0, 1000),
    duration: duration || 0,
    timestamp: Date.now(),
  });
}

function addFileChange(session, file, action) {
  session.fileChanges.push({ file, action, timestamp: Date.now() });
}

function updateCost(session, inTok, outTok, dollars) {
  session.cost.inputTokens += inTok || 0;
  session.cost.outputTokens += outTok || 0;
  session.cost.dollars += dollars || 0;
}

// ---- Context compression ----

/**
 * Compress old messages into a summary to keep context manageable.
 * Returns a prompt for the AI to summarize the conversation so far.
 */
function compressionPrompt(messages) {
  const text = messages.map(m => `[${m.role}]: ${m.content}`).join("\n\n");
  return [
    "Summarize this conversation into a concise context document.",
    "Preserve: key decisions, file changes made, current task state, any errors or blockers.",
    "Drop: greetings, thinking-out-loud, intermediate failed attempts (keep the final working approach).",
    "Format: bullet points grouped by topic. Max 500 words.",
    "",
    "--- CONVERSATION ---",
    text,
    "--- END ---",
  ].join("\n");
}

/**
 * Apply compression: move old messages to summaries, keep recent ones.
 */
function compressSession(session, summary, keepRecent) {
  keepRecent = keepRecent || 10;
  if (session.messages.length <= keepRecent) return false;

  const old = session.messages.slice(0, -keepRecent);
  session.summaries.push({
    messageCount: old.length,
    summary: String(summary || ""),
    compressedAt: Date.now(),
  });
  session.messages = session.messages.slice(-keepRecent);
  return true;
}

/**
 * Build the full context for a resumed session: summaries + recent messages.
 */
function buildContext(session) {
  const parts = [];
  if (session.goal) parts.push("## Goal\n" + session.goal);
  if (session.summaries.length) {
    parts.push("## Previous Context (compressed)");
    for (const s of session.summaries) {
      parts.push(s.summary);
    }
  }
  if (session.fileChanges.length) {
    const recent = session.fileChanges.slice(-20);
    parts.push("## Recent File Changes\n" + recent.map(f => `- ${f.action}: ${f.file}`).join("\n"));
  }
  return parts.join("\n\n");
}

// ---- Persistence ----

function sessionsDir(cwd) { return path.join(cwd, SESSIONS_DIR); }

function saveSession(cwd, session) {
  const dir = sessionsDir(cwd);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  fs.writeFileSync(path.join(dir, session.id + ".json"), JSON.stringify(session, null, 2));
}

function loadSession(cwd, id) {
  try { return JSON.parse(fs.readFileSync(path.join(sessionsDir(cwd), id + ".json"), "utf8")); }
  catch (_) { return null; }
}

function listSessions(cwd, opts) {
  opts = opts || {};
  const dir = sessionsDir(cwd);
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith(".json"));
    const sessions = files.map(f => {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
        return { id: s.id, goal: s.goal, status: s.status, engine: s.engine, model: s.model,
                 messages: s.messages.length, cost: s.cost, startedAt: s.startedAt, lastActiveAt: s.lastActiveAt };
      } catch (_) { return null; }
    }).filter(Boolean);
    sessions.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    return opts.limit ? sessions.slice(0, opts.limit) : sessions;
  } catch (_) { return []; }
}

function deleteSession(cwd, id) {
  try { fs.unlinkSync(path.join(sessionsDir(cwd), id + ".json")); return true; }
  catch (_) { return false; }
}

/** Should we auto-compress? */
function needsCompression(session) {
  return session.messages.length > MAX_MESSAGES_BEFORE_COMPRESS;
}

module.exports = {
  createSession, addMessage, addToolCall, addFileChange, updateCost,
  compressionPrompt, compressSession, buildContext, needsCompression,
  saveSession, loadSession, listSessions, deleteSession,
};
