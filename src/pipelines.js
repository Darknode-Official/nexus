"use strict";
// ================= Project Pipelines — named multi-agent workflows =================
// Configurable pipelines where specialized agents collaborate on a project.
// Each pipeline defines ROLES (specialized agents), STAGES (ordered phases),
// and HANDOFFS (how output flows between agents).
//
// Unlike raw multi-agent orchestration, pipelines are:
// - NAMED and REUSABLE — define once, run on any project
// - ROLE-BASED — each agent has a persona, tools, and focus area
// - STAGE-GATED — each stage must pass verification before the next begins
// - RESUMABLE — save/restore pipeline state mid-execution

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PIPELINE_DIR = ".nexus/pipelines";

// ---- Agent Role Definitions ----

const ROLES = {
  architect: {
    name: "Architect",
    persona: "You are a senior software architect. You design systems, define interfaces, plan module boundaries, and make technology decisions. You do NOT write implementation code — you write specs and plans.",
    tools: ["read_file", "list_dir", "search", "run_command"],
    focus: "system design, API contracts, module boundaries, tech stack decisions",
  },
  implementer: {
    name: "Implementer",
    persona: "You are an expert developer. You take specs/plans and write clean, tested, production-quality code. Follow the project's conventions exactly. You do NOT redesign — you implement what the architect specified.",
    tools: ["read_file", "write_file", "edit_file", "run_command", "list_dir", "search"],
    focus: "writing code, following specs, matching conventions",
  },
  reviewer: {
    name: "Reviewer",
    persona: "You are a principal engineer performing adversarial code review. Find REAL bugs, security issues, and design flaws. Be specific: file:line, problem, fix. Do NOT nitpick style.",
    tools: ["read_file", "search", "run_command"],
    focus: "correctness, security, performance, maintainability",
  },
  tester: {
    name: "Tester",
    persona: "You are a QA engineer. Write comprehensive tests: happy path, edge cases, error conditions, boundary values. Run them and report results. Tests must PASS.",
    tools: ["read_file", "write_file", "run_command", "search"],
    focus: "test coverage, edge cases, error handling, regression",
  },
  documenter: {
    name: "Documenter",
    persona: "You are a technical writer. Write clear, accurate documentation: README, API docs, inline comments, architecture decisions. Read the actual code — never guess.",
    tools: ["read_file", "write_file", "search", "list_dir"],
    focus: "documentation, examples, API reference, architecture docs",
  },
  security: {
    name: "Security Analyst",
    persona: "You are a security researcher. Audit code for vulnerabilities: injection, auth bypass, SSRF, path traversal, secrets exposure, insecure defaults. Provide severity, PoC, and fix.",
    tools: ["read_file", "search", "run_command"],
    focus: "vulnerabilities, attack vectors, secure defaults, secrets",
  },
  optimizer: {
    name: "Performance Engineer",
    persona: "You are a performance engineer. Profile, benchmark, and optimize. Find: O(n²) loops, repeated I/O, missing caching, memory leaks, blocking operations. Prove impact with measurements.",
    tools: ["read_file", "run_command", "search", "edit_file"],
    focus: "performance, profiling, caching, async optimization",
  },
  devops: {
    name: "DevOps Engineer",
    persona: "You are a DevOps/infra engineer. Set up CI/CD, Docker, deployment configs, monitoring, and infrastructure. Make builds reproducible and deployments safe.",
    tools: ["read_file", "write_file", "run_command", "list_dir"],
    focus: "CI/CD, Docker, deployment, monitoring, infrastructure",
  },
};

// ---- Built-in Pipeline Templates ----

