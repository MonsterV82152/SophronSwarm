/**
 * MCP tool catalog — a search index over tools across all agent-scoped servers.
 *
 * The lazy-loading core (SwarmClaw's highest-leverage MCP optimization): the
 * agent gets a single `mcp_tool_search` meta-tool and calls it to discover
 * tools. The catalog indexes `{ serverName, name, description, inputSchema }`
 * from each server's `tools/list` (paginating) and answers keyword search.
 *
 * No embeddings (deferred like memory) — keyword matching is good enough for v1.
 *
 * See docs/PHASE_4_DESIGN.md §3.3.
 */
import { log } from "../util/log.js";
import type { McpConnectionPool } from "./pool.js";

/** A tool discovered from an MCP server, flattened to what we need. */
export interface CatalogTool {
  server: string;
  name: string;
  description: string;
  inputSchema: object;
}

export interface SearchHit {
  tool: CatalogTool;
  /** Relevance score (higher = better). */
  score: number;
}

export class McpToolCatalog {
  /** index key = `server::tool`; preserves insertion order via Map. */
  private tools = new Map<string, CatalogTool>();
  private lastRefreshedAt = 0;
  /** Track which servers contributed to the current index. */
  private indexedServers = new Set<string>();

  constructor(private pool: McpConnectionPool) {}

  /**
   * Refresh the index by listing tools from each server. Paginates transparently.
   * Pass the agent-scoped server names to limit which servers are queried.
   */
  async refresh(serverNames: string[]): Promise<void> {
    const before = this.tools.size;
    // Don't wipe the whole index; only (re)index the requested servers so a
    // partial refresh doesn't lose tools from other servers.
    for (const name of serverNames) {
      await this.indexServer(name);
    }
    this.lastRefreshedAt = Date.now();
    log.debug(
      { servers: serverNames, added: this.tools.size - before, total: this.tools.size },
      "mcp catalog refreshed",
    );
  }

  /** List tools from one server and merge into the index. */
  private async indexServer(serverName: string): Promise<void> {
    if (!this.pool.canConnect(serverName)) return;
    const { client } = await this.pool.getOrConnect(serverName);

    let cursor: string | undefined;
    let count = 0;
    do {
      const res = await client.listTools(cursor ? { cursor } : undefined);
      for (const t of res.tools ?? []) {
        const key = `${serverName}::${t.name}`;
        this.tools.set(key, {
          server: serverName,
          name: t.name,
          description: t.description ?? "",
          inputSchema: t.inputSchema ?? { type: "object", properties: {} },
        });
        count++;
      }
      cursor = (res as { nextCursor?: string }).nextCursor;
    } while (cursor);
    this.indexedServers.add(serverName);
    log.debug({ server: serverName, tools: count }, "mcp catalog indexed server");
  }

  /** Drop all tools from a server from the index (e.g. after it disconnects). */
  forgetServer(serverName: string): void {
    for (const key of [...this.tools.keys()]) {
      if (key.startsWith(`${serverName}::`)) this.tools.delete(key);
    }
    this.indexedServers.delete(serverName);
  }

  /** All indexed tools (for diagnostics / the cost meter's full estimate). */
  list(): CatalogTool[] {
    return [...this.tools.values()];
  }

  /** Tools belonging to one server. */
  forServer(server: string): CatalogTool[] {
    return [...this.tools.values()].filter((t) => t.server === server);
  }

  get lastRefreshed(): number {
    return this.lastRefreshedAt;
  }

  /**
   * Keyword search over tool name + description.
   *
   * Scoring: tokenize the query into words; for each tool, count how many query
   * words appear (case-insensitive) in its name or description. Name matches
   * weigh double (the name is the strongest signal). Return the top `limit`.
   */
  search(query: string, limit: number = 5): SearchHit[] {
    const qTerms = tokenize(query);
    if (qTerms.length === 0) {
      // Empty query → return the first few tools (a "what's available" listing).
      return [...this.tools.values()].slice(0, limit).map((tool) => ({ tool, score: 0 }));
    }

    const hits: SearchHit[] = [];
    for (const tool of this.tools.values()) {
      const nameLower = tool.name.toLowerCase();
      const descLower = tool.description.toLowerCase();
      let score = 0;
      for (const term of qTerms) {
        if (nameLower.includes(term)) score += 2;
        if (descLower.includes(term)) score += 1;
      }
      if (score > 0) hits.push({ tool, score });
    }
    hits.sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name));
    return hits.slice(0, limit);
  }

  /** Look up a single tool by server + name (used by the promoted-tool handler). */
  get(server: string, name: string): CatalogTool | undefined {
    return this.tools.get(`${server}::${name}`);
  }
}

/** Tokenize a query into lowercase search terms (split on non-word chars, drop empties). */
function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 0);
}
