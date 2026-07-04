# Phase 0 — Skeleton (Completion Record)

> Status: **✅ COMPLETE** — 2026-07-04
> Acceptance criteria: all 7 met. Tests: 34/34 passing. Clean `tsc`.
> Live smoke test: ran end-to-end against `ollama:qwen3.5:9b-thinking`.
> Design doc: [`PHASE_0_DESIGN.md`](./PHASE_0_DESIGN.md)

This file records what was actually built, deviations from the design, and
gotchas discovered — the reference for anyone picking up the codebase.

---

## What was built

```
src/
├── index.ts                  # CLI entry (commander)
├── cli.ts                    # subcommands: run / agents / replay
├── types.ts                  # AgentDefinition, AgentRunState, LLMMessage, ToolCall/Result, Usage
├── util/
│   ├── log.ts                # pino logger (pretty in dev, JSON in prod)
│   ├── tokenize.ts           # approxTokens (chars/3.5)
│   └── retry.ts              # isTransientError + retryTransient (ported from V2)
├── state/
│   ├── checkpointer.ts       # better-sqlite3, WAL, append-only, save/loadLatest/loadAt/loadThread
│   └── recorder.ts           # JSONL singleton, typed events
├── llm/
│   ├── providers.ts          # OpenRouter / Ollama / z.ai config + tier→id resolution
│   ├── client.ts             # one OpenAI-compatible client, retry-controlled
│   └── promptBuilder.ts      # volatility-ordered message assembly
├── tools/
│   ├── schema.ts             # ToolSpec / ToolContext / toToolDefinition
│   ├── registry.ts           # ToolRegistry + definitionsFor (allow/deny filter)
│   ├── dispatcher.ts         # ToolDispatcher + PermissionGate (stub) + DefaultPermissionGate
│   └── builtin/
│       ├── paths.ts          # safeResolve (path-traversal guard)
│       ├── echo.ts  read_file.ts  write_file.ts  list_dir.ts   (in index.ts)
└── agent/
    ├── loader.ts             # gray-matter + zod; resolves model tier ONCE
    ├── registry.ts           # AgentRegistry + chokidar hot-reload + 12-agent soft cap
    └── loop.ts               # the agentic loop (the heart)

tests/  → util/retry, state/checkpointer, tools/dispatcher, agent/loader   (34 tests)
agents/ → echo-bot.md         # sample agent
scripts/ → verify-checkpoints.ts, list-checkpoints.ts   # debugging helpers
```

## Deviations from the design (and why)

1. **Model resolution happens ONCE at load time, not per-call.**
   The design had `LLMClient.complete()` re-resolve the model each turn via
   `resolveModel(req.model)`. In practice the agent's `model` field is already a
   *concrete* id (e.g. `qwen3.5:9b-thinking`) with no provider prefix, so
   re-resolving a bare id fails. Fix: the loader resolves tier → `(provider,
   model)` once and stores **both** on `AgentDefinition`. The client trusts
   `agent.provider` and never re-resolves. (See repo memory gotchas.)

2. **`AgentDefinition.provider` field added.** Not in the original `types.ts`;
   added to carry the resolved provider alongside `model`.

3. **No `src/config.ts`.** Provider config is loaded lazily inside
   `llm/providers.ts` (reads `~/.sophron/config.json` + env vars on demand).
   A standalone `config.ts` would have been dead weight at this size.

4. **Permission gate is a stub class, not an interface-only contract.**
   `DefaultPermissionGate` always returns `"allow"` (Phase 6 replaces it with
   the auto-mode classifier). Kept as a real class so the dispatcher has a
   working default out of the box.

## Gotchas (recorded in repo memory)

- **Checkpoints are keyed by `threadId`, not `runId`.** Both are UUIDs.
  `replay` takes a runId (matches the JSONL filename); checkpoint queries need
  the threadId. Phase 5's UI must surface this distinction.
- **Test env must set `OLLAMA_DEFAULT_MODEL`** so `model: inherit` resolves in
  unit tests.
- **OpenAI SDK tools need a cast:** `tools as unknown as ChatCompletionTool[]`
  (its `FunctionParameters` type rejects bare `object`).
- **chokidar:** `import chokidar, { type FSWatcher }` — `FSWatcher` is a named
  export, not a `chokidar.FSWatcher` namespace.
- **pino overload pitfall:** `log.debug(string, value)` doesn't typecheck; use
  `log.debug({ key: value }, "msg")`.

## Live smoke test (proof it works)

```
$ npm run dev -- run echo-bot "please echo the text: hello world from sophron"
... Agent result  [complete, 2 turn(s), 1748 tokens]
Echoed "hello world from sophron" successfully!

$ npm run dev -- replay <runId>
▶ run_start agent=echo-bot
  ─ turn 0
  ◆ llm t0 finish=tool_calls calls=1 tokens=866
    → echo {"text":"hello world from sophron"}
  ─ turn 1
  ◆ llm t1 finish=stop calls=0 tokens=882
■ run_end status=complete tokens=1748
```

SQLite checkpointer stored **4 snapshots** for the run (initial, post-turn-0,
post-turn-1, run_end). JSONL recorder wrote every event, flush-per-event.

## Phase 0 → Phase 1 handoff

The stable spine that Phase 1 builds on (and must not break):
- `ToolDispatcher` + `ToolRegistry` — Phase 1 adds `run_command` + `apply_patch`
  as new `ToolSpec`s; the dispatcher/permission-gate contract is unchanged.
- `AgentDefinition.permissionMode` — Phase 1 makes `run_command` honor it
  (`plan` denies; `default`/`accept-edits` route through the blocker;
  `full-auto` is sandboxed).
- `safeResolve()` path guard — Phase 1 reuses it for sandbox workspace binding.
- The agentic loop — unchanged; Phase 1 only adds tools.
