"use strict";
// Curated MCP-server catalog — one-command `/mcp add <name>` connects any model to
// external apps/services through the Model Context Protocol. These specs are written
// into .nexus/mcp.json; the local/any-model agent AND the claude engine then get the
// tools. Package names are real; some need an env var or an arg filled in (needsEnv /
// note). Pure data + helpers so it's unit-tested.
//
// The subset in DEFAULT_MCP is BUNDLED — Nexus auto-connects those (no API key) on
// every launch, so a fresh download already has web fetch, persistent memory, a
// reasoning scratchpad, live library docs, time, and git out of the box. Disable with
// DARKNODE_NO_DEFAULT_MCP=1; each only connects if its runtime (npx/uvx) is installed.
const MCP_CATALOG = {
  // ---- bundled by default (no key, broadly useful) ----
  fetch: { desc: "Fetch a web page and convert it to clean markdown for the model", spec: { command: "uvx", args: ["mcp-server-fetch"] } },
  memory: { desc: "Persistent knowledge-graph memory across sessions", spec: { command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] } },
  "sequential-thinking": { desc: "Structured step-by-step reasoning scratchpad", spec: { command: "npx", args: ["-y", "@modelcontextprotocol/server-sequential-thinking"] } },
  context7: { desc: "Up-to-date docs & code examples for any library/framework, on demand", spec: { command: "npx", args: ["-y", "@upstash/context7-mcp@latest"] } },
  time: { desc: "Current time and timezone conversions", spec: { command: "uvx", args: ["mcp-server-time"] } },
  git: { desc: "Git repo ops — status, diff, log, blame, commit, branches", spec: { command: "uvx", args: ["mcp-server-git", "--repository", "."] }, note: "operates on the current repo (--repository .)" },
  // ---- browsers / automation ----
  playwright: { desc: "Drive a real browser — navigate, click, type, screenshot, scrape (Microsoft)", spec: { command: "npx", args: ["-y", "@playwright/mcp@latest"] } },
  puppeteer: { desc: "Headless Chrome — navigate, screenshot, evaluate JS", spec: { command: "npx", args: ["-y", "@modelcontextprotocol/server-puppeteer"] } },
  // ---- code / dev platforms ----
  github: { desc: "GitHub — repos, issues, PRs, code search, file contents", spec: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_PERSONAL_ACCESS_TOKEN: "<your-token>" } }, needsEnv: ["GITHUB_PERSONAL_ACCESS_TOKEN"] },
  gitlab: { desc: "GitLab — projects, issues, MRs, files", spec: { command: "npx", args: ["-y", "@modelcontextprotocol/server-gitlab"], env: { GITLAB_PERSONAL_ACCESS_TOKEN: "<token>" } }, needsEnv: ["GITLAB_PERSONAL_ACCESS_TOKEN"] },
  sentry: { desc: "Sentry — pull and analyse error/issue details", spec: { command: "npx", args: ["-y", "@modelcontextprotocol/server-sentry"], env: { SENTRY_AUTH_TOKEN: "<token>" } }, needsEnv: ["SENTRY_AUTH_TOKEN"] },
  e2b: { desc: "Run code in a secure cloud sandbox (E2B) and get the output", spec: { command: "npx", args: ["-y", "@e2b/mcp-server"], env: { E2B_API_KEY: "<key>" } }, needsEnv: ["E2B_API_KEY"] },
  // ---- filesystem / databases ----
  filesystem: { desc: "Sandboxed filesystem access to specific root folders", spec: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."] }, note: "replace \".\" with the folders you want to expose" },
  sqlite: { desc: "Query and modify a SQLite database", spec: { command: "uvx", args: ["mcp-server-sqlite", "--db-path", "./data.db"] }, note: "point --db-path at your database file" },
  postgres: { desc: "Read-only Postgres queries + schema inspection", spec: { command: "npx", args: ["-y", "@modelcontextprotocol/server-postgres", "postgresql://localhost/mydb"] }, note: "set your connection string in the args" },
  gdrive: { desc: "Google Drive — search and read files", spec: { command: "npx", args: ["-y", "@modelcontextprotocol/server-gdrive"] }, note: "runs an OAuth flow on first use" },
  // ---- web search / scraping / research ----
  "brave-search": { desc: "Web + local search via the Brave Search API", spec: { command: "npx", args: ["-y", "@modelcontextprotocol/server-brave-search"], env: { BRAVE_API_KEY: "<key>" } }, needsEnv: ["BRAVE_API_KEY"] },
  exa: { desc: "Neural web search built for AI (Exa)", spec: { command: "npx", args: ["-y", "exa-mcp-server"], env: { EXA_API_KEY: "<key>" } }, needsEnv: ["EXA_API_KEY"] },
  tavily: { desc: "Real-time web search + extract optimised for agents (Tavily)", spec: { command: "npx", args: ["-y", "tavily-mcp"], env: { TAVILY_API_KEY: "<key>" } }, needsEnv: ["TAVILY_API_KEY"] },
  firecrawl: { desc: "Crawl & scrape whole sites into clean markdown (Firecrawl)", spec: { command: "npx", args: ["-y", "firecrawl-mcp"], env: { FIRECRAWL_API_KEY: "<key>" } }, needsEnv: ["FIRECRAWL_API_KEY"] },
  // ---- knowledge / notes / maps / media ----
  notion: { desc: "Notion — read and update pages and databases", spec: { command: "npx", args: ["-y", "@notionhq/notion-mcp-server"], env: { NOTION_TOKEN: "<integration-token>" } }, needsEnv: ["NOTION_TOKEN"] },
  slack: { desc: "Read and post Slack messages / list channels", spec: { command: "npx", args: ["-y", "@modelcontextprotocol/server-slack"], env: { SLACK_BOT_TOKEN: "<token>", SLACK_TEAM_ID: "<team-id>" } }, needsEnv: ["SLACK_BOT_TOKEN", "SLACK_TEAM_ID"] },
  "google-maps": { desc: "Google Maps — geocode, directions, place search", spec: { command: "npx", args: ["-y", "@modelcontextprotocol/server-google-maps"], env: { GOOGLE_MAPS_API_KEY: "<key>" } }, needsEnv: ["GOOGLE_MAPS_API_KEY"] },
  everart: { desc: "Generate images with EverArt models", spec: { command: "npx", args: ["-y", "@modelcontextprotocol/server-everart"], env: { EVERART_API_KEY: "<key>" } }, needsEnv: ["EVERART_API_KEY"] },
  blender: { desc: "Control Blender — build/modify 3D scenes, objects, materials, and render", spec: { command: "uvx", args: ["blender-mcp"] }, note: "install the Blender add-on from github.com/ahujasid/blender-mcp and enable it in Blender first" },
};

// Bundled-by-default servers (auto-connected on launch; only the no-key ones connect).
const DEFAULT_MCP = ["fetch", "memory", "sequential-thinking", "context7", "time", "git"];

function catalogList() { return Object.keys(MCP_CATALOG); }
function catalogGet(name) { return MCP_CATALOG[String(name || "").toLowerCase()] || null; }
function isBundled(name) { return DEFAULT_MCP.indexOf(String(name || "").toLowerCase()) >= 0; }
// The bundled specs that need NO API key — {name: spec}. These are the ones Nexus
// auto-connects out of the box (subject to their runtime being installed).
function bundledSpecs() {
  const out = {};
  for (const n of DEFAULT_MCP) { const e = MCP_CATALOG[n]; if (e && !(e.needsEnv && e.needsEnv.length)) out[n] = JSON.parse(JSON.stringify(e.spec)); }
  return out;
}
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
module.exports = { MCP_CATALOG, DEFAULT_MCP, catalogList, catalogGet, isBundled, bundledSpecs, addServerToConfig, removeServerFromConfig };
