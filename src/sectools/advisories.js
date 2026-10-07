"use strict";
// ================= sectools/advisories — offline dependency advisory checker =================
// Parses dependency manifests (package.json, package-lock.json, requirements.txt)
// and matches declared/resolved versions against the bundled advisory database
// (./advisory-db.js). No network access — the database is shipped in-repo.
//
// Version handling is a pragmatic semver: it compares numeric release components
// and treats pre-release versions as lower than their release. Manifest specs with
// range operators (^, ~, >=) are coerced to the lowest version the range allows,
// which is the conservative choice for "could this project be running a vulnerable
// version?". Supplying a lockfile yields exact resolved versions and the most
// precise result. Detection limits are documented in README.md.

const fs = require("fs");
const path = require("path");
const { ADVISORIES, META } = require("./advisory-db");

// ---------------------------------------------------------------------------
// Version parsing & comparison
// ---------------------------------------------------------------------------

/**
 * Parse a version string into comparable parts.
 * @param {string} v
 * @returns {{nums:number[], pre:string}}
 */
function parseVersion(v) {
  const clean = String(v == null ? "0" : v).trim().replace(/^[vV=]+/, "");
  const core = clean.split("+")[0];               // drop build metadata
  const dash = core.indexOf("-");
  const rel = dash >= 0 ? core.slice(0, dash) : core;
  const pre = dash >= 0 ? core.slice(dash + 1) : "";
  const nums = rel.split(".").map((n) => {
    const i = parseInt(n, 10);
    return Number.isFinite(i) ? i : 0;
  });
  while (nums.length < 3) nums.push(0);
  return { nums, pre };
}

/**
 * Compare two version strings. Returns -1, 0 or 1.
 * @param {string} a
 * @param {string} b
 */
function compareVersions(a, b) {
  const pa = parseVersion(a), pb = parseVersion(b);
  const len = Math.max(pa.nums.length, pb.nums.length);
  for (let i = 0; i < len; i++) {
    const x = pa.nums[i] || 0, y = pb.nums[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  // A version WITH a pre-release is lower than the same version without one.
  if (pa.pre && !pb.pre) return -1;
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre < pb.pre) return -1;
  if (pa.pre > pb.pre) return 1;
  return 0;
}

/**
 * Evaluate a single comparator such as ">=1.2.3", "<2.0.0", "=1.0.0" or a bare
 * version (treated as exact).
 * @param {string} version
 * @param {string} comp
 */
function matchComparator(version, comp) {
  const m = String(comp).trim().match(/^(>=|<=|==|=|>|<)?\s*(.+)$/);
  if (!m) return false;
  const op = m[1] || "=";
  const c = compareVersions(version, m[2]);
  switch (op) {
    case ">": return c > 0;
    case ">=": return c >= 0;
    case "<": return c < 0;
    case "<=": return c <= 0;
    case "=":
    case "==": return c === 0;
    default: return false;
  }
}

/**
 * Whether `version` satisfies a range string. A range is one or more comparator
 * groups separated by "||" (OR); within a group, space/comma-separated
 * comparators are AND-ed. Accepts a string or an array of range strings (OR).
 * @param {string} version
 * @param {string|string[]} range
 */
function satisfies(version, range) {
  const ranges = Array.isArray(range) ? range : [range];
  return ranges.some((r) =>
    String(r).split("||").some((group) => {
      const comps = group.trim().split(/[\s,]+/).filter(Boolean);
      if (!comps.length) return false;
      return comps.every((c) => matchComparator(version, c));
    })
  );
}

/**
 * Coerce a manifest version spec (^1.2.3, ~1.2, >=1.0.0, 1.* ) to the lowest
 * concrete version it allows — the conservative version to test for vulnerability.
 * Returns null when no concrete version can be derived (e.g. "*", "latest").
 * @param {string} spec
 * @returns {string|null}
 */
function coerceVersion(spec) {
  if (spec == null) return null;
  let s = String(spec).trim();
  if (!s || s === "*" || /latest|next|^workspace:|^file:|^link:|^git|^http/i.test(s)) return null;
  // For a compound range take the lower bound (first >= / > / bare version token).
  const lower = s.match(/>=?\s*([0-9]+(?:\.[0-9]+){0,2}(?:-[0-9A-Za-z.]+)?)/);
  if (lower) return lower[1];
  // Strip caret/tilde/equals and x-ranges.
  const m = s.replace(/^[\^~=v]+/, "").match(/^([0-9]+)(?:\.([0-9]+|x|\*))?(?:\.([0-9]+|x|\*))?/i);
  if (!m) return null;
  const major = m[1];
  const minor = /^[0-9]+$/.test(m[2] || "") ? m[2] : "0";
  const patch = /^[0-9]+$/.test(m[3] || "") ? m[3] : "0";
  return `${major}.${minor}.${patch}`;
}

// ---------------------------------------------------------------------------
// Manifest parsers
// ---------------------------------------------------------------------------

/**
 * Parse package.json text into dependency records.
 * @param {string} text
 * @returns {Array<{name:string, spec:string, scope:string, ecosystem:string}>}
 */
function parsePackageJson(text) {
  let json;
  try { json = JSON.parse(text); } catch (_) { return []; }
  const out = [];
  const sections = {
    dependencies: "prod",
    devDependencies: "dev",
    optionalDependencies: "optional",
    peerDependencies: "peer",
  };
  for (const [key, scope] of Object.entries(sections)) {
    const obj = json[key];
    if (!obj || typeof obj !== "object") continue;
    for (const [name, spec] of Object.entries(obj)) {
      out.push({ name: name.toLowerCase(), spec: String(spec), scope, ecosystem: "npm" });
    }
  }
  return out;
}

/**
 * Parse package-lock.json (v2/v3 "packages" or v1 "dependencies") into exact
 * resolved versions.
 * @param {string} text
 * @returns {Array<{name:string, version:string, ecosystem:string}>}
 */
function parsePackageLock(text) {
  let json;
  try { json = JSON.parse(text); } catch (_) { return []; }
  const out = [];
  const seen = new Set();
  const add = (name, version) => {
    if (!name || !version) return;
    const key = name + "@" + version;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name: name.toLowerCase(), version: String(version), ecosystem: "npm" });
  };
  if (json.packages && typeof json.packages === "object") {
    for (const [p, info] of Object.entries(json.packages)) {
      if (!p) continue; // root ""
      const idx = p.lastIndexOf("node_modules/");
      const name = idx >= 0 ? p.slice(idx + "node_modules/".length) : p;
      if (info && info.version) add(name, info.version);
    }
  }
  if (json.dependencies && typeof json.dependencies === "object") {
    const walk = (deps) => {
      for (const [name, info] of Object.entries(deps)) {
        if (info && info.version) add(name, info.version);
        if (info && info.dependencies) walk(info.dependencies);
      }
    };
    walk(json.dependencies);
  }
  return out;
}

