"use strict";
// ================= Skill Forge — the agent creates and composes its own tools =================
//
// WHAT THIS IS:
// Most AI agents use a FIXED set of tools. Skill Forge lets the agent CREATE new tools
// from successful action sequences, then REUSE and COMPOSE them on future tasks.
// Over time, the agent builds a library of project-specific skills — making it faster
// and more capable the longer you use it.
//
// RESEARCH BASIS:
// - Voyager (Wang et al. 2023): Minecraft agent that builds a skill library
// - CREATOR (Qian et al. 2024): LLMs that create tools via code generation
// - Toolformer: training LLMs to create and use tools
// - Compositional generalization: combining simple skills into complex behaviors
//
// HOW IT WORKS:
// 1. OBSERVE: Watch the agent's successful action sequences
// 2. EXTRACT: Identify reusable patterns (3+ step sequences that achieved a goal)
// 3. CODIFY: Generate a tool function that encapsulates the pattern
// 4. STORE: Save to .nexus/skills/ with metadata (when to use, what it needs)
// 5. COMPOSE: Combine existing skills into higher-order skills
// 6. RECALL: On new tasks, search skills by relevance and inject into tool set

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const SKILLS_DIR = ".nexus/skills";
const SKILL_INDEX = ".nexus/skills/index.json";

// ---- Skill representation ----

function createSkill(opts) {
  return {
    id: "skill_" + crypto.randomBytes(4).toString("hex"),
    name: opts.name,
    description: opts.description,
    // When should this skill be used?
    triggers: opts.triggers || [],         // keyword/intent triggers
    preconditions: opts.preconditions || [],// what must be true before using
    // What does it do?
    steps: opts.steps || [],               // the action sequence
    code: opts.code || null,               // generated tool function (string)
    // Metadata
    createdAt: Date.now(),
    lastUsed: null,
    useCount: 0,
    successCount: 0,
    confidence: opts.confidence || 0.5,
    source: opts.source || "extracted",    // extracted | composed | manual
    composedFrom: opts.composedFrom || [], // skill IDs this was composed from
  };
}

// ---- Skill extraction from action history ----

/**
 * Extract potential skills from a sequence of successful actions.
 * Looks for patterns: repeated sub-sequences, goal-achieving sequences.
 * @param {Array<{action, args, result, success, timestamp}>} history
 * @returns {object[]} candidate skills
 */
function extractSkills(history) {
  const candidates = [];
  if (history.length < 3) return candidates;

  // Find successful sub-sequences (3+ actions ending in success)
  for (let start = 0; start < history.length - 2; start++) {
    for (let end = start + 2; end < Math.min(start + 10, history.length); end++) {
      const sequence = history.slice(start, end + 1);
      const allSuccess = sequence.every(s => s.success !== false);
      if (!allSuccess) continue;

      // Score the sequence
      const hasRead = sequence.some(s => /read|search|find|list/i.test(s.action));
      const hasWrite = sequence.some(s => /write|edit|create/i.test(s.action));
      const hasVerify = sequence.some(s => /test|verify|check|run/i.test(s.action));

      // Good skills: read → transform → verify
      let score = 0;
      if (hasRead && hasWrite) score += 2;        // read-modify pattern
      if (hasVerify) score += 2;                  // includes verification
      if (sequence.length >= 3 && sequence.length <= 7) score += 1; // reasonable length
      if (score < 2) continue;

      // Generate a name from the actions
      const actions = sequence.map(s => s.action).join(" → ");
      const name = sequence.map(s => {
        if (/read/i.test(s.action)) return "read";
        if (/write/i.test(s.action)) return "write";
        if (/edit/i.test(s.action)) return "modify";
        if (/run|exec/i.test(s.action)) return "run";
        if (/search|find/i.test(s.action)) return "search";
        if (/test|verify/i.test(s.action)) return "verify";
        return s.action;
      }).join("_");

      candidates.push(createSkill({
        name: name,
        description: `Automated: ${actions}`,
        steps: sequence.map(s => ({ action: s.action, args: s.args })),
        triggers: extractTriggerWords(sequence),
        confidence: Math.min(1, score * 0.2),
        source: "extracted",
      }));
    }
  }

  // Deduplicate similar candidates
  const unique = [];
  for (const c of candidates) {
    const isDupe = unique.some(u =>
      u.steps.length === c.steps.length &&
      u.steps.every((s, i) => s.action === c.steps[i].action)
    );
    if (!isDupe) unique.push(c);
  }

  return unique.sort((a, b) => b.confidence - a.confidence).slice(0, 10);
}

function extractTriggerWords(sequence) {
  const words = new Set();
  for (const step of sequence) {
    const text = JSON.stringify(step.args || {}).toLowerCase();
    // Extract meaningful words (not common ones)
    const meaningful = text.match(/\b[a-z]{4,}\b/g) || [];
    for (const w of meaningful.slice(0, 5)) {
      if (!/true|false|null|undefined|string|number|function|return|const/.test(w)) {
        words.add(w);
      }
    }
  }
  return [...words].slice(0, 10);
}

// ---- Skill code generation ----

/**
 * Generate a tool function from a skill's action sequence.
 * The generated code is a self-contained function that can be executed by the agent.
 */
