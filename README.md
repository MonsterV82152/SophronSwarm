# SophronSwarm V3

A modular, token-optimized, multi-agent CLI for autonomous software engineering at the organization level.

**Status:** Phases 0–6 complete, milestones M1–M18 done — see [`docs/ROADMAP.md`](docs/ROADMAP.md) for the latest.

See [`docs/PROJECT_OVERVIEW.md`](docs/PROJECT_OVERVIEW.md) for the full architecture.

## Quick start (once Phase 0 is complete)

```bash
npm install
cp .env.example .env       # fill in your provider keys
npm run dev -- run echo-bot "say hello"
```

## CLI commands

```bash
# Agents
sophron                                  # launch the TUI dashboard (default)
sophron run <agent> "<task>" [--dir .] [--model <spec>]   # run one agent on a task
sophron set-model <agent> <spec> [--dir .]               # persist a model change to the agent's .md file
sophron agents [--drafts|--approve <n>...|--reject <n>...]   # list / manage drafts

# Global flags
sophron --debug ...                      # show INFO-level logs (default is warnings/errors only)

# LLM providers (config in ~/.sophron/config.json)
sophron add-provider                     # interactive: prompt for name/kind/url/key/model
sophron add-provider --name x --kind ollama --model qwen3.5:9b   # non-interactive (flags)
sophron edit-provider <name>             # edit existing (add/change an API key, etc.)
sophron edit-provider <name> --api-key '${OPENROUTER_API_KEY}'  # non-interactive edit
sophron remove-provider <name>           # remove an instance
sophron providers [name]                 # list instances (or test connectivity for one)

# Projects (registry in ~/.sophron/projects.json)
sophron projects                         # list registered projects
sophron projects remove <name|path> [-y] # unregister a project (does NOT delete files)
sophron projects rename <name> <new>     # rename a project alias
sophron projects pin|unpin <name>        # pin to the top of the list
sophron init [--template minimal] [--name x]   # scaffold a new project
```

Provider instances support an `${ENV_VAR}` reference in any string field
(baseURL, apiKey, defaultModel) that is expanded at load time, so secrets can
stay out of the config file. Tiers (`cheap`/`mid`/`frontier`/`inherit`) can be
mapped to concrete models via the `tiers` object in `config.json`.

## Stack

TypeScript (strict), Node 22+, OpenAI-compatible LLM client (OpenRouter / Ollama / z.ai), better-sqlite3 checkpointer, Ink TUI, MCP SDK. Next.js web UI deferred.

## Project layout

```
src/
├── agent/     # declarative agent loader + the agentic loop + model persistence
├── init/      # project templates + global orchestrator/architect installers
├── llm/       # provider config, client, prompt builder
├── memory/    # per-agent, shared, and checkpoint memory stores
├── mcp/       # MCP pool, catalog, cost meter, promotion
├── project/   # project registry
├── runtime/   # event recorder
├── sandbox/   # bubblewrap sandbox backend
├── services/  # lifecycle wiring
├── state/     # checkpointer (SQLite)
├── tools/     # tool dispatcher + built-in tools
├── tui/       # Ink TUI shell + components
└── util/      # retry, tokenize, logger
agents/        # project-level agent definitions (*.md)
docs/          # design docs
```

## License

Proprietary (for now).