/**
 * Parse a requirements.txt into dependency records. Handles ==, >=, ~=, comments,
 * environment markers, and extras (package[extra]).
 * @param {string} text
 * @returns {Array<{name:string, spec:string, ecosystem:string}>}
 */
function parseRequirementsTxt(text) {
  const out = [];
  for (let raw of String(text == null ? "" : text).split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("-")) continue;
    line = line.split(";")[0].trim();        // strip environment markers
    line = line.split(" #")[0].trim();        // strip inline comments
    if (!line) continue;
    const m = line.match(/^([A-Za-z0-9._-]+)\s*(\[[^\]]*\])?\s*(.*)$/);
    if (!m) continue;
    const name = m[1].toLowerCase().replace(/_/g, "-");
    const spec = (m[3] || "").trim();
    out.push({ name, spec, ecosystem: "pip" });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * Normalise a pip requirement spec into a concrete version for comparison.
 * "==2.1.0" -> "2.1.0", ">=1.0,<2.0" -> "1.0", "~=1.4.2" -> "1.4.2".
 * @param {string} spec
 * @returns {string|null}
 */
function coercePipVersion(spec) {
  if (!spec) return null;
  const exact = spec.match(/==\s*([0-9][0-9A-Za-z.*-]*)/);
  if (exact) return exact[1].replace(/\.\*$/, ".0");
  const tilde = spec.match(/~=\s*([0-9][0-9A-Za-z.-]*)/);
  if (tilde) return tilde[1];
  const lower = spec.match(/>=?\s*([0-9][0-9A-Za-z.-]*)/);
  if (lower) return lower[1];
  const bare = spec.match(/^([0-9][0-9A-Za-z.-]*)/);
  return bare ? bare[1] : null;
}

/**
 * Check a list of dependency records against the advisory database.
 * Each record is { name, ecosystem, version? , spec? }.
 * @param {Array<object>} deps
 * @param {object} [opts]
 * @param {Array<object>} [opts.db] advisory records (defaults to bundled set)
 * @returns {Array<object>} findings
 */
