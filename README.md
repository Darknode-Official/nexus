# Nexus

A terminal AI coding agent — like Claude Code, but with a hybrid **local + cloud**
engine, a live token/cost meter, `/undo` checkpoints, and an autonomous `/loop`.
Nexus edits files and runs commands to accomplish a goal, using your own models
(local Ollama, private) or a cloud engine (Claude / any OpenAI-compatible API).

This repo is the **Nexus engine**. The interactive command ships in
[`sentinel-cli`](https://github.com/Darknode-Official/sentinel-cli) as `sentinel nexus`,
which drives this engine.

## Architecture

```
You (a goal / prompt)
      |
      v
   +---------  N E X U S  ---------+
   |                              |
   |  engines ---> Ollama (local, private)                 |
   |          \--> Claude / OpenAI-compatible (cloud)      |
   |                              |
   |  tools   ---> read · write · run · search  (your files & shell)
   |                              |
   |  loop    ---> plan -> act -> observe -> repeat   (autonomous /loop)
   |                              |
   |  guards  ---> cost meter · /undo checkpoints · memory · MCP catalog
   +------------------------------+
      |
      v
   Edited files + commands, with a live token & cost readout each turn
```

Every turn runs through the engine, which picks a model (local or cloud), lets the
agent call tools against your workspace, and streams the result back with a running
cost estimate. The autonomous loop repeats plan→act→observe until the goal is met
or a round budget is hit.

## Project Structure

```
nexus/
├── src/
│   ├── engines.js       # model engines: local (Ollama) + cloud, unified streaming
│   ├── ollama.js        # local model runtime: serve, pull, chat
│   ├── tools.js         # the file/shell tools the agent can call
│   ├── loop.js          # autonomous plan->act->observe controller (/loop)
│   ├── todos.js         # task/plan tracking within a run
│   ├── memory.js        # lightweight persistent memory
│   ├── parsers.js       # tool-call / output parsing
│   ├── pricing.js       # per-model token pricing
│   ├── costsave.js      # cost meter + budget guardrails
│   ├── review.js        # self-review pass
│   ├── deps.js          # dependency awareness
│   ├── envaudit.js      # environment audit
│   ├── codestats.js     # codebase stats for context
│   ├── changelog.js     # changelog generation
│   ├── bgjobs.js        # background job tracking
│   └── mcp-catalog.js   # Model Context Protocol server catalog
├── package.json
├── LICENSE
└── README.md
```

## Engines

Nexus is engine-agnostic. Set one and go:

```
# local, private — no cloud, no key
nexus --engine ollama

# cloud — strongest models
nexus --engine claude       # needs the Claude Code CLI logged in
nexus --engine api          # any OpenAI-compatible endpoint + key
```

## Status

Active. Nexus is the AI layer of the Sentinel toolkit; the engine here is the same
one that powers `sentinel nexus` in the CLI.

## Security

Nexus runs commands and edits files on your machine. Run it only in workspaces you
control, review what the autonomous loop proposes, and prefer the local `ollama`
engine when working with sensitive code so nothing leaves your box.

## License

See `LICENSE`.
