"use strict";
// Goal-directed autonomous loop controller — powers Nexus /loop (its own "tick loop").
// Pure and tested: given the round, the cap, and the last step's output, decide whether
// to keep going. The agent signals completion by ending a reply with GOAL-DONE.
const DONE_TOKEN = "GOAL-DONE";

function loopDecision(round, maxRounds, output) {
  if (typeof output === "string" && output.toUpperCase().includes(DONE_TOKEN)) return { stop: true, reason: "goal complete" };
  if (round >= maxRounds) return { stop: true, reason: "reached the " + maxRounds + "-round limit" };
  return { stop: false, reason: "continue" };
}

// Clamp the requested round count to a sane range (default 6, 1..20).
function clampRounds(n, def) { n = parseInt(n, 10); if (!Number.isFinite(n)) return def || 6; return Math.max(1, Math.min(20, n)); }

// Build the per-round prompt for the agent.
function loopPrompt(goal, round, maxRounds, lastNote) {
  return "You are running an autonomous goal loop (round " + round + "/" + maxRounds + ").\n"
    + "GOAL: " + goal + "\n"
    + (lastNote ? "\nPrevious round's result:\n" + lastNote + "\n" : "")
    + "\nDo the SINGLE most valuable next step toward the goal now (create/edit files, run commands as needed). "
    + "Keep each step focused. When the goal is FULLY complete and verified, end your reply with the token " + DONE_TOKEN + ".";
}
module.exports = { DONE_TOKEN, loopDecision, clampRounds, loopPrompt };
