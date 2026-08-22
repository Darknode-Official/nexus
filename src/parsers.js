"use strict";
// Parse assistant text + REAL token usage from the structured output modes of the
// Gemini CLI (`--output-format json`) and the Codex CLI (`exec --json`). Both are
// deliberately defensive across shape variants and return null on anything they
// don't recognize, so the caller falls back to raw text + an estimated token count
// and a future CLI-format change degrades gracefully instead of breaking.
function geminiParse(raw) {
  try {
    const j = JSON.parse(String(raw).trim());
    let text = typeof j.response === "string" ? j.response : (typeof j.text === "string" ? j.text : "");
    let inTok = 0, outTok = 0, model = "";
    const models = j.stats && j.stats.models;
    if (models && typeof models === "object") for (const k in models) { model = model || k; const t = (models[k] && models[k].tokens) || {}; inTok += (t.prompt || 0) + (t.cached || 0); outTok += (t.candidates || 0) + (t.thoughts || 0) + (t.tool || 0); }
    if (!text && !inTok && !outTok) return null;
    return { text, inTok, outTok, model };
  } catch (_) { return null; }
}
function codexParse(raw) {
  const lines = String(raw).split(/\r?\n/); let text = "", inTok = 0, outTok = 0, gotText = false, gotUsage = false;
  for (const ln of lines) {
    const s = ln.trim(); if (s[0] !== "{") continue;
    let e; try { e = JSON.parse(s); } catch (_) { continue; }
    const item = e.item || e.msg || e, itype = (item && item.type) || e.type;
    if (itype === "agent_message" || itype === "assistant_message") { const t = item.text || item.message || item.content; if (typeof t === "string" && t) { text = t; gotText = true; } } // latest complete assistant message
    const u = e.usage || (item && item.usage) || (itype === "token_count" ? (e.usage || e) : null);
    if (u && (u.input_tokens != null || u.output_tokens != null)) { inTok = (u.input_tokens || 0) + (u.cached_input_tokens || u.cache_read_input_tokens || 0); outTok = u.output_tokens || 0; gotUsage = true; }
  }
  return (gotText || gotUsage) ? { text, inTok, outTok } : null;
}

module.exports = { geminiParse, codexParse };
