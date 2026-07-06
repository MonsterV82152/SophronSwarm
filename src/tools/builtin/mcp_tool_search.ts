/**
 * mcp_tool_search — the single MCP meta-tool exposed to agents by default.
 *
 * SwarmClaw's lazy-loading core: instead of binding a chatty MCP server's 40
 * tools into every agent prompt (thousands of tokens/turn), the agent gets ONE
 * tool — this one. It searches the catalog of available MCP tools and promotes
 * the matches into the run's tool set so they're callable on subsequent turns.
 *
 * Flow:
 *   1. Resolve the agent's MCP servers (from agent.mcpServers + pool config).
 *   2. Refresh the catalog for those servers (lazily; only once).
 *   3. Keyword-search.
 *   4. Promote the matches → append to state.mcpTools (per-run isolated).
 *   5. Record costs (so the budget is visible).
 *   6. Return a concise list: `server::tool — description (~N tokens)`.
 *
 * See docs/PHASE_4_DESIGN.md §3.5.
 */
import { log } from "../../util/log.js";
import type { ToolSpec, ToolContext } from "../schema.js";
import { promoteTool, recordPromotionCosts } from "../../mcp/promotion.js";

function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string") throw new Error(`Missing or non-string argument '${key}'`);
  return v;
}

/**
 * Resolve which MCP server names this agent may use. Derived from the agent's
 * `mcpServers` frontmatter filtered against the pool's configured servers.
 */
function agentServerNames(ctx: ToolContext): string[] {
  const allowed = new Set(ctx.services.mcpPool.configuredServers().map((s) => s.name));
  const declared = ctx.agent.mcpServers ?? [];
  const names: string[] = [];
  for (const entry of declared) {
    if (typeof entry === "string" && allowed.has(entry)) names.push(entry);
    else if (entry && typeof entry === "object" && typeof entry["name"] === "string" && allowed.has(entry["name"] as string)) {
      names.push(entry["name"] as string);
    }
  }
  return names;
}

export const mcp_tool_search: ToolSpec = {
  name: "mcp_tool_search",
  description:
    "Discover and enable MCP (external) tools. Searches available MCP servers for tools " +
    "matching your query and ENABLES the matches so you can call them on your next turn. " +
    "Returns the matches with a short description and per-tool token cost. " +
    "Use specific keywords (e.g. 'database query', 'web fetch', 'git diff'). " +
    "Call this BEFORE trying to use any external capability you don't already have.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Keywords describing the capability you need (e.g. 'read file', 'search web').",
      },
      limit: {
        type: "number",
        description: "Max tools to enable (default 5). Keep small to control token cost.",
      },
    },
    required: ["query"],
  },
  handler: async (ctx: ToolContext): Promise<string> => {
    const query = requireString(ctx.args, "query");
    const limit = typeof ctx.args["limit"] === "number" && ctx.args["limit"] > 0
      ? Math.min(Math.floor(ctx.args["limit"]), 20)
      : 5;

    const names = agentServerNames(ctx);
    if (names.length === 0) {
      return "No MCP servers are configured for this agent. Ask the operator to add servers to .sophron/mcp.json and reference them in the agent's mcpServers frontmatter.";
    }

    // Refresh the catalog for the agent's servers (lazy — the catalog caches per server).
    try {
      await ctx.services.mcpCatalog.refresh(names);
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      log.warn({ err: msg }, "mcp catalog refresh failed");
      return `Failed to list MCP tools: ${msg}`;
    }

    const hits = ctx.services.mcpCatalog.search(query, limit);
    if (hits.length === 0) {
      const total = ctx.services.mcpCatalog.list().length;
      return `No MCP tools matched '${query}'. ${total} tool(s) indexed across ${names.length} server(s). Try different keywords.`;
    }

    // Promote each hit into the run's tool set (per-run isolated on state.mcpTools).
    const promoted = ctx.state.mcpTools ?? [];
    const alreadyPromoted = new Set(promoted.map((t) => t.name));
    const newlyPromoted = [];
    for (const hit of hits) {
      const id = `mcp__${hit.tool.server}__${hit.tool.name}`;
      if (alreadyPromoted.has(id)) continue; // don't double-register
      const spec = promoteTool(hit.tool, ctx.services.mcpPool, ctx.services.mcpCostMeter);
      promoted.push(spec);
      newlyPromoted.push(hit.tool);
    }
    ctx.state.mcpTools = promoted;

    // Record costs so the budget is visible.
    if (newlyPromoted.length > 0) {
      recordPromotionCosts(newlyPromoted, ctx.services.mcpCostMeter);
    }

    // Build a concise result string the agent can act on.
    const lines = [
      `Enabled ${newlyPromoted.length} MCP tool(s) for '${query}'. You can now call them.`,
      ``,
    ];
    const allTools = hits.map((h) => h.tool);
    const cumulative = ctx.services.mcpCostMeter.cumulative();
    for (const t of allTools) {
      const cost = ctx.services.mcpCostMeter.report().perTool.find(
        (c) => c.server === t.server && c.tool === t.name,
      );
      const costStr = cost ? ` (~${cost.tokens}t/turn)` : "";
      lines.push(`- mcp__${t.server}__${t.name} — ${t.description || t.name}${costStr}`);
    }
    lines.push(``, `Cumulative MCP tool cost: ~${cumulative} tokens/turn.`);
    return lines.join("\n");
  },
};
