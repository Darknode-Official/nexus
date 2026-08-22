"use strict";
// Curated MCP-server catalog — one-command `/mcp add <name>` connects any model to
// external apps/services through the Model Context Protocol. These specs are written
// into .nexus/mcp.json; the local/any-model agent AND the claude engine then get the
// tools. Package names are real; some need an env var or an arg filled in (needsEnv /
// note). Pure data + helpers so it's unit-tested.
const MCP_CATALOG = {
  blender: { desc: "Control Blender — build/modify 3D scenes, objects, materials, and render", spec: { command: "uvx", args: ["blender-mcp"] }, note: "install the Blender add-on from github.com/ahujasid/blender-mcp and enable it in Blender first" },
  playwright: { desc: "Drive a real browser — navigate, click, type, screenshot, scrape (Microsoft)", spec: { command: "npx", args: ["-y", "@playwright/mcp@latest"] } },
  puppeteer: { desc: "Headless Chrome — navigate, screenshot, evaluate JS", spec: { command: "npx", args: ["-y", "@modelcontextprotocol/server-puppeteer"] } },
  github: { desc: "GitHub — repos, issues, PRs, code search, file contents", spec: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_PERSONAL_ACCESS_TOKEN: "<your-token>" } }, needsEnv: ["GITHUB_PERSONAL_ACCESS_TOKEN"] },
  filesystem: { desc: "Sandboxed filesystem access to specific root folders", spec: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."] }, note: "replace \".\" with the folders you want to expose" },
  fetch: { desc: "Fetch a web page and convert it to clean markdown for the model", spec: { command: "uvx", args: ["mcp-server-fetch"] } },
  memory: { desc: "Persistent knowledge-graph memory across sessions", spec: { command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] } },
  sqlite: { desc: "Query and modify a SQLite database", spec: { command: "uvx", args: ["mcp-server-sqlite", "--db-path", "./data.db"] }, note: "point --db-path at your database file" },
  postgres: { desc: "Read-only Postgres queries + schema inspection", spec: { command: "npx", args: ["-y", "@modelcontextprotocol/server-postgres", "postgresql://localhost/mydb"] }, note: "set your connection string in the args" },
  "brave-search": { desc: "Web + local search via the Brave Search API", spec: { command: "npx", args: ["-y", "@modelcontextprotocol/server-brave-search"], env: { BRAVE_API_KEY: "<key>" } }, needsEnv: ["BRAVE_API_KEY"] },
  slack: { desc: "Read and post Slack messages / list channels", spec: { command: "npx", args: ["-y", "@modelcontextprotocol/server-slack"], env: { SLACK_BOT_TOKEN: "<token>", SLACK_TEAM_ID: "<team-id>" } }, needsEnv: ["SLACK_BOT_TOKEN", "SLACK_TEAM_ID"] },
  time: { desc: "Current time and timezone conversions", spec: { command: "uvx", args: ["mcp-server-time"] } },
  "sequential-thinking": { desc: "Structured step-by-step reasoning scratchpad", spec: { command: "npx", args: ["-y", "@modelcontextprotocol/server-sequential-thinking"] } },
};

function catalogList() { return Object.keys(MCP_CATALOG); }
function catalogGet(name) { return MCP_CATALOG[String(name || "").toLowerCase()] || null; }
// Merge a catalog entry into an mcp.json config object; returns the new config (or null
// if unknown). Non-destructive to other servers already present.
function addServerToConfig(cfg, name) {
  const e = catalogGet(name); if (!e) return null;
  const out = cfg && typeof cfg === "object" ? JSON.parse(JSON.stringify(cfg)) : {};
  if (!out.mcpServers || typeof out.mcpServers !== "object") out.mcpServers = {};
  out.mcpServers[name.toLowerCase()] = JSON.parse(JSON.stringify(e.spec));
  return out;
}
function removeServerFromConfig(cfg, name) {
  const out = cfg && typeof cfg === "object" ? JSON.parse(JSON.stringify(cfg)) : { mcpServers: {} };
  if (out.mcpServers) delete out.mcpServers[String(name || "").toLowerCase()];
  return out;
}
module.exports = { MCP_CATALOG, catalogList, catalogGet, addServerToConfig, removeServerFromConfig };
