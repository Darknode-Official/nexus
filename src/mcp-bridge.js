"use strict";
// ================= MCP Bridge — Model Context Protocol client for Nexus =================
// Connects Nexus to any MCP server via JSON-RPC 2.0 over stdio. Handles the full
// lifecycle: spawn → initialize → capability negotiation → tool/resource/prompt
// discovery → tool calls → graceful shutdown.
//
// PROTOCOL REFERENCE (2025-06-18 spec):
// - Transport: stdio (server reads JSON-RPC from stdin, writes to stdout)
// - Lifecycle: initialize → notifications/initialized → operation → shutdown
// - Primitives: tools (model-controlled), resources (app-controlled), prompts (user-controlled)
// - Tool calls return content[] (text/image/resource) with isError flag for soft failures
// - Capability negotiation: client declares {roots, sampling}, server declares {tools, resources, prompts}

const { spawn } = require("child_process");
const crypto = require("crypto");
const readline = require("readline");

const PROTOCOL_VERSION = "2025-06-18";

// ---- JSON-RPC helpers ----

function jsonrpcRequest(method, params, id) {
  return JSON.stringify({ jsonrpc: "2.0", id: id || crypto.randomBytes(4).toString("hex"), method, params: params || {} });
}

function jsonrpcNotify(method, params) {
  return JSON.stringify({ jsonrpc: "2.0", method, params: params || {} });
}

// ---- MCP Server Connection ----

class MCPConnection {
  constructor(name, command, args, env) {
    this.name = name;
    this.command = command;
    this.args = args || [];
    this.env = env || {};
    this.process = null;
    this.rl = null;
    this.pending = new Map(); // id → { resolve, reject, timer }
    this.capabilities = {};
    this.serverInfo = {};
    this.tools = [];
    this.resources = [];
    this.prompts = [];
    this.connected = false;
    this._notificationHandlers = {};
  }

