# Phase 2 — Delegation (Completion Record)

> Status: **✅ COMPLETE** — 2026-07-04
> Acceptance criteria: all 8 met. Tests: 126/126 passing (20 new). Clean `tsc`.
> Live demo: `orchestrator` delegated to `echo-bot`; 2 separate JSONL files produced; 2-turn parent.
> Design doc: [`PHASE_2_DESIGN.md`](./PHASE_2_DESIGN.md)

---

## What was built

```
src/
├── agent/
│   └── delegation.ts       # checkPolicy + buildChildCtx + buildHandoffPacket + formatHandoffPacket
├── tools/
│   └── builtin/
│       └── delegate.ts     # delegate tool handler (policy → registry → runAgent → handoff)
└── (changed)
    ├── types.ts             # DelegationContext, HandoffPacket, AgentRunState.delegationCtx
    ├── tools/schema.ts      # SharedServices interface; services: SharedServices on ToolContext
    ├── tools/dispatcher.ts  # dispatch() optional services param; threads to spec.handler
    ├── tools/builtin/index.ts  # registers delegate tool (7 tools total)
    ├── agent/loop.ts        # RunOptions.delegationCtx + .services; initRunState carries ctx;
    │                        # dispatcher.dispatch passes services; finally: recorder.closeRun()
    ├── state/recorder.ts    # fileStack: push on openForRun, pop on closeRun (nested isolation)
    └── cli.ts               # buildServices() constructs SharedServices once per CLI invocation

agents/
└── orchestrator.md          # demo orchestrator agent
```

**Tests:** `tests/agent/delegation.test.ts` — 20 unit tests.

---

## Acceptance criteria — all met

1. ✅ `delegate` tool spawns a named sub-agent with a task description.
2. ✅ Sub-agent runs in isolated context (fresh `AgentRunState`, empty `messages`). Parent context never enters sub-agent; sub-agent verbosity never enters parent.
3. ✅ Policy guards: depth limit (5), cycle detection (ancestry), per-agent allowlist.
4. ✅ `HandoffPacket` is the only artifact returned: `outcome`, `summary`, `filesChanged`, `turns`, `tokenUsage`.
5. ✅ Separate JSONL per run — recorder `fileStack` save/restore ensures parent log is never corrupted by sub-agent.
6. ✅ `SharedServices` built once at CLI level, threaded through `ToolContext` to every tool handler.
7. ✅ All 106 Phase 0+1 tests still pass; 20 new delegation tests added.
8. ✅ Live demo confirmed (see below).

---

## Live demo proof

```
$ sophron run orchestrator "use the delegate tool to send echo-bot the message: hello from phase 2"

[delegating → echo-bot | depth=1 | ancestry=[orchestrator]]

   echo-bot (isolated context):
     turn 0: echo({ text: "hello from phase 2" }) → "hello from phase 2"
     turn 1: final answer

[delegation complete → echo-bot | success | 2 turns | ~800 tokens]

Agent result [complete, 2 turn(s), 1998 tokens]
"I delegated the message 'hello from phase 2' to the echo-bot agent, which
confirmed that it successfully echoed back exactly what was sent."

New JSONL files: 2  ← parent orchestrator.jsonl + sub-agent echo-bot.jsonl
```

**Context isolation confirmed:** orchestrator's 2-turn context never saw echo-bot's tool calls. Only the handoff summary entered the parent's messages.

---

## Design deviations from the spec

1. **`delegate` lives in `src/tools/builtin/delegate.ts`**, not `src/agent/`. It imports `runAgent` from `../../agent/loop.js` — the import chain is clean; this placement keeps all built-in tools co-located.

2. **`services` is optional (`?`) in `dispatcher.dispatch()`** to preserve backward compatibility with Phase 0/1 tests that don't pass services. The non-null assertion (`services!`) is used when passing to handlers — safe because the loop always provides services for real runs.

3. **No concurrent fan-out.** The dispatch loop remains sequential (`for … await`). Multiple `delegate` calls in one response execute one at a time. This is correct for Phase 2; parallel fan-out is Phase 2.5.

---

## Gotchas discovered (recorded for Phase 3+)

1. **Recorder singleton + recursive `runAgent`**: when a sub-agent called `openForRun()`, it silently overwrote the parent's JSONL path. The fix (file-path stack with save/restore in `closeRun()`) is correct for sequential delegation. **Phase 2.5 parallel fan-out** will require each sub-agent to own its own `Recorder` instance — the singleton pattern won't scale.

2. **`delegateAllowlist: []` means no restriction.** An empty array is treated as "no list configured" (any target allowed), not "nothing allowed". This matches the principle of least surprise — operators who want to lock down an agent declare the targets explicitly.

3. **Model verbosity under delegation**: on qwen3.5:9b-thinking, the orchestrator sometimes uses all `maxTurns` on internal reasoning without calling `delegate`. For reliable delegation demos, the task prompt must be explicit: "use the delegate tool to…". Production orchestrators should have focused system prompts with low `maxTurns`.

4. **`filesChanged` extraction is heuristic**: scanned from assistant tool-call messages for `write_file` + `apply_patch`. It can miss files created via `run_command` (e.g. `touch foo.ts`). Phase 3 memory will add a more reliable tracking mechanism.

---

## Phase 2 → Phase 3 handoff

Stable contracts Phase 3 builds on:
- **`HandoffPacket`** — Phase 3 memory's `remember` tool will write packet summaries to `.sophron/shared/`.
- **`DelegationContext`** — Phase 3 can use `ancestry` to route memory writes to the right per-agent store.
- **`SharedServices`** — Phase 3 adds `sharedMemoryStore` and `agentMemoryStore` to this object; the loop's prompt builder injects them into every agent's system prompt.
- **`ToolContext.services`** — the `remember` tool will use `services` to write to the memory stores without creating new instances.
