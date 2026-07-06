# Phase 4 — MCP (Design)

> Status: **DESIGN** — 2026-07-05
> Spec: [`PROJECT_OVERVIEW.md`](./PROJECT_OVERVIEW.md) §5.1b (MCP Access), §6 #3 (token optimization)
> Depends on: Phase 3 complete (SharedServices DI object, ToolSpec/ToolRegistry contract).
> SDK: `@modelcontextprotocol/sdk` v1.29.0 (stable v1.x; v2 is beta).

---

## 1. Goal

Give agents access to **Model Context Protocol servers** (external tool providers) while spending the **minimum possible tokens** on them. The single most important lesson (from SwarmClaw): binding a chatty MCP server's 40 tools into every agent's system prompt costs *thousands* of tokens every turn. Phase 4 makes **lazy loading the default**.

**Non-goals (deferred):** MCP `resources` and `prompts` (Phase 4 ships **tools** only), OAuth/auth flows, the web UI cost dashboard (Phase 5), embedding-based semantic search (deferred like memory — keyword search is good enough for v1).

---

## 2. Research — what SwarmClaw / Claude Code / Codex do

### SwarmClaw's MCP cost-reduction patterns (the model for V3)
1. **Lazy by default (`alwaysExpose: false`)**: the agent gets a **single** `mcp_tool_search({query, limit})` meta-tool. Tools are promoted into the session *only when the agent asks*. Nothing is bound up front.
2. **Per-tool token-cost meter** (`chars / 3.5` estimate): surface the costliest servers *before* a run so operators see the token impact.
3. **Long-lived per-server connection pool**: one Client per configured server, kept alive across turns (saves 100–500 ms × servers × turns). No fresh subprocess / HTTP session per turn.
4. **MCP scoped per-agent** (`mcpServers` in agent frontmatter): only the servers the agent needs are even connectable by it.
5. **Subagent context isolation**: verbose MCP output stays in the sub-agent (already done in Phase 2 via HandoffPacket).

### Accuracy patterns
- **Tool descriptions + annotations**: MCP tools carry `title`, `description`, `inputSchema`, `outputSchema`, `annotations` (audience, priority). Rich descriptions → better tool selection by the model.
- **Pagination on `tools/list`**: large servers return pages via `cursor`/`nextCursor`. The search layer paginates transparently.
- **Structured content + `outputSchema`**: lets the model parse results reliably.

### MCP TypeScript SDK facts (v1.29.0, verified against installed package)
- **Client API**: `new Client({name,version}, {capabilities})` → `client.connect(transport)` → `client.listTools({cursor?})` → `client.callTool({name, arguments})`.
- **Transports**: `StdioClientTransport({command, args?, env?, cwd?})` (subprocess) and `StreamableHTTPClientTransport(new URL(url), {requestInit?})` (HTTP POST + optional SSE).
- **Tool shape**: `{ name, title?, description?, inputSchema, outputSchema?, annotations? }`.
- **Tool result**: `{ content: ContentBlock[], isError?: boolean, structuredContent? }`; `ContentBlock` = `{type:"text", text}` | `{type:"image", data, mimeType}` | `{type:"resource", resource}` | …
- **listChanged**: servers with `tools.listChanged` emit `notifications/tools/list_changed`; the catalog can refresh.

---

## 3. Design

### 3.1 Configuration (`src/mcp/config.ts`)
MCP servers are configured **globally** (CLI / `.sophron/mcp.json` or env) and **scoped per-agent** (`mcpServers` in the agent frontmatter). A server definition is:

```ts
interface McpServerConfig {
  name: string;              // unique id, used in agent.mcpServers
  transport: "stdio" | "http";
  // stdio:
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  // http:
  url?: string;
  headers?: Record<string, string>;
  /** Expose all tools up front instead of via search. Default false (lazy). */
  alwaysExpose?: boolean;
  /** Cap on tools promoted from this server per session. Default 20. */
  maxTools?: number;
}
```

The agent frontmatter `mcpServers` is `string[]` (server names) — resolves against the global config. (The existing `mcpServers?: (string | Record<string, unknown>)[]` type stays; we accept both shapes but normalize to names.)

### 3.2 Connection pool (`src/mcp/pool.ts`)
`McpConnectionPool` keeps one `Client` per server name, alive for the CLI process lifetime. Lazy connect (first use). Methods: `getOrConnect(name)` → `{ client, server }`, `closeAll()`.

- Stdio servers are spawned as subprocesses; the pool owns their lifecycle.
- HTTP servers open a session (the SDK handles `Mcp-Session-Id`).
- Connection errors are surfaced to the agent as `isError` tool results (never fatal) — retry is per the existing transient classifier but only for HTTP; stdio spawn failures are immediate.