function checkDependencies(deps, opts) {
  opts = opts || {};
  const db = opts.db || ADVISORIES;
  const findings = [];
  for (const dep of deps || []) {
    const eco = dep.ecosystem;
    const version = dep.version != null
      ? String(dep.version)
      : (eco === "pip" ? coercePipVersion(dep.spec) : coerceVersion(dep.spec));
    if (!version) continue; // unresolvable (e.g. "*", git url) — cannot assess
    for (const adv of db) {
      if (adv.ecosystem !== eco) continue;
      if (adv.package.toLowerCase() !== dep.name.toLowerCase()) continue;
      if (!satisfies(version, adv.vulnerable)) continue;
      findings.push({
        id: adv.id,
        type: "dependency",
        ecosystem: eco,
        package: dep.name,
        version,
        resolvedFrom: dep.version != null ? "lockfile" : "manifest-spec",
        severity: adv.severity,
        cwe: adv.cwe,
        title: adv.title,
        vulnerableRange: adv.vulnerable,
        patched: adv.patched,
        aliases: adv.aliases || [],
        references: adv.references || [],
        remediation: `Upgrade ${dep.name} to ${adv.patched} or later.`,
        confidence: dep.version != null ? 0.95 : 0.75,
      });
    }
  }
  return findings;
}

/**
 * Discover and check supported manifests under a directory (or a single file).
 * Prefers a package-lock.json (exact versions) over package.json when both exist.
 * @param {string} root
 * @param {object} [opts]
 * @returns {{findings:Array<object>, manifests:string[]}}
 */
function checkManifestsDir(root, opts) {
  opts = opts || {};
  const manifests = [];
  const findings = [];
  let stat;
  try { stat = fs.statSync(root); } catch (_) { return { findings, manifests }; }

  const handleFile = (file, rel) => {
    const base = path.basename(file).toLowerCase();
    let text;
    try { text = fs.readFileSync(file, "utf8"); } catch (_) { return; }
    if (base === "package.json") {
      manifests.push(rel);
      const lock = path.join(path.dirname(file), "package-lock.json");
      if (fs.existsSync(lock)) {
        try { findings.push(...checkDependencies(parsePackageLock(fs.readFileSync(lock, "utf8")), opts)); return; } catch (_) {}
      }
      findings.push(...checkDependencies(parsePackageJson(text), opts));
    } else if (base === "requirements.txt") {
      manifests.push(rel);
      findings.push(...checkDependencies(parseRequirementsTxt(text), opts));
    }
  };

  if (stat.isFile()) {
    handleFile(root, path.basename(root));
    return { findings: dedupe(findings), manifests };
  }

  const SKIP = require("./walk").DEFAULT_IGNORE_DIRS;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const ent of ents) {
      if (ent.isDirectory()) { if (!SKIP.has(ent.name)) stack.push(path.join(dir, ent.name)); continue; }
      const low = ent.name.toLowerCase();
      if (low === "package.json" || low === "requirements.txt") {
        const full = path.join(dir, ent.name);
        handleFile(full, path.relative(root, full).split(path.sep).join("/"));
      }
    }
  }
  return { findings: dedupe(findings), manifests };
}

/**
 * De-duplicate findings by advisory id + package + version.
 * @param {Array<object>} findings
 */
function dedupe(findings) {
  const seen = new Set();
  const out = [];
  for (const f of findings) {
    const key = f.id + "|" + f.package + "|" + f.version;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

/**
 * Load an external advisory database (array of records) and validate shape.
 * Returns the array of valid records; invalid records are dropped.
 * @param {string|Array<object>} jsonOrArray
 * @returns {Array<object>}
 */
function loadDatabase(jsonOrArray) {
  let arr = jsonOrArray;
  if (typeof jsonOrArray === "string") {
    try { arr = JSON.parse(jsonOrArray); } catch (_) { return []; }
  }
  if (!Array.isArray(arr)) return [];
  return arr.filter((r) =>
    r && typeof r.package === "string" && typeof r.ecosystem === "string" &&
    r.vulnerable != null && typeof r.severity === "string"
  );
}

module.exports = {
  META,
  parseVersion,
  compareVersions,
  matchComparator,
  satisfies,
  coerceVersion,
  coercePipVersion,
  parsePackageJson,
  parsePackageLock,
  parseRequirementsTxt,
  checkDependencies,
  checkManifestsDir,
  loadDatabase,
  dedupe,
};
