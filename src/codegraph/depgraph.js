"use strict";
// ===================== Code Graph — Dependency Graph =====================
// Builds a module-level import graph from parsed file records, resolving RELATIVE
// imports to concrete files in the index (language-aware candidate resolution for
// JS/TS, Python, Ruby; Go/package specifiers are treated as external unless they
// resolve locally). Provides cycle detection via Tarjan's strongly-connected-
// components algorithm and a topological ordering (Kahn's algorithm over the SCC
// condensation, so a cyclic graph still yields a usable build/visit order with the
// offending cycles reported). Pure given the file records.
const path = require("path");

const JS_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];
const JS_INDEX = JS_EXTS.map((e) => "/index" + e);

function toPosix(p) { return String(p).replace(/\\/g, "/"); }
function dirOf(f) { const p = toPosix(f); const i = p.lastIndexOf("/"); return i < 0 ? "" : p.slice(0, i); }
function normalize(p) { return toPosix(path.posix.normalize(toPosix(p))).replace(/^\.\//, ""); }

// resolveImport(importerFile, spec, lang, known) -> resolved file (relpath) | null.
// `known` is a Set of index file paths. Only relative/local specifiers resolve;
// bare package names return null (they are external dependencies).
function resolveImport(importerFile, spec, lang, known) {
  const dir = dirOf(importerFile);
  const isRel = /^[./]/.test(spec);

  if (lang === "javascript" || lang === "typescript") {
    if (!isRel) return null;
    const base = normalize(path.posix.join(dir, spec));
    return tryCandidates(base, JS_EXTS, JS_INDEX, known);
  }
  if (lang === "python") {
    // relative: ".mod" / "..pkg.mod"  — leading dots are levels up
    let target;
    if (spec.startsWith(".")) {
      const dots = (spec.match(/^\.+/) || [""])[0].length;
      const rest = spec.slice(dots).replace(/\./g, "/");
      let up = dir; for (let k = 1; k < dots; k++) up = dirOf(up);
      target = normalize(path.posix.join(up, rest));
    } else {
      target = spec.replace(/\./g, "/"); // absolute dotted path from project root
    }
    return tryCandidates(target, [".py", ".pyi"], ["/__init__.py"], known);
  }
  if (lang === "ruby") {
    if (!isRel) return null;
    const base = normalize(path.posix.join(dir, spec));
    return tryCandidates(base, [".rb"], [], known);
  }
  if (lang === "go") {
    if (!isRel) return null;
    const base = normalize(path.posix.join(dir, spec));
    return known.has(base) ? base : null;
  }
  return null;
}

function tryCandidates(base, exts, indexSuffixes, known) {
  if (known.has(base)) return base;
  for (const e of exts) if (known.has(base + e)) return base + e;
  for (const s of indexSuffixes) if (known.has(base + s)) return base + s;
  return null;
}

// buildDepGraph(files, opts) -> graph object.
//   files: [{ file, lang, imports:[{source, ...}] }]
// returns { nodes, adj (Map file->Set deps), rdeps (Map file->Set dependents),
//           externals (Map file->Set pkg), unresolved (Map file->Set spec) }
function buildDepGraph(files, opts) {
  opts = opts || {};
  const known = new Set(files.map((f) => normalize(f.file)));
  const adj = new Map(), rdeps = new Map(), externals = new Map(), unresolved = new Map();
  for (const f of files) { const n = normalize(f.file); adj.set(n, new Set()); rdeps.set(n, new Set()); }

  for (const f of files) {
    const from = normalize(f.file);
    for (const imp of (f.imports || [])) {
      const spec = imp.source;
      if (!spec) continue;
      const resolved = resolveImport(from, spec, f.lang, known);
      if (resolved && resolved !== from) {
        adj.get(from).add(resolved);
        rdeps.get(resolved).add(from);
      } else if (!resolved) {
        if (/^[./]/.test(spec)) { (unresolved.get(from) || unresolved.set(from, new Set()).get(from)).add(spec); }
        else { (externals.get(from) || externals.set(from, new Set()).get(from)).add(spec.replace(/^node:/, "").split("/")[0]); }
      }
    }
  }
  return { nodes: [...known], adj, rdeps, externals, unresolved };
}

// detectCycles(adj) -> array of cycles, each an array of files (Tarjan SCC).
// Only SCCs with >1 node, or a single node with a self-edge, are returned.
function detectCycles(adj) {
  let idx = 0; const stack = [], onStack = new Set(), index = new Map(), low = new Map(), sccs = [];
  const strongconnect = (v) => {
    index.set(v, idx); low.set(v, idx); idx++; stack.push(v); onStack.add(v);
    for (const w of (adj.get(v) || [])) {
      if (!index.has(w)) { strongconnect(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (onStack.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
    }
    if (low.get(v) === index.get(v)) {
      const comp = []; let w;
      do { w = stack.pop(); onStack.delete(w); comp.push(w); } while (w !== v);
      const selfLoop = comp.length === 1 && (adj.get(comp[0]) || new Set()).has(comp[0]);
      if (comp.length > 1 || selfLoop) sccs.push(comp.reverse());
    }
  };
  for (const v of adj.keys()) if (!index.has(v)) strongconnect(v);
  return sccs;
}

// topoOrder(adj) -> { order, cyclic, cycles }. Order is a topological sort of the
// SCC condensation flattened back to files; nodes inside a cycle keep input order.
function topoOrder(adj) {
  const cycles = detectCycles(adj);
  const compOf = new Map(); // node -> component id
  let cid = 0;
  for (const cyc of cycles) { for (const n of cyc) compOf.set(n, cid); cid++; }
  for (const n of adj.keys()) if (!compOf.has(n)) { compOf.set(n, cid); cid++; }

  const comps = new Map(); // id -> [nodes]
  for (const [n, c] of compOf) { (comps.get(c) || comps.set(c, []).get(c)).push(n); }
  const cadj = new Map(), indeg = new Map();
  for (const c of comps.keys()) { cadj.set(c, new Set()); indeg.set(c, 0); }
  for (const [n, deps] of adj) {
    for (const d of deps) {
      const a = compOf.get(n), b = compOf.get(d);
      if (a !== b && !cadj.get(a).has(b)) { cadj.get(a).add(b); indeg.set(b, indeg.get(b) + 1); }
    }
  }
  // Kahn on condensation. A depends-on B means B must come first -> emit deps first.
  const queue = [...indeg.keys()].filter((c) => indeg.get(c) === 0).sort((a, b) => a - b);
  const order = [], emittedComps = [];
  while (queue.length) {
    const c = queue.shift(); emittedComps.push(c);
    for (const nb of cadj.get(c)) { indeg.set(nb, indeg.get(nb) - 1); if (indeg.get(nb) === 0) queue.push(nb); }
  }
  // dependencies should appear before dependents: reverse the emission order
  for (const c of emittedComps.reverse()) for (const n of comps.get(c)) order.push(n);
  return { order, cyclic: cycles.length > 0, cycles };
}

module.exports = { resolveImport, buildDepGraph, detectCycles, topoOrder, normalize };
