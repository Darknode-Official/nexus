"use strict";
// Durable agent memory (a Glitch `remember` idea): merge a fact into NEXUS.md under
// a "## Remembered" section, with dedup so the same fact called twice doesn't stack.
// Pure — takes the current markdown, returns the new markdown + whether it changed.
function normalize(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, "").replace(/\s+/g, " ").trim(); }
function mergeMemory(md, note) {
  const clean = String(note || "").trim();
  if (clean.length < 3) return { md, added: false, reason: "too short" };
  const target = normalize(clean);
  for (const line of String(md || "").split("\n")) {
    const m = line.match(/^\s*[-*]\s+(.*)/);
    if (!m) continue;
    const other = normalize(m[1]);
    if (other && (other === target || other.includes(target) || target.includes(other))) return { md, added: false, reason: "already known" };
  }
  let out = String(md || "");
  if (!/^##\s+Remembered\s*$/m.test(out)) out += (out && !out.endsWith("\n") ? "\n" : "") + "\n## Remembered\n";
  if (!out.endsWith("\n")) out += "\n";
  out += "- " + clean + "\n";
  return { md: out, added: true };
}
module.exports = { mergeMemory, normalize };
