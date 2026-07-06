# Phase 4 — MCP (Completion Record)

> Status: **✅ COMPLETE** — 2026-07-05
> Acceptance criteria: all met. Tests: 262/262 passing (62 new). Clean `tsc`.
> Live demo: `mcp-explorer` agent searched → promoted → called a real stdio MCP server tool (15+27=42).
> Design: [`PHASE_4_DESIGN.md`](./PHASE_4_DESIGN.md)
> Spec: [`PROJECT_OVERVIEW.md`](./PROJECT_OVERVIEW.md) §5.1b (MCP Access), §6 #3 (token optimization)

---

## What was built

```
src/
├── mcp/                           # NEW — the lazy MCP loader (Phase 4)
│   ├── config.ts                  # McpServerConfig + loadGlobalConfig + resolveAgentServers
│   ├── pool.ts                    # McpConnectionPool — one Client per server, kept alive
│   ├── catalog.ts                 # McpToolCatalog — index + keyword search
│   ├── costMeter.ts               # TokenCostMeter — per-tool cost estimate + cumulative tracking
│   └── promotion.ts               # promoteTool (catalog→ToolSpec), mcpToolId, flattenMcpResult
├── tools/
│   └── builtin/
│       └── mcp_tool_search.ts     # NEW — the single lazy-loading meta-tool
└── (changed)
    ├── types.ts                   # AgentRunState.mcpTools (per-run promoted tools)
    ├── tools/schema.ts            # SharedServices += mcpPool + mcpCatalog + mcpCostMeter
    ├── tools/builtin/index.ts     # registers mcp_tool_search (10 tools total)
    ├── tools/dispatcher.ts        # isMcpTool exemption from allowlist; resolves from state.mcpTools
    ├── agent/loop.ts              # merges mcpTools into per-turn defs; prePromoteAlwaysExpose
    └── cli.ts                     # buildServices constructs MCP services; closeAll on exit

agents/
└── mcp-explorer.md                # demo agent: search → promote → call math MCP server

tests/
├── mcp/                           # NEW — 56 unit + 6 live tests
│   ├── config.test.ts             (20)
│   ├── costMeter.test.ts          (10)
│   ├── catalog.test.ts            (11)
│   ├── promotion.test.ts          (15)
│   └── pool.live.test.ts          (6, live)
└── fixtures/
    └── math-mcp-server.js         # in-repo stdio MCP server (add/multiply tools)
```

**62 new tests across 5 files; all 200 prior tests still pass (262 total).**

---

## Acceptance criteria — all met

1. ✅ **Lazy by default** — agents get a single `mcp_tool_search` meta-tool; MCP tools are promoted only when the agent asks. Nothing is bound up front (unless `alwaysExpose: true`).
2. ✅ **Per-agent scoping** — `agent.mcpServers` frontmatter resolves against `.sophron/mcp.json`; an agent can only connect to servers it declares.
3. ✅ **Connection pool** — `McpConnectionPool` keeps one `Client` per server alive across turns (verified: `openCount` stays 1 across repeated calls).
4. ✅ **Keyword search** — `McpToolCatalog.search` ranks tools by query-term matches (name ×2, desc ×1), returns top N, handles pagination transparently.
5. ✅ **Token-cost meter** — `TokenCostMeter` estimates per-tool cost (`chars/3.5`), tracks cumulative promoted-tool cost, warns when over budget.
6. ✅ **Promotion → ToolSpec** — `promoteTool` builds a namespaced `mcp__<server>__<tool>` ToolSpec that routes through the pool and flattens the result.
7. ✅ **Per-run isolation** — promoted tools live on `state.mcpTools`; a parent's promotions never leak into a child (consistent with Phase 2 context isolation).
8. ✅ **`alwaysExpose` opt-in** — eager servers pre-promote at run start (`prePromoteAlwaysExpose`).
9. ✅ All 200 Phase 0–3 tests still pass; 62 new MCP tests added.
10. ✅ Live demo against a real stdio MCP server (see below).

---

## Live demo proof (full search → promote → call path)

```
$ sophron run mcp-explorer "Use mcp_tool_search to find an addition tool, \
    then use it to compute 15 + 27." --dir <workspace with .sophron/mcp.json>

turn 0: mcp_tool_search({ query: "add numbers", limit: 3 })
        → "Enabled 2 MCP tool(s) for 'add numbers'. You can now call them.
           - mcp__math__add — Add two numbers (~40t/turn)
           - mcp__math__multiply — Multiply two numbers (~44t/turn)
           Cumulative MCP tool cost: ~84 tokens/turn."

turn 1: mcp__math__add({ a: 15, b: 27 })
        → "42"
```

The agent started with **zero** math tools. It searched once, promoted 2 tools (~84 tokens/turn), and called one. A 40-tool server bound every turn would cost ~3–5k tokens/turn — **Phase 4 cuts that to ~84 tokens/turn** for the 2 tools actually needed (a ~98% reduction for that server).

---

## How SwarmClaw's patterns map to V3

