# Nexus

An open-source AI coding and security agent engine. Hybrid local + cloud
execution, multi-agent orchestration, adaptive per-project learning, prompt
optimization, full MCP integration, and multiple AI engines from local Ollama to
hosted Claude, GPT, and Gemini.

Ships in [`darknode-cli`](https://github.com/Darknode-Official/darknode-cli) as
`darknode nexus`.

## What Nexus Does

This describes Nexus only; it makes no claims about other tools. Each capability
is implemented in this repo (see the module tree below).

- Multi-engine: routes across local and hosted AI backends through one interface.
- Local/private AI: runs fully on-device via Ollama when nothing should leave the machine.
- Multi-agent orchestration with worktree isolation.
- Adaptive per-project learning that persists context across sessions.
- Smart model delegation (`cowork`): mechanical steps on cheaper models, hard steps on stronger ones.
- Prompt optimization.
- Full MCP client (25 servers available, 6 bundled by default).
- Knowledge graph of the codebase.
- Self-evaluation with automatic retry.
- Plugin system: custom tools, commands, hooks, intents.
- Response cache and context compaction to reduce token spend.
- Live cost meter and `/undo` checkpoints.
- Built-in security scanning.
- Git intelligence: ownership and velocity signals.
- Autonomous `/loop` with goal tracking.

## Architecture

```
┌──────────────────────────── N E X U S ────────────────────────────┐
│                                                                    │
│  INPUT LAYER                                                       │
│  ├─ Intent Router        classify → route to optimal handler       │
│  ├─ Reasoning Engine     4 structured thinking modes               │
│  └─ Adaptive Learner     gets smarter per-project over time        │
│                                                                    │
│  PLANNING LAYER                                                    │
│  ├─ Agentic Planner      dependency-aware task graphs              │
│  ├─ Workspace Intel      auto-detect stack, framework, conventions │
│  └─ Cowork Engine        delegate easy tasks to cheap/fast models  │
│                                                                    │
│  EXECUTION LAYER                                                   │
│  ├─ Multi-Agent          fan-out · debate · pipeline · review-loop │
│  ├─ Secure Sandbox       blocked patterns, warnings, audit trail   │
│  ├─ Codemod Engine       rename, update imports, extract, rollback │
│  ├─ Code Actions         docs, dead code, security scan, endpoints │
│  └─ Error Recovery       classify → retry → backoff → escalate    │
│                                                                    │
│  CONTEXT LAYER                                                     │
│  ├─ Prompt Engine        attention-optimal structuring, CoT, MCP   │
│  ├─ Context Engine       auto-gather files, git, memories, TODOs   │
│  ├─ Knowledge Graph      code entities + relationships graph       │
│  ├─ Session Manager      persist, compress, resume across restarts │
│  └─ MCP Bridge           full JSON-RPC client (2025-06-18 spec)    │
│                                                                    │
│  QUALITY LAYER                                                     │
│  ├─ Self-Eval Engine     grade output, auto-retry below threshold  │
│  ├─ Code Review (auto)   security + bugs + perf + style rules      │
│  ├─ Code Radar           complexity hotspots, tech debt map        │
│  └─ Smart Test Gen       structure-aware test generation           │
│                                                                    │
│  OPS LAYER                                                         │
│  ├─ Telemetry            duration, tokens, cost, quality tracking  │
│  ├─ Git Intelligence     ownership, velocity, merge risk, commit   │
│  ├─ Cost Saver           dedup, cache, squeeze (10-30% savings)    │
│  ├─ Background Jobs      async commands without blocking           │
│  └─ Diff Explainer       semantic diff → human explanation         │
│                                                                    │
│  EXTENSION LAYER                                                   │
│  ├─ Plugin System        custom tools, commands, hooks, intents    │
│  ├─ MCP Catalog          25+ servers, 6 bundled by default         │
│  ├─ Project Bootstrap    scaffolds with CI/CD, tests, security     │
│  └─ 8 AI Engines         Claude · Gemini · Codex · Ollama · more  │
│                                                                    │
│  61 modules · 11,860 lines · zero-dependency test suite            │
└────────────────────────────────────────────────────────────────────┘
```

## Engines

| Engine | Kind | Context | Models |
|--------|------|---------|--------|
| Claude Code | Stream (rich) | 200K | opus, sonnet, haiku, fable |
| Gemini CLI | CLI (JSON) | 1M | gemini-2.5-pro, gemini-2.5-flash |
| Codex CLI | CLI (JSON) | 272K | gpt-5-codex, gpt-5, o4-mini |
| OpenCode | CLI | 200K | any configured |
| Aider | CLI | 200K | any configured |
| Ollama (local) | In-process | 8-32K | any local model |
| Any OpenAI-compat | API | varies | OpenRouter, Groq, DeepSeek, vLLM... |
| Anthropic API | API | 200K | claude-* (native, in-process) |

## Quick Start

```bash
darknode nexus "fix the login bug"
darknode nexus --engine ollama "explain this codebase"
darknode nexus run "build a REST API with auth"
darknode nexus agents "add tests" "write docs" "fix lint"
darknode nexus --engine hybrid "refactor auth module"  # smart delegation
```

## License

See [LICENSE](LICENSE).
