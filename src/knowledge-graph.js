"use strict";
// ================= Knowledge Graph — persistent, queryable project understanding =================
// Builds and maintains a graph of entities (files, functions, classes, variables, imports)
// and their relationships (calls, imports, exports, inherits, tests). Persisted to
// .nexus/graph.json. The context engine queries this to pull in EXACTLY the right files
// for a task — not keyword matching, but structural understanding.

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const GRAPH_FILE = ".nexus/graph.json";
const CODE_EXT = /\.(js|ts|jsx|tsx|py|rb|go|rs|java|c|cpp|h|cs|php|swift|kt|sh)$/;
const SKIP = /(^|\/)(\.git|node_modules|dist|build|__pycache__|\.cache|vendor|\.nexus)(\/|$)/;

// ---- Entity types ----
const ENTITY = { FILE: "file", FUNC: "function", CLASS: "class", MODULE: "module", TEST: "test", ROUTE: "route" };
const RELATION = { IMPORTS: "imports", EXPORTS: "exports", CALLS: "calls", TESTS: "tests", INHERITS: "inherits", CONTAINS: "contains" };

function createGraph() {
  return { entities: {}, relations: [], meta: { builtAt: 0, fileCount: 0, version: 1 } };
}

function addEntity(graph, id, type, meta) {
  graph.entities[id] = { id, type, ...(meta || {}) };
}

function addRelation(graph, from, to, type, meta) {
  // Dedupe
  const exists = graph.relations.some(r => r.from === from && r.to === to && r.type === type);
  if (!exists) graph.relations.push({ from, to, type, ...(meta || {}) });
}

// ---- JavaScript/TypeScript extractor ----

