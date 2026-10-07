#!/usr/bin/env node
"use strict";
// ============================= nexus lsp — demo CLI =============================
// A runnable demonstration of the LSP subsystem that DEGRADES GRACEFULLY when no
// language server is installed: instead of crashing, it tells the user exactly
// which server handles the file and how to install it (NX-107).
//
//   nexus lsp info                         list every known server + install state
//   nexus lsp diagnostics <file>           compiler diagnostics for a file
//   nexus lsp definition  <file> L:C       where the symbol at line:col is defined
//   nexus lsp references  <file> L:C       all references to that symbol
//   nexus lsp hover       <file> L:C       hover/type info at line:col
//   nexus lsp symbols     <file>           document symbol outline
//   nexus lsp wsymbols    <query>          workspace-wide symbol search
//
// Positions are 1-based L:C on the command line (LSP is 0-based internally).
// The facade is injectable so tests drive this CLI against the mock server.
//
// Zero third-party dependencies — Node stdlib only.

const path = require("node:path");
const registry = require("./registry");
const { NexusLsp } = require("./facade");

const HELP = `nexus lsp — ground-truth semantic intelligence (requires an installed language server)

Usage:
  nexus lsp info
  nexus lsp diagnostics <file>
  nexus lsp definition  <file> <line:col>
  nexus lsp references  <file> <line:col>
  nexus lsp hover       <file> <line:col>
  nexus lsp symbols     <file>
  nexus lsp wsymbols    <query> [--for <file>]

Notes:
  * Positions are 1-based line:col (e.g. 12:5).
  * When no server is installed for a file, the command reports which server
    handles it and how to install it, and exits 3 (not a crash).
  --json   emit machine-readable JSON
  -h       show this help`;

/**
 * Parse "L:C" (1-based) into a 0-based LSP position.
 * @param {string} s
 * @returns {{line:number,character:number}|null}
 */
function parsePosition(s) {
  if (!s) return null;
  const m = /^(\d+):(\d+)$/.exec(s.trim());
  if (!m) return null;
  return { line: Math.max(0, parseInt(m[1], 10) - 1), character: Math.max(0, parseInt(m[2], 10) - 1) };
}

function out(stream, obj, json) {
  if (json) stream.write(JSON.stringify(obj, null, 2) + "\n");
}

function reportUnavailable(res, io) {
  io.err("LSP unavailable: " + res.reason);
  if (res.installHint) io.err("Install: " + res.installHint);
  return 3;
}

/**
 * Run the CLI. Returns an exit code (does not call process.exit) so it is
 * testable. `deps.facade` may inject a NexusLsp (e.g. mock-backed) for tests.
 * @param {string[]} argv - args after "lsp"
 * @param {object} [deps] - { facade, cwd, stdout, stderr }
 * @returns {Promise<number>}
 */
