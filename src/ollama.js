"use strict";
// Local/any-model client — chat, model listing, coder-model selection.
// By default talks to the local Ollama HTTP API (127.0.0.1:11434). If an
// OpenAI-COMPATIBLE endpoint is configured (SENTINEL_API_BASE, e.g. OpenAI,
// OpenRouter, Groq, DeepSeek, Together, Mistral, LM Studio, vLLM, llama.cpp),
// it transparently drives ANY model there instead — same agentic tool loop.
// The tool loop that USES this (ollamaExec / the TUI local turn) is in sentinel.js.
const http = require("http");
const HOST = () => process.env.OLLAMA_HOST || "127.0.0.1";
const PORT = () => +(process.env.OLLAMA_PORT || 11434);
// Configured OpenAI-compatible base URL (any provider). When set, we route there.
const API_BASE = () => (process.env.SENTINEL_API_BASE || process.env.OPENAI_BASE_URL || process.env.OPENAI_API_BASE || "").trim();
const API_KEY = () => (process.env.SENTINEL_API_KEY || process.env.OPENAI_API_KEY || process.env.OPENROUTER_API_KEY || process.env.GROQ_API_KEY || "").trim();

// POST to any OpenAI-compatible /chat/completions. The tool loop's role:"tool"
// messages are mapped to user turns (this protocol is prompt-driven, not native
// function-calling, so it works with strict OpenAI and lenient providers alike).
function openaiCompatChat(base, model, messages, format, signal) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(base.replace(/\/+$/, "") + "/chat/completions"); }
    catch (e) { return reject(new Error("invalid SENTINEL_API_BASE: " + base)); }
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

function ollamaChat(model, messages, format, signal) {
  const base = API_BASE();
  if (base) return openaiCompatChat(base, model, messages, format, signal);
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
// Pick the best available model for coding: prefer known coder models, then
// anything named code-ish, else the first available model.
function pickCoderModel(ms) {
  ms = ms || [];
  const pri = ["qwen2.5-coder", "deepseek-coder", "codellama", "hermes3", "dolphin3", "llama3.1"];
  for (const p of pri) { const hit = ms.find((m) => m.toLowerCase().startsWith(p)); if (hit) return hit; }
  return ms.find((m) => /coder|code/i.test(m)) || ms[0] || "";
}
// Is an external OpenAI-compatible model API configured (vs local Ollama)?
function apiConfigured() { return !!API_BASE(); }
module.exports = { ollamaChat, ollamaTags, pickCoderModel, apiConfigured, API_BASE, API_KEY };
