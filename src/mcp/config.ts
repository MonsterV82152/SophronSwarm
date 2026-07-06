/**
 * MCP server configuration — global config + per-agent scoping.
 *
 * Servers are configured globally (a `.sophron/mcp.json` file or loaded
 * programmatically) and scoped per-agent via the `mcpServers` frontmatter field
 * (a list of server names). An agent can only connect to servers named in its
 * `mcpServers` list — this is the per-agent scoping that prevents every agent
 * from paying the connection cost of every server.
 *
 * Default is LAZY: an agent gets a single `mcp_tool_search` meta-tool and tools
 * are promoted only when the agent asks. A server may opt into eager exposure
 * with `alwaysExpose: true` (rare).
 *
 * See docs/PHASE_4_DESIGN.md §3.1.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { log } from "../util/log.js";

export type McpTransport = "stdio" | "http";

export interface McpServerConfig {
  /** Unique id; referenced by agent.mcpServers. */
  name: string;
  transport: McpTransport;

  // ── stdio transport ──────────────────────────────────────────────────────
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;

  // ── http transport ───────────────────────────────────────────────────────
  url?: string;
  headers?: Record<string, string>;

  /** Expose all tools up front instead of via search. Default false (lazy). */
  alwaysExpose?: boolean;
  /** Cap on tools promoted from this server per session. Default 20. */
  maxTools?: number;

  /** Where the config was loaded from (for diagnostics). */
  source?: string;
}

export interface McpGlobalConfig {
  servers: McpServerConfig[];
  /** Path the config was loaded from, if any. */
  source?: string;
}

export const DEFAULT_MAX_TOOLS_PER_SERVER = 20;
export const MCP_CONFIG_FILENAME = "mcp.json";

/**
 * Validate + normalize a single server config. Throws on an invalid combo
 * (e.g. stdio without a command, http without a url).
 */
export function normalizeServerConfig(raw: McpServerConfig): McpServerConfig {
  if (!raw.name || typeof raw.name !== "string") {
    throw new Error("MCP server config requires a non-empty 'name'");
  }
  const transport: McpTransport = raw.transport === "http" ? "http" : "stdio";
  const out: McpServerConfig = {
    name: raw.name,
    transport,
    alwaysExpose: raw.alwaysExpose === true,
    maxTools:
      typeof raw.maxTools === "number" && raw.maxTools > 0
        ? Math.floor(raw.maxTools)
        : DEFAULT_MAX_TOOLS_PER_SERVER,
    source: raw.source,
  };
  if (transport === "stdio") {
    if (!raw.command) throw new Error(`MCP server '${raw.name}': stdio transport requires 'command'`);
    out.command = raw.command;
    out.args = raw.args ?? [];
    out.env = raw.env;
    out.cwd = raw.cwd;
  } else {
    if (!raw.url) throw new Error(`MCP server '${raw.name}': http transport requires 'url'`);
    out.url = raw.url;
    out.headers = raw.headers;
  }
  return out;
}

/**
 * Load global MCP config from `<workspace>/.sophron/mcp.json` if it exists.
 * Returns an empty config (no servers) when the file is absent — MCP is opt-in.
 */
export function loadGlobalConfig(workspaceDir: string): McpGlobalConfig {
  const file = join(workspaceDir, ".sophron", MCP_CONFIG_FILENAME);
  if (!existsSync(file)) {
    return { servers: [] };
  }
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    log.warn({ file, err: (e as Error).message }, "could not read mcp config");
    return { servers: [], source: file };
  }
  return parseConfigString(raw, file);
}

/** Parse a JSON config string into a validated global config. */
export function parseConfigString(json: string, source?: string): McpGlobalConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    log.warn({ source, err: (e as Error).message }, "mcp config is not valid JSON");
    return { servers: [], source };
  }

  // Accept either { servers: [...] } or a bare array (treated as the servers list).
  const list: unknown[] | null =
    Array.isArray(parsed) ? parsed
    : (parsed && typeof parsed === "object" && Array.isArray((parsed as { servers?: unknown }).servers))
      ? (parsed as { servers: unknown[] }).servers
      : null;
  if (!list) {
    log.warn({ source }, "mcp config must be an array or { servers: [...] }");
    return { servers: [], source };
  }

  const servers: McpServerConfig[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    try {
      const cfg = normalizeServerConfig(entry as unknown as McpServerConfig);
      cfg.source = source;
      servers.push(cfg);
    } catch (e) {
      log.warn({ source, err: (e as Error).message }, "skipping invalid mcp server config");
    }
  }
  return { servers, source };
}

/**
 * Resolve the set of MCP servers an agent is permitted to connect to.
 *
 * `agentMcpServers` is the agent's frontmatter list — it may be `string[]`
 * (server names) or `Record<string, unknown>[]` (legacy shape with inline
 * config). For Phase 4 we resolve names against the global config; inline-config
 * entries (objects with a `name`) are accepted as ad-hoc servers too.
 */
export function resolveAgentServers(
  globalConfig: McpGlobalConfig,
  agentMcpServers?: (string | Record<string, unknown>)[],
): McpServerConfig[] {
  if (!agentMcpServers || agentMcpServers.length === 0) return [];
  const byName = new Map(globalConfig.servers.map((s) => [s.name, s]));
  const out: McpServerConfig[] = [];
  const seen = new Set<string>();

  for (const entry of agentMcpServers) {
    if (typeof entry === "string") {
      const cfg = byName.get(entry);
      if (!cfg) {
        log.warn({ server: entry }, "agent references unknown mcp server (not in global config)");
        continue;
      }
      if (!seen.has(cfg.name)) {
        seen.add(cfg.name);
        out.push(cfg);
      }
    } else if (entry && typeof entry === "object" && typeof entry["name"] === "string") {
      // Inline ad-hoc server config.
      try {
        const cfg = normalizeServerConfig(entry as unknown as McpServerConfig);
        if (!seen.has(cfg.name)) {
          seen.add(cfg.name);
          out.push(cfg);
        }
      } catch (e) {
        log.warn({ err: (e as Error).message }, "skipping invalid inline mcp server in agent");
      }
    }
  }
  return out;
}
