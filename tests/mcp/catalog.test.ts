import { beforeEach, describe, expect, it } from "vitest";
import { McpToolCatalog } from "../../src/mcp/catalog.js";
import type { McpConnectionPool } from "../../src/mcp/pool.js";
import type { McpServerConfig } from "../../src/mcp/config.js";

// ── Stub pool: returns canned tool lists without a real server ──────────────

function makeStubPool(servers: Record<string, Array<{ name: string; description?: string; inputSchema?: object }>>): McpConnectionPool {
  return {
    canConnect: (name: string) => name in servers,
    configuredServers: () => Object.keys(servers).map((name) => ({ name, transport: "stdio" } as McpServerConfig)),
    getOrConnect: async (name: string) => ({
      config: { name } as McpServerConfig,
      client: {
        listTools: async () => ({
          tools: (servers[name] ?? []).map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema ?? { type: "object" },
          })),
        }),
        callTool: async () => ({ content: [] }),
        close: async () => {},
      },
    }),
  } as unknown as McpConnectionPool;
}

describe("McpToolCatalog", () => {
  let catalog: McpToolCatalog;

  describe("search ranking", () => {
    beforeEach(() => {
      const pool = makeStubPool({
        math: [
          { name: "add", description: "Add two numbers together" },
          { name: "multiply", description: "Multiply two numbers" },
          { name: "sqrt", description: "Square root of a number" },
        ],
        search: [
          { name: "web_search", description: "Search the web for a query" },
          { name: "fetch", description: "Fetch a URL" },
        ],
      });
      catalog = new McpToolCatalog(pool);
    });

    it("ranks tools by query term matches in name + description", async () => {
      await catalog.refresh(["math", "search"]);
      const hits = catalog.search("search web", 5);
      expect(hits.length).toBeGreaterThan(0);
      // "web_search" matches both "search" (name+desc) and "web" (desc) → top hit.
      expect(hits[0]!.tool.name).toBe("web_search");
      expect(hits[0]!.score).toBeGreaterThan(0);
    });

    it("name matches weigh double (name term scores higher than desc-only)", async () => {
      await catalog.refresh(["math"]);
      const hits = catalog.search("add", 5);
      expect(hits[0]!.tool.name).toBe("add");
    });

    it("returns at most `limit` hits", async () => {
      await catalog.refresh(["math", "search"]);
      const hits = catalog.search("number", 2);
      expect(hits.length).toBeLessThanOrEqual(2);
    });

    it("returns no hits for an unmatched query", async () => {
      await catalog.refresh(["math"]);
      const hits = catalog.search("zzzznonexistent", 5);
      expect(hits).toHaveLength(0);
    });

    it("returns a few tools for an empty query (a what's-available listing)", async () => {
      await catalog.refresh(["math"]);
      const hits = catalog.search("", 3);
      expect(hits.length).toBeLessThanOrEqual(3);
      expect(hits.length).toBeGreaterThan(0);
    });

    it("ranks ties deterministically by tool name", async () => {
      const pool = makeStubPool({
        x: [
          { name: "zebra", description: "match keyword" },
          { name: "alpha", description: "match keyword" },
        ],
      });
      catalog = new McpToolCatalog(pool);
      await catalog.refresh(["x"]);
      const hits = catalog.search("keyword", 5);
      // Same score → sorted by name ascending.
      expect(hits[0]!.tool.name).toBe("alpha");
      expect(hits[1]!.tool.name).toBe("zebra");
    });
  });

  describe("indexing", () => {
    it("list returns all indexed tools", async () => {
      const pool = makeStubPool({
        math: [{ name: "add" }, { name: "multiply" }],
      });
      catalog = new McpToolCatalog(pool);
      await catalog.refresh(["math"]);
      expect(catalog.list().map((t) => t.name).sort()).toEqual(["add", "multiply"]);
    });

    it("forServer filters by server", async () => {
      const pool = makeStubPool({
        math: [{ name: "add" }],
        search: [{ name: "fetch" }],
      });
      catalog = new McpToolCatalog(pool);
      await catalog.refresh(["math", "search"]);
      expect(catalog.forServer("math").map((t) => t.name)).toEqual(["add"]);
      expect(catalog.forServer("search").map((t) => t.name)).toEqual(["fetch"]);
    });

    it("get retrieves a single tool by server + name", async () => {
      const pool = makeStubPool({ math: [{ name: "add", description: "add" }] });
      catalog = new McpToolCatalog(pool);
      await catalog.refresh(["math"]);
      expect(catalog.get("math", "add")?.name).toBe("add");
      expect(catalog.get("math", "missing")).toBeUndefined();
    });

    it("forgetServer removes a server's tools", async () => {
      const pool = makeStubPool({
        math: [{ name: "add" }],
        search: [{ name: "fetch" }],
      });
      catalog = new McpToolCatalog(pool);
      await catalog.refresh(["math", "search"]);
      catalog.forgetServer("math");
      expect(catalog.list().map((t) => t.name)).toEqual(["fetch"]);
    });

    it("refresh merges without wiping other servers (partial refresh)", async () => {
      const pool = makeStubPool({
        math: [{ name: "add" }],
        search: [{ name: "fetch" }],
      });
      catalog = new McpToolCatalog(pool);
      await catalog.refresh(["math"]);
      expect(catalog.list()).toHaveLength(1);
      await catalog.refresh(["search"]); // only search; math stays
      expect(catalog.list().map((t) => t.name).sort()).toEqual(["add", "fetch"]);
    });
  });
});