| SwarmClaw pattern (researched) | V3 implementation |
|---|---|
| `alwaysExpose: false` default + `mcp_tool_search` meta-tool | `mcp_tool_search.ts` — the only MCP tool exposed by default |
| Per-tool token-cost meter (`chars/3.5`) | `TokenCostMeter` — estimates + cumulative + budget warning |
| Long-lived per-server connection pool | `McpConnectionPool` — one `Client` per server, lazy connect |
| MCP scoped per-agent (`mcpServers` frontmatter) | `resolveAgentServers` + `agentServerNames` in the search tool |
| Subagent context isolation (verbose output stays out) | Phase 2 HandoffPacket (unchanged); promoted tools are per-run on `state.mcpTools` |
| Accuracy: rich tool descriptions + annotations | Promoted ToolSpec preserves the MCP tool's `description` + `inputSchema` verbatim |

**Research notes:** SwarmClaw's repo wasn't directly searchable, but its patterns are documented in `PROJECT_OVERVIEW.md` §3 and were confirmed against the official MCP spec + TypeScript SDK (v1.29.0). The SDK's `Client.listTools()` (with pagination via `nextCursor`) and `Client.callTool()` map cleanly to the catalog + promotion design.

---

## Design decisions & deviations

1. **Keyword search, not embeddings.** Same discipline as Phase 3 memory: keyword matching (tokenize query → score by name×2 + desc×1) is good enough for v1 and adds zero dependencies. Embedding-based semantic search is deferred until tool volume justifies it.

2. **Per-run promoted-tool overlay, not global registry mutation.** Promoted MCP tools live on `state.mcpTools` (per-run), NOT in the global `ToolRegistry`. This guarantees Phase 2's context isolation holds: a parent agent's MCP promotions never leak into a sub-agent's tool set. The loop merges `state.mcpTools` into the per-turn definitions; the dispatcher resolves MCP handlers from `state.mcpTools`.

3. **MCP tools are exempt from the static allowlist.** An agent's `tools` allowlist gates *built-in* tools. MCP tools are gated by `mcp_tool_search` (the agent must search to enable them). Exempting `mcp__*` names from the allowlist check (`isMcpTool`) avoids forcing operators to pre-declare every possible MCP tool name.

4. **`alwaysExpose` is the rare opt-in.** The default is lazy. Eager exposure pre-promotes at run start (`prePromoteAlwaysExpose`) — useful for a trusted server with a small, always-needed toolset, but it pays the full schema cost every turn.

5. **Result flattening handles all MCP content types.** `flattenMcpResult` joins text blocks; images/audio/resources become concise markers (the model can't render base64 in a text tool result). Structured content arrives as text (the SDK serializes it).

6. **Connection errors are non-fatal.** A failing MCP server surfaces as an `isError` tool result to the agent (which can adapt), never aborting the run. Stdio spawn failures are immediate; HTTP transient errors could be retried (future).

---

## Gotchas discovered (recorded for Phase 5+)

1. **`describe.skipIf` for live tests.** The pool live test uses `describe.skipIf(!hasNode)` so it's skipped in environments without node — but `process.execPath` (the test runner's node) is effectively always available, so this is a safety net, not a real gate.

2. **MCP SDK v1.x import paths.** The client imports are `@modelcontextprotocol/sdk/client/index.js`, `…/client/stdio.js`, `…/client/streamableHttp.js` (deep imports with `.js` extensions under ESM). The types come from `@modelcontextprotocol/sdk/types.js`. v2 splits these into separate packages (`@modelcontextprotocol/client`) — a migration note for later.

3. **Tool result `content` is an array of discriminated unions.** Each block has a `type` field (`text`/`image`/`audio`/`resource`/`resource_link`). The dispatcher returns a single string, so `flattenMcpResult` must handle every type or the model sees `[unsupported content type]`.

4. **qwen3.5:9b-thinking burns turns on MCP.** Like the Phase 2 delegation demo, the thinking model sometimes uses all `maxTurns` reasoning without cleanly terminating. The live demo *did* execute search + call correctly (verified in the JSONL), but the agent hit the cap before emitting a final answer. Production MCP agents should have focused prompts + higher `maxTurns`.

5. **The recorder logs MCP tool calls with their namespaced names** (`mcp__math__add`), which is exactly what we want for debugging — easy to grep for MCP activity in a run.

---

## Phase 4 → Phase 5 handoff

**Stable contracts Phase 5 (CLI/TUI + web UI) builds on:**
- **`SharedServices`** now carries `mcpPool` + `mcpCatalog` + `mcpCostMeter` — the TUI/web UI can read `mcpCostMeter.report()` for the token-cost dashboard, and `mcpPool.configuredServers()` for the MCP server list panel.
- **`AgentRunState.mcpTools`** — the run inspector can show which MCP tools an agent promoted (and when, from the recorder).
- **The recorder** logs `mcp_tool_search` + `mcp__*` calls like any other tool — the replay UI needs no changes to render them.

**What Phase 5 explicitly needs (not yet built):** the Ink TUI panels, slash-commands, approvals desk, and the promoted Next.js web UI. The MCP layer is complete and orthogonal to the UI work.

**What remains for MCP (deferred):** MCP `resources` and `prompts` (Phase 4 ships tools only), OAuth/auth flows for HTTP servers, embedding-based semantic search, and the web UI cost dashboard (Phase 5).