const TEMPLATES = {
  // Full software development lifecycle
  "full-build": {
    name: "Full Build",
    description: "Architect → Implement → Test → Review → Document",
    stages: [
      { role: "architect", task: "Analyze the goal and create a detailed implementation plan with module boundaries, interfaces, and data flow.", gate: "plan" },
      { role: "implementer", task: "Implement the architect's plan. Write all code, following project conventions.", gate: "verify" },
      { role: "tester", task: "Write comprehensive tests for the implementation. Run them and ensure all pass.", gate: "verify" },
      { role: "reviewer", task: "Review the implementation and tests. Report bugs, security issues, and design flaws.", gate: "review" },
      { role: "implementer", task: "Fix all issues found by the reviewer. Re-run tests.", gate: "verify" },
      { role: "documenter", task: "Write documentation: README updates, API docs, inline comments.", gate: "none" },
    ],
  },

  // Quick feature implementation
  "quick-feature": {
    name: "Quick Feature",
    description: "Implement → Test → Review (fast, for small changes)",
    stages: [
      { role: "implementer", task: "Implement the feature.", gate: "verify" },
      { role: "tester", task: "Write and run tests.", gate: "verify" },
      { role: "reviewer", task: "Quick review — focus on bugs and security only.", gate: "none" },
    ],
  },

  // Security audit
  "security-audit": {
    name: "Security Audit",
    description: "Security scan → Manual audit → Fix → Re-audit",
    stages: [
      { role: "security", task: "Run automated security scans and manual code audit. List all findings with severity.", gate: "review" },
      { role: "implementer", task: "Fix all critical and high severity findings.", gate: "verify" },
      { role: "security", task: "Re-audit the fixes. Confirm all critical/high issues are resolved.", gate: "none" },
    ],
  },

  // Code quality improvement
  "quality-sweep": {
    name: "Quality Sweep",
    description: "Review → Optimize → Test → Document",
    stages: [
      { role: "reviewer", task: "Full codebase review. Identify tech debt, design flaws, dead code.", gate: "review" },
      { role: "optimizer", task: "Fix performance hotspots and optimize critical paths.", gate: "verify" },
      { role: "tester", task: "Add missing tests. Ensure coverage of edge cases.", gate: "verify" },
      { role: "documenter", task: "Update all documentation to reflect changes.", gate: "none" },
    ],
  },

  // DevOps setup
  "devops-setup": {
    name: "DevOps Setup",
    description: "Architect infra → Implement CI/CD → Test deployment",
    stages: [
      { role: "architect", task: "Design the deployment architecture: CI/CD, Docker, environments, monitoring.", gate: "plan" },
      { role: "devops", task: "Implement the CI/CD pipeline, Dockerfile, and deployment configs.", gate: "verify" },
      { role: "tester", task: "Test the CI pipeline runs. Verify Docker builds. Check deployment works.", gate: "none" },
    ],
  },

  // Parallel deep review
  "deep-review": {
    name: "Deep Review",
    description: "3 parallel agents: security + performance + correctness → merge findings",
    parallel: true,
    stages: [
      { role: "security", task: "Audit for security vulnerabilities.", gate: "none" },
      { role: "optimizer", task: "Audit for performance issues.", gate: "none" },
      { role: "reviewer", task: "Audit for correctness bugs and design flaws.", gate: "none" },
    ],
    merge: "Synthesize all findings into a prioritized action list.",
  },

  // 3D model creation pipeline (for the MCP 3D tool)
  "3d-model": {
    name: "3D Model Pipeline",
    description: "Design → Structure → Detail → Texture → Export",
    stages: [
      { role: "architect", task: "Design the 3D model structure: define layers, components, materials, and assembly order.", gate: "plan" },
      { role: "implementer", task: "Build the base geometry using the 3D modeling tool. Create structural layers 1-30.", gate: "none" },
      { role: "implementer", task: "Add detail layers 31-70: surface detail, bevels, edge loops, mechanical parts.", gate: "none" },
      { role: "implementer", task: "Add refinement layers 71-100: textures, materials, lighting, final polish.", gate: "none" },
      { role: "reviewer", task: "Review the model: check topology, UV mapping, material assignments, layer organization.", gate: "none" },
    ],
  },
};

// ---- Pipeline State ----

function createPipelineRun(templateName, goal, opts) {
  const template = TEMPLATES[templateName];
  if (!template) throw new Error("Unknown pipeline: " + templateName + ". Available: " + Object.keys(TEMPLATES).join(", "));

  return {
    id: "pipe_" + crypto.randomBytes(6).toString("hex"),
    template: templateName,
    name: template.name,
    goal: goal,
    stages: template.stages.map((s, i) => ({
      index: i,
      role: s.role,
      task: s.task,
      gate: s.gate || "none",
      status: "pending",    // pending | running | passed | failed | skipped
      agentId: null,
      input: null,          // output from previous stage
      output: null,
      startedAt: null,
      finishedAt: null,
      verification: null,
    })),
    parallel: template.parallel || false,
    merge: template.merge || null,
    status: "pending",
    createdAt: Date.now(),
    finishedAt: null,
    opts: opts || {},
  };
}

// ---- Pipeline Execution ----

/**
 * Execute a pipeline stage.
 * @param {object} run - the pipeline run state
 * @param {number} stageIndex - which stage
 * @param {function} executeFn - async (role, prompt, tools) => result
 * @param {function} verifyFn - async (cwd) => { passed, summary }
 * @returns {object} updated stage
 */
