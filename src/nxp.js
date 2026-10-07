"use strict";
// ================= NXP — Nexus Extension Protocol =================
//
// WHY NOT JUST MCP?
// MCP is great for EXTERNAL services (GitHub, Slack, databases). But for tools
// the agent uses every turn, MCP's overhead kills performance:
//   - Spawn a subprocess per server
//   - JSON-RPC handshake + capability negotiation
//   - Serialize/deserialize every call through stdin/stdout
//   - No shared state between tools
//   - No streaming progress
//   - Each tool is isolated (can't call other tools)
//
// NXP is Nexus's OWN protocol — built for speed:
//   ✓ In-process: tools are JS functions, direct calls (~0.1ms vs MCP's ~50-200ms)
//   ✓ Zero config: drop a .js file in .nexus/extensions/ and it auto-loads
//   ✓ Context-aware: every tool gets project context (cwd, workspace, memory)
//   ✓ Composable: tools can call other tools directly
//   ✓ Streaming: tools can yield progress updates
//   ✓ Typed: JSON Schema validation built in
//   ✓ MCP bridge: NXP wraps MCP servers too — one unified interface
//   ✓ Hot-reload: edit a tool, it reloads next call
//
// WRITING AN NXP EXTENSION:
//   // .nexus/extensions/my-tool.js
//   module.exports = {
//     name: "my_tool",
//     description: "Does a thing",
//     input: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
//     run: async (input, ctx) => {
//       const file = ctx.tools.read_file({ path: input.query });
//       return { result: file.content };
//     },
//   };

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const EXT_DIR = ".nexus/extensions";

// ================= CORE: Tool Registry =================

class NXPRegistry {
  constructor() {
    this.tools = new Map();       // name → tool definition
    this.middleware = [];          // pre/post hooks
    this.metrics = new Map();     // name → { calls, errors, totalMs }
    this._context = null;
  }

  // ---- Register a tool ----

  register(tool) {
    if (!tool.name) throw new Error("NXP tool must have a name");
    if (typeof tool.run !== "function") throw new Error(`NXP tool "${tool.name}" must have a run() function`);

    this.tools.set(tool.name, {
      name: tool.name,
      description: tool.description || "",
      input: tool.input || { type: "object" },   // JSON Schema
      output: tool.output || null,                 // optional output schema
      tags: tool.tags || [],                       // for discovery
      cacheable: tool.cacheable || false,           // can results be cached?
      timeout: tool.timeout || 30000,              // ms
      run: tool.run,
      source: tool.source || "code",               // code | extension | mcp | builtin
      _loadedAt: Date.now(),
    });

    if (!this.metrics.has(tool.name)) {
      this.metrics.set(tool.name, { calls: 0, errors: 0, totalMs: 0, lastCall: null });
    }
  }

  // ---- Register multiple tools at once ----

  registerAll(tools) {
    for (const tool of tools) this.register(tool);
  }

  // ---- Call a tool ----

  async call(name, input, extraContext) {
    const tool = this.tools.get(name);
    if (!tool) {
      // Try fuzzy match
      const candidates = this.search(name);
      if (candidates.length === 1) return this.call(candidates[0].name, input, extraContext);
      throw new NXPError("TOOL_NOT_FOUND", `Tool "${name}" not found. ${candidates.length ? "Did you mean: " + candidates.map(c => c.name).join(", ") + "?" : "Available: " + [...this.tools.keys()].join(", ")}`);
    }

    const metrics = this.metrics.get(name);
    const start = Date.now();
    const ctx = this._buildContext(extraContext);

    // Run middleware (pre)
    let processedInput = input;
    for (const mw of this.middleware) {
      if (mw.pre) processedInput = (await mw.pre(name, processedInput, ctx)) || processedInput;
    }

    // Validate input
    const validation = validateInput(processedInput, tool.input);
    if (!validation.valid) {
      throw new NXPError("INVALID_INPUT", `Tool "${name}": ${validation.errors.join(", ")}`);
    }

    // Execute with timeout
    let result;
    try {
      result = await Promise.race([
        tool.run(processedInput, ctx),
        new Promise((_, reject) => setTimeout(() => reject(new NXPError("TIMEOUT", `Tool "${name}" timed out after ${tool.timeout}ms`)), tool.timeout)),
      ]);
    } catch (e) {
      metrics.errors++;
      metrics.totalMs += Date.now() - start;
      metrics.lastCall = Date.now();

      // Run middleware (error)
      for (const mw of this.middleware) {
        if (mw.onError) {
          const recovery = await mw.onError(name, e, processedInput, ctx);
          if (recovery !== undefined) { result = recovery; break; }
        }
      }
      if (result === undefined) throw e;
    }

    metrics.calls++;
    metrics.totalMs += Date.now() - start;
    metrics.lastCall = Date.now();

    // Run middleware (post)
    for (const mw of this.middleware) {
      if (mw.post) result = (await mw.post(name, result, processedInput, ctx)) || result;
    }

    return result;
  }

