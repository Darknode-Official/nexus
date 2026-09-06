"use strict";
// ================= Deep Memory — episodic + semantic + working memory architecture =================
//
// WHAT THIS IS:
// A three-tier memory system inspired by cognitive science:
//
// WORKING MEMORY (tier 1): The current task context — what the agent is actively
//   thinking about. Small, fast, always in the prompt. Capacity: ~4000 tokens.
//
// EPISODIC MEMORY (tier 2): Specific events — "yesterday I fixed a bug in auth.js
//   by adding null checks." Timestamped, fading over time. Used for: what happened,
//   what worked, what failed.
//
// SEMANTIC MEMORY (tier 3): General knowledge extracted from episodes — "auth.js
//   has fragile null handling" or "the team prefers functional style." Permanent,
//   compressed. Used for: project truths, conventions, patterns.
//
// RESEARCH BASIS:
// - MemGPT (Packer et al. 2023): virtual context management with memory tiers
// - Generative Agents (Park et al. 2023): reflection → higher-level observations
// - Memory consolidation: sleep/reflection compresses episodes into knowledge
// - Ebbinghaus forgetting curve: relevance decays, but reinforced memories persist

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const MEMORY_DIR = ".nexus/memory";
const EPISODIC_FILE = "episodes.json";
const SEMANTIC_FILE = "knowledge.json";
const MAX_EPISODES = 500;
const MAX_KNOWLEDGE = 200;

function memDir(cwd) { return path.join(cwd, MEMORY_DIR); }

// ---- Working Memory ----
// In-process only — lives in the current agent session.

function createWorkingMemory(capacity) {
  return {
    items: [],       // { content, priority, addedAt }
    capacity: capacity || 4000, // token budget
    _tokens: 0,
  };
}

function addToWorking(wm, content, priority) {
  priority = priority || 1;
  const tokens = Math.ceil(String(content || "").length / 4);
  // Evict lowest-priority items if over capacity
  while (wm._tokens + tokens > wm.capacity && wm.items.length > 0) {
    wm.items.sort((a, b) => a.priority - b.priority);
    const evicted = wm.items.shift();
    wm._tokens -= evicted.tokens;
  }
  const item = { content, priority, tokens, addedAt: Date.now() };
  wm.items.push(item);
  wm._tokens += tokens;
  return item;
}

function workingContext(wm) {
  return wm.items
    .sort((a, b) => b.priority - a.priority)
    .map(i => i.content)
    .join("\n");
}

// ---- Episodic Memory ----
// Specific events: what happened, when, what was the outcome.

function loadEpisodes(cwd) {
  try { return JSON.parse(fs.readFileSync(path.join(memDir(cwd), EPISODIC_FILE), "utf8")); }
  catch (_) { return []; }
}

function saveEpisodes(cwd, episodes) {
  const dir = memDir(cwd);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  if (episodes.length > MAX_EPISODES) episodes = episodes.slice(-MAX_EPISODES);
  fs.writeFileSync(path.join(dir, EPISODIC_FILE), JSON.stringify(episodes, null, 2));
}

/**
 * Record an episodic memory.
 * @param {string} cwd
 * @param {object} episode - { event, context, outcome, importance }
 */
function remember(cwd, episode) {
  const episodes = loadEpisodes(cwd);
  episodes.push({
    id: "ep_" + crypto.randomBytes(4).toString("hex"),
    event: episode.event,
    context: episode.context || "",
    outcome: episode.outcome || "",
    importance: episode.importance || 0.5,  // 0-1
    timestamp: Date.now(),
    accessCount: 0,
    lastAccessed: null,
    decayed: false,
  });
  saveEpisodes(cwd, episodes);
}

/**
 * Recall relevant episodic memories for a task.
 * Uses: keyword matching + recency + importance + access frequency.
 */
