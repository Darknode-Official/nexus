"use strict";
// ===================== Code Graph — Impact / Blast-Radius Analysis =====================
// "If I change this, what could break?" Given a file or a specific exported symbol,
// computes the transitive set of dependent modules from the dependency graph's
// reverse edges (BFS, tracking distance in hops). For a symbol it additionally
// pinpoints the DIRECT consumers — files whose resolved import bindings actually
// reference that symbol by name — so the agent can distinguish "imports the module"
// from "uses the thing you changed". Pure given graph + symbol table.
const { normalize } = require("./depgraph");

// transitiveDependents(graph, file) -> [{ file, distance }] ordered by distance.
function transitiveDependents(graph, file) {
  const start = normalize(file);
  const seen = new Map(); // file -> distance
  const queue = [{ f: start, d: 0 }];
  seen.set(start, 0);
  const out = [];
  while (queue.length) {
    const { f, d } = queue.shift();
    for (const dep of (graph.rdeps.get(f) || [])) {
      if (!seen.has(dep)) { seen.set(dep, d + 1); out.push({ file: dep, distance: d + 1 }); queue.push({ f: dep, d: d + 1 }); }
    }
  }
  return out.sort((a, b) => a.distance - b.distance || a.file.localeCompare(b.file));
}

// fileImpact(graph, file) -> blast radius for changing an entire module.
function fileImpact(graph, file) {
  const deps = transitiveDependents(graph, file);
  return { file: normalize(file), directDependents: deps.filter((d) => d.distance === 1).map((d) => d.file), transitive: deps, count: deps.length };
}

// symbolImpact(graph, symtab, target) -> blast radius for changing one symbol.
//   target: { file, name }
function symbolImpact(graph, symtab, target) {
  const file = normalize(target.file), name = target.name;
  // Direct symbol users: files whose bindings resolve to this {file,name}.
  const directSymbolUsers = [];
  for (const [consumer, bm] of symtab.bindings) {
    for (const [, binding] of bm) {
      if (binding && binding.kind === "internal" && normalize(binding.file) === file && binding.name === name) {
        directSymbolUsers.push(consumer); break;
      }
      if (binding && (binding.kind === "internal-file" || binding.kind === "namespace") && normalize(binding.file) === file) {
        directSymbolUsers.push(consumer); break; // whole-module or namespace import — may use it
      }
    }
  }
  const transitive = transitiveDependents(graph, file);
  const severity = directSymbolUsers.length === 0 ? "isolated"
    : directSymbolUsers.length <= 2 ? "low"
    : directSymbolUsers.length <= 8 ? "moderate" : "high";
  return {
    symbol: name, file,
    directSymbolUsers: [...new Set(directSymbolUsers)].sort(),
    transitiveModules: transitive,
    transitiveCount: transitive.length,
    severity,
  };
}

module.exports = { transitiveDependents, fileImpact, symbolImpact };
