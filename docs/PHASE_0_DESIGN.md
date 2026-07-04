# Phase 0 — Skeleton (Technical Design)

> Goal: a minimal but real foundation that every later phase builds on. No sandbox, no delegation, no memory, no MCP yet — just the **agentic loop + tool dispatcher + declarative agent loader + LLM client + checkpointer + recorder**. By the end of Phase 0 you can: define an agent as a markdown file, load it, run its loop against any of the three providers, have it call (stub) tools, persist state to SQLite, and replay events from JSONL.

Stack: TypeScript (decided §10). V2 (Python) is the reference spec; logic ports 1:1, not the code.

---

## 0. Acceptance Criteria (definition of done)

1. `npm run dev` launches a CLI that loads every `*.md` under `agents/` and `~/.sophron/agents/`.
2. `sophron run <agent-name> "<task>"` runs an agent's agentic loop to completion against a configured provider (OpenRouter / Ollama / z.ai).
3. The agent can call stub tools (`echo`, `read_file`, `write_file`) and receive their results within the same run, in a single loop.
4. Every LLM call, tool call, and turn boundary is recorded to a timestamped JSONL file under `runs/`.
5. Every state transition is persisted to a SQLite checkpointer (`<workspace>/.sophron/checkpoint.db`) with `load`/`loadAt(seq)` working.
6. Transient errors (timeout, 429, 5xx, ECONNRESET) retry with exponential backoff; fatal errors surface cleanly.
7. Hot-reload: editing an agent `.md` file mid-session is picked up on the next run without restart.

**Not in scope for Phase 0:** real sandbox isolation, `run_command`, delegation, MCP, memory, TUI, web UI, permission prompts. Those land in later phases.

---

## 1. Project Structure (Phase 0)

```
V3/
├── package.json
├── tsconfig.json
├── .gitignore
├── .env.example                      # provider keys + base URLs
├── README.md
├── docs/
│   ├── PROJECT_OVERVIEW.md
│   └── PHASE_0_DESIGN.md             # this file
├── src/
│   ├── index.ts                      # CLI entry: parses argv, dispatches subcommands
│   ├── cli.ts                        # subcommand router (run / agents / replay)
│   ├── types.ts                      # core shared types (§2)
│   ├── config.ts                     # load .env + ~/.sophron/config.json
│   ├── agent/
│   │   ├── loader.ts                 # .md + frontmatter → AgentDefinition (§3)
│   │   ├── registry.ts               # indexed collection of loaded agents, hot-reload
│   │   └── loop.ts                   # the agentic loop (§4) — the heart
│   ├── tools/
│   │   ├── dispatcher.ts             # ToolDispatcher: name → handler, allow/deny (§5)
│   │   ├── registry.ts               # Tool registry: registers built-in + plugin tools
│   │   ├── schema.ts                 # tool-definition helpers (JSON schema → OpenAI fmt)
│   │   └── builtin/
│   │       ├── echo.ts               # trivial — proves the loop end-to-end
│   │       ├── read_file.ts          # minimal, no sandbox yet (cwd-bound)
│   │       ├── write_file.ts         # minimal, no sandbox yet
│   │       └── list_dir.ts           # minimal
│   ├── llm/
│   │   ├── client.ts                 # OpenAI-compatible client w/ retry + usage (§6)
│   │   ├── promptBuilder.ts          # volatility-ordered message assembly (§7)
│   │   └── providers.ts              # OpenRouter / Ollama / z.ai endpoint config
│   ├── state/
│   │   ├── checkpointer.ts           # better-sqlite3, WAL, append-only (§8)
│   │   └── recorder.ts               # JSONL event recorder, singleton (§9)
│   └── util/
│       ├── retry.ts                  # transient classifier + backoff (§10)
│       ├── tokenize.ts               # approximate token count (chars/3.5)
│       └── log.ts                    # structured logger (pino)
├── agents/                           # project-level agent definitions (user-authored)
│   └── .gitkeep
└── tests/
    ├── agent/loader.test.ts
    ├── tools/dispatcher.test.ts
    ├── state/checkpointer.test.ts
    └── util/retry.test.ts
```

---

## 2. Core Types (`src/types.ts`)

The foundation everything builds on. Kept minimal; later phases extend.