function recall(cwd, query, limit) {
  limit = limit || 10;
  const episodes = loadEpisodes(cwd);
  const queryLower = String(query || "").toLowerCase();
  const words = queryLower.split(/\s+/).filter(w => w.length > 3);
  const now = Date.now();

  const scored = episodes.map(ep => {
    let score = 0;
    const text = (ep.event + " " + ep.context + " " + ep.outcome).toLowerCase();
    // Keyword relevance
    for (const w of words) { if (text.includes(w)) score += 2; }
    // Recency (Ebbinghaus-inspired decay: score = importance × e^(-t/τ))
    const hoursSince = (now - ep.timestamp) / (3600 * 1000);
    const recency = Math.exp(-hoursSince / (24 * 7)); // τ = 1 week
    score += recency * ep.importance * 3;
    // Reinforce accessed memories
    if (ep.accessCount > 0) score += Math.log(1 + ep.accessCount) * 0.5;
    return { episode: ep, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const results = scored.slice(0, limit);

  // Mark accessed
  const accessed = new Set(results.map(r => r.episode.id));
  for (const ep of episodes) {
    if (accessed.has(ep.id)) {
      ep.accessCount++;
      ep.lastAccessed = now;
    }
  }
  saveEpisodes(cwd, episodes);

  return results.map(r => r.episode);
}

// ---- Semantic Memory ----
// General knowledge extracted from episodes — permanent, compressed.

function loadKnowledge(cwd) {
  try { return JSON.parse(fs.readFileSync(path.join(memDir(cwd), SEMANTIC_FILE), "utf8")); }
  catch (_) { return []; }
}

function saveKnowledge(cwd, knowledge) {
  const dir = memDir(cwd);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  if (knowledge.length > MAX_KNOWLEDGE) {
    knowledge.sort((a, b) => (b.confidence * b.useCount) - (a.confidence * a.useCount));
    knowledge = knowledge.slice(0, MAX_KNOWLEDGE);
  }
  fs.writeFileSync(path.join(dir, SEMANTIC_FILE), JSON.stringify(knowledge, null, 2));
}

/**
 * Store a piece of semantic knowledge.
 * @param {string} cwd
 * @param {object} fact - { statement, category, confidence, evidence }
 */
function learn(cwd, fact) {
  const knowledge = loadKnowledge(cwd);
  // Check for existing similar knowledge
  const existing = knowledge.find(k =>
    k.statement.toLowerCase() === fact.statement.toLowerCase() ||
    (k.category === fact.category && levenshteinSimilarity(k.statement, fact.statement) > 0.8)
  );
  if (existing) {
    existing.confidence = Math.min(1, existing.confidence + 0.1);
    existing.evidence = (existing.evidence || []).concat(fact.evidence || []).slice(-10);
    existing.reinforcedAt = Date.now();
    existing.useCount = (existing.useCount || 0) + 1;
  } else {
    knowledge.push({
      id: "know_" + crypto.randomBytes(4).toString("hex"),
      statement: fact.statement,
      category: fact.category || "general", // "convention", "architecture", "bug_pattern", "preference", "constraint"
      confidence: fact.confidence || 0.5,
      evidence: fact.evidence || [],
      learnedAt: Date.now(),
      reinforcedAt: null,
      useCount: 0,
    });
  }
  saveKnowledge(cwd, knowledge);
}

function queryKnowledge(cwd, query, category) {
  const knowledge = loadKnowledge(cwd);
  const queryLower = String(query || "").toLowerCase();
  const words = queryLower.split(/\s+/).filter(w => w.length > 3);

  let filtered = knowledge;
  if (category) filtered = filtered.filter(k => k.category === category);

  return filtered.map(k => {
    let score = 0;
    const text = k.statement.toLowerCase();
    for (const w of words) { if (text.includes(w)) score += 2; }
    score += k.confidence * 2;
    score += Math.log(1 + (k.useCount || 0)) * 0.5;
    return { ...k, _score: score };
  })
  .filter(k => k._score > 0)
  .sort((a, b) => b._score - a._score)
  .slice(0, 15);
}

// ---- Memory Consolidation ----
// Compress episodic memories into semantic knowledge (like sleep consolidation).

/**
 * Generate a consolidation prompt — asks the AI to extract general knowledge
 * from recent episodic memories.
 */
function consolidationPrompt(episodes) {
  const episodeText = episodes.map(ep =>
    `- [${new Date(ep.timestamp).toLocaleDateString()}] ${ep.event}${ep.outcome ? " → " + ep.outcome : ""}`
  ).join("\n");

  return [
    "You are analyzing a developer's recent experiences to extract GENERAL knowledge.",
    "From these specific events, identify PATTERNS, RULES, and CONVENTIONS that apply broadly.",
    "",
    "Recent episodes:",
    episodeText,
    "",
    "For each insight, output ONE line in this format:",
    '  CATEGORY | STATEMENT | CONFIDENCE (0.0-1.0)',
    "",
    "Categories: convention, architecture, bug_pattern, preference, constraint, process",
    "Only extract genuinely general knowledge — not one-off events.",
    "Output 3-8 insights, or 'NONE' if these episodes don't reveal patterns.",
  ].join("\n");
}

/**
 * Parse consolidation output into knowledge facts.
 */
function parseConsolidation(output) {
  const facts = [];
  for (const line of String(output || "").split("\n")) {
    const parts = line.split("|").map(s => s.trim());
    if (parts.length >= 3 && parts[0] && parts[1]) {
      facts.push({
        category: parts[0].toLowerCase(),
        statement: parts[1],
        confidence: parseFloat(parts[2]) || 0.5,
      });
    }
  }
  return facts;
}

// ---- Build context from all memory tiers ----

/**
 * Assemble memory context for injection into the agent's prompt.
 * @param {string} cwd
 * @param {string} task - the current task (for relevance filtering)
 * @param {object} workingMemory - the current working memory
 * @returns {string} formatted memory context
 */
function assembleMemoryContext(cwd, task, workingMemory) {
  const parts = [];

  // Working memory (always included)
  if (workingMemory && workingMemory.items.length > 0) {
    parts.push("## Working Memory (current focus)");
    parts.push(workingContext(workingMemory));
  }

  // Semantic knowledge (project truths — always relevant)
  const knowledge = queryKnowledge(cwd, task);
  if (knowledge.length > 0) {
    parts.push("\n## Project Knowledge");
    for (const k of knowledge.slice(0, 8)) {
      const conf = k.confidence >= 0.8 ? "✓" : k.confidence >= 0.5 ? "~" : "?";
      parts.push(`  ${conf} ${k.statement} [${k.category}]`);
    }
  }

  // Episodic memories (relevant past events)
  const episodes = recall(cwd, task, 5);
  if (episodes.length > 0) {
    parts.push("\n## Relevant Past Events");
    for (const ep of episodes) {
      const age = Math.round((Date.now() - ep.timestamp) / 86400000);
      parts.push(`  • ${ep.event}${ep.outcome ? " → " + ep.outcome : ""} (${age}d ago)`);
    }
  }

  return parts.join("\n");
}

// ---- Utilities ----

function levenshteinSimilarity(a, b) {
  a = String(a || "").toLowerCase();
  b = String(b || "").toLowerCase();
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  // Simple word overlap similarity (faster than true Levenshtein for long strings)
  const wordsA = new Set(a.split(/\s+/));
  const wordsB = new Set(b.split(/\s+/));
  let overlap = 0;
  for (const w of wordsA) { if (wordsB.has(w)) overlap++; }
  return overlap / Math.max(wordsA.size, wordsB.size);
}

function memorySummary(cwd) {
  const episodes = loadEpisodes(cwd);
  const knowledge = loadKnowledge(cwd);
  return {
    episodes: episodes.length,
    knowledge: knowledge.length,
    knowledgeByCategory: knowledge.reduce((acc, k) => { acc[k.category] = (acc[k.category] || 0) + 1; return acc; }, {}),
    oldestEpisode: episodes.length ? new Date(episodes[0].timestamp).toLocaleDateString() : null,
    newestEpisode: episodes.length ? new Date(episodes[episodes.length - 1].timestamp).toLocaleDateString() : null,
  };
}

module.exports = {
  // Working memory
  createWorkingMemory, addToWorking, workingContext,
  // Episodic memory
  remember, recall, loadEpisodes,
  // Semantic memory
  learn, queryKnowledge, loadKnowledge,
  // Consolidation
  consolidationPrompt, parseConsolidation,
  // Assembly
  assembleMemoryContext,
  // Utils
  memorySummary,
};