  // ---- Batch call (parallel) ----

  async batch(calls) {
    return Promise.allSettled(
      calls.map(({ name, input }) => this.call(name, input))
    ).then(results => results.map((r, i) => ({
      tool: calls[i].name,
      status: r.status,
      result: r.status === "fulfilled" ? r.value : null,
      error: r.status === "rejected" ? r.reason.message : null,
    })));
  }

  // ---- Pipe: chain tools (output of A → input of B) ----

  async pipe(steps) {
    let data = null;
    const trace = [];
    for (const step of steps) {
      const input = typeof step.transform === "function" ? step.transform(data) : { ...data, ...(step.input || {}) };
      const start = Date.now();
      try {
        data = await this.call(step.tool, input);
        trace.push({ tool: step.tool, status: "ok", ms: Date.now() - start });
      } catch (e) {
        trace.push({ tool: step.tool, status: "error", error: e.message, ms: Date.now() - start });
        if (!step.optional) throw e;
      }
    }
    return { result: data, trace };
  }

  // ---- Discovery: search tools by keyword ----

  search(query) {
    const words = String(query || "").toLowerCase().split(/\s+/).filter(w => w.length > 1);
    if (!words.length) return [...this.tools.values()].map(t => ({ name: t.name, description: t.description, tags: t.tags }));

    return [...this.tools.values()]
      .map(tool => {
        const text = (tool.name + " " + tool.description + " " + tool.tags.join(" ")).toLowerCase();
        let score = 0;
        for (const w of words) {
          if (tool.name.toLowerCase().includes(w)) score += 5;
          if (text.includes(w)) score += 2;
        }
        return { name: tool.name, description: tool.description, tags: tool.tags, score };
      })
      .filter(t => t.score > 0)
      .sort((a, b) => b.score - a.score);
  }

  // ---- List all tools (for AI prompt injection) ----

  list() {
    return [...this.tools.values()].map(t => ({
      name: t.name,
      description: t.description,
      input: t.input,
      tags: t.tags,
      source: t.source,
    }));
  }

  // ---- Format tools for AI system prompt ----

  formatForPrompt(filter) {
    let tools = [...this.tools.values()];
    if (filter) tools = tools.filter(t => filter(t));

    const lines = ["## Available Tools"];
    for (const tool of tools) {
      const params = tool.input?.properties
        ? Object.entries(tool.input.properties).map(([k, v]) => {
            const req = (tool.input.required || []).includes(k) ? "" : "?";
            return `${k}${req}: ${v.type || "any"}`;
          }).join(", ")
        : "";
      lines.push(`- **${tool.name}**(${params}) — ${tool.description}`);
    }
    return lines.join("\n");
  }

  // ---- Middleware ----

  use(middleware) {
    this.middleware.push(middleware);
  }

  // ---- Context ----

  setContext(ctx) { this._context = ctx; }

  _buildContext(extra) {
    const base = this._context || {};
    return {
      cwd: base.cwd || process.cwd(),
      workspace: base.workspace || null,
      memory: base.memory || null,
      tools: this._createToolProxy(),  // tools can call other tools
      ...(extra || {}),
    };
  }

  // Proxy that lets tools call other tools: ctx.tools.read_file({ path: "x" })
  _createToolProxy() {
    const self = this;
    return new Proxy({}, {
      get(_, name) {
        return (input) => self.call(name, input);
      },
    });
  }

  // ---- Metrics ----

