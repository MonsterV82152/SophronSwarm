/**
 * MCP tool promotion — convert a catalog tool into a callable ToolSpec.
 *
 * When the agent calls `mcp_tool_search` and decides to use a tool, that tool is
 * "promoted": it becomes a normal function-call tool (named `mcp__<server>__<tool>`)
 * the model can invoke on subsequent turns. The promoted tool's handler routes
 * the call through the connection pool to the MCP server and flattens the result.
 *
 * Naming: `mcp__<server>__<tool>` keeps MCP tools in a distinct namespace so they
 * never collide with built-in tools and are easy to identify in logs / the
 * recorder. Characters allowed: `[a-z0-9_]` only — server/tool names are sanitized.
 *
 * See docs/PHASE_4_DESIGN.md §3.5.
 */
import { log } from "../util/log.js";
import type { ToolSpec } from "../tools/schema.js";
import type { ToolContext } from "../tools/schema.js";
import type { McpConnectionPool } from "./pool.js";
import { TokenCostMeter } from "./costMeter.js";
import type { CatalogTool } from "./catalog.js";

/** Build the namespaced tool id for a promoted MCP tool. */
export function mcpToolId(server: string, tool: string): string {
  return `mcp__${sanitize(server)}__${sanitize(tool)}`;
}

/** Parse `mcp__<server>__<tool>` back into { server, tool }. */
export function parseMcpToolId(id: string): { server: string; tool: string } | null {
  const m = id.match(/^mcp__(.+)__(.+)$/);
  if (!m) return null;
  return { server: m[1]!, tool: m[2]! };
}

/** Is this tool name a promoted MCP tool? */
export function isMcpTool(name: string): boolean {
  return name.startsWith("mcp__");
}

/** Replace characters that aren't safe in a function name with `_`. */
function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_]/g, "_");
}

/**
 * Flatten an MCP tool result (content array) into a single string for the model.
 * Text blocks are concatenated; images/audio/resources are summarized as markers
 * (the model can't render base64 blobs in a text tool result).
 */
export function flattenMcpResult(content: Array<Record<string, unknown>>): string {
  const parts: string[] = [];
  for (const block of content) {
    const type = block["type"];
    if (type === "text" && typeof block["text"] === "string") {
      parts.push(block["text"] as string);
    } else if (type === "image") {
      parts.push(`[image: ${block["mimeType"] ?? "unknown"}, ${(block["data"] as string)?.length ?? 0} bytes]`);
    } else if (type === "audio") {
      parts.push(`[audio: ${block["mimeType"] ?? "unknown"}]`);
    } else if (type === "resource" && block["resource"] && typeof block["resource"] === "object") {
      const res = block["resource"] as Record<string, unknown>;
      parts.push(`[resource: ${res["uri"] ?? res["name"] ?? "unknown"}]`);
    } else if (type === "resource_link" && block["uri"]) {
      parts.push(`[resource link: ${block["uri"]}]`);
    } else {
      parts.push(`[unsupported content type: ${type ?? "unknown"}]`);
    }
  }
  return parts.length > 0 ? parts.join("\n") : "(empty result)";
}

/**
 * Build a ToolSpec for a catalog tool. The handler routes the call through the
 * pool to the MCP server and returns the flattened result. Errors are thrown so
 * the dispatcher surfaces them as `isError` (consistent with built-in tools).
 */
export function promoteTool(
  tool: CatalogTool,
  pool: McpConnectionPool,
  costMeter: TokenCostMeter,
): ToolSpec {
  const id = mcpToolId(tool.server, tool.name);
  const handler = async (ctx: ToolContext): Promise<string> => {
    const { args } = ctx;
    if (!pool.canConnect(tool.server)) {
      throw new Error(`MCP server '${tool.server}' is not available`);
    }
    const { client } = await pool.getOrConnect(tool.server);
    log.info({ server: tool.server, tool: tool.name }, "mcp tool call");

    const result = await client.callTool({ name: tool.name, arguments: args });
    const content = (result["content"] as Array<Record<string, unknown>>) ?? [];
    const text = flattenMcpResult(content);

    // MCP reports tool-execution errors with isError: true (vs protocol errors
    // which throw). Surface both consistently by throwing on isError.
    if (result["isError"] === true) {
      throw new Error(text || `MCP tool '${tool.name}' returned an error`);
    }
    return text;
  };

  return {
    name: id,
    description:
      `[mcp:${tool.server}] ` +
      (tool.description || tool.name) +
      ` (server: ${tool.server})`,
    parameters: tool.inputSchema,
    handler,
  };
}

/**
 * Estimate + record the cost of promoting a set of catalog tools. Returns the
 * cost estimates so the caller (mcp_tool_search) can show per-tool cost to the
 * agent in its result string.
 */
export function recordPromotionCosts(
  tools: CatalogTool[],
  costMeter: TokenCostMeter,
): void {
  const costs = tools.map((t) =>
    TokenCostMeter.estimateTool(t.server, t.name, t.description, t.inputSchema),
  );
  costMeter.recordPromotions(costs);
  costMeter.warnIfOverBudget();
}
