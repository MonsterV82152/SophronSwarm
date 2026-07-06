import { describe, expect, it } from "vitest";
import { TokenCostMeter, type ToolCost } from "../../src/mcp/costMeter.js";

describe("TokenCostMeter.estimateTool", () => {
  it("estimates a non-zero cost from the schema", () => {
    const cost = TokenCostMeter.estimateTool("srv", "add", "Add two numbers", {
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
      required: ["a", "b"],
    });
    expect(cost.server).toBe("srv");
    expect(cost.tool).toBe("add");
    expect(cost.tokens).toBeGreaterThan(0);
  });

  it("larger schemas cost more than smaller ones", () => {
    const small = TokenCostMeter.estimateTool("s", "x", "do", { type: "object" });
    const big = TokenCostMeter.estimateTool("s", "x", "do something very complex", {
      type: "object",
      properties: {
        a: { type: "string", description: "a long description " + "x".repeat(200) },
        b: { type: "array", items: { type: "object", properties: { nested: { type: "string" } } } },
      },
    });
    expect(big.tokens).toBeGreaterThan(small.tokens);
  });
});

describe("TokenCostMeter cumulative tracking", () => {
  it("starts at zero", () => {
    expect(new TokenCostMeter().cumulative()).toBe(0);
  });

  it("sums promoted tool costs", () => {
    const meter = new TokenCostMeter();
    meter.recordPromotion(TokenCostMeter.estimateTool("a", "x", "d", { type: "object" }));
    meter.recordPromotion(TokenCostMeter.estimateTool("b", "y", "d", { type: "object" }));
    expect(meter.cumulative()).toBeGreaterThan(0);
  });

  it("deduplicates on re-promotion of the same server::tool", () => {
    const meter = new TokenCostMeter();
    const cost = TokenCostMeter.estimateTool("a", "x", "d", { type: "object" });
    meter.recordPromotion(cost);
    const before = meter.cumulative();
    meter.recordPromotion(cost); // same server::tool → overwrite, not add
    expect(meter.cumulative()).toBe(before);
  });

  it("forget removes a tool from the cumulative", () => {
    const meter = new TokenCostMeter();
    meter.recordPromotion(TokenCostMeter.estimateTool("a", "x", "d", { type: "object" }));
    const before = meter.cumulative();
    meter.forget("a", "x");
    expect(meter.cumulative()).toBeLessThan(before);
    expect(meter.cumulative()).toBe(0);
  });

  it("reset clears everything", () => {
    const meter = new TokenCostMeter();
    meter.recordPromotion(TokenCostMeter.estimateTool("a", "x", "d", { type: "object" }));
    meter.reset();
    expect(meter.cumulative()).toBe(0);
  });
});

describe("TokenCostMeter.report", () => {
  it("aggregates per-server and sorts per-tool by cost", () => {
    const meter = new TokenCostMeter();
    meter.recordPromotion(TokenCostMeter.estimateTool("a", "small", "d", { type: "object" }));
    meter.recordPromotion(
      TokenCostMeter.estimateTool("a", "BIG", "d".repeat(200), {
        type: "object",
        properties: { x: { type: "string", description: "y".repeat(200) } },
      }),
    );
    meter.recordPromotion(TokenCostMeter.estimateTool("b", "mid", "d".repeat(50), { type: "object" }));

    const report = meter.report();
    expect(report.perServer.get("a")).toBeGreaterThan(report.perServer.get("b"));
    // Per-tool sorted descending: BIG should be first.
    expect(report.perTool[0]!.tool).toBe("BIG");
    expect(report.total).toBe(meter.cumulative());
  });
});

describe("TokenCostMeter.warnIfOverBudget", () => {
  it("does not throw when under budget", () => {
    const meter = new TokenCostMeter(100000);
    meter.recordPromotion(TokenCostMeter.estimateTool("a", "x", "d", { type: "object" }));
    expect(() => meter.warnIfOverBudget()).not.toThrow();
  });

  it("still runs (logs) when over budget without throwing", () => {
    const meter = new TokenCostMeter(1); // tiny budget
    meter.recordPromotion(TokenCostMeter.estimateTool("a", "x", "d", { type: "object" }));
    expect(() => meter.warnIfOverBudget()).not.toThrow();
  });
});
