# SophronSwarm V3

A modular, token-optimized, multi-agent CLI for autonomous software engineering at the organization level.

**Status:** Phase 0 (skeleton) — in progress.

See [`docs/PROJECT_OVERVIEW.md`](docs/PROJECT_OVERVIEW.md) for the full architecture and [`docs/PHASE_0_DESIGN.md`](docs/PHASE_0_DESIGN.md) for the current build plan.

## Quick start (once Phase 0 is complete)

```bash
npm install
cp .env.example .env       # fill in your provider keys
npm run dev -- run echo-bot "say hello"
```

## Stack

TypeScript (strict), Node 22+, OpenAI-compatible LLM client (OpenRouter / Ollama / z.ai), better-sqlite3 checkpointer, Ink TUI (later), Next.js web UI (later).

## Project layout

```
src/
├── agent/     # declarative agent loader + the agentic loop
├── tools/     # tool dispatcher + built-in tools
├── llm/       # provider config, client, prompt builder
├── state/     # checkpointer (SQLite) + recorder (JSONL)
└── util/      # retry, tokenize, logger
agents/        # project-level agent definitions (*.md)
docs/          # design docs
```

## License

Proprietary (for now).
