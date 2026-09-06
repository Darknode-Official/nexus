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
      │
      ▼
  ┌─────────── N E X U S ───────────┐
  │                                  │
  │  Intent Router ──► classifies    │
  │       │            your request  │
  │       ▼                          │
  │  Reasoning Engine                │
  │       │  structured thinking     │
  │       ▼                          │
  │  Agentic Planner                 │
  │       │  task decomposition      │
  │       ▼                          │
  │  Multi-Agent Orchestrator        │
  │       │  fan-out / debate /      │
  │       │  pipeline / review-loop  │
  │       ▼                          │
  │  Context Engine + Knowledge Graph│
  │       │  auto-gathers relevant   │
  │       │  files, git, memories    │
  │       ▼                          │
  │  Self-Eval Engine                │
  │       │  grades output, retries  │
  │       │  if quality < threshold  │
  │       ▼                          │
  │  Engines ──► Claude / Gemini /   │
  │              Codex / OpenCode /  │
  │              Aider / Ollama /    │
  │              any OpenAI-compat   │
  │                                  │
  │  Sandbox ── safe execution with  │
  │              blocked patterns,   │
  │              audit trail         │
  │                                  │
  │  Sessions ── persistent context  │
  │              across restarts,    │
  │              auto-compression    │
  │                                  │
  │  Tools ──► read · write · edit · │
  │            run · search · find · │
  │            discover · remember   │
  │                                  │
  │  MCP ──► 25+ servers, 6 bundled  │
  │          (fetch, memory, think,  │
  │           context7, time, git)   │
  │                                  │
  │  Guards ── cost meter · /undo ·  │
  │            response cache ·      │
  │            context squeeze       │
  └──────────────────────────────────┘
```

## Core Systems

### Intent Router (`src/intent.js`)
Classifies every user message into an action category (code_edit, debug, review,
explain, run, plan, etc.) and routes it to the optimal handler — whether that's a
direct tool call, a multi-step plan, a multi-agent fan-out, or a simple chat.

### Reasoning Engine (`src/reasoning.js`)
Structured chain-of-thought for complex decisions. Four modes:
- **analyze** — observe → pattern → implications → recommendations
- **debug** — symptoms → hypotheses → investigation → root cause → fix → prevention
- **design** — requirements → constraints → options → tradeoffs → recommendation → plan
- **decide** — frame → criteria → evaluate → risks → decision → reversibility

### Agentic Planner (`src/planner.js`)
Decomposes complex goals into dependency-aware task graphs. Tasks run in topological
order, parallelizing independent branches, with automatic skip on upstream failure.

### Multi-Agent Orchestrator (`src/multi-agent.js`)
Four orchestration patterns:
- **fan-out** — N agents work N sub-tasks in parallel, results merged
- **debate** — N agents propose solutions, a judge picks the best
- **pipeline** — sequential chain, each stage feeds the next
- **review-loop** — writer + reviewer iterate until approved

### Context Engine (`src/context.js`)
Auto-gathers relevant project context before each agent turn: environment, git state,
NEXUS.md memories, keyword-matched files, open TODOs, project structure, dependencies.
Token-budgeted and priority-ranked.

### Knowledge Graph (`src/knowledge-graph.js`)
Builds a persistent graph of code entities (files, functions, classes) and their
relationships (imports, exports, calls, inherits, tests). Queries return structurally
relevant files — not keyword matching, but real dependency awareness.

### Self-Evaluation Engine (`src/eval.js`)
After completing a task, the agent evaluates its own output against quality criteria
(correctness, completeness, quality, safety, tested). Below threshold? Automatically
retries with the feedback. Closed-loop self-improvement.

### Secure Sandbox (`src/sandbox.js`)
Validates commands before execution — blocks destructive patterns (rm -rf /, fork bombs,
pipe-to-shell), warns on risky operations (sudo, git push, npm install), enforces
timeouts and output limits, maintains an audit trail.

### Session Manager (`src/sessions.js`)
Persistent conversation context across restarts. Tracks messages, tool calls, file
changes, and cost. Auto-compresses old context into semantic summaries so the agent
can resume long-running work without losing history.

### Additional Systems
- **Code Radar** — strategic codebase overview: complexity hotspots, security-sensitive code, dead code, tech debt
- **Auto Code Review** — structured multi-dimensional review (security, bugs, performance, maintainability)
- **Smart Test Generator** — analyzes code structure and generates comprehensive tests (happy path, edge cases, errors)
- **Diff Explainer** — semantic explanation of git diffs (what changed, why, impact)
- **Project Bootstrap** — complete project scaffolds with CI/CD, testing, linting, security baked in
- **Cost Saver** — context deduplication, response cache, token squeeze
- **Background Jobs** — long-running commands without blocking the agent turn
- **MCP Catalog** — 25+ MCP servers, 6 bundled by default

## Engines

| Engine | Kind | Context | Models |
|--------|------|---------|--------|
| Claude Code | Stream (rich) | 200K | opus, sonnet, haiku, fable |
| Gemini CLI | CLI (JSON) | 1M | gemini-2.5-pro, gemini-2.5-flash |
| Codex CLI | CLI (JSON) | 272K | gpt-5-codex, gpt-5, o4-mini |
| OpenCode | CLI | 200K | any configured |
| Aider | CLI | 200K | any configured |
| Ollama (local) | In-process | 8-32K | any local model |
| Any OpenAI-compat | API | varies | any (OpenRouter, Groq, DeepSeek, vLLM...) |
| Anthropic API | API | 200K | claude-* (native, in-process) |

## Quick Start

```bash
# Via sentinel-cli
sentinel nexus "fix the login bug"

# Autonomous loop
sentinel nexus --loop "refactor the auth module"

# With a specific engine
sentinel nexus --engine ollama "explain this codebase"
sentinel nexus --engine gemini "review security"
```

## License

See [LICENSE](LICENSE).