  // Spawn the server process and wire up JSON-RPC
  async connect(timeout) {
    timeout = timeout || 15000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`MCP server "${this.name}" timed out on connect`)), timeout);

      this.process = spawn(this.command, this.args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...this.env },
      });

      this.process.on("error", (err) => {
        clearTimeout(timer);
        reject(new Error(`Failed to spawn MCP server "${this.name}": ${err.message}`));
      });

      this.process.on("exit", (code) => {
        this.connected = false;
        // Reject all pending requests
        for (const [id, p] of this.pending) {
          p.reject(new Error(`MCP server "${this.name}" exited (code ${code})`));
          clearTimeout(p.timer);
        }
        this.pending.clear();
      });

      // Parse newline-delimited JSON-RPC from stdout
      this.rl = readline.createInterface({ input: this.process.stdout });
      this.rl.on("line", (line) => {
        let msg;
        try { msg = JSON.parse(line); } catch (_) { return; }

        if (msg.id && this.pending.has(msg.id)) {
          // Response to our request
          const p = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          else p.resolve(msg.result);
        } else if (msg.method) {
          // Notification or server-initiated request
          const handler = this._notificationHandlers[msg.method];
          if (handler) handler(msg.params);
        }
      });

      // Initialize handshake
      this._send("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { roots: { listChanged: false } },
        clientInfo: { name: "Nexus", version: "1.0.0" },
      }).then((result) => {
        this.capabilities = result.capabilities || {};
        this.serverInfo = result.serverInfo || {};
        // Send initialized notification
        this._notify("notifications/initialized");
        this.connected = true;
        clearTimeout(timer);
        resolve(this);
      }).catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  // Send a JSON-RPC request and wait for response
  _send(method, params, timeout) {
    timeout = timeout || 30000;
    return new Promise((resolve, reject) => {
      const id = crypto.randomBytes(4).toString("hex");
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request "${method}" timed out after ${timeout}ms`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      const msg = jsonrpcRequest(method, params, id);
      this.process.stdin.write(msg + "\n");
    });
  }

  // Send a notification (no response expected)
  _notify(method, params) {
    this.process.stdin.write(jsonrpcNotify(method, params) + "\n");
  }

  // Register a notification handler
  onNotification(method, handler) {
    this._notificationHandlers[method] = handler;
  }

  // ---- Tool operations ----

  async listTools() {
    if (!this.capabilities.tools) return [];
    const result = await this._send("tools/list");
    this.tools = result.tools || [];
    return this.tools;
  }

  async callTool(name, args) {
    const result = await this._send("tools/call", { name, arguments: args || {} });
    // Handle tool execution errors (soft errors, not protocol errors)
    if (result.isError) {
      const errorText = (result.content || []).filter(c => c.type === "text").map(c => c.text).join("\n");
      return { error: true, content: errorText || "Tool execution failed", raw: result };
    }
    // Extract text content
    const textContent = (result.content || []).filter(c => c.type === "text").map(c => c.text).join("\n");
    const imageContent = (result.content || []).filter(c => c.type === "image");
    return { error: false, text: textContent, images: imageContent, raw: result };
  }

  // ---- Resource operations ----

  async listResources() {
    if (!this.capabilities.resources) return [];
    const result = await this._send("resources/list");
    this.resources = result.resources || [];
    return this.resources;
  }

  async readResource(uri) {
    const result = await this._send("resources/read", { uri });
    return (result.contents || []).map(c => ({
      uri: c.uri,
      mimeType: c.mimeType,
      text: c.text || null,
      blob: c.blob || null,
    }));
  }

  async listResourceTemplates() {
    if (!this.capabilities.resources) return [];
    const result = await this._send("resources/templates/list");
    return result.resourceTemplates || [];
  }

  // ---- Prompt operations ----

  async listPrompts() {
    if (!this.capabilities.prompts) return [];
    const result = await this._send("prompts/list");
    this.prompts = result.prompts || [];
    return this.prompts;
  }

  async getPrompt(name, args) {
    const result = await this._send("prompts/get", { name, arguments: args || {} });
    return { description: result.description, messages: result.messages || [] };
  }

  // ---- Lifecycle ----

  async disconnect() {
    if (this.process) {
      this.process.stdin.end();
      // Give it a moment to exit gracefully
      await new Promise(r => setTimeout(r, 500));
      if (this.process.exitCode === null) this.process.kill("SIGTERM");
      await new Promise(r => setTimeout(r, 1000));
      if (this.process.exitCode === null) this.process.kill("SIGKILL");
    }
    this.connected = false;
  }

  // ---- Summary ----

  summary() {
    return {
      name: this.name,
      connected: this.connected,
      server: this.serverInfo,
      capabilities: Object.keys(this.capabilities),
      tools: this.tools.length,
      resources: this.resources.length,
      prompts: this.prompts.length,
    };
  }
}

// ---- MCP Manager: manages multiple server connections ----

class MCPManager {
  constructor() {
    this.connections = new Map(); // name → MCPConnection
  }

  async connectServer(name, spec) {
    if (this.connections.has(name)) {
      const existing = this.connections.get(name);
      if (existing.connected) return existing;
      await existing.disconnect();
    }
    const conn = new MCPConnection(name, spec.command, spec.args, spec.env);
    await conn.connect();
    // Auto-discover tools, resources, prompts
    await Promise.allSettled([conn.listTools(), conn.listResources(), conn.listPrompts()]);
    // Listen for list changes
    conn.onNotification("notifications/tools/list_changed", () => conn.listTools());
    conn.onNotification("notifications/resources/list_changed", () => conn.listResources());
    conn.onNotification("notifications/prompts/list_changed", () => conn.listPrompts());
    this.connections.set(name, conn);
    return conn;
  }

  async disconnectServer(name) {
    const conn = this.connections.get(name);
    if (conn) {
      await conn.disconnect();
      this.connections.delete(name);
    }
  }

  async disconnectAll() {
    for (const [name, conn] of this.connections) {
      await conn.disconnect();
    }
    this.connections.clear();
  }

  getConnection(name) {
    return this.connections.get(name) || null;
  }

  // Get all tools across all connected servers, namespaced
  allTools() {
    const tools = [];
    for (const [serverName, conn] of this.connections) {
      if (!conn.connected) continue;
      for (const tool of conn.tools) {
        tools.push({
          name: tool.name,
          full: `${serverName}__${tool.name}`, // namespaced for disambiguation
          description: tool.description || "",
          inputSchema: tool.inputSchema || {},
          server: serverName,
          annotations: tool.annotations || {},
        });
      }
    }
    return tools;
  }

  // Route a tool call to the right server
  async callTool(fullName, args) {
    // Parse server__toolName or just toolName
    let serverName, toolName;
    if (fullName.includes("__")) {
      [serverName, toolName] = fullName.split("__", 2);
    } else {
      toolName = fullName;
      // Find which server has this tool
      for (const [name, conn] of this.connections) {
        if (conn.tools.some(t => t.name === toolName)) {
          serverName = name;
          break;
        }
      }
    }
    if (!serverName) throw new Error(`No server found for tool: ${fullName}`);
    const conn = this.connections.get(serverName);
    if (!conn || !conn.connected) throw new Error(`Server "${serverName}" not connected`);
    return conn.callTool(toolName, args);
  }

  // Get all resources across all servers
  allResources() {
    const resources = [];
    for (const [serverName, conn] of this.connections) {
      if (!conn.connected) continue;
      for (const resource of conn.resources) {
        resources.push({ ...resource, server: serverName });
      }
    }
    return resources;
  }

  // Summary of all connections
  summary() {
    const servers = [];
    for (const [name, conn] of this.connections) {
      servers.push(conn.summary());
    }
    return {
      connected: servers.filter(s => s.connected).length,
      total: servers.length,
      totalTools: servers.reduce((s, c) => s + c.tools, 0),
      totalResources: servers.reduce((s, c) => s + c.resources, 0),
      servers,
    };
  }
}

module.exports = { MCPConnection, MCPManager, jsonrpcRequest, jsonrpcNotify, PROTOCOL_VERSION };
