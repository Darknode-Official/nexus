"use strict";
// ================= Per-project settings store =================
// A small key/value settings store at .nexus/config.json, following the repo's
// existing ".nexus/<name>.json" convention (telemetry.json, graph.json, ...).
// Used for persisted per-project toggles such as /autocorrect. Fail-safe: a
// missing or corrupt file reads as empty defaults, never throws.

const fs = require("fs");
const path = require("path");

const CONFIG_FILE = ".nexus/config.json";
function configPath(cwd) { return path.join(cwd || process.cwd(), CONFIG_FILE); }

function load(cwd) {
  try { return JSON.parse(fs.readFileSync(configPath(cwd), "utf8")) || {}; }
  catch (_) { return {}; }
}

function get(cwd, key, dflt) {
  const c = load(cwd);
  return Object.prototype.hasOwnProperty.call(c, key) ? c[key] : dflt;
}

function set(cwd, key, value) {
  const c = load(cwd);
  c[key] = value;
  const fp = configPath(cwd);
  try { fs.mkdirSync(path.dirname(fp), { recursive: true }); } catch (_) {}
  fs.writeFileSync(fp, JSON.stringify(c, null, 2));
  return c;
}

module.exports = { load, get, set, configPath, CONFIG_FILE };
