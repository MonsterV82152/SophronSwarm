/**
 * LIVE integration test — proves the full MCP search→promote→call path against
 * a real stdio MCP server (tests/fixtures/math-mcp-server.js).
 *
 * Marked live (like tests/sandbox/bubblewrap.test.ts). Spawns a subprocess via
 * the official SDK's StdioClientTransport. Requires node on PATH.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpConnectionPool } from "../../src/mcp/pool.js";
import { McpToolCatalog } from "../../src/mcp/catalog.js";
import { TokenCostMeter } from "../../src/mcp/costMeter.js";
import { promoteTool } from "../../src/mcp/promotion.js";
import { normalizeServerConfig } from "../../src/mcp/config.js";

const SERVER_CFG = normalizeServerConfig({
  name: "math",
  transport: "stdio",
  command: process.execPath,
  args: ["--no-warnings", "tests/fixtures/math-mcp-server.js"],
});

const hasNode = (() => {
  try {
    // process.execPath is the node binary running the tests — always available.
    return Boolean(process.execPath);
  } catch {
    return false;
  }
})();

describe.skipIf(!hasNode)("MCP live (stdio math server)", () => {
  let pool: McpConnectionPool;

  beforeEach(() => {
    pool = new McpConnectionPool([SERVER_CFG]);
  });
  afterEach(async () => {
    await pool.closeAll();
  });

  it("connects, lists tools, and calls one end-to-end", async () => {
    const { client } = await pool.getOrConnect("math");
    const list = await client.listTools();
    const names = list.tools.map((t) => t.name);
    expect(names).toContain("add");
    expect(names).toContain("multiply");

    const res = await client.callTool({ name: "add", arguments: { a: 2, b: 3 } });
    const text = (res["content"] as Array<{ type: string; text?: string }>)[0];
    expect(text?.text).toBe("5");
  });

  it("catalog refresh indexes both tools", async () => {
    const catalog = new McpToolCatalog(pool);
    await catalog.refresh(["math"]);
    expect(catalog.list().map((t) => t.name).sort()).toEqual(["add", "multiply"]);
  });

  it("catalog search finds 'add' by keyword", async () => {
    const catalog = new McpToolCatalog(pool);
    await catalog.refresh(["math"]);
    const hits = catalog.search("add numbers", 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.tool.name).toBe("add");
  });

  it("promoted tool routes through the pool and returns the flattened result", async () => {
    const catalog = new McpToolCatalog(pool);
    await catalog.refresh(["math"]);
    const tool = catalog.get("math", "add")!;
    const spec = promoteTool(tool, pool, new TokenCostMeter());

    const out = await spec.handler({
      args: { a: 7, b: 6 },
      agent: {} as never,
      state: {} as never,
      services: {} as never,
    });
    expect(out).toBe("13");
  });

  it("promoted multiply tool works too", async () => {
    const catalog = new McpToolCatalog(pool);
    await catalog.refresh(["math"]);
    const tool = catalog.get("math", "multiply")!;
    const spec = promoteTool(tool, pool, new TokenCostMeter());

    const out = await spec.handler({
      args: { a: 4, b: 5 },
      agent: {} as never,
      state: {} as never,
      services: {} as never,
    });
    expect(out).toBe("20");
  });

  it("connection is reused across calls (pool caches the client)", async () => {
    const a = await pool.getOrConnect("math");
    const b = await pool.getOrConnect("math");
    expect(a.client).toBe(b.client);
    expect(pool.openCount).toBe(1);
  });
});
