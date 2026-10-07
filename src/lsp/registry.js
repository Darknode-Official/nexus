"use strict";
// ============================= Language-server registry =============================
// Maps languages / file extensions to the language-server programs that provide
// real compiler-grade intelligence, and detects whether each one is actually
// installed on this machine. Detection is PATH-based (no process spawn), so it is
// fast and safe to run anywhere, including CI.
//
// Design note (NX-107 "say what's missing"): when a server is not installed we
// never fail opaquely. `detect()` returns the exact binary we looked for, the
// one-line reason, and a concrete install hint, so the agent can tell the user
// precisely what to install instead of just "LSP unavailable".
//
// Zero third-party dependencies — Node stdlib only.

const fs = require("node:fs");
const path = require("node:path");

// Each entry: a language server Nexus knows how to drive. `command` is the
// executable we look for on PATH; `args` launch it in stdio mode.
const SERVERS = [
  {
    id: "typescript-language-server",
    languages: ["typescript", "typescriptreact", "javascript", "javascriptreact"],
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
    command: "typescript-language-server",
    args: ["--stdio"],
    installHint: "npm i -g typescript-language-server typescript",
    docs: "https://github.com/typescript-language-server/typescript-language-server",
  },
  {
    id: "pyright",
    languages: ["python"],
    extensions: [".py", ".pyi"],
    command: "pyright-langserver",
    args: ["--stdio"],
    installHint: "npm i -g pyright   (or: pip install pyright)",
    docs: "https://github.com/microsoft/pyright",
  },
  {
    id: "pylsp",
    languages: ["python"],
    extensions: [".py", ".pyi"],
    command: "pylsp",
    args: [],
    installHint: "pip install python-lsp-server",
    docs: "https://github.com/python-lsp/python-lsp-server",
  },
  {
    id: "gopls",
    languages: ["go"],
    extensions: [".go"],
    command: "gopls",
    args: ["serve"],
    installHint: "go install golang.org/x/tools/gopls@latest",
    docs: "https://pkg.go.dev/golang.org/x/tools/gopls",
  },
  {
    id: "rust-analyzer",
    languages: ["rust"],
    extensions: [".rs"],
    command: "rust-analyzer",
    args: [],
    installHint: "rustup component add rust-analyzer",
    docs: "https://rust-analyzer.github.io/",
  },
  {
    id: "clangd",
    languages: ["c", "cpp", "objective-c"],
    extensions: [".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh", ".m", ".mm"],
    command: "clangd",
    args: [],
    installHint: "apt install clangd   (or: brew install llvm)",
    docs: "https://clangd.llvm.org/",
  },
  {
    id: "jdtls",
    languages: ["java"],
    extensions: [".java"],
    command: "jdtls",
    args: [],
    installHint: "install Eclipse JDT Language Server (jdtls on PATH)",
    docs: "https://github.com/eclipse-jdtls/eclipse.jdt.ls",
  },
  {
    id: "lua-language-server",
    languages: ["lua"],
    extensions: [".lua"],
    command: "lua-language-server",
    args: [],
    installHint: "brew install lua-language-server   (or distro package)",
    docs: "https://github.com/LuaLS/lua-language-server",
  },
  {
    id: "bash-language-server",
    languages: ["shellscript"],
    extensions: [".sh", ".bash"],
    command: "bash-language-server",
    args: ["start"],
    installHint: "npm i -g bash-language-server",
    docs: "https://github.com/bash-lsp/bash-language-server",
  },
];

// Fallback language id by extension when callers only have a filename.
const EXT_TO_LANGUAGE = {};
for (const s of SERVERS) {
  for (const ext of s.extensions) {
    if (!EXT_TO_LANGUAGE[ext]) EXT_TO_LANGUAGE[ext] = s.languages[0];
  }
}

const IS_WINDOWS = process.platform === "win32";
// Executable extensions to try on Windows when the bare name is not found.
const WIN_EXE_EXTS = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").map((e) => e.toLowerCase());

/**
 * Determine the LSP language id for a file path by extension.
 * @param {string} filePath
 * @returns {string|null}
 */
function languageIdForPath(filePath) {
  const ext = path.extname(filePath || "").toLowerCase();
  return EXT_TO_LANGUAGE[ext] || null;
}

