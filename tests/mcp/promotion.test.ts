import { describe, expect, it } from "vitest";
import {
  mcpToolId,
  parseMcpToolId,
  isMcpTool,
  flattenMcpResult,
  promoteTool,
  recordPromotionCosts,
} from "../../src/mcp/promotion.js";
import { TokenCostMeter } from "../../src/mcp/costMeter.js";
import type { CatalogTool } from "../../src/mcp/catalog.js";
import type { McpConnectionPool } from "../../src/mcp/pool.js";

// ── id helpers ────────────────────────────────────────────────────────────────

describe("mcpToolId / parseMcpToolId / isMcpTool", () => {
  it("builds a namespaced id", () => {
    expect(mcpToolId("math-server", "add")).toBe("mcp__math_server__add");
  });

  it("sanitizes special characters", () => {
    expect(mcpToolId("my.server-1", "tool/name")).toBe("mcp__my_server_1__tool_name");
  });

  it("round-trips parseMcpToolId", () => {
    const id = mcpToolId("math", "add");
    expect(parseMcpToolId(id)).toEqual({ server: "math", tool: "add" });
  });

  it("parseMcpToolId returns null for a non-mcp id", () => {
    expect(parseMcpToolId("read_file")).toBeNull();
    expect(parseMcpToolId("mcp__onlyonepart")).toBeNull();
  });

  it("isMcpTool detects the mcp__ prefix", () => {
    expect(isMcpTool("mcp__srv__tool")).toBe(true);
    expect(isMcpTool("read_file")).toBe(false);
  });
});

// ── flattenMcpResult ──────────────────────────────────────────────────────────

describe("flattenMcpResult", () => {
  it("joins text blocks", () => {
    const out = flattenMcpResult([
      { type: "text", text: "hello" },
      { type: "text", text: "world" },
    ]);
    expect(out).toBe("hello\nworld");
  });

  it("summarizes image blocks as markers", () => {
    const out = flattenMcpResult([{ type: "image", data: "abc==", mimeType: "image/png" }]);
    expect(out).toMatch(/image: image\/png/);
    expect(out).not.toContain("abc==");
  });

  it("summarizes resource blocks", () => {
    const out = flattenMcpResult([
      { type: "resource", resource: { uri: "file:///x", name: "x" } },
    ]);
    expect(out).toContain("file:///x");
  });

  it("handles an empty result", () => {
    expect(flattenMcpResult([])).toBe("(empty result)");
  });

  it("flags unsupported content types", () => {
    const out = flattenMcpResult([{ type: "weird" }]);
    expect(out).toMatch(/unsupported/);
  });
});

// ── promoteTool ──────────────────────────────────────────────────────────────

function makeCatalogTool(overrides: Partial<CatalogTool> = {}): CatalogTool {
  return {
    server: "math",
    name: "add",
    description: "Add two numbers",
    inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
    ...overrides,
  };
}

describe("promoteTool", () => {
  it("builds a ToolSpec with the namespaced id and original schema", () => {
    const pool = { canConnect: () => true } as unknown as McpConnectionPool;
    const spec = promoteTool(makeCatalogTool(), pool, new TokenCostMeter());
    expect(spec.name).toBe("mcp__math__add");
    expect(spec.description).toContain("[mcp:math]");
    expect(spec.description).toContain("Add two numbers");
    expect(spec.parameters).toMatchObject({ type: "object" });
    expect(typeof spec.handler).toBe("function");
  });

  it("handler throws when the server is not available", async () => {
    const pool = { canConnect: () => false } as unknown as McpConnectionPool;
    const spec = promoteTool(makeCatalogTool(), pool, new TokenCostMeter());
    await expect(
      spec.handler({
        args: { a: 1, b: 2 },
        agent: {} as never,
        state: {} as never,
        services: {} as never,
      }),
    ).rejects.toThrow(/not available/);
  });

  it("handler calls the server and flattens the text result", async () => {
    const callTool = async () => ({
      content: [{ type: "text", text: "3" }],
    });
    const pool = {
      canConnect: () => true,
      getOrConnect: async () => ({ client: { callTool }, config: { name: "math" } }),
    } as unknown as McpConnectionPool;
    const spec = promoteTool(makeCatalogTool(), pool, new TokenCostMeter());
    const out = await spec.handler({
      args: { a: 1, b: 2 },
      agent: {} as never,
      state: {} as never,
      services: {} as never,
    });
    expect(out).toBe("3");
  });

  it("handler throws when the MCP tool returns isError", async () => {
    const callTool = async () => ({
      content: [{ type: "text", text: "division by zero" }],
      isError: true,
    });
    const pool = {
      canConnect: () => true,
      getOrConnect: async () => ({ client: { callTool }, config: { name: "math" } }),
    } as unknown as McpConnectionPool;
    const spec = promoteTool(makeCatalogTool(), pool, new TokenCostMeter());
    await expect(
      spec.handler({
        args: { a: 1, b: 0 },
        agent: {} as never,
        state: {} as never,
        services: {} as never,
      }),
    ).rejects.toThrow(/division by zero/);
  });
});

describe("recordPromotionCosts", () => {
  it("records costs for each tool on the meter", () => {
    const meter = new TokenCostMeter();
    const before = meter.cumulative();
    recordPromotionCosts(
      [makeCatalogTool(), makeCatalogTool({ name: "multiply" })],
      meter,
    );
    expect(meter.cumulative()).toBeGreaterThan(before);
    expect(meter.report().perTool).toHaveLength(2);
  });
});
