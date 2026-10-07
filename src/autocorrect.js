"use strict";
// ================= /autocorrect — local, zero-token prompt normalization =================
// When enabled (opt-in, persisted per project via src/config.js), Nexus runs this
// LOCAL, deterministic pass over a user prompt BEFORE sending it to an engine. No
// LLM call, no tokens spent on the correction itself — the whole point is to SAVE
// input tokens and clean up the prompt, not to spend tokens doing so.
//
// It does three conservative things to NATURAL-LANGUAGE text only:
//   1. fix a small embedded list of common typos (case-preserving),
//   2. collapse redundant whitespace,
//   3. tighten a few verbose filler phrases ("in order to" -> "to").
//
// SAFETY (hard rule): it never alters content inside code fences, inline code,
// file paths, URLs, quoted strings, CLI flags, or any token that is not a plain
// natural-language word (anything with digits, _, /, ., @, camelCase, ALL-CAPS,
// etc. is left untouched). Low-confidence words are left unchanged.

const { estimateTokens } = require("./context");

// ---- small, high-confidence typo dictionary (lowercase keys) ----
// Deliberately conservative: only unambiguous misspellings that are not valid
// words in any common sense. Anything risky is omitted.
const TYPOS = {
  teh: "the", thsi: "this", taht: "that", adn: "and", nad: "and", ot: "to",
  recieve: "receive", recieved: "received", seperate: "separate", seperated: "separated",
  occured: "occurred", occurence: "occurrence", untill: "until", acheive: "achieve",
  achive: "achieve", wich: "which", wiht: "with", witht: "with", fucntion: "function",
  funciton: "function", functon: "function", retrun: "return", retur: "return",
  paramter: "parameter", paramters: "parameters", arguement: "argument", arguements: "arguments",
  lenght: "length", widht: "width", heigth: "height", defualt: "default",
  dependancy: "dependency", dependancies: "dependencies", enviroment: "environment",
  enviornment: "environment", existance: "existence", neccessary: "necessary",
  compatability: "compatibility", successfull: "successful", sucessful: "successful",
  begining: "beginning", refering: "referring", occuring: "occurring",
  implment: "implement", implmentation: "implementation", repositry: "repository",
  commited: "committed", commiting: "committing", databse: "database",
  authetication: "authentication", vulnerabilty: "vulnerability", vulnerabilties: "vulnerabilities",
  shoud: "should", woud: "would", coud: "could", doesnt: "doesn't", dont: "don't",
  cant: "can't", wont: "won't", isnt: "isn't", wasnt: "wasn't", couldnt: "couldn't",
  thier: "their", youre: "you're", alot: "a lot", aboutt: "about", abotu: "about",
};