function generateSkillCode(skill) {
  const params = new Set();
  const body = [];

  for (const step of skill.steps) {
    // Extract parameterizable values from args
    if (step.args) {
      for (const [key, value] of Object.entries(step.args)) {
        if (typeof value === "string" && value.length > 3) {
          params.add(key);
        }
      }
    }
    body.push(`  // Step: ${step.action}`);
    body.push(`  const result_${body.length} = await tools.${step.action}(${JSON.stringify(step.args || {})});`);
  }

  const paramList = [...params].join(", ");
  return `async function ${skill.name.replace(/[^a-zA-Z0-9_]/g, "_")}(${paramList}, tools) {\n${body.join("\n")}\n}`;
}

// ---- Skill composition ----

/**
 * Compose two or more skills into a higher-order skill.
 * @param {object[]} skills - skills to compose
 * @param {string} name - name for the composed skill
 * @param {string} description - what the composed skill does
 * @returns {object} composed skill
 */
function composeSkills(skills, name, description) {
  const allSteps = [];
  for (const skill of skills) {
    allSteps.push(...skill.steps);
  }

  const allTriggers = new Set();
  for (const skill of skills) {
    for (const t of skill.triggers) allTriggers.add(t);
  }

  return createSkill({
    name,
    description: description || `Composed from: ${skills.map(s => s.name).join(" + ")}`,
    steps: allSteps,
    triggers: [...allTriggers],
    confidence: Math.min(...skills.map(s => s.confidence)),
    source: "composed",
    composedFrom: skills.map(s => s.id),
  });
}

// ---- Skill persistence ----

function skillsDir(cwd) { return path.join(cwd, SKILLS_DIR); }

function saveSkill(cwd, skill) {
  const dir = skillsDir(cwd);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  const code = generateSkillCode(skill);
  skill.code = code;
  fs.writeFileSync(path.join(dir, skill.id + ".json"), JSON.stringify(skill, null, 2));
  // Update index
  updateIndex(cwd);
  return skill;
}

function loadSkill(cwd, id) {
  try { return JSON.parse(fs.readFileSync(path.join(skillsDir(cwd), id + ".json"), "utf8")); }
  catch (_) { return null; }
}

function listSkills(cwd) {
  const dir = skillsDir(cwd);
  try {
    return fs.readdirSync(dir)
      .filter(f => f.endsWith(".json") && f !== "index.json")
      .map(f => {
        try { return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); }
        catch (_) { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => (b.useCount * b.confidence) - (a.useCount * a.confidence));
  } catch (_) { return []; }
}

function updateIndex(cwd) {
  const skills = listSkills(cwd);
  const index = skills.map(s => ({
    id: s.id, name: s.name, description: s.description,
    triggers: s.triggers, confidence: s.confidence,
    useCount: s.useCount, source: s.source,
  }));
  try { fs.writeFileSync(path.join(skillsDir(cwd), "index.json"), JSON.stringify(index, null, 2)); }
  catch (_) {}
}

// ---- Skill retrieval ----

/**
 * Find skills relevant to a task.
 * @param {string} cwd
 * @param {string} task - the current task
 * @returns {object[]} relevant skills, ranked
 */
function findRelevantSkills(cwd, task) {
  const skills = listSkills(cwd);
  const taskLower = String(task || "").toLowerCase();
  const words = taskLower.split(/\s+/).filter(w => w.length > 3);

  return skills.map(skill => {
    let score = 0;
    // Trigger match
    for (const trigger of skill.triggers) {
      if (taskLower.includes(trigger.toLowerCase())) score += 3;
    }
    // Description match
    const descLower = (skill.description || "").toLowerCase();
    for (const w of words) {
      if (descLower.includes(w)) score += 1;
    }
    // Boost by historical success
    if (skill.useCount > 0) {
      const successRate = skill.successCount / skill.useCount;
      score *= (1 + successRate);
    }
    // Boost by confidence
    score *= skill.confidence;
    return { skill, score };
  })
  .filter(s => s.score > 0)
  .sort((a, b) => b.score - a.score)
  .slice(0, 5)
  .map(s => s.skill);
}

/**
 * Record that a skill was used (and whether it succeeded).
 */
function recordSkillUse(cwd, skillId, success) {
  const skill = loadSkill(cwd, skillId);
  if (!skill) return;
  skill.useCount++;
  if (success) skill.successCount++;
  skill.lastUsed = Date.now();
  // Adjust confidence based on outcomes
  if (success) skill.confidence = Math.min(1, skill.confidence + 0.05);
  else skill.confidence = Math.max(0.1, skill.confidence - 0.1);
  saveSkill(cwd, skill);
}

// ---- Summary ----

function forgeSummary(cwd) {
  const skills = listSkills(cwd);
  return {
    totalSkills: skills.length,
    extracted: skills.filter(s => s.source === "extracted").length,
    composed: skills.filter(s => s.source === "composed").length,
    manual: skills.filter(s => s.source === "manual").length,
    mostUsed: skills.slice(0, 5).map(s => ({ name: s.name, uses: s.useCount, confidence: s.confidence.toFixed(2) })),
    totalUses: skills.reduce((s, sk) => s + sk.useCount, 0),
  };
}

module.exports = {
  createSkill, extractSkills, generateSkillCode, composeSkills,
  saveSkill, loadSkill, listSkills, findRelevantSkills, recordSkillUse,
  forgeSummary,
};
