"use strict";
// Local-agent tool catalog + `discover` search (a Glitch idea): let the agent look
// up which tool fits a need by keyword instead of relying on a fixed prompt list —
// useful once MCP tools inflate the toolset. Pure/testable.
const TOOL_CATALOG = [
  ["read_file", "read a file's contents"],
  ["write_file", "create or overwrite a file"],
  ["edit_file", "find and replace within a file"],
  ["list_dir", "list the entries of a directory"],
  ["run_command", "run a shell command and get its output"],
  ["search", "grep file contents for a pattern"],
  ["find", "find files by glob pattern"],
  ["http_fetch", "make an HTTP(S) request to a url"],
  ["sysinfo", "OS, CPU, memory and disk information"],
  ["list_processes", "list running processes"],
  ["make_dir", "create a directory"],
  ["move", "move or rename a file"],
  ["copy", "copy a file"],
  ["delete", "delete a file"],
  ["remember", "save a durable project convention or preference to NEXUS.md"],
  ["spawn_agents", "run several independent sub-tasks in parallel via sub-agents"],
  ["discover", "search available tools by keyword"],
];
function discoverTools(query, catalog) {
  catalog = catalog || TOOL_CATALOG;
  const words = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
  const hit = words.length
    ? catalog.filter(([n, d]) => words.some((w) => n.toLowerCase().includes(w) || d.toLowerCase().includes(w)))
    : catalog.slice();
  return hit.map(([name, description]) => ({ name, description }));
}
module.exports = { TOOL_CATALOG, discoverTools };
