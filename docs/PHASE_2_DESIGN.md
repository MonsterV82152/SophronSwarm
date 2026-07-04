# Phase 2 — Delegation (Technical Design)

> Goal: turn the collection of independent agents into a true **multi-agent organization**. Agents gain a `delegate` tool that spawns a specialized sub-agent in its own isolated context window. The sub-agent's verbose output (file reads, build logs, search results) never inflates the parent's context — only a concise **HandoffPacket** summary returns. After Phase 2 an orchestrator agent can decompose work across a roster of specialists while keeping its own context tight.

Stack: TypeScript. Reference design: docs/PROJECT_OVERVIEW.md §4.3, SwarmClaw delegation patterns (see repo memory).

---

## 0. Acceptance Criteria

1. A `delegate` tool lets any agent spawn a named sub-agent with a specific task.
2. Sub-agent runs in a **fully isolated context window** — fresh `AgentRunState`, empty message history.  Parent's conversation never enters the sub-agent; sub-agent's tool verbosity never enters the parent.
3. Three policy guards are enforced before any delegation fires: **depth limit** (5 levels), **cycle detection** (ancestry chain), **per-agent allowlist** (`delegateAllowlist` frontmatter field).
4. A structured **HandoffPacket** — `outcome`, `summary`, `filesChanged`, `turns`, `tokenUsage` — is the only result returned to the parent's context.
5. The JSONL event recorder produces **separate files** per run: orchestrator gets its own `.jsonl`; each sub-agent gets its own. Recorder state is saved/restored on entry/exit so nested runs never corrupt the parent's log.
6. `SharedServices` (LLM client, agent registry, tool registry, dispatcher, checkpointer) are constructed once at CLI level and threaded through every tool call, eliminating redundant object creation in the delegation hot-path.
7. All Phase 0 + Phase 1 tests still pass; 20 new unit tests cover every policy rule, handoff-packet extraction, and format rendering.
8. Live demo: `orchestrator` agent delegates to `echo-bot`; two JSONL files are produced; orchestrator reports the handoff summary in ≤ 2 turns.

**Not in scope for Phase 2:** parallel fan-out (multiple delegates in one turn — Phase 2.5), memory persistence (Phase 3), MCP (Phase 4), TUI/web UI (Phase 5), auto-mode classifier (Phase 6).

---

## 1. New / Changed Files

```
src/
├── agent/
│   └── delegation.ts          # NEW — checkPolicy, buildChildCtx, buildHandoffPacket, formatHandoffPacket
├── tools/
│   └── builtin/
│       └── delegate.ts        # NEW — delegate tool handler
└── (changed)
    ├── types.ts                # + DelegationContext, HandoffPacket, AgentRunState.delegationCtx
    ├── tools/schema.ts         # + SharedServices interface, services field on ToolContext
    ├── tools/dispatcher.ts     # dispatch() accepts optional SharedServices; threads to handlers
    ├── tools/builtin/index.ts  # registers delegate tool
    ├── agent/loop.ts           # RunOptions gets delegationCtx + services; passes to dispatch; calls recorder.closeRun()
    ├── state/recorder.ts       # openForRun() pushes to a file-path stack; new closeRun() pops
    └── cli.ts                  # builds SharedServices once; passes to runAgent

agents/
└── orchestrator.md             # NEW — demo orchestrator for Phase 2
```

---

## 2. Core Types

### `DelegationContext`

Injected into every sub-agent run. Carries the information needed to enforce policy and enable debugging.

```typescript
interface DelegationContext {
  parentRunId: string;
  parentThreadId: string;
  depth: number;        // 0 = main session, 1 = first delegate, …
  ancestry: string[];   // agent names in call chain, oldest first
}
```

### `HandoffPacket`

The only artifact a sub-agent returns to its parent. Structured, concise, context-safe.

```typescript
interface HandoffPacket {
  agentName: string;
  task: string;
  status: RunStatus;
  outcome: "success" | "failure" | "halted";
  summary: string;         // sub-agent's final assistant message
  filesChanged: string[];  // inferred from write_file / apply_patch calls
  turns: number;
  tokenUsage: Usage;
  error?: string;
}
```

### `SharedServices`

Created once at CLI startup; threaded through `ToolContext` so the delegate tool can spawn sub-agents without re-constructing clients.

```typescript
interface SharedServices {
  llm: LLMClient;
  agentRegistry: AgentRegistry;
  toolRegistry: ToolRegistry;
  dispatcher: ToolDispatcher;
  checkpointer: Checkpointer;
}
```

---

## 3. Delegation Policy (`src/agent/delegation.ts`)

### `checkPolicy(targetAgentName, callerAgent, ctx)`

Three guards in priority order. First failure wins.

