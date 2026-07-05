# Phase 3 — Memory (Completion Record)

> Status: **✅ COMPLETE** — 2026-07-05
> Acceptance criteria: all met. Tests: 200/200 passing (74 new). Clean `tsc`.
> Live demo: `rememberer` agent recorded a gotcha in run 1, recalled it verbatim in runs 2 & 3.
> Spec: [`PROJECT_OVERVIEW.md`](./PROJECT_OVERVIEW.md) §5.2/§5.3, [`AGENT_CONTEXT.md`](./AGENT_CONTEXT.md) §5.

---

## What was built

```
src/
├── memory/                        # NEW — the three-tier memory layer
│   ├── sections.ts                # ## -section parse/serialize/edit + dedup helpers
│   ├── sharedStore.ts             # .sophron/shared/*.md (file + section level)
│   ├── agentStore.ts              # .sophron/memory/<id>/MEMORY.md (quality-gated append)
│   └── checkpoints.ts             # parseCheckpoints + CheckpointManager.advance()
├── tools/
│   └── builtin/
│       ├── remember.ts            # NEW — write to per-agent or shared memory
│       └── advance_checkpoint.ts  # NEW — mark current milestone done, advance
└── (changed)
    ├── tools/schema.ts            # SharedServices += sharedMemoryStore + agentMemoryStore
    ├── tools/builtin/index.ts     # registers remember + advance_checkpoint (9 tools total)
    ├── tools/builtin/delegate.ts  # persists handoff packet to .sophron/shared/HANDOFFS.md
    ├── llm/promptBuilder.ts       # BuildContext.agentMemory; injects per-agent + shared
    ├── agent/loop.ts              # pulls memory from services, passes to PromptBuilder
    └── cli.ts                     # buildServices constructs the two stores

agents/
└── rememberer.md                  # demo agent: record a gotcha, recall it next run

tests/
├── memory/                        # NEW — 61 tests
│   ├── sections.test.ts           (20)
│   ├── sharedStore.test.ts        (13)
│   ├── agentStore.test.ts         (14)
│   └── checkpoints.test.ts        (14)
├── tools/memoryTools.test.ts      (8)   — remember + advance_checkpoint tools
└── llm/promptBuilderMemory.test.ts (5)  — injection + cross-run proof
```

**74 new tests across 6 new files; all 126 prior tests still pass (200 total).**

---

## Acceptance criteria — all met

1. ✅ **Per-agent memory** — `.sophron/memory/<agent_id>/MEMORY.md` with three structured sections (Past Points of Failure, Past Encountered Issues, Key Points). First ~200 lines auto-injected.
2. ✅ **Writes via `remember` tool** — agent calls deliberately; quality-gated (min length) + exact-duplicate dedup. NOT auto-dumped.
3. ✅ **Shared memory** — plain markdown under `.sophron/shared/` (OVERVIEW.md, CHECKPOINTS.md, CURRENT_CHECKPOINT.md, HANDOFFS.md). Diffs in git, operator-editable.
4. ✅ **Current checkpoint as a file** — `CURRENT_CHECKPOINT.md` in shared memory (not checkpointer state). Orchestrator advances it via the `advance_checkpoint` tool.
5. ✅ **Auto-injection** — prompt builder injects both per-agent memory ("YOUR PAST MEMORY") and shared memory ("SHARED PROJECT CONTEXT") into every agent's system prompt at the stable prefix boundary.
6. ✅ **Handoff packets → shared memory** — completed delegations append a concise record to `.sophron/shared/HANDOFFS.md` (capped at 20 entries) so the next agent picks up what was done.
7. ✅ **Task memory stays ephemeral** — sub-agent transcripts die with the task; only promoted notes/handoffs survive (unchanged from Phase 2 isolation).
8. ✅ **Demo agent remembers across two separate runs** — `rememberer` recorded a gotcha in run 1, recalled it verbatim in runs 2 & 3 without re-recording (live demo below).
9. ✅ All 126 Phase 0–2 tests still pass; 74 new memory tests added.

---

## Live demo proof (cross-run persistence)

**Run 1 — record a gotcha:**
```
$ sophron run rememberer "Use the remember tool to record this sandbox gotcha: \
    bubblewrap masks workspaces under /tmp, so use --bind-try /tmp /tmp."

Agent result  [complete, 2 turn(s), 2417 tokens]
Gotcha recorded: bubblewrap masks workspaces under /tmp, so use --bind-try /tmp /tmp.
```
On disk after run 1:
```
$ cat .sophron/memory/rememberer/MEMORY.md
## Past Points of Failure

- [2026-07-05] bubblewrap masks workspaces under /tmp, so use --bind-try /tmp /tmp
  to properly bind mount the workspace.
```