### 3.3 Tool catalog (`src/mcp/catalog.ts`)
`McpToolCatalog` is the **search index** over all tools across all (agent-scoped) servers. On demand, it:
1. Calls `listTools()` (paginating) on each connected server.
2. Indexes tools by `{ serverName, name, description, inputSchema }`.
3. Answers **`search({query, limit})`** via keyword matching (no embeddings — same discipline as memory): tokenize the query, score each tool by how many query tokens appear in its name+description (case-insensitive), return top `limit`.

This is the **only** thing exposed to the agent by default.

### 3.4 Token-cost meter (`src/mcp/costMeter.ts`)
`TokenCostMeter` estimates the token cost of promoting a set of MCP tools (each tool's JSON-schema serialized → `approxTokens`). It:
- Reports per-server and per-tool costs so the operator/UI can see the costliest servers *before* promotion.
- Tracks **cumulative** MCP token spend across a run (the promoted tools' schema cost, paid every turn they're bound).
- Emits a warning when cumulative MCP schema cost exceeds a threshold (e.g. 20% of a typical context window) — surfacing the silent budget killer early.

### 3.5 The `mcp_tool_search` meta-tool + dynamic registration
`src/tools/builtin/mcp_tool_search.ts` — the **single** MCP tool exposed by default:

```
mcp_tool_search({ query: string, limit?: number }): string
```

When called:
1. Searches the catalog scoped to the calling agent's `mcpServers`.
2. Returns a concise list of matches: `server::tool — description (cost: ~N tokens)`.
3. **Promotes** the matched tools into the run's **dynamic tool set**: each becomes a callable `ToolSpec` (named `mcp__<server>__<tool>`) registered in a per-run overlay on the registry.
4. On the next turn, those tools are available as normal function-call tools. The model invokes them; the handler routes to `pool.callTool(server, tool, args)` and flattens the `content[]` result to a string.

This collapses SwarmClaw's "search then promote then call" into a clean two-step: **search (this turn) → call (next turn)**.

### 3.6 Per-run dynamic tool overlay
The agent loop already computes `toolDefsFor(registry, agent)` each turn. Phase 4 adds a **dynamic overlay**: promoted MCP tools are added to the per-run tool set. We store promoted tools on `AgentRunState` (a `Set<string>` of promoted tool names) so checkpoints capture state and sub-agents get isolated promotion (a parent's promotions don't leak into a child — consistent with Phase 2 isolation).

### 3.7 Wiring
- `SharedServices` += `mcpPool: McpConnectionPool`, `mcpCatalog: McpToolCatalog`, `mcpCostMeter: TokenCostMeter`.
- `buildServices()` constructs them once; `pool.closeAll()` on process exit.
- The loop computes the per-turn tool list = builtin tools (allow/deny filtered) **∪** promoted MCP tools for this run.
- `mcp_tool_search` is always registered; `alwaysExpose: true` servers have their tools pre-promoted at run start (rare opt-in).

---

## 4. Token budget — where the savings come from

| Strategy | Without Phase 4 | With Phase 4 |
|---|---|---|
| 40-tool server bound every turn | ~3–5k tokens/turn × turns × agents | **0** until the agent searches |
| After a targeted search (promote 3 tools) | (same 3–5k) | ~300 tokens/turn for the 3 tools |
| Connection per turn | 100–500 ms spawn × turns | one-time spawn |

**Net:** a 40-tool server that the agent searches once and promotes 3 tools from costs ~300 tokens/turn instead of ~5000 — a **~94% reduction** for that server, exactly SwarmClaw's result.

---

## 5. Build order

1. `src/mcp/config.ts` — server config types + loader (from `.sophron/mcp.json` / agent frontmatter).
2. `src/mcp/pool.ts` — connection pool (lazy connect, stdio + http, closeAll).
3. `src/mcp/catalog.ts` — list + index + keyword search.
4. `src/mcp/costMeter.ts` — per-tool cost estimate + cumulative tracking.
5. `src/mcp/promotion.ts` — promote a catalog tool → a `ToolSpec` that routes to the pool.
6. `src/tools/builtin/mcp_tool_search.ts` — the meta-tool.
7. Wire into `SharedServices`, the loop (dynamic overlay), and `cli.ts`.
8. Tests (config parse, search ranking, cost meter, promotion → ToolSpec, search tool end-to-end with a stub server).
9. Demo: an in-repo stdio MCP server + an agent that searches + calls it.

---

## 6. Testing strategy

- **Unit (no live MCP server):** config parsing, catalog search ranking, cost meter estimates, promotion → ToolSpec shape, dynamic overlay merge. These use stub objects.
- **Integration (live, gated):** a tiny in-repo stdio MCP server (a "math" server with `add`/`multiply` tools) so we can prove the full search→promote→call→result path against the real SDK. Marked live (like `bubblewrap.test.ts`).
- **Regression:** all 200 existing tests unchanged.
