"use strict";
// ================= Plugin System — extend Nexus with custom tools, commands, and hooks =================
// Users can drop .js files into .nexus/plugins/ and they become part of the agent's
// capability set. Plugins can add tools, slash commands, pre/post hooks on actions,
// custom intents, and AI prompt templates. Hot-reloaded on change.

const fs = require("fs");
const path = require("path");

const PLUGINS_DIR = ".nexus/plugins";

// ---- Plugin contract ----
// A plugin exports: { name, version, tools?, commands?, hooks?, intents?, templates? }
//   tools:     [{ name, description, fn(input, ctx) -> result }]
//   commands:  [{ name, description, fn(args, ctx) -> result }]
//   hooks:     { beforeAction?, afterAction?, onError?, onComplete? }
//   intents:   [{ id, keywords, handler, description }]
//   templates: { [name]: promptTemplate }

function loadPlugin(filePath) {
  try {
    // Clear require cache for hot reload
    delete require.cache[require.resolve(filePath)];
    const mod = require(filePath);
    if (!mod.name) mod.name = path.basename(filePath, ".js");
    if (!mod.version) mod.version = "0.0.0";
    return { plugin: mod, error: null, path: filePath };
  } catch (e) {
    return { plugin: null, error: e.message, path: filePath };
  }
}

function loadAllPlugins(cwd) {
  const dir = path.join(cwd, PLUGINS_DIR);
  const loaded = [];
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith(".js"));
    for (const f of files) {
      loaded.push(loadPlugin(path.join(dir, f)));
    }
  } catch (_) {}
  return loaded;
}

// ---- Plugin registry ----

function createRegistry() {
  const registry = {
    plugins: [],
    tools: [],
    commands: [],
    hooks: { beforeAction: [], afterAction: [], onError: [], onComplete: [] },
    intents: [],
    templates: {},
  };

  function register(loaded) {
    for (const entry of loaded) {
      if (!entry.plugin) continue;
      const p = entry.plugin;
      registry.plugins.push({ name: p.name, version: p.version, path: entry.path });

      if (p.tools) {
        for (const tool of p.tools) {
          registry.tools.push({ ...tool, plugin: p.name });
        }
      }
      if (p.commands) {
        for (const cmd of p.commands) {
          registry.commands.push({ ...cmd, plugin: p.name });
        }
      }
      if (p.hooks) {
        for (const [event, fn] of Object.entries(p.hooks)) {
          if (registry.hooks[event] && typeof fn === "function") {
            registry.hooks[event].push({ fn, plugin: p.name });
          }
        }
      }
      if (p.intents) {
        for (const intent of p.intents) {
          registry.intents.push({ ...intent, plugin: p.name });
        }
      }
      if (p.templates) {
        for (const [name, template] of Object.entries(p.templates)) {
          registry.templates[name] = { template, plugin: p.name };
        }
      }
    }
  }

  async function runHook(event, data) {
    const hooks = registry.hooks[event] || [];
    let result = data;
    for (const { fn, plugin } of hooks) {
      try { result = (await fn(result)) || result; }
      catch (e) { console.error(`Plugin ${plugin} hook ${event} error:`, e.message); }
    }
    return result;
  }

  function findTool(name) {
    return registry.tools.find(t => t.name === name);
  }

  function findCommand(name) {
    return registry.commands.find(c => c.name === name);
  }

  function summary() {
    return {
      plugins: registry.plugins.length,
      tools: registry.tools.length,
      commands: registry.commands.length,
      hooks: Object.entries(registry.hooks).reduce((s, [k, v]) => s + v.length, 0),
      intents: registry.intents.length,
      templates: Object.keys(registry.templates).length,
      details: registry.plugins.map(p => `${p.name}@${p.version}`),
    };
  }

  return { register, runHook, findTool, findCommand, summary, registry };
}

// ---- Plugin scaffold ----

function scaffoldPlugin(cwd, name) {
  const dir = path.join(cwd, PLUGINS_DIR);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  const file = path.join(dir, name + ".js");
  const content = `"use strict";
// Nexus Plugin: ${name}
// Drop this file in .nexus/plugins/ — it's auto-loaded on every session.

module.exports = {
  name: "${name}",
  version: "1.0.0",

  // Custom tools the agent can use
  tools: [
    {
      name: "${name}_example",
      description: "An example tool from the ${name} plugin",
      fn: async (input, ctx) => {
        return { result: "Hello from ${name}!", input };
      },
    },
  ],

  // Slash commands for the user
  commands: [
    {
      name: "${name}",
      description: "Run the ${name} plugin",
      fn: async (args, ctx) => {
        return "Plugin ${name} executed with args: " + args;
      },
    },
  ],

  // Lifecycle hooks
  hooks: {
    // beforeAction: async (data) => { /* modify data before agent acts */ return data; },
    // afterAction: async (result) => { /* post-process agent output */ return result; },
    // onError: async (error) => { /* custom error handling */ },
  },
};
`;
  fs.writeFileSync(file, content);
  return file;
}

module.exports = { loadPlugin, loadAllPlugins, createRegistry, scaffoldPlugin };
