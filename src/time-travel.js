"use strict";
// ================= Time Travel — /undo on steroids =================
//
// UNIQUE CONCEPT: Every AI action creates a checkpoint. You can:
//   - UNDO any action (not just the last one — any specific one)
//   - REDO an undone action
//   - FORK from any checkpoint to try a different approach
//   - DIFF between any two checkpoints
//   - REPLAY a sequence of actions in a different context
//
// Unlike git (which checkpoints manually), Time Travel checkpoints
// AUTOMATICALLY on every AI action — you never lose work.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execSync } = require("child_process");

const TT_DIR = ".nexus/timeline";
const MAX_CHECKPOINTS = 100;

function run(cmd, cwd) {
  try { return execSync(cmd, { cwd, encoding: "utf8", timeout: 10000, stdio: ["pipe","pipe","pipe"] }).trim(); }
  catch (_) { return ""; }
}

// ---- Checkpoint ----

function createCheckpoint(cwd, description, filesChanged) {
  const id = "cp_" + Date.now().toString(36) + "_" + crypto.randomBytes(3).toString("hex");
  const snapshot = {};

  // Snapshot only the changed files (efficient)
  for (const file of (filesChanged || [])) {
    const fp = path.resolve(cwd, file);
    try { snapshot[file] = fs.readFileSync(fp, "utf8"); }
    catch (_) { snapshot[file] = null; } // file was deleted
  }

  const checkpoint = {
    id,
    description,
    files: filesChanged || [],
    snapshot,
    gitRef: run("git rev-parse HEAD 2>/dev/null", cwd) || null,
    gitDirty: run("git status --porcelain 2>/dev/null", cwd).length > 0,
    timestamp: Date.now(),
    parentId: null,
  };

  return checkpoint;
}

// ---- Timeline (ordered list of checkpoints) ----

function timelineDir(cwd) { return path.join(cwd, TT_DIR); }

function loadTimeline(cwd) {
  const dir = timelineDir(cwd);
  try {
    const index = JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8"));
    return index;
  } catch (_) {
    return { checkpoints: [], head: null, forks: [] };
  }
}

function saveTimeline(cwd, timeline) {
  const dir = timelineDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  // Trim old checkpoints
  if (timeline.checkpoints.length > MAX_CHECKPOINTS) {
    const removed = timeline.checkpoints.splice(0, timeline.checkpoints.length - MAX_CHECKPOINTS);
    for (const cp of removed) {
      try { fs.unlinkSync(path.join(dir, cp.id + ".json")); } catch (_) {}
    }
  }
  fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify(timeline, null, 2));
}

function saveCheckpoint(cwd, checkpoint) {
  const dir = timelineDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, checkpoint.id + ".json"), JSON.stringify(checkpoint));

  const timeline = loadTimeline(cwd);
  checkpoint.parentId = timeline.head;
  timeline.checkpoints.push({ id: checkpoint.id, description: checkpoint.description, timestamp: checkpoint.timestamp, files: checkpoint.files });
  timeline.head = checkpoint.id;
  saveTimeline(cwd, timeline);
  return checkpoint;
}

function loadCheckpoint(cwd, id) {
  try { return JSON.parse(fs.readFileSync(path.join(timelineDir(cwd), id + ".json"), "utf8")); }
  catch (_) { return null; }
}

// ---- Undo: restore files from a specific checkpoint ----

function undo(cwd, checkpointId) {
  const cp = loadCheckpoint(cwd, checkpointId);
  if (!cp) return { ok: false, error: "Checkpoint not found: " + checkpointId };

  const restored = [];
  for (const [file, content] of Object.entries(cp.snapshot)) {
    const fp = path.resolve(cwd, file);
    if (content === null) {
      // File was created after this checkpoint — delete it
      try { fs.unlinkSync(fp); restored.push({ file, action: "deleted" }); }
      catch (_) { restored.push({ file, action: "skip (already gone)" }); }
    } else {
      // Restore the file content
      try {
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        fs.writeFileSync(fp, content);
        restored.push({ file, action: "restored" });
      } catch (e) { restored.push({ file, action: "failed: " + e.message }); }
    }
  }

  // Save an undo checkpoint (so you can redo)
  const undoCp = createCheckpoint(cwd, "Undo → " + cp.description, cp.files);
  saveCheckpoint(cwd, undoCp);

  return { ok: true, checkpoint: cp.description, restored, undoCheckpoint: undoCp.id };
}

// ---- Diff: compare two checkpoints ----

function diff(cwd, fromId, toId) {
  const from = loadCheckpoint(cwd, fromId);
  const to = loadCheckpoint(cwd, toId);
  if (!from || !to) return { error: "Checkpoint not found" };

  const changes = [];
  const allFiles = new Set([...Object.keys(from.snapshot), ...Object.keys(to.snapshot)]);

  for (const file of allFiles) {
    const fromContent = from.snapshot[file];
    const toContent = to.snapshot[file];

    if (fromContent === undefined && toContent !== undefined) {
      changes.push({ file, type: "added", lines: toContent ? toContent.split("\n").length : 0 });
    } else if (fromContent !== undefined && toContent === undefined) {
      changes.push({ file, type: "removed" });
    } else if (fromContent !== toContent) {
      const fromLines = (fromContent || "").split("\n");
      const toLines = (toContent || "").split("\n");
      changes.push({ file, type: "modified", fromLines: fromLines.length, toLines: toLines.length, delta: toLines.length - fromLines.length });
    }
  }

  return { from: from.description, to: to.description, changes };
}

// ---- Fork: branch the timeline from a checkpoint ----

function fork(cwd, checkpointId, description) {
  const cp = loadCheckpoint(cwd, checkpointId);
  if (!cp) return { ok: false, error: "Checkpoint not found" };

  // Restore the checkpoint first
  const result = undo(cwd, checkpointId);
  if (!result.ok) return result;

  // Mark as a fork in the timeline
  const timeline = loadTimeline(cwd);
  timeline.forks.push({
    fromCheckpoint: checkpointId,
    description: description || "Fork from " + cp.description,
    timestamp: Date.now(),
  });
  saveTimeline(cwd, timeline);

  return { ok: true, forkedFrom: cp.description, message: "Timeline forked. You're now on a new branch from this point." };
}

// ---- List: show the timeline ----

function listCheckpoints(cwd, limit) {
  const timeline = loadTimeline(cwd);
  const checkpoints = timeline.checkpoints.slice(-(limit || 20)).reverse();
  return checkpoints.map(cp => ({
    id: cp.id,
    description: cp.description,
    files: cp.files.length,
    age: Math.round((Date.now() - cp.timestamp) / 60000) + "m ago",
    isHead: cp.id === timeline.head,
  }));
}

function visualizeTimeline(cwd, limit) {
  const cps = listCheckpoints(cwd, limit);
  if (!cps.length) return "No checkpoints yet. Actions will auto-checkpoint.";
  const lines = ["Timeline (newest first):", ""];
  for (const cp of cps) {
    const head = cp.isHead ? " ◄ HEAD" : "";
    lines.push(`  ${cp.isHead ? "●" : "○"} ${cp.id.slice(0, 12)} — ${cp.description} (${cp.files} files, ${cp.age})${head}`);
  }
  return lines.join("\n");
}

module.exports = {
  createCheckpoint, saveCheckpoint, loadCheckpoint,
  undo, diff, fork,
  listCheckpoints, visualizeTimeline,
  loadTimeline, saveTimeline,
};
