"use strict";
// ================= NX-107 Local-Model Preflight =================
// Local (Ollama) models run at 8-32K context vs hosted 200K-1M, on the user's own
// hardware. The complaint is that a local task degrades or fails OPAQUELY. This
// module detects the known resource limits BEFORE spending, and returns a
// specific, actionable message for every local-execution failure class:
//   model-not-pulled, context-exceeded, insufficient-vram, thermal-throttle,
//   ollama-down, needs-hosted-engine.
//
// Detection is best-effort and dependency-free (shells out to `ollama` and, if
// present, `nvidia-smi`). Every path returns { ok, failure, message, action }.

const { execSync } = require("child_process");

function sh(cmd, timeout) {
  try { return execSync(cmd, { encoding: "utf8", timeout: timeout || 5000, stdio: ["pipe", "pipe", "pipe"] }).trim(); }
  catch (e) { const err = new Error(String(e.stderr || e.message || e)); err.failed = true; throw err; }
}

// Parse `ollama list` into model names.
function installedModels() {
  try {
    return sh("ollama list").split("\n").slice(1).map(l => l.split(/\s+/)[0]).filter(Boolean);
  } catch (_) { return null; } // null => ollama not reachable
}

// Parse a model's real context length from `ollama show`.
function modelContext(model) {
  try {
    const out = sh("ollama show " + shellQuote(model));
    const m = out.match(/context length\s+(\d+)/i);
    const p = out.match(/parameters\s+([0-9.]+[BMK]?)/i);
    return { context: m ? parseInt(m[1], 10) : null, parameters: p ? p[1] : null };
  } catch (_) { return { context: null, parameters: null }; }
}

function shellQuote(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

// Best-effort VRAM headroom (MiB) via nvidia-smi; null if no NVIDIA GPU.
function vramFreeMiB() {
  try {
    const out = sh("nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits");
    const vals = out.split("\n").map(x => parseInt(x.trim(), 10)).filter(n => !isNaN(n));
    return vals.length ? Math.max(...vals) : null;
  } catch (_) { return null; }
}

// GPU temperature (C) via nvidia-smi; null if unavailable.
function gpuTempC() {
  try {
    const out = sh("nvidia-smi --query-gpu=temperature.gpu --format=csv,noheader,nounits");
    const vals = out.split("\n").map(x => parseInt(x.trim(), 10)).filter(n => !isNaN(n));
    return vals.length ? Math.max(...vals) : null;
  } catch (_) { return null; }
}

// Rough VRAM need from parameter count (GB) for a Q4/Q5 quant: ~0.7 GB per 1B.
function estVramMiBForParams(paramStr) {
  const m = String(paramStr || "").match(/([0-9.]+)\s*B/i);
  if (!m) return null;
  return Math.round(parseFloat(m[1]) * 0.7 * 1024);
}

// Main preflight. opts: { model, estPromptTokens, requireHosted }
// Returns { ok, failure, message, action, detail }.
function preflight(opts) {
  opts = opts || {};
  const model = opts.model || "";

  // 0. task explicitly needs a hosted engine
  if (opts.requireHosted) {
    return fail("needs-hosted-engine", "This task needs a hosted engine (long context / tool breadth beyond local limits).",
      "Run with --engine claude|gemini|codex, or accept reduced scope on local.");
  }

  // 1. is Ollama reachable at all?
  const models = installedModels();
  if (models === null) {
    return fail("ollama-down", "Ollama is not reachable.",
      "Start it (`ollama serve`) or install it (curl -fsSL https://ollama.com/install.sh | sh).");
  }

  // 2. is the model pulled?
  if (model && !models.some(m => m === model || m.split(":")[0] === model.split(":")[0])) {
    return fail("model-not-pulled", "Model '" + model + "' is not installed locally.",
      "Pull it: `ollama pull " + model + "` (installed: " + (models.join(", ") || "none") + ").");
  }

  // 3. context exceeded?
  const info = model ? modelContext(model) : { context: null, parameters: null };
  if (info.context && opts.estPromptTokens && opts.estPromptTokens > info.context) {
    return fail("context-exceeded", "Prompt (~" + opts.estPromptTokens + " tok) exceeds " + model + "'s " + info.context + "-token context.",
      "Trim context (use --lean), split the task, or switch to a hosted engine (200K-1M context).", { modelContext: info.context });
  }

  // 4. insufficient VRAM? (only when we can see a GPU)
  const free = vramFreeMiB();
  const need = estVramMiBForParams(info.parameters);
  if (free != null && need != null && need > free) {
    return fail("insufficient-vram", model + " needs ~" + need + " MiB but only " + free + " MiB VRAM is free.",
      "Close other GPU apps, use a smaller/more-quantized model, or run CPU-only (slower).", { freeMiB: free, needMiB: need });
  }

  // 5. thermal throttling?
  const temp = gpuTempC();
  if (temp != null && temp >= (opts.thermalLimitC || 85)) {
    return fail("thermal-throttle", "GPU is at " + temp + "C — likely throttling.",
      "Pause to let it cool, improve airflow, or offload to a hosted engine for this run.", { tempC: temp });
  }

  return { ok: true, failure: null, message: "local preflight passed", action: null, detail: { modelContext: info.context, vramFreeMiB: free, gpuTempC: temp } };
}

function fail(failure, message, action, detail) { return { ok: false, failure, message, action, detail: detail || {} }; }

module.exports = { preflight, installedModels, modelContext, vramFreeMiB, gpuTempC, estVramMiBForParams, FAILURE_CLASSES: ["needs-hosted-engine", "ollama-down", "model-not-pulled", "context-exceeded", "insufficient-vram", "thermal-throttle"] };