function extractJS(content, filePath, graph) {
  const fileId = filePath;
  addEntity(graph, fileId, ENTITY.FILE, { path: filePath, lines: content.split("\n").length });

  // Imports
  const importRe = /(?:import\s+(?:[\w{},*\s]+)\s+from\s+['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\))/g;
  let m;
  while ((m = importRe.exec(content))) {
    const target = m[1] || m[2];
    addRelation(graph, fileId, target, RELATION.IMPORTS);
  }

  // Exports
  const exportRe = /(?:module\.exports\s*=\s*\{([^}]+)\}|export\s+(?:default\s+)?(?:function|class|const|let|var)\s+(\w+))/g;
  while ((m = exportRe.exec(content))) {
    const names = m[1] ? m[1].split(",").map(s => s.trim().split(/\s*[:=]/)[0].trim()).filter(Boolean) : [m[2]];
    for (const name of names) {
      const exportId = fileId + ":" + name;
      addEntity(graph, exportId, ENTITY.FUNC, { name, file: fileId });
      addRelation(graph, fileId, exportId, RELATION.EXPORTS);
    }
  }

  // Functions
  const funcRe = /(?:(?:async\s+)?function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[^=])\s*=>|(\w+)\s*\([^)]*\)\s*\{)/g;
  while ((m = funcRe.exec(content))) {
    const name = m[1] || m[2] || m[3];
    if (name && name.length > 1 && !/^(if|for|while|switch|catch|return|else|new|typeof|delete)$/.test(name)) {
      const funcId = fileId + ":" + name;
      addEntity(graph, funcId, ENTITY.FUNC, { name, file: fileId, line: content.slice(0, m.index).split("\n").length });
      addRelation(graph, fileId, funcId, RELATION.CONTAINS);
    }
  }

  // Classes
  const classRe = /class\s+(\w+)(?:\s+extends\s+(\w+))?\s*\{/g;
  while ((m = classRe.exec(content))) {
    const classId = fileId + ":" + m[1];
    addEntity(graph, classId, ENTITY.CLASS, { name: m[1], file: fileId });
    addRelation(graph, fileId, classId, RELATION.CONTAINS);
    if (m[2]) addRelation(graph, classId, m[2], RELATION.INHERITS);
  }

  // Test files
  if (/\.(test|spec)\.(js|ts|jsx|tsx)$/.test(filePath) || /\bdescribe\s*\(/.test(content)) {
    addEntity(graph, fileId, ENTITY.TEST, { path: filePath });
    // What does this test import?
    const testImportRe = /(?:import|require)\s*\(?\s*['"]\.\/([^'"]+)['"]/g;
    while ((m = testImportRe.exec(content))) {
      addRelation(graph, fileId, m[1], RELATION.TESTS);
    }
  }
}

// ---- Python extractor ----

function extractPython(content, filePath, graph) {
  const fileId = filePath;
  addEntity(graph, fileId, ENTITY.FILE, { path: filePath, lines: content.split("\n").length });

  // Imports
  const importRe = /(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/g;
  let m;
  while ((m = importRe.exec(content))) {
    addRelation(graph, fileId, m[1] || m[2], RELATION.IMPORTS);
  }

  // Functions
  const defRe = /(?:async\s+)?def\s+(\w+)\s*\(/g;
  while ((m = defRe.exec(content))) {
    const funcId = fileId + ":" + m[1];
    addEntity(graph, funcId, ENTITY.FUNC, { name: m[1], file: fileId, line: content.slice(0, m.index).split("\n").length });
    addRelation(graph, fileId, funcId, RELATION.CONTAINS);
  }

  // Classes
  const classRe = /class\s+(\w+)(?:\(([^)]*)\))?\s*:/g;
  while ((m = classRe.exec(content))) {
    const classId = fileId + ":" + m[1];
    addEntity(graph, classId, ENTITY.CLASS, { name: m[1], file: fileId });
    addRelation(graph, fileId, classId, RELATION.CONTAINS);
    if (m[2]) {
      for (const parent of m[2].split(",").map(s => s.trim()).filter(Boolean)) {
        addRelation(graph, classId, parent, RELATION.INHERITS);
      }
    }
  }
}

// ---- Build the graph from a project directory ----

function buildGraph(cwd) {
  const graph = createGraph();
  const files = [];

  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const fp = path.join(dir, e.name);
      const rel = path.relative(cwd, fp);
      if (SKIP.test(rel)) continue;
      if (e.isDirectory()) walk(fp);
      else if (CODE_EXT.test(e.name)) files.push({ path: fp, rel });
    }
  }
  walk(cwd);

  for (const f of files) {
    try {
      const content = fs.readFileSync(f.path, "utf8");
      if (/\.(js|jsx|ts|tsx|mjs|cjs)$/.test(f.rel)) extractJS(content, f.rel, graph);
      else if (/\.py$/.test(f.rel)) extractPython(content, f.rel, graph);
      // Other languages: add extractors as needed
    } catch (_) {}
  }

  graph.meta.builtAt = Date.now();
  graph.meta.fileCount = files.length;
  return graph;
}

// ---- Persist / load ----

function saveGraph(cwd, graph) {
  const fp = path.join(cwd, GRAPH_FILE);
  const dir = path.dirname(fp);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  fs.writeFileSync(fp, JSON.stringify(graph, null, 2));
}

function loadGraph(cwd) {
  try { return JSON.parse(fs.readFileSync(path.join(cwd, GRAPH_FILE), "utf8")); }
  catch (_) { return null; }
}

// ---- Query the graph ----

/** Find all entities related to a given entity */
function neighbors(graph, entityId, depth) {
  depth = depth || 1;
  const visited = new Set();
  const queue = [{ id: entityId, d: 0 }];
  const results = [];

  while (queue.length > 0) {
    const { id, d } = queue.shift();
    if (visited.has(id) || d > depth) continue;
    visited.add(id);
    if (d > 0) results.push({ id, depth: d, entity: graph.entities[id] || null });

    for (const r of graph.relations) {
      if (r.from === id && !visited.has(r.to)) queue.push({ id: r.to, d: d + 1 });
      if (r.to === id && !visited.has(r.from)) queue.push({ id: r.from, d: d + 1 });
    }
  }
  return results;
}

/** Find files most relevant to a query by searching entity names */
function queryFiles(graph, query) {
  const words = String(query || "").toLowerCase().split(/\s+/).filter(w => w.length > 2);
  if (!words.length) return [];

  const fileScores = {};
  for (const [id, entity] of Object.entries(graph.entities)) {
    const text = (id + " " + (entity.name || "") + " " + (entity.path || "")).toLowerCase();
    let score = 0;
    for (const w of words) {
      if (text.includes(w)) score += entity.type === "file" ? 3 : 1;
    }
    if (score > 0 && entity.file) {
      fileScores[entity.file] = (fileScores[entity.file] || 0) + score;
    }
    if (score > 0 && entity.type === "file") {
      fileScores[id] = (fileScores[id] || 0) + score;
    }
  }

  return Object.entries(fileScores)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([file, score]) => ({ file, score }));
}

/** Get a summary of the graph for display */
function graphSummary(graph) {
  const types = {};
  for (const e of Object.values(graph.entities)) {
    types[e.type] = (types[e.type] || 0) + 1;
  }
  return {
    entities: Object.keys(graph.entities).length,
    relations: graph.relations.length,
    byType: types,
    files: types.file || 0,
    functions: types.function || 0,
    classes: types.class || 0,
    tests: types.test || 0,
    builtAt: graph.meta.builtAt,
  };
}

module.exports = { createGraph, addEntity, addRelation, buildGraph, saveGraph, loadGraph, neighbors, queryFiles, graphSummary, ENTITY, RELATION };
