"use strict";
// ================= Reasoning Engine — structured chain-of-thought for complex decisions =================
// Instead of one-shot prompting, the reasoning engine breaks complex questions into
// a structured thought process: observe → hypothesize → test → conclude.
// Each step is explicit and auditable — you can see WHY the agent made a decision.

/**
 * Build a structured reasoning prompt that forces the AI through a rigorous process.
 * @param {string} question - the problem to reason about
 * @param {string} context - relevant code/project context
 * @param {string} mode - 'analyze' | 'debug' | 'design' | 'decide'
 * @returns {string}
 */
function reasoningPrompt(question, context, mode) {
  const modes = {
    analyze: {
      steps: [
        "1. OBSERVE: What exactly is in front of you? List the concrete facts from the code/context.",
        "2. PATTERN: What patterns, anti-patterns, or anomalies do you see?",
        "3. IMPLICATIONS: What are the consequences of what you found?",
        "4. RECOMMENDATIONS: What specific actions should be taken, ranked by impact?",
      ],
      instruction: "Analyze this code/situation systematically.",
    },
    debug: {
      steps: [
        "1. SYMPTOMS: What is the exact error/behavior? Quote error messages verbatim.",
        "2. HYPOTHESES: List 3-5 possible causes, ranked by likelihood. For each, state what evidence would confirm or rule it out.",
        "3. INVESTIGATION: For the top hypothesis, what specific check would confirm it? (a file to read, a command to run, a value to inspect)",
        "4. ROOT CAUSE: Based on the evidence, what is the actual cause?",
        "5. FIX: What is the minimal change that fixes it without side effects?",
        "6. PREVENTION: How to prevent this class of bug in the future?",
      ],
      instruction: "Debug this issue using systematic elimination.",
    },
    design: {
      steps: [
        "1. REQUIREMENTS: What must this system do? List functional and non-functional requirements.",
        "2. CONSTRAINTS: What can't change? (existing APIs, performance budgets, backward compatibility)",
        "3. OPTIONS: Describe 2-3 design approaches. For each: architecture sketch, pros, cons, complexity estimate.",
        "4. TRADEOFFS: What does each option trade? (simplicity vs flexibility, performance vs maintainability)",
        "5. RECOMMENDATION: Which option and why? What are the risks of this choice?",
        "6. PLAN: Step-by-step implementation plan with dependencies.",
      ],
      instruction: "Design a solution using structured architectural thinking.",
    },
    decide: {
      steps: [
        "1. FRAME: What exactly is the decision? What are the options?",
        "2. CRITERIA: What matters? List criteria and their relative importance.",
        "3. EVALUATE: Score each option against each criterion (1-5).",
        "4. RISKS: What could go wrong with each option? How likely, how severe?",
        "5. DECISION: Which option wins and why? What's the confidence level?",
        "6. REVERSIBILITY: How hard is it to change this decision later?",
      ],
      instruction: "Make this decision using structured evaluation.",
    },
  };

  const m = modes[mode] || modes.analyze;
  return [
    "You are a senior engineer using structured reasoning. " + m.instruction,
    "",
    "Follow these steps IN ORDER. Complete each step fully before moving to the next.",
    "Write your reasoning under each numbered heading.",
    "",
    ...m.steps,
    "",
    context ? "## Context\n" + context + "\n" : "",
    "## Question",
    question,
  ].join("\n");
}

/**
 * Parse a structured reasoning response into sections.
 */
function parseReasoning(response) {
  const text = String(response || "");
  const sections = {};
  const lines = text.split("\n");
  let currentSection = null;
  let currentContent = [];

  for (const line of lines) {
    const headerMatch = line.match(/^(\d+)\.\s*([A-Z]+):\s*(.*)/);
    if (headerMatch) {
      if (currentSection) sections[currentSection] = currentContent.join("\n").trim();
      currentSection = headerMatch[2].toLowerCase();
      currentContent = headerMatch[3] ? [headerMatch[3]] : [];
    } else if (currentSection) {
      currentContent.push(line);
    }
  }
  if (currentSection) sections[currentSection] = currentContent.join("\n").trim();

  return {
    sections,
    stepCount: Object.keys(sections).length,
    hasConclusion: !!(sections.recommendations || sections.fix || sections.recommendation || sections.decision),
  };
}

/**
 * Detect the right reasoning mode from the user's question.
 */
function detectMode(question) {
  const q = String(question || "").toLowerCase();
  if (/\b(bug|error|crash|fail|broken|not working|exception|undefined|null|wrong)\b/.test(q)) return "debug";
  if (/\b(design|architect|structure|build|create|implement|how should)\b/.test(q)) return "design";
  if (/\b(should|choose|pick|decide|which|better|compare|vs|or)\b/.test(q)) return "decide";
  return "analyze";
}

module.exports = { reasoningPrompt, parseReasoning, detectMode };