**Run 2 — recall (fresh process, same workspace):**
```
$ sophron run rememberer "Do you already know any sandbox gotchas? Quote it and stop."

Agent result  [complete, 1 turn(s), 1229 tokens]
Yes, I recall this sandbox gotcha from my past memory: "bubblewrap masks workspaces
under /tmp, so use --bind-try /tmp /tmp to properly bind mount the workspace."
```

Run 2 used only 1 turn (no `remember` call) — the lesson was auto-injected into the system prompt from disk. The prompt-token count rose (~1053 vs ~1115) because of the injected memory block, exactly as designed.

---

## Memory tiers (as implemented)

| Tier | Location | Lifetime | Injection | Write path |
|---|---|---|---|---|
| **Per-agent** | `.sophron/memory/<id>/MEMORY.md` | across sessions | first 200 lines → system prompt | `remember` tool (scope: per-agent) |
| **Shared** | `.sophron/shared/*.md` | across sessions, all agents | full file → system prompt | `remember` tool (scope: shared) + `advance_checkpoint` + handoff auto-persist |
| **Task** | (sub-agent transcript) | dies with the task | none | promote via `remember` or handoff packet |

**Deferred (per §5 of AGENT_CONTEXT.md):** vector DB / embeddings (only when volume justifies), full reflection consolidation cycles (Phase 3.5), memory browser UI (Phase 5).

---

## Design decisions & deviations

1. **Section utilities shared by both stores.** `src/memory/sections.ts` provides `## `-section parse/serialize/edit + dedup helpers used by both `SharedMemoryStore` and `AgentMemoryStore`. One parser, consistent behavior.

2. **Section bodies are trimmed (leading + trailing newlines stripped) on parse.** This keeps `readSection` returning clean content and makes dedup reliable (splitting on `\n` doesn't yield phantom leading-empty entries).

3. **`remember` accepts friendly aliases.** Per-agent sections: `failure`/`issue`/`key-point` (and full names). Shared files: `overview`/`checkpoints`/`current-checkpoint`. Reduces model formatting errors.

4. **`memoryScopes` undefined ⇒ both scopes allowed.** An agent that doesn't declare `memoryScopes` defaults to full read/write of both per-agent and shared. Declaring the array restricts it (least-surprise).

5. **Quality gate: MIN_NOTE_LENGTH = 10 (normalized chars).** Trivially short notes are rejected with a reason returned to the model. Exact-duplicate dedup is substring-based so a short restatement of an existing note is caught.

6. **Handoff packets cap at 20 entries.** `persistHandoffToShared` trims the oldest entries when over the cap so `HANDOFFS.md` doesn't grow unbounded.

7. **`advance()` resolves the current milestone within a SINGLE milestones array.** Earlier draft called `this.current()` (which re-parses into a second array), so `cur.done = true` mutated the wrong object and the done-state never reached disk. Fixed by finding the current milestone by title within the same array that gets serialized.

---

## Gotchas discovered (recorded for Phase 4+)

1. **Per-agent memory injection is prefix-stable within a session but NOT across turns that append.** The 200-line injection snapshot is taken once at run start (in `runAgent`). A `remember` call mid-run writes to disk but won't appear in the prompt until the NEXT run. This matches the design intent (memory is for future sessions, not the current one) — but is worth documenting.

2. **`fileToTitle` must lowercase before title-casing.** `OVERVIEW.md` → `Overview` requires `.toLowerCase()` before the `\b\w` replace, or you get `OVERVIEW` unchanged (the `\b\w` regex only lowercases if the first char is already lowercase-eligible — uppercase input stays uppercase).

3. **Mutation across two parsed arrays is a silent bug.** When a method parses a document twice (once for `list`, once for `current`), mutating an object from one array doesn't affect the other. Always operate on a single parse result when you intend to mutate + serialize.

4. **`tsx -e` breaks on `.js` import extensions.** Inline ESM scripts with explicit `.js` extensions fail to resolve under `tsx -e`. Use a `.ts` file on disk instead for one-off debugging.

---

## Phase 3 → Phase 4 handoff

**Stable contracts Phase 4 (MCP) builds on:**
- **`SharedServices`** is now the single DI object — Phase 4 adds `mcpRegistry` / `mcpConnectionPool` here; no new wiring pattern needed.
- **`ToolSpec` + `ToolRegistry`** — Phase 4's lazy-loaded MCP tools register as `ToolSpec`s (sourced from `mcp_tool_search` promotions). The dispatcher already handles allow/deny + permission gating.
- **Token-cost awareness** — Phase 4's per-tool cost meter can reuse `util/tokenize.ts`'s `approxTokens` (chars/3.5) to estimate MCP tool-schema cost before promotion.
- **Prompt builder** — the `BASE_SYSTEM_RULES` block is the natural place to advertise the `mcp_tool_search` meta-tool (one line) without bloating the prefix.

**What Phase 4 explicitly needs (not yet built):** MCP server config, connection pool, `mcp_tool_search` meta-tool, token-cost meter UI. The memory stores are orthogonal to MCP and won't be touched.