async function main(argv, deps) {
  deps = deps || {};
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const io = { log: (s) => stdout.write(s + "\n"), err: (s) => stderr.write(s + "\n") };
  const json = argv.includes("--json");
  const args = argv.filter((a) => a !== "--json");

  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
    io.log(HELP);
    return 0;
  }

  const cmd = args[0];
  const cwd = deps.cwd || process.cwd();
  const lsp = deps.facade || new NexusLsp({ cwd });
  const ownsFacade = !deps.facade;

  try {
    switch (cmd) {
      case "info": {
        const info = lsp.info();
        out(stdout, info, json);
        if (!json) {
          io.log("Known language servers (cwd: " + info.cwd + "):");
          for (const s of info.servers) {
            io.log("  [" + (s.installed ? "installed" : "  missing") + "] " + s.id +
              " (" + s.extensions.join(" ") + ")" + (s.installed ? " -> " + s.resolvedPath : "  install: " + s.installHint));
          }
        }
        return 0;
      }
      case "diagnostics": {
        const file = resolveFile(args[1], cwd);
        if (!file) { io.err("diagnostics: missing <file>"); return 1; }
        const res = await lsp.diagnostics(file);
        if (!res.available) return reportUnavailable(res, io);
        out(stdout, res, json);
        if (!json) {
          if (res.diagnostics.length === 0) io.log("No diagnostics (" + res.serverId + ").");
          for (const d of res.diagnostics) {
            io.log(`${relative(file, cwd)}:${(d.line || 0) + 1}:${(d.column || 0) + 1} ${d.severity}: ${d.message}` +
              (d.code != null ? ` [${d.code}]` : ""));
          }
        }
        return res.diagnostics.some((d) => d.severityCode === 1) ? 2 : 0;
      }
      case "definition":
      case "references":
      case "hover": {
        const file = resolveFile(args[1], cwd);
        const pos = parsePosition(args[2]);
        if (!file || !pos) { io.err(cmd + ": usage: nexus lsp " + cmd + " <file> <line:col>"); return 1; }
        let res;
        if (cmd === "hover") res = await lsp.hover(file, pos);
        else if (cmd === "definition") res = await lsp.definition(file, pos);
        else res = await lsp.references(file, pos);
        if (!res.available) return reportUnavailable(res, io);
        out(stdout, res, json);
        if (!json) printPositionResult(cmd, res, cwd, io);
        return 0;
      }
      case "symbols": {
        const file = resolveFile(args[1], cwd);
        if (!file) { io.err("symbols: missing <file>"); return 1; }
        const res = await lsp.documentSymbols(file);
        if (!res.available) return reportUnavailable(res, io);
        out(stdout, res, json);
        if (!json) printSymbols(res.symbols, 0, io);
        return 0;
      }
      case "wsymbols": {
        const query = args[1] || "";
        const forIdx = args.indexOf("--for");
        const forFile = forIdx >= 0 ? resolveFile(args[forIdx + 1], cwd) : undefined;
        const res = await lsp.workspaceSymbols(query, { forFile });
        if (!res.available) return reportUnavailable(res, io);
        out(stdout, res, json);
        if (!json) printSymbols(res.symbols, 0, io);
        return 0;
      }
      default:
        io.err("unknown command: " + cmd + "\n");
        io.log(HELP);
        return 1;
    }
  } finally {
    if (ownsFacade) { try { await lsp.dispose(); } catch (_) { /* noop */ } }
  }
}

function resolveFile(arg, cwd) {
  if (!arg) return null;
  return path.isAbsolute(arg) ? arg : path.resolve(cwd, arg);
}

function relative(file, cwd) {
  const r = path.relative(cwd, file);
  return r.startsWith("..") ? file : r;
}

function printPositionResult(cmd, res, cwd, io) {
  if (cmd === "hover") {
    io.log(res.hover && res.hover.contents ? res.hover.contents : "(no hover info)");
    return;
  }
  const locs = res.locations || [];
  if (res.locations && res.locations.unsupported) { io.log("(server does not support " + res.locations.capability + ")"); return; }
  if (locs.length === 0) { io.log("(none)"); return; }
  for (const l of locs) {
    const start = l.range && l.range.start ? `${l.range.start.line + 1}:${l.range.start.character + 1}` : "?";
    io.log(`${relative(l.path || l.uri, cwd)}:${start}`);
  }
}

function printSymbols(symbols, depth, io) {
  if (symbols && symbols.unsupported) { io.log("(server does not support " + symbols.capability + ")"); return; }
  for (const s of symbols || []) {
    const loc = s.selectionRange || s.range;
    const at = loc && loc.start ? ` (${loc.start.line + 1}:${loc.start.character + 1})` : "";
    io.log("  ".repeat(depth) + s.kind + " " + s.name + at);
    if (s.children && s.children.length) printSymbols(s.children, depth + 1, io);
  }
}

if (require.main === module) {
  // Support being invoked both as `cli.js <cmd>` and `cli.js lsp <cmd>`.
  let argv = process.argv.slice(2);
  if (argv[0] === "lsp") argv = argv.slice(1);
  main(argv).then((code) => process.exit(code)).catch((err) => {
    process.stderr.write("nexus lsp: " + (err && err.stack || err) + "\n");
    process.exit(1);
  });
}

module.exports = { main, parsePosition, HELP };
