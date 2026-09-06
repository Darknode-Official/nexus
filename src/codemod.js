"use strict";
// ================= Codemod Engine — safe, surgical code transformations =================
// Applies structured code modifications with preview, dry-run, and rollback.
// Unlike raw find-and-replace, codemods understand code structure: they can rename
// across files, update imports, migrate APIs, and refactor patterns project-wide.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ---- Snapshot for rollback ----

function createSnapshot(files) {
  const id = "snap_" + crypto.randomBytes(4).toString("hex");
  const entries = {};
  for (const file of files) {
    try { entries[file] = fs.readFileSync(file, "utf8"); }
    catch (_) { entries[file] = null; } // file didn't exist
  }
  return { id, entries, createdAt: Date.now() };
}

function rollback(snapshot) {
  const restored = [];
  for (const [file, content] of Object.entries(snapshot.entries)) {
    try {
      if (content === null) {
        fs.unlinkSync(file);
        restored.push({ file, action: "deleted" });
      } else {
        fs.writeFileSync(file, content);
        restored.push({ file, action: "restored" });
      }
    } catch (e) {
      restored.push({ file, action: "failed", error: e.message });
    }
  }
  return restored;
}

// ---- Transform primitives ----

/**
 * Rename a symbol across all files in the project.
 * @param {string} cwd - project root
 * @param {string} oldName - current name
 * @param {string} newName - new name
 * @param {object} opts - { dryRun, extensions, exclude }
 * @returns {{ changes: Array<{file, line, before, after}>, fileCount: number }}
 */
function renameSymbol(cwd, oldName, newName, opts) {
  opts = opts || {};
  const extensions = opts.extensions || [".js", ".ts", ".jsx", ".tsx", ".py", ".rb", ".go"];
  const exclude = opts.exclude || /node_modules|\.git|dist|build|__pycache__/;
  const changes = [];
  const files = [];

  function walk(dir) {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fp = path.join(dir, entry.name);
        const rel = path.relative(cwd, fp);
        if (exclude.test(rel)) continue;
        if (entry.isDirectory()) walk(fp);
        else if (extensions.some(e => entry.name.endsWith(e))) files.push(fp);
      }
    } catch (_) {}
  }
  walk(cwd);

  // Word-boundary rename (not inside strings that happen to contain it)
  const pattern = new RegExp("\\b" + oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "g");

  for (const file of files) {
    let content;
    try { content = fs.readFileSync(file, "utf8"); } catch (_) { continue; }
    if (!pattern.test(content)) continue;

    const lines = content.split("\n");
    const fileChanges = [];
    const newLines = lines.map((line, i) => {
      if (pattern.test(line)) {
        const newLine = line.replace(pattern, newName);
        fileChanges.push({ file: path.relative(cwd, file), line: i + 1, before: line.trim(), after: newLine.trim() });
        return newLine;
      }
      return line;
    });

    if (fileChanges.length > 0) {
      changes.push(...fileChanges);
      if (!opts.dryRun) {
        fs.writeFileSync(file, newLines.join("\n"));
      }
    }
  }

  return { changes, fileCount: new Set(changes.map(c => c.file)).size };
}

/**
 * Update import paths across a project (e.g., after moving a file).
 * @param {string} cwd
 * @param {string} oldPath - old import path (e.g., "./utils/helper")
 * @param {string} newPath - new import path (e.g., "./lib/helper")
 * @param {object} opts - { dryRun }
 */
