"use strict";
// Local/any-model client — chat, model listing, coder-model selection.
// By default talks to the local Ollama HTTP API (127.0.0.1:11434). If an
// OpenAI-COMPATIBLE endpoint is configured (DARKNODE_API_BASE, e.g. OpenAI,
// OpenRouter, Groq, DeepSeek, Together, Mistral, LM Studio, vLLM, llama.cpp),
// it transparently drives ANY model there instead — same agentic tool loop.
// The tool loop that USES this (ollamaExec / the TUI local turn) is in sentinel.js.
const http = require("http");
const HOST = () => process.env.OLLAMA_HOST || "127.0.0.1";
const PORT = () => +(process.env.OLLAMA_PORT || 11434);
// Configured OpenAI-compatible base URL (any provider). When set, we route there.
const API_BASE = () => (process.env.DARKNODE_API_BASE || process.env.SENTINEL_API_BASE || process.env.OPENAI_BASE_URL || process.env.OPENAI_API_BASE || "").trim();
const API_KEY = () => (process.env.DARKNODE_API_KEY || process.env.SENTINEL_API_KEY || process.env.OPENAI_API_KEY || process.env.OPENROUTER_API_KEY || process.env.GROQ_API_KEY || "").trim();

// POST to any OpenAI-compatible /chat/completions. The tool loop's role:"tool"
// messages are mapped to user turns (this protocol is prompt-driven, not native
// function-calling, so it works with strict OpenAI and lenient providers alike).
function openaiCompatChat(base, model, messages, format, signal) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(base.replace(/\/+$/, "") + "/chat/completions"); }
    catch (e) { return reject(new Error("invalid DARKNODE_API_BASE: " + base)); }
    const lib = url.protocol === "https:" ? require("https") : require("http");
    const msgs = messages.map((m) => m.role === "tool" ? { role: "user", content: "[tool result] " + m.content } : m);
    const payload = { model, messages: msgs, stream: false, temperature: 0.2 };
    if (format) payload.response_format = { type: "json_object" }; // ask for valid JSON; providers that ignore it still work (prompt already asks)
    const body = JSON.stringify(payload);
    const headers = { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) };
    const key = API_KEY(); if (key) headers["Authorization"] = "Bearer " + key;
    const req = lib.request({ hostname: url.hostname, port: url.port || (url.protocol === "https:" ? 443 : 80), path: url.pathname + url.search, method: "POST", signal, headers },
      (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => {
        try {
          const j = JSON.parse(d);
          if (j.error) return reject(new Error("API error: " + (j.error.message || JSON.stringify(j.error))));
          const c = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
          resolve(c || "");
        } catch (e) { reject(new Error("bad API response (" + res.statusCode + "): " + String(d).slice(0, 200))); }
      }); });
    req.setTimeout(+(process.env.OLLAMA_TIMEOUT || 300000), () => req.destroy(new Error("model API timed out (no response)")));
    req.on("error", (e) => reject(new Error("cannot reach model API at " + base + " — " + e.message)));
    req.write(body); req.end();
  });
}

// Native Anthropic (Claude) Messages API — "actual Claude" via an API key, in-process
// (NO headless Claude Code CLI). Used whenever the model id starts with "claude" and a
// key is present. Same prompt-driven tool loop as every other engine.
const ANTHROPIC_KEY = () => (process.env.ANTHROPIC_API_KEY || process.env.DARKNODE_ANTHROPIC_KEY || process.env.SENTINEL_ANTHROPIC_KEY || "").trim();
function hasAnthropic() { return !!ANTHROPIC_KEY(); }
function anthropicChat(model, messages, format, signal) {
  return new Promise((resolve, reject) => {
    const https = require("https");
    const sys = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n")
      + (format ? "\n\nRespond with ONLY valid JSON matching the requested schema — no prose, no code fences." : "");
    // map tool->user, merge consecutive same-role turns, and ensure it starts with user
    const mapped = messages.filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.role === "tool" ? "[tool result] " + m.content : String(m.content) }));
    const msgs = [];
    for (const m of mapped) { const last = msgs[msgs.length - 1]; if (last && last.role === m.role) last.content += "\n\n" + m.content; else msgs.push({ ...m }); }
    if (!msgs.length || msgs[0].role !== "user") msgs.unshift({ role: "user", content: "(begin)" });
    const body = JSON.stringify({ model, max_tokens: 4096, system: sys, messages: msgs });
    const req = https.request({ hostname: "api.anthropic.com", path: "/v1/messages", method: "POST", signal,
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), "x-api-key": ANTHROPIC_KEY(), "anthropic-version": "2023-06-01" } },
      (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => {
        try { const j = JSON.parse(d); if (j.error) return reject(new Error("Claude API: " + (j.error.message || String(d).slice(0, 200))));
          resolve((j.content && j.content.map((b) => b.text || "").join("")) || ""); }
        catch (e) { reject(new Error("bad Claude response (" + res.statusCode + "): " + String(d).slice(0, 160))); }
      }); });
    req.setTimeout(+(process.env.OLLAMA_TIMEOUT || 300000), () => req.destroy(new Error("Claude API timed out (no response)")));
    req.on("error", (e) => reject(new Error("cannot reach Claude API — " + e.message)));
    req.write(body); req.end();
  });
}

