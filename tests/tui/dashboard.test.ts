import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDashboard, readRecentRuns, readRunDetail, formatTokens } from "../../src/tui/dashboard.js";
import { SharedMemoryStore, SHARED_FILES } from "../../src/memory/sharedStore.js";
import { AgentMemoryStore } from "../../src/memory/agentStore.js";
import { McpConnectionPool } from "../../src/mcp/pool.js";
import { McpToolCatalog } from "../../src/mcp/catalog.js";
import { TokenCostMeter } from "../../src/mcp/costMeter.js";
import type { SharedServices } from "../../src/tools/schema.js";
import type { AgentDefinition } from "../../src/types.js";

function makeAgent(name: string): AgentDefinition {
  return {
    name,
    description: `${name} agent`,
    systemPrompt: "",
    model: "ollama:test:1b",
    provider: "ollama",
    permissionMode: "default",
    source: "project",
    filePath: "/tmp/x.md",
  };
}

function makeServices(dir: string, agents: AgentDefinition[]): SharedServices {
  const shared = new SharedMemoryStore(join(dir, ".sophron", "shared"));
  const agentMem = new AgentMemoryStore(join(dir, ".sophron", "memory"));
  return {
    llm: {} as never,
    agentRegistry: {
      list: () => agents,
      get: (n: string) => agents.find((a) => a.name === n),
    } as never,
    toolRegistry: {} as never,
    dispatcher: {} as never,
    checkpointer: {} as never,
    sharedMemoryStore: shared,
    agentMemoryStore: agentMem,
    mcpPool: new McpConnectionPool([]),
    mcpCatalog: new McpToolCatalog(new McpConnectionPool([])),
    mcpCostMeter: new TokenCostMeter(),
  };
}

function writeRunFile(dir: string, name: string, agent: string, status: string, tokens: number, ts: number): void {
  const lines = [
    JSON.stringify({ type: "run_start", runId: name, agent, ts }),
    JSON.stringify({ type: "run_end", status, turns: 3, totalUsage: { totalTokens: tokens }, ts: ts + 1000 }),
  ];
  writeFileSync(join(dir, "runs", name), lines.join("\n") + "\n");
}

describe("formatTokens", () => {
  it("formats small counts as-is", () => {
    expect(formatTokens(42)).toBe("42");
    expect(formatTokens(999)).toBe("999");
  });
  it("formats thousands with one decimal", () => {
    expect(formatTokens(1234)).toBe("1.2k");
    expect(formatTokens(10000)).toBe("10.0k");
  });
});

describe("readRecentRuns", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sophron-dash-"));
    mkdirSync(join(dir, "runs"), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns empty when no runs dir exists", () => {
    rmSync(join(dir, "runs"), { recursive: true, force: true });
    expect(readRecentRuns(dir, 5)).toEqual([]);
  });

  it("reads a run file into a summary", () => {
    writeRunFile(dir, "events_a.jsonl", "builder", "complete", 1000, 100000);
    const runs = readRecentRuns(dir, 5);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ agent: "builder", status: "complete", turns: 3, tokens: 1000 });
  });

  it("returns the most recent first, limited", () => {
    writeRunFile(dir, "events_old.jsonl", "a", "complete", 100, 100000);
    writeRunFile(dir, "events_new.jsonl", "b", "complete", 200, 200000);
    const runs = readRecentRuns(dir, 1);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.agent).toBe("b");
  });

  it("ignores malformed jsonl gracefully", () => {
    writeFileSync(join(dir, "runs", "bad.jsonl"), "not json\n{also bad\n");
    expect(readRecentRuns(dir, 5)).toEqual([]);
  });
});