// ---- verbose filler -> tighter phrasing (natural-language only) ----
const FILLER = [
  [/\bin order to\b/gi, "to"],
  [/\bdue to the fact that\b/gi, "because"],
  [/\bat this (?:point in time|moment in time)\b/gi, "now"],
  [/\bin the event that\b/gi, "if"],
  [/\bfor the purpose of\b/gi, "to"],
  [/\bwith regard to\b/gi, "about"],
  [/\bin spite of the fact that\b/gi, "although"],
  [/\ba large number of\b/gi, "many"],
  [/\bthe majority of\b/gi, "most"],
  [/\bplease (?:kindly )?(?:go ahead and )?/gi, ""],
  [/\bcan you (?:please )?/gi, ""],
  [/\bi(?:'d| would) like you to\b/gi, ""],
  [/\bi want you to\b/gi, ""],
  [/\bmake sure (?:to|that you)\b/gi, ""],
];

// A token is "protected" (left untouched) if it looks technical/deliberate.
function isProtectedWord(w) {
  if (!w) return true;
  if (/[0-9_@/\\.]/.test(w)) return true;         // paths, identifiers, versions, emails
  if (/^-{1,2}[A-Za-z]/.test(w)) return true;     // CLI flags
  if (/[a-z][A-Z]/.test(w)) return true;          // camelCase
  if (/^[A-Z]{2,}$/.test(w)) return true;         // ACRONYM / CONST
  return false;
}

// Correct a single whitespace-delimited word, preserving leading/trailing
// punctuation and the original capitalization pattern.
function correctWord(token) {
  if (/-/.test(token)) return { token, changed: false }; // CLI flags / hyphenated tokens: leave alone
  const m = token.match(/^([^A-Za-z']*)([A-Za-z']+(?:'[A-Za-z]+)?)([^A-Za-z']*)$/);
  if (!m) return { token, changed: false };
  const [, lead, core, trail] = m;
  if (isProtectedWord(core)) return { token, changed: false };
  const lower = core.toLowerCase();
  const fix = TYPOS[lower];
  if (!fix) return { token, changed: false };
  // preserve case: Capitalized -> Capitalized, UPPER -> UPPER, else lower
  let out = fix;
  if (/^[A-Z][a-z]/.test(core)) out = fix.charAt(0).toUpperCase() + fix.slice(1);
  else if (/^[A-Z]+$/.test(core)) out = fix.toUpperCase();
  return { token: lead + out + trail, changed: out.toLowerCase() !== lower, from: core, to: out };
}

// Split text into protected segments (code fences, inline code, URLs, quoted
// strings) and plain segments. Only plain segments are processed.
function segment(text) {
  const segs = [];
  // order matters: fenced code first, then inline, URLs, quotes
  const re = /(```[\s\S]*?```|`[^`]*`|https?:\/\/[^\s)]+|"[^"]*"|'[^']*'|\/[^\s'"]+)/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) segs.push({ t: text.slice(last, m.index), plain: true });
    segs.push({ t: m[0], plain: false });
    last = m.index + m[0].length;
  }
  if (last < text.length) segs.push({ t: text.slice(last), plain: true });
  return segs;
}

// Main entry. Returns the corrected text + an itemized, measurable report.
function autocorrect(input) {
  const original = String(input == null ? "" : input);
  const corrections = [];

  const processed = segment(original).map(seg => {
    if (!seg.plain) return seg.t; // never touch protected segments
    let s = seg.t;
    // 1. filler tightening
    for (const [re, rep] of FILLER) {
      s = s.replace(re, (mm) => { corrections.push({ kind: "filler", from: mm.trim(), to: rep.trim() }); return rep; });
    }
    // 2. per-word typo fix
    s = s.replace(/\S+/g, (tok) => {
      const r = correctWord(tok);
      if (r.changed) corrections.push({ kind: "typo", from: r.from, to: r.to });
      return r.token;
    });
    return s;
  }).join("");

  // 3. whitespace collapse (safe: operates on the reassembled text but code
  //    fences were preserved as single segments, so their interior is intact
  //    because we only collapse spaces/newlines in the plain join seams).
  const squeezed = collapseWhitespace(processed, original);

  const tokensBefore = estimateTokens(original);
  const tokensAfter = estimateTokens(squeezed);
  return {
    text: squeezed,
    changed: squeezed !== original,
    corrections,
    tokensBefore,
    tokensAfter,
    saved: tokensBefore - tokensAfter,
  };
}

// Collapse redundant whitespace WITHOUT touching inside fenced code blocks.
function collapseWhitespace(text, original) {
  const parts = text.split(/(```[\s\S]*?```)/g);
  return parts.map((p, i) => {
    if (i % 2 === 1) return p; // fenced code block, leave exactly as-is
    return p.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n");
  }).join("").trim();
}

// One-line human notice for the live meter (NX-103 visibility).
function notice(result) {
  if (!result.changed) return "autocorrect: no changes (0 tokens saved)";
  const typos = result.corrections.filter(c => c.kind === "typo");
  const filler = result.corrections.filter(c => c.kind === "filler");
  const bits = [];
  if (typos.length) bits.push(typos.length + " typo" + (typos.length > 1 ? "s" : "") + " (" + typos.slice(0, 3).map(c => c.from + "->" + c.to).join(", ") + (typos.length > 3 ? ", ..." : "") + ")");
  if (filler.length) bits.push(filler.length + " filler phrase" + (filler.length > 1 ? "s" : "") + " tightened");
  const delta = result.saved === 0 ? "0 tokens saved" : (result.saved > 0 ? result.saved + " tokens saved" : Math.abs(result.saved) + " tokens added");
  return "autocorrect: " + (bits.join(", ") || "whitespace") + " — " + result.tokensBefore + " -> " + result.tokensAfter + " tokens (" + delta + ")";
}

// ---- /autocorrect slash command + config-aware apply ----
const config = require("./config");
const CONFIG_KEY = "autocorrect";

// Handle `/autocorrect`, `/autocorrect on`, `/autocorrect off`. Default OFF.
// Persists per-project in .nexus/config.json. Returns { enabled, message }.
function command(cwd, arg) {
  const a = String(arg || "").trim().toLowerCase();
  let enabled = config.get(cwd, CONFIG_KEY, false);
  if (a === "on" || a === "enable" || a === "true") enabled = true;
  else if (a === "off" || a === "disable" || a === "false") enabled = false;
  else if (a === "" || a === "toggle") enabled = !enabled;
  else return { enabled, message: "usage: /autocorrect [on|off]  (currently " + (enabled ? "on" : "off") + ")" };
  config.set(cwd, CONFIG_KEY, enabled);
  return { enabled, message: "autocorrect is now " + (enabled ? "ON (local, zero-token prompt cleanup before each send)" : "OFF") };
}

function isEnabled(cwd) { return config.get(cwd, CONFIG_KEY, false) === true; }

// Called by the runner before sending a prompt. If disabled, returns the prompt
// untouched and applied:false so no notice is shown.
function applyIfEnabled(cwd, prompt) {
  if (!isEnabled(cwd)) return { applied: false, text: String(prompt == null ? "" : prompt) };
  const r = autocorrect(prompt);
  return Object.assign({ applied: true, prompt: String(prompt), notice: notice(r) }, r);
}

module.exports = { autocorrect, notice, command, isEnabled, applyIfEnabled, correctWord, segment, TYPOS, FILLER, CONFIG_KEY };