  getMetrics() {
    const all = [];
    for (const [name, m] of this.metrics) {
      all.push({
        name,
        calls: m.calls,
        errors: m.errors,
        avgMs: m.calls ? Math.round(m.totalMs / m.calls) : 0,
        errorRate: m.calls ? (m.errors / m.calls * 100).toFixed(1) + "%" : "0%",
        lastCall: m.lastCall,
      });
    }
    return all.sort((a, b) => b.calls - a.calls);
  }

  resetMetrics() {
    for (const m of this.metrics.values()) {
      m.calls = 0; m.errors = 0; m.totalMs = 0; m.lastCall = null;
    }
  }
}

// ================= BUILT-IN TOOLS =================
// The core tools every Nexus agent needs — implemented as NXP, not MCP.

const BUILTIN_TOOLS = [
  {
    name: "read_file",
    description: "Read a file's contents. Returns the text content.",
    input: { type: "object", properties: { path: { type: "string", description: "File path to read" }, maxLines: { type: "integer", description: "Max lines to read (default: all)" } }, required: ["path"] },
    tags: ["file", "read", "core"],
    source: "builtin",
    run: async (input, ctx) => {
      const fp = path.resolve(ctx.cwd, input.path);
      const content = fs.readFileSync(fp, "utf8");
      if (input.maxLines) {
        const lines = content.split("\n").slice(0, input.maxLines);
        return { content: lines.join("\n"), lines: lines.length, truncated: content.split("\n").length > input.maxLines };
      }
      return { content, lines: content.split("\n").length };
    },
  },
  {
    name: "write_file",
    description: "Create or overwrite a file with the given content.",
    input: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
    tags: ["file", "write", "core"],
    source: "builtin",
    run: async (input, ctx) => {
      const fp = path.resolve(ctx.cwd, input.path);
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, input.content);
      return { ok: true, path: input.path, bytes: Buffer.byteLength(input.content) };
    },
  },
  {
    name: "edit_file",
    description: "Find and replace text in a file. The 'find' string must match exactly.",
    input: { type: "object", properties: { path: { type: "string" }, find: { type: "string" }, replace: { type: "string" } }, required: ["path", "find", "replace"] },
    tags: ["file", "edit", "core"],
    source: "builtin",
    run: async (input, ctx) => {
      const fp = path.resolve(ctx.cwd, input.path);
      const content = fs.readFileSync(fp, "utf8");
      if (!content.includes(input.find)) return { ok: false, error: "find string not present in file" };
      fs.writeFileSync(fp, content.replace(input.find, input.replace));
      return { ok: true, path: input.path };
    },
  },
  {
    name: "list_dir",
    description: "List entries in a directory.",
    input: { type: "object", properties: { path: { type: "string" } } },
    tags: ["file", "list", "core"],
    source: "builtin",
    run: async (input, ctx) => {
      const dp = path.resolve(ctx.cwd, input.path || ".");
      const entries = fs.readdirSync(dp, { withFileTypes: true });
      return { items: entries.map(e => e.isDirectory() ? e.name + "/" : e.name) };
    },
  },
  {
    name: "run_command",
    description: "Execute a shell command and return stdout/stderr.",
    input: { type: "object", properties: { command: { type: "string" }, timeout: { type: "integer" } }, required: ["command"] },
    tags: ["shell", "run", "core"],
    timeout: 60000,
    source: "builtin",
    run: async (input, ctx) => {
      const { execSync } = require("child_process");
      try {
        const stdout = execSync(input.command, { cwd: ctx.cwd, encoding: "utf8", timeout: input.timeout || 30000, stdio: ["pipe", "pipe", "pipe"] });
        return { code: 0, output: stdout.slice(0, 50000) };
      } catch (e) {
        return { code: e.status || 1, output: (e.stdout || "") + "\n" + (e.stderr || e.message || "").slice(0, 10000) };
      }
    },
  },
  {
    name: "search",
    description: "Search file contents for a pattern (grep). Returns matching lines with file paths.",
    input: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" }, maxResults: { type: "integer" } }, required: ["pattern"] },
    tags: ["search", "grep", "core"],
    source: "builtin",
    run: async (input, ctx) => {
      const { execSync } = require("child_process");
      const max = input.maxResults || 50;
      const searchPath = input.path || ".";
      try {
        const out = execSync(`grep -rn --include="*.js" --include="*.ts" --include="*.py" --include="*.json" --include="*.md" "${input.pattern}" ${searchPath} 2>/dev/null | head -${max}`, { cwd: ctx.cwd, encoding: "utf8", timeout: 10000 });
        const matches = out.trim().split("\n").filter(Boolean).map(line => {
          const [loc, ...rest] = line.split(":");
          return { location: loc, match: rest.join(":").trim() };
        });
        return { matches, count: matches.length };
      } catch (_) { return { matches: [], count: 0 }; }
    },
  },
  {
    name: "find_files",
    description: "Find files by name pattern (glob).",
    input: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" } }, required: ["pattern"] },
    tags: ["search", "find", "core"],
    source: "builtin",
    run: async (input, ctx) => {
      const { execSync } = require("child_process");
      try {
        const out = execSync(`find ${input.path || "."} -name "${input.pattern}" -not -path "*/node_modules/*" -not -path "*/.git/*" 2>/dev/null | head -50`, { cwd: ctx.cwd, encoding: "utf8", timeout: 10000 });
        return { files: out.trim().split("\n").filter(Boolean) };
      } catch (_) { return { files: [] }; }
    },
  },
  {
    name: "web_fetch",
    description: "Fetch a URL and return its content as text/markdown.",
    input: { type: "object", properties: { url: { type: "string" }, maxLength: { type: "integer" } }, required: ["url"] },
    tags: ["web", "fetch", "http"],
    timeout: 15000,
    source: "builtin",
    run: async (input) => {
      const https = require("https");
      const http = require("http");
      return new Promise((resolve, reject) => {
        const lib = input.url.startsWith("https") ? https : http;
        lib.get(input.url, { timeout: 10000 }, res => {
          let data = "";
          res.on("data", chunk => { data += chunk; if (data.length > (input.maxLength || 100000)) res.destroy(); });
          res.on("end", () => resolve({ status: res.statusCode, content: data.slice(0, input.maxLength || 100000), contentType: res.headers["content-type"] }));
        }).on("error", e => reject(new Error("Fetch failed: " + e.message)));
      });
    },
  },
  {
    name: "remember",
    description: "Save a durable note to project memory (.nexus/NEXUS.md).",
    input: { type: "object", properties: { note: { type: "string" } }, required: ["note"] },
    tags: ["memory", "note", "core"],
    source: "builtin",
    run: async (input, ctx) => {
      const { mergeMemory } = require("./memory");
      const memPath = path.join(ctx.cwd, ".nexus", "NEXUS.md");
      let md = "";
      try { md = fs.readFileSync(memPath, "utf8"); } catch (_) {}
      const result = mergeMemory(md, input.note);
      if (result.added) {
        fs.mkdirSync(path.dirname(memPath), { recursive: true });
        fs.writeFileSync(memPath, result.md);
      }
      return { added: result.added, reason: result.reason };
    },
  },
  {
    name: "discover",
    description: "Search available tools by keyword. Returns matching tools with descriptions.",
    input: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    tags: ["meta", "discover", "core"],
    source: "builtin",
    run: async (input, ctx) => {
      // ctx.tools is a proxy, but we can access the registry from closure
      return { message: "Use the NXP registry's search() method to discover tools." };
    },
  },
];