```typescript
// ── Agent definition (parsed from .md + frontmatter) ──────────────────────
export type PermissionMode =
  | "default"        // prompt on risky actions (Phase 0: log only)
  | "accept-edits"   // auto file edits
  | "auto"           // classifier vets each command (Phase 6)
  | "plan"           // read-only
  | "full-auto";     // sandboxed, no prompts (Phase 6)

export type ModelTier = "inherit" | "frontier" | "mid" | "cheap" | string;

export interface AgentDefinition {
  name: string;                    // unique id, lowercase-hyphenated
  description: string;             // when to delegate to this agent
  systemPrompt: string;            // markdown body
  tools?: string[];                // allowlist; undefined = inherit all
  disallowedTools?: string[];      // denylist
  model: ModelTier;                // resolved at runtime to provider model id
  permissionMode: PermissionMode;
  mcpServers?: (string | Record<string, unknown>)[];   // Phase 4
  memoryScopes?: ("per-agent" | "shared" | "task")[];  // Phase 3
  delegateAllowlist?: string[];    // which agent types it may spawn (Phase 2)
  maxTurns?: number;               // hard cap on loop iterations
  source: "project" | "user" | "builtin";  // where it was loaded from
  filePath: string;                // for hot-reload
}

// ── LLM messaging ─────────────────────────────────────────────────────────
export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;           // for role: "tool"
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };  // arguments is JSON string
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: object;            // JSON Schema
  };
}

export interface ToolResult {
  tool_call_id: string;
  content: string;
  isError?: boolean;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface LLMResponse {
  content: string | null;
  toolCalls: ToolCall[];
  usage: Usage;
  finishReason: "stop" | "tool_calls" | "length" | "content_filter";
}

// ── Agent runtime state (per run) ─────────────────────────────────────────
export interface AgentRunState {
  runId: string;                   // unique per run
  threadId: string;                // groups a run + its (future) sub-runs
  agentName: string;
  messages: LLMMessage[];          // full conversation
  turn: number;                    // current turn index
  status: "running" | "complete" | "error" | "halted";
  workingDir: string;
  tokenUsage: Usage;               // cumulative
  startedAt: number;
  seq: number;                     // checkpointer sequence number
}
```

---

## 3. Agent Loader (`src/agent/loader.ts`)

Ports V2's declarative-node concept to markdown files, à la Claude Code.