async function executeStage(run, stageIndex, executeFn, verifyFn) {
  const stage = run.stages[stageIndex];
  const role = ROLES[stage.role];
  if (!role) throw new Error("Unknown role: " + stage.role);

  stage.status = "running";
  stage.startedAt = Date.now();

  // Build the stage prompt
  const prevOutput = stageIndex > 0 ? run.stages[stageIndex - 1].output : null;
  const prompt = [
    role.persona,
    "",
    "## Project Goal",
    run.goal,
    "",
    "## Your Task (Stage " + (stageIndex + 1) + "/" + run.stages.length + ")",
    stage.task,
    prevOutput ? "\n## Input from Previous Stage\n" + prevOutput : "",
  ].join("\n");

  try {
    const result = await executeFn(stage.role, prompt, role.tools);
    stage.output = typeof result === "string" ? result : JSON.stringify(result);
    stage.status = "passed";
  } catch (e) {
    stage.output = "ERROR: " + e.message;
    stage.status = "failed";
  }

  // Verification gate
  if (stage.gate === "verify" && verifyFn) {
    try {
      stage.verification = await verifyFn();
      if (!stage.verification.passed) stage.status = "failed";
    } catch (e) {
      stage.verification = { passed: false, summary: "Verification error: " + e.message };
    }
  }

  stage.finishedAt = Date.now();
  return stage;
}

/**
 * Run an entire pipeline sequentially.
 */
async function executePipeline(run, executeFn, verifyFn) {
  run.status = "running";

  if (run.parallel) {
    // All stages run in parallel
    await Promise.all(run.stages.map((_, i) => executeStage(run, i, executeFn, verifyFn)));
  } else {
    // Sequential with gate checks
    for (let i = 0; i < run.stages.length; i++) {
      const stage = await executeStage(run, i, executeFn, verifyFn);
      if (stage.status === "failed" && stage.gate !== "none") {
        // Skip remaining stages
        for (let j = i + 1; j < run.stages.length; j++) {
          run.stages[j].status = "skipped";
        }
        break;
      }
    }
  }

  run.status = run.stages.some(s => s.status === "failed") ? "failed" : "completed";
  run.finishedAt = Date.now();
  return run;
}

// ---- Persistence ----

function savePipelineRun(cwd, run) {
  const dir = path.join(cwd, PIPELINE_DIR);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  fs.writeFileSync(path.join(dir, run.id + ".json"), JSON.stringify(run, null, 2));
}

function loadPipelineRun(cwd, id) {
  try { return JSON.parse(fs.readFileSync(path.join(cwd, PIPELINE_DIR, id + ".json"), "utf8")); }
  catch (_) { return null; }
}

function listPipelineRuns(cwd) {
  try {
    return fs.readdirSync(path.join(cwd, PIPELINE_DIR))
      .filter(f => f.endsWith(".json"))
      .map(f => { try { const r = JSON.parse(fs.readFileSync(path.join(cwd, PIPELINE_DIR, f), "utf8")); return { id: r.id, name: r.name, goal: r.goal, status: r.status, createdAt: r.createdAt }; } catch (_) { return null; } })
      .filter(Boolean)
      .sort((a, b) => b.createdAt - a.createdAt);
  } catch (_) { return []; }
}

// ---- Summary ----

function pipelineSummary(run) {
  const counts = { pending: 0, running: 0, passed: 0, failed: 0, skipped: 0 };
  for (const s of run.stages) counts[s.status]++;
  const elapsed = run.finishedAt ? ((run.finishedAt - run.createdAt) / 1000).toFixed(1) + "s" : "running";

  const lines = [
    `Pipeline: ${run.name} [${run.status}] (${elapsed})`,
    `Goal: ${run.goal}`,
    `Stages: ${run.stages.length} — ✅${counts.passed} ❌${counts.failed} ⏳${counts.pending} ⏭${counts.skipped}`,
    "",
  ];
  for (const s of run.stages) {
    const icon = { pending: "⏳", running: "🔄", passed: "✅", failed: "❌", skipped: "⏭" }[s.status];
    const role = ROLES[s.role]?.name || s.role;
    const time = s.startedAt && s.finishedAt ? ` (${((s.finishedAt - s.startedAt) / 1000).toFixed(1)}s)` : "";
    const gate = s.gate !== "none" ? ` [gate: ${s.gate}]` : "";
    lines.push(`  ${icon} ${role}: ${s.task.slice(0, 60)}${time}${gate}`);
    if (s.verification && !s.verification.passed) lines.push(`    ⚠ ${s.verification.summary}`);
  }
  return lines.join("\n");
}

module.exports = {
  ROLES, TEMPLATES,
  createPipelineRun, executeStage, executePipeline,
  savePipelineRun, loadPipelineRun, listPipelineRuns,
  pipelineSummary,
};