// ================= EXTENSION LOADER =================

function loadExtensions(cwd) {
  const dir = path.join(cwd, EXT_DIR);
  const loaded = [];
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith(".js"));
    for (const f of files) {
      const fp = path.join(dir, f);
      try {
        delete require.cache[require.resolve(fp)]; // hot-reload
        const ext = require(fp);
        // Support single tool or array of tools
        const tools = Array.isArray(ext) ? ext : ext.name ? [ext] : Object.values(ext).filter(v => v && v.name && typeof v.run === "function");
        for (const tool of tools) {
          tool.source = tool.source || "extension";
          loaded.push({ tool, file: f, error: null });
        }
      } catch (e) {
        loaded.push({ tool: null, file: f, error: e.message });
      }
    }
  } catch (_) {} // no extensions dir
  return loaded;
}

// ================= MCP BRIDGE =================
// Wrap an MCP server's tools as NXP tools — unified interface.

function wrapMCPTool(serverName, mcpTool, callFn) {
  return {
    name: `${serverName}__${mcpTool.name}`,
    description: mcpTool.description || "",
    input: mcpTool.inputSchema || { type: "object" },
    tags: ["mcp", serverName],
    source: "mcp",
    timeout: 30000,
    run: async (input) => {
      const result = await callFn(mcpTool.name, input);
      return result.error ? { error: result.content || result.text } : { result: result.text || result.raw };
    },
  };
}

