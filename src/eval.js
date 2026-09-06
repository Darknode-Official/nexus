"use strict";
// ================= Self-Evaluation Engine — the agent grades its own work =================
// After completing a task, the agent evaluates its output against quality criteria.
// If the score is below threshold, it automatically retries with the feedback.
// This closed-loop self-improvement is what makes an AI agent reliable.

const CRITERIA = [
  { id: "correctness",   weight: 3, prompt: "Does the output correctly solve the stated task? Are there logic errors, missing edge cases, or wrong assumptions?" },
  { id: "completeness",  weight: 2, prompt: "Does the output address ALL parts of the task? Is anything missing or partially implemented?" },
  { id: "quality",       weight: 2, prompt: "Is the code clean, well-structured, and maintainable? Does it follow project conventions?" },
  { id: "safety",        weight: 3, prompt: "Are there security issues, data loss risks, or destructive operations without safeguards?" },
  { id: "tested",        weight: 1, prompt: "Is the output verified? Are there tests, or was it at least manually checked?" },
];

/**
 * Build the self-evaluation prompt.
 * @param {string} task - what was asked
 * @param {string} output - what the agent produced
 * @param {object[]} criteria - evaluation criteria
 * @returns {string}
 */
function evalPrompt(task, output, criteria) {
  criteria = criteria || CRITERIA;
  const rubric = criteria.map((c, i) =>
    `  ${i + 1}. ${c.id} (weight ${c.weight}): ${c.prompt}`
  ).join("\n");

  return [
    "You are a rigorous evaluator. Grade the WORK below against each criterion.",
    "For each, give a score 1-5 (1=terrible, 5=excellent) and a one-line justification.",
    "",
    "Criteria:",
    rubric,
    "",
    "Then give an OVERALL score (weighted average, 1-5) and a VERDICT:",
    "  - 4.0+ = PASS (ship it)",
    "  - 3.0-3.9 = REVISE (specific improvements needed)",
    "  - <3.0 = FAIL (fundamental problems)",
    "",
    "Output ONLY valid JSON:",
    '{ "scores": { "<criterion_id>": { "score": N, "reason": "..." } }, "overall": N, "verdict": "PASS|REVISE|FAIL", "feedback": "..." }',
    "",
    "## TASK",
    task,
    "",
    "## WORK",
    output,
  ].join("\n");
}

/**
 * Parse the evaluation response.
 * @param {string} response - the AI's eval JSON
 * @returns {{ scores: object, overall: number, verdict: string, feedback: string, valid: boolean }}
 */
function parseEval(response) {
  try {
    // Extract JSON from response (may be wrapped in code fences)
    const jsonMatch = String(response).match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { scores: {}, overall: 0, verdict: "FAIL", feedback: "Could not parse evaluation", valid: false };
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      scores: parsed.scores || {},
      overall: Number(parsed.overall) || 0,
      verdict: String(parsed.verdict || "FAIL").toUpperCase(),
      feedback: String(parsed.feedback || ""),
      valid: true,
    };
  } catch (_) {
    return { scores: {}, overall: 0, verdict: "FAIL", feedback: "Evaluation parse error", valid: false };
  }
}

/**
 * Decide whether to retry based on evaluation.
 * @param {{ overall: number, verdict: string }} evaluation
 * @param {object} opts - { minScore, maxRetries, currentRetry }
 * @returns {{ shouldRetry: boolean, reason: string }}
 */
function retryDecision(evaluation, opts) {
  opts = opts || {};
  const minScore = opts.minScore || 3.5;
  const maxRetries = opts.maxRetries || 2;
  const currentRetry = opts.currentRetry || 0;

  if (evaluation.overall >= minScore || evaluation.verdict === "PASS") {
    return { shouldRetry: false, reason: "Quality threshold met" };
  }
  if (currentRetry >= maxRetries) {
    return { shouldRetry: false, reason: `Max retries (${maxRetries}) reached` };
  }
  return {
    shouldRetry: true,
    reason: `Score ${evaluation.overall.toFixed(1)} < ${minScore} — retrying with feedback`,
  };
}

/**
 * Build a retry prompt incorporating the evaluation feedback.
 */
function retryPrompt(originalTask, previousOutput, evaluation) {
  return [
    "Your previous attempt scored " + evaluation.overall.toFixed(1) + "/5 (" + evaluation.verdict + ").",
    "",
    "Feedback: " + evaluation.feedback,
    "",
    "Specific issues:",
    ...Object.entries(evaluation.scores || {}).filter(([_, v]) => v.score < 4).map(([k, v]) =>
      `  - ${k}: ${v.score}/5 — ${v.reason}`
    ),
    "",
    "## Original task:",
    originalTask,
    "",
    "Fix ALL the issues above. Produce a COMPLETE, improved solution.",
  ].join("\n");
}

/**
 * Run the full eval-retry loop.
 * @param {string} task
 * @param {function} doWork - async (prompt) => output
 * @param {function} doEval - async (evalPrompt) => evalResponse
 * @param {object} opts - { minScore, maxRetries }
 * @returns {Promise<{ output: any, evaluation: object, retries: number, history: object[] }>}
 */
async function evalLoop(task, doWork, doEval, opts) {
  opts = opts || {};
  const history = [];
  let output = await doWork(task);
  let retries = 0;

  for (let i = 0; i <= (opts.maxRetries || 2); i++) {
    const ep = evalPrompt(task, typeof output === "string" ? output : JSON.stringify(output));
    const evalResponse = await doEval(ep);
    const evaluation = parseEval(evalResponse);
    history.push({ attempt: i + 1, evaluation, outputPreview: String(output).slice(0, 200) });

    const decision = retryDecision(evaluation, { ...opts, currentRetry: i });
    if (!decision.shouldRetry) {
      return { output, evaluation, retries, history };
    }

    // Retry
    retries++;
    const rp = retryPrompt(task, output, evaluation);
    output = await doWork(rp);
  }

  return { output, evaluation: history[history.length - 1]?.evaluation, retries, history };
}

module.exports = { CRITERIA, evalPrompt, parseEval, retryDecision, retryPrompt, evalLoop };