describe("buildDashboard", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sophron-dash2-"));
    mkdirSync(join(dir, "runs"), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("aggregates agents, checkpoints, mcp cost, and runs", () => {
    const services = makeServices(dir, [makeAgent("builder"), makeAgent("orchestrator")]);
    services.sharedMemoryStore.write(SHARED_FILES.CHECKPOINTS, "1. [ ] Phase 0\n2. [ ] Phase 1\n");
    services.sharedMemoryStore.write(SHARED_FILES.CURRENT_CHECKPOINT, "# Current Checkpoint\n\nPhase 0\n");
    writeRunFile(dir, "events_x.jsonl", "builder", "complete", 500, 100000);

    const model = buildDashboard(services, { workspaceDir: dir });
    expect(model.agents.map((a) => a.name)).toEqual(["builder", "orchestrator"]);
    expect(model.checkpoint.current).toBe("Phase 0");
    expect(model.checkpoint.milestones).toHaveLength(2);
    expect(model.mcpCost.total).toBe(0);
    expect(model.recentRuns).toHaveLength(1);
    expect(model.recentRuns[0]!.agent).toBe("builder");
  });

  it("degrades gracefully with empty workspace", () => {
    const services = makeServices(dir, []);
    const model = buildDashboard(services, { workspaceDir: dir });
    expect(model.agents).toEqual([]);
    expect(model.checkpoint.current).toBe("(none set)");
    expect(model.checkpoint.milestones).toEqual([]);
    expect(model.recentRuns).toEqual([]);
  });

  it("includes approvalsPending count when provided", () => {
    const services = makeServices(dir, []);
    const model = buildDashboard(services, { workspaceDir: dir, approvalsPending: 3 });
    expect(model.approvalsPending).toBe(3);
  });
});

describe("readRunDetail", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sophron-rundetail-"));
    mkdirSync(join(dir, "runs"), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function writeEvents(name: string, lines: object[]): void {
    writeFileSync(join(dir, "runs", name), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  }

  it("returns null when no runs dir exists", () => {
    rmSync(join(dir, "runs"), { recursive: true, force: true });
    expect(readRunDetail(dir, "anything")).toBeNull();
  });

  it("parses a run's events into a structured detail", () => {
    writeEvents("events_2026-07-05_abc12345.jsonl", [
      { type: "run_start", runId: "abc12345", agent: "builder", task: "do work", ts: 1000 },
      { type: "turn_start", turn: 0, ts: 1001 },
      { type: "tool_call_start", tool: "echo", turn: 0, args: { text: "hi" }, ts: 1002 },
      { type: "tool_call_result", tool: "echo", turn: 0, resultPreview: "hi", isError: false, ts: 1003 },
      { type: "run_end", status: "complete", turns: 1, totalUsage: { totalTokens: 800 }, ts: 1004 },
    ]);
    const detail = readRunDetail(dir, "abc12345");
    expect(detail).not.toBeNull();
    expect(detail!.agent).toBe("builder");
    expect(detail!.task).toBe("do work");
    expect(detail!.status).toBe("complete");
    expect(detail!.tokens).toBe(800);
    expect(detail!.events.length).toBeGreaterThanOrEqual(4);
    // tool_call_result event should be flagged from the JSONL.
    const resultEv = detail!.events.find((e) => e.label === "← echo");
    expect(resultEv?.detail).toContain("hi");
  });

  it("matches by filename substring (runId prefix)", () => {
    writeEvents("events_2026-07-05_deadbeef.jsonl", [
      { type: "run_start", runId: "deadbeef", agent: "x", ts: 1 },
    ]);
    expect(readRunDetail(dir, "deadbeef")?.agent).toBe("x");
  });

  it("returns null for an unknown runId", () => {
    writeEvents("events_x.jsonl", [{ type: "run_start", runId: "x", agent: "x", ts: 1 }]);
    expect(readRunDetail(dir, "nonexistent")).toBeNull();
  });

  it("ignores malformed lines gracefully", () => {
    // Write a mix: one malformed line + one valid event (raw, not via writeEvents).
    writeFileSync(
      join(dir, "runs", "events_y.jsonl"),
      "not valid json\n" + JSON.stringify({ type: "run_start", runId: "y", agent: "y" }) + "\n",
    );
    expect(readRunDetail(dir, "y")?.agent).toBe("y");
  });
});
