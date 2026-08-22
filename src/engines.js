"use strict";
// ================= engine registry — one source of truth per AI backend =================
// Add a new AI = add ONE entry here. `args(prompt, opts)` is the ONLY place a given
// engine's CLI flags are built, so a flag meant for one engine can never leak into
// another (verified by test/run.js). `kind`: "stream" = the Claude Code NDJSON driver
// (rich token/cost/tools), "cli" = spawn the binary and stream its stdout, "local" =
// the in-process Ollama tool loop. `caps` documents which cross-engine features apply.
const ENGINES = {
  claude: {
    label: "Claude Code", bin: "claude", install: "npm i -g @anthropic-ai/claude-code", kind: "stream", paid: true, ctx: 200000, model: "opus", models: ["opus", "sonnet", "haiku", "fable"],
    caps: { effort: true, appendSystemPrompt: true, fallbackModel: true, maxBudget: true, disallowedTools: true, cowork: true, model: true },
    args: (p, o) => { const a = ["-p", p, "--output-format", "text"]; if (o.cont) a.push("--continue"); if (o.autonomous) a.push("--dangerously-skip-permissions"); if (o.model) a.push("--model", o.model); if (o.effort) a.push("--effort", o.effort); return a; },
    tips: ["Claude can search the web, run bash, read/write files and spawn sub-agents to parallelize", "your real token usage and dollar cost update live in the status bar", "plan mode (shift+tab) has Claude outline the work before it touches any files", "Claude reads .nexus/NEXUS.md every session — keep project context there"],
  },
  gemini: {
    label: "Gemini CLI", bin: "gemini", install: "npm i -g @google/gemini-cli", kind: "cli", proto: "gemini-json", paid: true, ctx: 1000000, model: "gemini-2.5-pro", models: ["gemini-2.5-pro", "gemini-2.5-flash"],
    caps: { model: true },
    args: (p, o) => { const a = ["--output-format", "json"]; if (o.model) a.push("-m", o.model); if (o.autonomous) a.push("--yolo"); a.push("-p", p); return a; }, // JSON mode → real token counts (geminiParse)
    tips: ["Gemini's very large context window is great for whole-repo questions", "set the model with /model (e.g. gemini-2.5-pro, gemini-2.5-flash)", "needs the Gemini CLI installed and authenticated (`gemini`)"],
  },
  codex: {
    label: "Codex CLI", bin: "codex", install: "npm i -g @openai/codex", kind: "cli", proto: "codex-json", paid: true, ctx: 272000, model: "gpt-5-codex", models: ["gpt-5-codex", "gpt-5", "o4-mini"],
    caps: { model: true },
    args: (p, o) => { const a = ["exec", "--json", "--skip-git-repo-check"]; if (o.model) a.push("-m", o.model); if (o.autonomous) a.push("--dangerously-bypass-approvals-and-sandbox"); a.push(p); return a; }, // JSONL events → real token counts (codexParse)
    tips: ["Codex runs OpenAI models non-interactively via `codex exec`", "set the model with /model (e.g. gpt-5-codex, o4-mini)", "needs the Codex CLI installed and signed in"],
  },
  opencode: {
    label: "OpenCode", bin: "opencode", install: "npm i -g opencode-ai", kind: "cli", paid: true, ctx: 200000, model: "", models: [],
    caps: { model: true },
    args: (p, o) => { const a = ["run"]; if (o.model) a.push("-m", o.model); a.push(p); return a; },
    tips: ["OpenCode drives whichever provider/model you've configured for it", "prefer Claude or a private local model? switch with /engine"],
  },
  aider: {
    label: "Aider", bin: "aider", install: "pipx install aider-chat", kind: "cli", paid: true, ctx: 200000, model: "", models: [],
    caps: { model: true },
    args: (p, o) => { const a = ["--message", p, "--yes-always", "--no-auto-commit"]; if (o.model) a.push("--model", o.model); return a; },
    tips: ["Aider applies edits and shows diffs — pass a model with /model", "runs one message per turn via `aider --message`"],
  },
  ollama: {
    label: "Ollama (local)", bin: "ollama", install: "curl -fsSL https://ollama.com/install.sh | sh", kind: "local", paid: false, ctx: 8192,
    caps: { model: true, cowork: true },
    tips: ["this AI runs 100% on your machine — private, offline-capable, and free", "no token charges here — the meter shows estimated local tokens only", "switch local models anytime with /model (e.g. qwen2.5-coder, hermes3)", "point it at ANY model with /api <base-url> [model] — OpenAI, OpenRouter, Groq, DeepSeek, vLLM…", "it has full local tool access: read, write, edit files and run commands"],
  },
};
const ENGINE_ORDER = ["claude", "gemini", "codex", "opencode", "aider", "ollama"];
const engineCap = (e, c) => !!(ENGINES[e] && ENGINES[e].caps && ENGINES[e].caps[c]); // does this engine support this cross-engine feature?
const ENGINE_TIPS = Object.fromEntries(Object.entries(ENGINES).map(([k, v]) => [k, v.tips || []]));

module.exports = { ENGINES, ENGINE_ORDER, engineCap, ENGINE_TIPS };