- **Parse:** use `gray-matter` to split frontmatter (YAML) from body (the system prompt).
- **Validate:** a `zod` schema enforces required fields (`name`, `description`), types, and enums. Invalid files are reported by name, not crash the loader.
- **Resolve model tier → concrete model id:** via config (e.g. `frontier` → `anthropic/claude-sonnet-4` on OpenRouter, or a z.ai model, or a local Ollama tag). The mapping lives in `~/.sophron/config.json` so it's operator-editable.
- **Scope precedence** (highest → lowest): `agents/` (project) > `~/.sophron/agents/` (user) > builtin. Same-name agents in a higher scope override lower.
- **Hot-reload:** `chokidar` watches both agent dirs; on change, the registry re-indexes and the next run uses the updated definition. (Matching Claude Code's behavior — first-time dir creation still needs a restart.)

```typescript
export async function loadAgentFile(filePath: string): Promise<AgentDefinition> {
  const raw = await fs.readFile(filePath, "utf8");
  const { data: frontmatter, content: body } = matter(raw);
  const parsed = AgentSchema.parse({
    ...frontmatter,
    systemPrompt: body.trim(),
    filePath,
  });
  return resolveModel(parsed);  // tier → concrete id
}
```

---

## 4. The Agentic Loop (`src/agent/loop.ts`) — the heart

This is the Claude Code / SwarmClaw pattern: the model decides the next action, tools execute synchronously in-turn, the agent terminates when it emits a non-tool final answer.

```typescript
export async function runAgent(
  agent:   AgentDefinition,
  task:    string,
  context: { workingDir: string; sharedMemory?: Map<string,string> }
): Promise<AgentRunState> {

  const state: AgentRunState = initRunState(agent, task, context);
  const tools = registry.toolsFor(agent);           // resolved allow/deny
  const messages = promptBuilder.build(agent, task, context);

  recorder.recordRunStart(state);
  checkpointer.save(state);

  const maxTurns = agent.maxTurns ?? DEFAULT_MAX_TURNS;

  for (state.turn = 0; state.turn < maxTurns; state.turn++) {
    recorder.recordTurnStart(state);

    // ── 1. Call the model (with transient-error retry) ────────────────────
    const response = await retryTransient(() =>
      llm.complete({ model: agent.model, messages, tools, temperature: 0 })
    );
    accumulateUsage(state, response.usage);
    recorder.recordLLMResponse(response);

    // ── 2. Terminal? ──────────────────────────────────────────────────────
    if (response.finishReason !== "tool_calls" || response.toolCalls.length === 0) {
      messages.push({ role: "assistant", content: response.content });
      state.status = "complete";
      recorder.recordTurnEnd(state);
      checkpointer.save(state);
      break;
    }

    // ── 3. Dispatch tool calls synchronously, in-turn ─────────────────────
    messages.push({
      role: "assistant",
      content: response.content,
      tool_calls: response.toolCalls,
    });

    for (const call of response.toolCalls) {
      recorder.recordToolCallStart(call);
      const result = await dispatcher.dispatch(call, agent, state);
      messages.push({ role: "tool", tool_call_id: call.id, content: result.content });
      recorder.recordToolCallResult(call, result);
    }

    checkpointer.save(state);
    recorder.recordTurnEnd(state);
  }

  if (state.status === "running") {
    state.status = "halted";       // hit maxTurns
    log.warn(`Agent ${agent.name} halted at maxTurns=${maxTurns}`);
  }

  recorder.recordRunEnd(state);
  checkpointer.save(state);
  return state;
}
```

**Key properties:**
- **Single-turn tool execution** — the #1 V2→V3 win (§6 of overview). No request→serve→act multi-iteration dance.
- **`maxTurns` cap** — infinite-loop protection (V2's `MAX_ITERATIONS`).
- **Retry only wraps the LLM call** — transient network errors retry; tool errors do NOT retry (they're returned to the model as `isError` results so it can adapt).
- **Checkpoint after every turn** — enables rewind (Phase 5).

---

## 5. Tool Dispatcher (`src/tools/dispatcher.ts`)

Maps tool name → handler, enforcing the agent's allow/deny lists and permission mode.

```typescript
export class ToolDispatcher {
  constructor(private registry: ToolRegistry, private prompts: PromptGate) {}

  async dispatch(
    call: ToolCall,
    agent: AgentDefinition,
    state: AgentRunState,
  ): Promise<ToolResult> {
    const name = call.function.name;
    let args: unknown;
    try { args = JSON.parse(call.function.arguments || "{}"); }
    catch { return error(call.id, `Invalid JSON arguments`); }

    // ── Allow/deny enforcement ─────────────────────────────────────────────
    if (agent.disallowedTools?.includes(name))
      return error(call.id, `Tool '${name}' is disallowed for this agent`);
    if (agent.tools && !agent.tools.includes(name))
      return error(call.id, `Tool '${name}' not in this agent's allowlist`);

    const handler = this.registry.get(name);
    if (!handler) return error(call.id, `Unknown tool '${name}'`);

    // ── Permission gate (Phase 0: log only; Phase 6: real prompts/classifier)
    const decision = await this.prompts.check(name, args, agent);
    if (decision === "deny") return error(call.id, `Denied by permission gate`);

    // ── Execute ────────────────────────────────────────────────────────────
    try {
      const out = await handler({ args, agent, state });
      return { tool_call_id: call.id, content: typeof out === "string" ? out : JSON.stringify(out) };
    } catch (e) {
      return error(call.id, `${(e as Error).message}`);   // surfaced to model, not fatal
    }
  }
}
```

**Built-in tools (Phase 0 — minimal, no sandbox):** `echo`, `read_file`, `write_file`, `list_dir`. These run bound to `state.workingDir` with the same path-traversal guard as V2's `WorkspaceManager` (strip leading `/`, ensure resolved path stays under root). Real isolation (`run_command`, bubblewrap) arrives in Phase 1.

---

## 6. LLM Client (`src/llm/client.ts`)

One client, three providers — all OpenAI-compatible.

```typescript
export class LLMClient {
  constructor(private config: ProviderConfig) {}

  @retryTransient                                   // decorator wraps with backoff
  async complete(req: {
    model: string;
    messages: LLMMessage[];
    tools?: ToolDefinition[];
    temperature?: number;
  }): Promise<LLMResponse> {
    const client = new OpenAI({
      apiKey:    this.config.apiKey ?? "ollama",   // ollama ignores key
      baseURL:   this.config.baseURL,
      timeout:   120_000,
      maxRetries: 0,                                // WE control retry, not the SDK
    });

    const resp = await client.chat.completions.create({
      model: req.model, messages: req.messages,
      tools: req.tools?.map(t => ({ type: "function", function: t })),
      temperature: req.temperature ?? 0,
    });

    const choice = resp.choices[0];
    return {
      content:     choice.message.content ?? null,
      toolCalls:   (choice.message.tool_calls ?? []).map(normalizeToolCall),
      usage:       { promptTokens: resp.usage!.prompt_tokens, /* ... */ },
      finishReason: mapFinishReason(choice.finish_reason),
    };
  }
}
```

**Provider config (`src/llm/providers.ts`):**
```typescript
const PROVIDERS = {
  openrouter: { baseURL: "https://openrouter.ai/api/v1",        envKey: "OPENROUTER_API_KEY" },
  ollama:     { baseURL: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1", envKey: null },
  zai:        { baseURL: "https://api.z.ai/api/coding/paas/v4", envKey: "ZAI_API_KEY" },
};
```
The agent's resolved model id carries the routing (e.g. `anthropic/claude-sonnet-4` → OpenRouter; `llama3.2:1b` → Ollama; a `z.ai/...` prefix → z.ai). `config.ts` picks the provider by prefix.

---

## 7. Prompt Builder (`src/llm/promptBuilder.ts`)

Volatility ordering for maximum prefix-cache hits — ported from V2.

```
[Position 0] system  ── base rules + agent.systemPrompt   (stable)
[Position 1] user    ── immutable task/context            (stable per task)
[Position 2] user    ── volatile turn state (turn N)      (changes every turn)
[Position 3+]        ── assistant/tool tool-call pairs    (accumulates)
```

Positions 0–1 are byte-identical across turns → provider prefix-cache matches. Only the tail grows. Phase 3 (memory) and Phase 4 (MCP) inject their blocks at the correct volatility boundary.

---

## 8. Checkpointer (`src/state/checkpointer.ts`)

Ports V2's immutable SQLite log to `better-sqlite3` (sync, WAL, fast).

```typescript
export class Checkpointer {
  private db: Database;

  constructor(dbPath = "<workspace>/.sophron/checkpoint.db") {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS checkpoints (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      state TEXT NOT NULL,          -- JSON-serialized AgentRunState
      ts INTEGER NOT NULL
    )`);
  }

  save(state: AgentRunState): number {
    const info = this.db.prepare(
      "INSERT INTO checkpoints (thread_id, run_id, state, ts) VALUES (?,?,?,?)"
    ).run(state.threadId, state.runId, JSON.stringify(state), Date.now());
    state.seq = Number(info.lastInsertRowid);
    return state.seq;
  }

  loadLatest(threadId: string): AgentRunState | null { /* … */ }
  loadAt(seq: number): AgentRunState | null { /* … */ }
}
```
All failures degrade to no-ops (logged, never crash the loop) — matches V2's `_safe_checkpoint`.

---

## 9. Recorder (`src/state/recorder.ts`)

JSONL event recorder (singleton), ported from V2. One file per run under `runs/events_<timestamp>.jsonl`. Flushed after every event for live inspection.

```typescript
type Event =
  | { type: "run_start"; runId: string; agent: string; task: string }
  | { type: "turn_start"; turn: number }
  | { type: "llm_response"; usage: Usage; finishReason: string; preview: string }
  | { type: "tool_call_start"; tool: string; args: unknown }
  | { type: "tool_call_result"; tool: string; isError: boolean; preview: string }
  | { type: "turn_end"; turn: number; cumulativeUsage: Usage }
  | { type: "run_end"; status: string; totalUsage: Usage };
```

This same JSONL feeds the Phase 5 web UI's replay view (promoted from V2's `debug_server`).

---

## 10. Retry (`src/util/retry.ts`)

Ported 1:1 from V2's `retry.py`.

```typescript
export function isTransientError(e: unknown): boolean {
  if (e instanceof APIError) {
    if (e.status === 429 || (e.status && e.status >= 500)) return true;
  }
  const msg = String((e as Error).message ?? e).toLowerCase();
  return /timeout|econnreset|socket hang up|fetch failed|connect etimedout/.test(msg);
}

export async function retryTransient<T>(fn: () => Promise<T>, opts = {
  retries: 3, baseMs: 2000, maxMs: 30000,
}): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      if (!isTransientError(e) || attempt === opts.retries) throw e;
      const delay = Math.min(opts.maxMs, opts.baseMs * 2 ** attempt) * (0.8 + Math.random() * 0.4);
      await sleep(delay);
    }
  }
  throw lastErr;
}
```
Applied to: LLM `complete()` calls. (Phase 1+: also to sandbox exec.) **Never** trip on tool errors — those return to the model.

---

## 11. Build Order (within Phase 0)

Sequence so each step is independently testable:

1. **Scaffold:** `package.json`, `tsconfig.json` (strict), `.gitignore`, `.env.example`, dir structure, logger.
2. **`util/`** — `retry.ts` (+ tests), `tokenize.ts`, `log.ts`. No deps on the rest.
3. **`state/`** — `checkpointer.ts` (+ tests), `recorder.ts`. Only depend on `types.ts`.
4. **`types.ts`** — all core types (§2).
5. **`llm/`** — `providers.ts`, `client.ts`, `promptBuilder.ts`. Depends on `types`, `util/retry`.
6. **`tools/`** — `schema.ts`, `registry.ts`, `dispatcher.ts` (+ tests), `builtin/echo.ts`.
7. **`agent/`** — `loader.ts` (+ tests), `registry.ts` (hot-reload), `loop.ts`.
8. **`cli.ts` + `index.ts`** — wire it together: `sophron run <agent> "<task>"`, `sophron agents`, `sophron replay <runId>`.
9. **End-to-end smoke test:** define `agents/echo-bot.md`, run it against Ollama, verify tool call + JSONL + checkpoint.

---

## 12. Dependencies (`package.json`)

```json
{
  "dependencies": {
    "openai":            "^4.x",    // the one LLM client (3 providers)
    "gray-matter":       "^4.x",    // .md + frontmatter parsing
    "zod":               "^3.x",    // schema validation (agent defs, tool args)
    "better-sqlite3":    "^11.x",   // checkpointer (WAL, sync)
    "chokidar":          "^4.x",    // agent-file hot-reload
    "chalk":             "^5.x",    // CLI output (Ink comes Phase 5)
    "pino":              "^9.x",    // structured logging
    "commander":         "^12.x"    // CLI argv parsing
  },
  "devDependencies": {
    "typescript":        "^5.x",
    "tsx":               "^4.x",    // dev runner (no build step during dev)
    "@types/node":       "^22.x",
    "@types/better-sqlite3": "^7.x",
    "vitest":            "^2.x"     // tests
  },
  "scripts": {
    "dev":     "tsx src/index.ts",
    "build":   "tsc",
    "start":   "node dist/index.js",
    "test":    "vitest"
  }
}
```

---

## 13. What Phase 0 Explicitly Defers

| Feature | Phase |
|---|---|
| `run_command` + sandbox isolation (bubblewrap/Rust) | **Phase 1** |
| Dangerous-command blocker | Phase 1 |
| Real patch applier (port from V2) | Phase 1 |
| Delegation (`delegate` tool, policy, concurrency) | Phase 2 |
| Per-agent + shared memory, handoff packets | Phase 3 |
| MCP lazy-loading, `mcp_tool_search` | Phase 4 |
| TUI (Ink) + web UI (Next.js) + rewind | Phase 5 |
| Auto-mode classifier + agent-creation (`propose_agent`) | Phase 6 |
| Specialization kits | Phase 7 |

The interfaces in §2 are shaped so each phase adds fields/behaviors without rewriting the core. The `ToolDispatcher`, `LLMClient`, and agentic loop are the stable spine.
