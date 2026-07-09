/**
 * Smoke test for the TUI App shell.
 *
 * Renders the App with mocked services and asserts that the initial frame
 * contains the expected chrome elements exactly once (no duplicate frames).
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "../../src/tui/app.js";
import { AgentRegistry } from "../../src/agent/registry.js";
import { ApprovalsQueue } from "../../src/tui/approvals.js";
import { SharedMemoryStore } from "../../src/memory/sharedStore.js";
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
    modelTier: "inherit",
    permissionMode: "default",
    source: "project",
    filePath: join(tmpdir(), `${name}.md`),
  };
}

function makeServices(dir: string): SharedServices {
  const shared = new SharedMemoryStore(join(dir, ".sophron", "shared"));
  const agentMem = new AgentMemoryStore(join(dir, ".sophron", "memory"));
  return {
    llm: {} as never,
    agentRegistry: { list: () => [], get: () => undefined } as never,
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

describe("App shell render", () => {
  let dir: string;
  let registry: AgentRegistry;
  let approvals: ApprovalsQueue;
  let services: SharedServices;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sophron-app-render-"));
    mkdirSync(join(dir, ".sophron", "shared"), { recursive: true });
    mkdirSync(join(dir, ".sophron", "memory"), { recursive: true });
    mkdirSync(join(dir, "agents"), { recursive: true });
    writeFileSync(
      join(dir, "agents", "builder.md"),
      "---\\nname: builder\\ndescription: builds things\\nmodel: ollama:test:1b\\n---\\n\\nYou are a builder agent.\\n",
    );
    registry = new AgentRegistry();
    registry.scan();
    approvals = new ApprovalsQueue();
    services = makeServices(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("renders a single frame with the expected chrome", () => {
    const { lastFrame } = render(<App services={services} workspaceDir={dir} approvals={approvals} registry={registry} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("V3");
    expect(frame).toContain("Home");
    // Only one set of chrome elements (no stacked frames).
    expect(frame.match(/Overview — all projects/g)?.length).toBe(1);
    expect(frame.match(/Projects/g)?.length).toBe(1);
    expect(frame.match(/  V3/g)?.length).toBe(1);
    // Single bordered frame.
    expect(frame.match(/╭/g)?.length).toBe(1);
    expect(frame.match(/╰/g)?.length).toBe(1);
  });
});