/**
 * All registered servers that can handle the given file extension, best match
 * first (registry order acts as preference, e.g. pyright before pylsp).
 * @param {string} ext - like ".py" (leading dot optional)
 * @returns {Array<object>}
 */
function forExtension(ext) {
  if (!ext) return [];
  const e = (ext[0] === "." ? ext : "." + ext).toLowerCase();
  return SERVERS.filter((s) => s.extensions.includes(e));
}

/**
 * All registered servers for a language id.
 * @param {string} language
 * @returns {Array<object>}
 */
function forLanguage(language) {
  if (!language) return [];
  return SERVERS.filter((s) => s.languages.includes(language));
}

/**
 * Servers applicable to a file path (by its extension).
 * @param {string} filePath
 * @returns {Array<object>}
 */
function forPath(filePath) {
  return forExtension(path.extname(filePath || ""));
}

/**
 * Resolve an executable name to an absolute path by scanning PATH, honoring
 * PATHEXT on Windows. Returns null when not found. No process is spawned.
 * @param {string} command
 * @param {object} [opts] - { env, pathSep }
 * @returns {string|null}
 */
function resolveExecutable(command, opts) {
  opts = opts || {};
  const env = opts.env || process.env;
  if (!command) return null;
  // If the command already contains a path separator, test it directly.
  if (command.includes("/") || (IS_WINDOWS && command.includes("\\"))) {
    return isExecutableFile(command) ? command : null;
  }
  const pathVar = env.PATH || env.Path || "";
  const dirs = pathVar.split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const base = path.join(dir, command);
    if (isExecutableFile(base)) return base;
    if (IS_WINDOWS) {
      for (const ext of WIN_EXE_EXTS) {
        const withExt = base + ext;
        if (isExecutableFile(withExt)) return withExt;
      }
    }
  }
  return null;
}

function isExecutableFile(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    if (IS_WINDOWS) return true; // Windows uses PATHEXT, not the exec bit
    // POSIX: any exec bit set.
    return (st.mode & 0o111) !== 0;
  } catch (_) {
    return false;
  }
}

/**
 * Report installation status for a single server definition.
 * @param {object} server
 * @param {object} [opts] - { env }
 * @returns {object} { id, command, installed, resolvedPath, reason, installHint, docs }
 */
function status(server, opts) {
  const resolved = resolveExecutable(server.command, opts);
  return {
    id: server.id,
    command: server.command,
    args: server.args,
    languages: server.languages,
    extensions: server.extensions,
    installed: !!resolved,
    resolvedPath: resolved,
    reason: resolved
      ? "found on PATH at " + resolved
      : "'" + server.command + "' is not on PATH",
    installHint: server.installHint,
    docs: server.docs,
  };
}

/**
 * Detect server availability. With a filePath, restrict to servers for that
 * file and return them in preference order with installed flags + reasons. The
 * first installed one (if any) is also returned as `chosen`.
 * @param {object} [opts] - { filePath, language, env }
 * @returns {{ candidates:Array<object>, chosen:(object|null), available:boolean, reason:string }}
 */
function detect(opts) {
  opts = opts || {};
  let candidates;
  if (opts.filePath) candidates = forPath(opts.filePath);
  else if (opts.language) candidates = forLanguage(opts.language);
  else candidates = SERVERS.slice();

  const reports = candidates.map((s) => status(s, opts));
  const chosen = reports.find((r) => r.installed) || null;
  let reason;
  if (reports.length === 0) {
    reason = opts.filePath
      ? "no known language server handles " + (path.extname(opts.filePath) || "this file type")
      : "no matching language server in registry";
  } else if (chosen) {
    reason = chosen.id + " is installed (" + chosen.resolvedPath + ")";
  } else {
    reason = "no installed server; tried: " + reports.map((r) => r.command).join(", ") +
      ". Install one, e.g.: " + reports[0].installHint;
  }
  return { candidates: reports, chosen, available: !!chosen, reason };
}

/**
 * Full availability snapshot across every registered server (for `nexus lsp info`).
 * @param {object} [opts] - { env }
 * @returns {Array<object>}
 */
function listAll(opts) {
  return SERVERS.map((s) => status(s, opts));
}

module.exports = {
  SERVERS,
  EXT_TO_LANGUAGE,
  languageIdForPath,
  forExtension,
  forLanguage,
  forPath,
  resolveExecutable,
  status,
  detect,
  listAll,
};