function ollamaChat(model, messages, format, signal) {
  const base = API_BASE();
  if (base) return openaiCompatChat(base, model, messages, format, signal);   // an explicitly configured API base always wins
  if (/^claude/i.test(String(model)) && hasAnthropic()) return anthropicChat(model, messages, format, signal);  // else native Claude for claude-* models
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model, stream: false, format, keep_alive: "30m", options: { temperature: 0.2, num_ctx: 16384 }, messages });
    const req = http.request({ host: HOST(), port: PORT(), path: "/api/chat", method: "POST", signal, headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
      (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => { try { resolve(JSON.parse(d).message.content || ""); } catch (e) { reject(new Error("bad model response")); } }); });
    req.setTimeout(+(process.env.OLLAMA_TIMEOUT || 300000), () => { req.destroy(new Error("Ollama timed out (no response) — is the model stuck loading?")); });
    req.on("error", (e) => reject(new Error("cannot reach Ollama at " + HOST() + ":" + PORT() + " — is it running? (" + e.message + ")"))); req.write(body); req.end();
  });
}
function ollamaTags() {
  const base = API_BASE();
  if (base) return new Promise((resolve) => {                 // GET <base>/models (OpenAI list format)
    let url; try { url = new URL(base.replace(/\/+$/, "") + "/models"); } catch (e) { return resolve([]); }
    const lib = url.protocol === "https:" ? require("https") : require("http");
    const key = API_KEY();
    lib.get({ hostname: url.hostname, port: url.port || (url.protocol === "https:" ? 443 : 80), path: url.pathname, headers: key ? { Authorization: "Bearer " + key } : {} },
      (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => { try { const j = JSON.parse(d); resolve((j.data || j.models || []).map((m) => m.id || m.name).filter(Boolean)); } catch (_) { resolve([]); } }); }).on("error", () => resolve([]));
  });
  return new Promise((resolve) => {
    http.get({ host: HOST(), port: PORT(), path: "/api/tags" }, (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => { try { resolve((JSON.parse(d).models || []).map((m) => m.name)); } catch (_) { resolve([]); } }); }).on("error", () => resolve([]));
  });
}
// Pick the best available model for coding/agentic work. gpt-oss (OpenAI's open-weight
// reasoning models) is preferred — gpt-oss:120b first, then 20b — as it's far stronger at
// tool use than small local models. DARKNODE_MODEL overrides. Falls back through known
// coder models, then anything code-ish, then whatever's installed.
function pickCoderModel(ms) {
  ms = ms || [];
  const rawWant = (process.env.DARKNODE_MODEL || process.env.SENTINEL_MODEL || "").trim();
  if (rawWant) { const w = rawWant.toLowerCase(); const hit = ms.find((m) => m.toLowerCase() === w) || ms.find((m) => m.toLowerCase().startsWith(w)); return hit || rawWant; } // honor explicit choice even if not yet pulled (Ollama fetches on first use)
  const pri = ["darknode", "gpt-oss:120b", "gpt-oss:20b", "gpt-oss", "qwen2.5-coder", "deepseek-coder", "codellama", "hermes3", "dolphin3", "llama3.1"];
  for (const p of pri) { const hit = ms.find((m) => m.toLowerCase().startsWith(p)); if (hit) return hit; }
  return ms.find((m) => /coder|code/i.test(m)) || ms[0] || "";
}
// Is an external OpenAI-compatible model API configured (vs local Ollama)?
function apiConfigured() { return !!API_BASE(); }

// Auto-build the local `darknode` Ollama model from the bundled Modelfile on first
// local use. Skips when DARKNODE_NO_AUTOINSTALL is set, when an external API base is
// configured (no local Ollama in play), or when a `darknode`/`darknode:*` model is
// already installed. Streams `ollama create` progress lines to `log`. Never throws;
// resolves true when the model is present/built, false on any failure.
function ensureDarknodeModel(log) {
  const say = typeof log === "function" ? log : function () {};
  return new Promise((resolve) => {
    try {
      if (process.env.DARKNODE_NO_AUTOINSTALL) return resolve(true);
      if (API_BASE()) return resolve(true); // remote API model, nothing to build locally
      ollamaTags().then((tags) => {
        const have = (tags || []).some((t) => { const n = String(t).toLowerCase(); return n === "darknode" || n.indexOf("darknode:") === 0; });
        if (have) return resolve(true);
        const path = require("path");
        const fs = require("fs");
        const mf = path.join(__dirname, "darknode.Modelfile");
        if (!fs.existsSync(mf)) { say("darknode: bundled Modelfile not found at " + mf); return resolve(false); }
        say("darknode: building local model (ollama create darknode) — one-time first-run setup...");
        let proc;
        try { proc = require("child_process").spawn("ollama", ["create", "darknode", "-f", mf], { stdio: ["ignore", "pipe", "pipe"] }); }
        catch (e) { say("darknode: cannot run ollama — " + e.message); return resolve(false); }
        const onData = (buf) => String(buf).split(/\r?\n/).forEach((l) => { if (l.trim()) say(l.trim()); });
        if (proc.stdout) proc.stdout.on("data", onData);
        if (proc.stderr) proc.stderr.on("data", onData);
        proc.on("error", (e) => { say("darknode: build error — " + e.message); resolve(false); });
        proc.on("close", (code) => { if (code === 0) { say("darknode: model ready."); resolve(true); } else { say("darknode: build failed (exit " + code + ")"); resolve(false); } });
      }).catch(() => resolve(false));
    } catch (_) { resolve(false); }
  });
}
module.exports = { ollamaChat, ollamaTags, pickCoderModel, apiConfigured, ensureDarknodeModel, API_BASE, API_KEY, hasAnthropic, ANTHROPIC_KEY };