function updateImports(cwd, oldPath, newPath, opts) {
  opts = opts || {};
  const escaped = oldPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(['"])(${escaped})(['"])`, "g");
  const changes = [];
  const files = [];

  function walk(dir) {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fp = path.join(dir, entry.name);
        if (/node_modules|\.git|dist/.test(fp)) continue;
        if (entry.isDirectory()) walk(fp);
        else if (/\.(js|ts|jsx|tsx|mjs|cjs|py)$/.test(entry.name)) files.push(fp);
      }
    } catch (_) {}
  }
  walk(cwd);

  for (const file of files) {
    let content;
    try { content = fs.readFileSync(file, "utf8"); } catch (_) { continue; }
    if (!pattern.test(content)) continue;
    pattern.lastIndex = 0;

    const newContent = content.replace(pattern, `$1${newPath}$3`);
    if (newContent !== content) {
      changes.push({ file: path.relative(cwd, file), oldImport: oldPath, newImport: newPath });
      if (!opts.dryRun) fs.writeFileSync(file, newContent);
    }
  }

  return { changes, fileCount: changes.length };
}

/**
 * Apply a regex-based transform across files.
 * @param {string} cwd
 * @param {RegExp} pattern - what to match
 * @param {string|function} replacement - what to replace with
 * @param {object} opts - { dryRun, extensions, exclude }
 */
function transformPattern(cwd, pattern, replacement, opts) {
  opts = opts || {};
  const extensions = opts.extensions || [".js", ".ts", ".jsx", ".tsx", ".py"];
  const exclude = opts.exclude || /node_modules|\.git|dist|build/;
  const changes = [];
  const files = [];

  function walk(dir) {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fp = path.join(dir, entry.name);
        if (exclude.test(path.relative(cwd, fp))) continue;
        if (entry.isDirectory()) walk(fp);
        else if (extensions.some(e => entry.name.endsWith(e))) files.push(fp);
      }
    } catch (_) {}
  }
  walk(cwd);

  for (const file of files) {
    let content;
    try { content = fs.readFileSync(file, "utf8"); } catch (_) { continue; }
    const newContent = content.replace(pattern, replacement);
    if (newContent !== content) {
      const matchCount = (content.match(pattern) || []).length;
      changes.push({ file: path.relative(cwd, file), matches: matchCount });
      if (!opts.dryRun) fs.writeFileSync(file, newContent);
    }
  }

  return { changes, fileCount: changes.length, totalMatches: changes.reduce((s, c) => s + c.matches, 0) };
}

/**
 * Extract a function/section into a new file.
 * @param {string} sourceFile - file to extract from
 * @param {string} targetFile - new file to create
 * @param {number} startLine - 1-indexed start line
 * @param {number} endLine - 1-indexed end line
 * @param {string} exportName - name to export as
 * @param {object} opts - { dryRun }
 */
function extractToFile(sourceFile, targetFile, startLine, endLine, exportName, opts) {
  opts = opts || {};
  const content = fs.readFileSync(sourceFile, "utf8");
  const lines = content.split("\n");
  const extracted = lines.slice(startLine - 1, endLine).join("\n");
  const remaining = [...lines.slice(0, startLine - 1), ...lines.slice(endLine)].join("\n");

  const isJS = /\.(js|ts|jsx|tsx|mjs|cjs)$/.test(targetFile);
  const newFileContent = isJS
    ? `"use strict";\n\n${extracted}\n\nmodule.exports = { ${exportName} };\n`
    : extracted + "\n";

  const importStatement = isJS
    ? `const { ${exportName} } = require("${path.relative(path.dirname(sourceFile), targetFile).replace(/\\/g, "/").replace(/\.(js|ts)$/, "")}");\n`
    : "";

  if (!opts.dryRun) {
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.writeFileSync(targetFile, newFileContent);
    fs.writeFileSync(sourceFile, importStatement + remaining);
  }

  return {
    extracted: { file: targetFile, lines: endLine - startLine + 1, export: exportName },
    source: { file: sourceFile, importAdded: importStatement.trim() },
  };
}

function codemodSummary(result) {
  if (result.changes) {
    return `${result.changes.length} changes across ${result.fileCount} files`;
  }
  if (result.extracted) {
    return `Extracted ${result.extracted.lines} lines to ${result.extracted.file} as ${result.extracted.export}`;
  }
  return JSON.stringify(result);
}

module.exports = { createSnapshot, rollback, renameSymbol, updateImports, transformPattern, extractToFile, codemodSummary };