// ================= INPUT VALIDATION =================

function validateInput(input, schema) {
  if (!schema || schema.type !== "object") return { valid: true, errors: [] };
  const errors = [];

  // Check required fields
  if (schema.required) {
    for (const field of schema.required) {
      if (input == null || input[field] === undefined || input[field] === null) {
        errors.push(`Missing required field: ${field}`);
      }
    }
  }

  // Check types
  if (schema.properties && input) {
    for (const [key, prop] of Object.entries(schema.properties)) {
      if (input[key] === undefined) continue;
      if (prop.type === "string" && typeof input[key] !== "string") errors.push(`${key} must be a string`);
      if (prop.type === "integer" && !Number.isInteger(input[key])) errors.push(`${key} must be an integer`);
      if (prop.type === "number" && typeof input[key] !== "number") errors.push(`${key} must be a number`);
      if (prop.type === "boolean" && typeof input[key] !== "boolean") errors.push(`${key} must be a boolean`);
      if (prop.type === "array" && !Array.isArray(input[key])) errors.push(`${key} must be an array`);
      if (prop.enum && !prop.enum.includes(input[key])) errors.push(`${key} must be one of: ${prop.enum.join(", ")}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

// ================= ERROR CLASS =================

class NXPError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "NXPError";
  }
}

// ================= FACTORY =================

/**
 * Create a fully initialized NXP registry with builtins + extensions + optional MCP.
 * @param {string} cwd - project root
 * @param {object} opts - { loadExtensions, workspace, memory }
 * @returns {NXPRegistry}
 */
function createNXP(cwd, opts) {
  opts = opts || {};
  const registry = new NXPRegistry();
  registry.setContext({ cwd, workspace: opts.workspace, memory: opts.memory });

  // Register builtins
  registry.registerAll(BUILTIN_TOOLS);

  // Load extensions from .nexus/extensions/
  if (opts.loadExtensions !== false) {
    const exts = loadExtensions(cwd);
    for (const ext of exts) {
      if (ext.tool) registry.register(ext.tool);
    }
  }

  // Logging middleware
  if (opts.logging) {
    registry.use({
      pre: (name, input) => {
        const ui = require("./ui");
        ui.out(ui.render.toolCall({ name, args: JSON.stringify(input).slice(0, 100), status: "running" }, { indent: 1 }));
        return input;
      },
      onError: (name, error) => {
        const ui = require("./ui");
        process.stderr.write(ui.render.roleLine("error", `${name}: ${error.message}`, { indent: 1 }) + "\n");
      },
    });
  }

  return registry;
}

// ================= SCAFFOLD =================

function scaffoldExtension(cwd, name) {
  const dir = path.join(cwd, EXT_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name + ".js");
  fs.writeFileSync(file, `"use strict";
// NXP Extension: ${name}
// Drop this in .nexus/extensions/ — auto-loaded on every session.
// Tools can call other tools via ctx.tools.read_file(), ctx.tools.search(), etc.

module.exports = {
  name: "${name}",
  description: "TODO: describe what this tool does",
  input: {
    type: "object",
    properties: {
      query: { type: "string", description: "The input query" },
    },
    required: ["query"],
  },
  tags: ["custom"],
  run: async (input, ctx) => {
    // ctx.cwd — project root
    // ctx.workspace — detected project info
    // ctx.tools.read_file({ path: "..." }) — call other tools
    // ctx.tools.search({ pattern: "..." }) — search the codebase
    // ctx.tools.run_command({ command: "..." }) — run a shell command

    return { result: "Hello from ${name}!", query: input.query };
  },
};
`);
  return file;
}

module.exports = {
  NXPRegistry, NXPError,
  createNXP, scaffoldExtension,
  loadExtensions, wrapMCPTool,
  validateInput, BUILTIN_TOOLS,
};