| Guard | Condition | Error message shape |
|---|---|---|
| **Depth limit** | `ctx.depth >= MAX_DEPTH` (5) | "Max delegation depth (5) reached." |
| **Cycle detection** | `ctx.ancestry.includes(targetAgentName)` | "Delegation cycle: … already in call chain." |
| **Allowlist** | `delegateAllowlist` set and target not in it | "Not in [caller]'s delegate allowlist." |

When `delegateAllowlist` is absent or empty, any target is permitted (no restriction by default — agents that need restriction declare it explicitly).

### `buildChildCtx(callerAgent, parentState)`

Constructs the `DelegationContext` for the sub-agent:
- `depth = parentCtx.depth + 1` (or 1 if main session)
- `ancestry = [...parentCtx.ancestry, callerAgent.name]`
- `parentRunId / parentThreadId` from parent state

### `buildHandoffPacket(state, task)`

Extracts from the completed sub-agent state:
- **Summary**: last assistant text message with no tool calls.
- **filesChanged**: scans all assistant messages for successful `write_file` / `apply_patch` calls, parses the `path` argument.
- **outcome**: `complete → "success"`, `error → "failure"`, `halted → "halted"`.

### `formatHandoffPacket(packet)`

Serialises the packet as the concise string returned to the parent:

```
[delegated: echo-bot | success | 3 turn(s) | 1200 tokens]

Summary:
I echoed "hello from phase 2" back as requested.

Files changed: src/greeting.ts
```

---

## 4. The `delegate` Tool (`src/tools/builtin/delegate.ts`)

```typescript
handler: async ({ args, agent: callerAgent, state, services }) => {
  // 1. Policy check (depth / cycle / allowlist)
  // 2. Registry lookup — fail with available names if not found
  // 3. buildChildCtx()
  // 4. runAgent({ …, delegationCtx: childCtx, services })   ← isolated context
  // 5. buildHandoffPacket() → formatHandoffPacket() → return to parent
}
```

The sub-agent inherits `workingDir`, `llm`, `dispatcher`, `checkpointer`, and `services` from the parent. It gets a **fresh `AgentRunState`** (new `runId`, new `threadId`, empty `messages`) — full context isolation.

---

## 5. Recorder Isolation (`src/state/recorder.ts`)

The module-level singleton recorder had a single `filePath`. When `openForRun()` was called for a sub-agent, it overwrote the parent's file path, causing the parent's subsequent events to land in the sub-agent's log.

**Fix:** a `fileStack` — `openForRun()` pushes the current context before overwriting; `closeRun()` (called at the end of every `runAgent()`) pops and restores.

```
openForRun(orchestratorId)  →  stack: [null]      file: orchestrator.jsonl
openForRun(subAgentId)      →  stack: [orchestrator.jsonl]  file: subagent.jsonl
… sub-agent events …
closeRun()                  →  stack: []           file: orchestrator.jsonl   ← restored
… orchestrator events …
closeRun()                  →  stack: []           file: null                 ← initial
```

This is safe for sequential delegation (Phase 2). Parallel fan-out (Phase 2.5) will require a per-run recorder instance rather than the global singleton.

---

## 6. SharedServices threading

```
CLI buildServices()
  ├── LLMClient (one OpenAI-compat client)
  ├── AgentRegistry (loaded + hot-reloading)
  ├── ToolRegistry (BUILTIN_TOOLS registered)
  ├── ToolDispatcher (wraps ToolRegistry)
  └── Checkpointer (SQLite, WAL)
          │
          ▼
    runAgent(…, services)
          │
          ▼
    dispatcher.dispatch(call, agent, state, services)
          │
          ▼
    tool handler receives ctx.services
          │ (only delegate tool uses it)
          ▼
    runAgent(sub-agent, …, services)   ← same instances, no re-construction
```

---

## 7. Frontmatter: `delegateAllowlist`

Agents declare which sub-agent types they may spawn in their definition file:

```yaml
---
name: architect
delegateAllowlist:
  - coder
  - security-reviewer
  - dependency-manager
---
```

When absent, all registered agents are reachable. This gates the blast radius of agent-created delegation chains.

---

## 8. What Phase 2 Explicitly Defers

| Feature | Phase |
|---|---|
| Parallel fan-out (`delegate` × N in one turn, join policies) | **Phase 2.5** |
| Per-agent persistent memory (`MEMORY.md`, `remember` tool) | Phase 3 |
| Shared project memory (`.sophron/shared/`) | Phase 3 |
| MCP lazy-loading + `mcp_tool_search` | Phase 4 |
| TUI (Ink) + web UI (Next.js) + rewind | Phase 5 |
| Auto-mode classifier + agent-creation (`propose_agent`) | Phase 6 |
