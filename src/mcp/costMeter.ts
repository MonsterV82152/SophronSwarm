/**
 * MCP token-cost meter — estimates the token cost of promoting MCP tools.
 *
 * SwarmClaw pattern: surface the costliest servers *before* a run so operators
 * see the token impact, and track cumulative MCP token spend so the "silent
 * budget killer" (MCP schema bloat) is visible.
 *
 * Uses the existing `approxTokens` (chars / 3.5) estimator from util/tokenize —
 * the same heuristic used for LLM usage estimates.
 *
 * See docs/PHASE_4_DESIGN.md §3.4.
 */
import { approxTokens } from "../util/tokenize.js";
import { log } from "../util/log.js";

/** Token-cost estimate for a single promoted tool's schema (paid every turn it's bound). */
export interface ToolCost {
  server: string;
  tool: string;
  tokens: number;
}

/** Warn when cumulative MCP schema cost exceeds this fraction of a ~32k context window. */
export const DEFAULT_WARN_BUDGET = 4000;

export interface CostReport {
  perServer: Map<string, number>;
  perTool: ToolCost[];
  total: number;
}

export class TokenCostMeter {
  private promoted = new Map<string, ToolCost>(); // key = `server::tool`
  /** Warn threshold for cumulative MCP schema token cost. */
  readonly warnBudget: number;

  constructor(warnBudget: number = DEFAULT_WARN_BUDGET) {
    this.warnBudget = warnBudget;
  }

  /**
   * Estimate the per-turn token cost of a tool definition (its JSON-schema
   * serialized). This cost is paid every turn the tool is bound to the agent.
   */
  static estimateTool(
    server: string,
    tool: string,
    description: string | undefined,
    inputSchema: object,
  ): ToolCost {
    // The schema + name + description is what gets serialized into the LLM tool list.
    const serialized = `${tool}\n${description ?? ""}\n${JSON.stringify(inputSchema)}`;
    return { server, tool, tokens: approxTokens(serialized) };
  }

  /** Record that a tool has been promoted (becomes part of cumulative cost). */
  recordPromotion(cost: ToolCost): void {
    const key = `${cost.server}::${cost.tool}`;
    this.promoted.set(key, cost);
  }

  /** Record multiple promotions at once. */
  recordPromotions(costs: ToolCost[]): void {
    for (const c of costs) this.recordPromotion(c);
  }

  /** Remove a promoted tool from the cumulative tracker (e.g. on demotion). */
  forget(server: string, tool: string): void {
    this.promoted.delete(`${server}::${tool}`);
  }

  /** Current cumulative per-turn MCP token cost across all promoted tools. */
  cumulative(): number {
    let total = 0;
    for (const c of this.promoted.values()) total += c.tokens;
    return total;
  }

  /** Build a full report (per-server + per-tool + total). */
  report(): CostReport {
    const perServer = new Map<string, number>();
    const perTool: ToolCost[] = [];
    let total = 0;
    for (const c of this.promoted.values()) {
      perServer.set(c.server, (perServer.get(c.server) ?? 0) + c.tokens);
      perTool.push(c);
      total += c.tokens;
    }
    perTool.sort((a, b) => b.tokens - a.tokens);
    return { perServer, perTool, total };
  }

  /**
   * Emit a warning if cumulative MCP token cost exceeds the budget. Call after
   * each promotion so the operator sees the silent budget killer early.
   */
  warnIfOverBudget(): void {
    const total = this.cumulative();
    if (total > this.warnBudget) {
      const report = this.report();
      const top = report.perTool.slice(0, 3).map((t) => `${t.server}::${t.tool} (${t.tokens}t)`);
      log.warn(
        { total, budget: this.warnBudget, topCostly: top },
        "mcp token budget exceeded — promoted tools cost ~%d tokens/turn",
        total,
      );
    }
  }

  /** Reset the meter (e.g. at the start of a fresh run). */
  reset(): void {
    this.promoted.clear();
  }
}
