import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PromptBuilder } from "../../src/llm/promptBuilder.js";
import { SharedMemoryStore, SHARED_FILES } from "../../src/memory/sharedStore.js";
import { AgentMemoryStore, AGENT_MEMORY_SECTIONS } from "../../src/memory/agentStore.js";
import type { AgentDefinition } from "../../src/types.js";

function makeAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: "builder",
    description: "test",
    systemPrompt: "You are a builder.",
    model: "ollama:llama3.2:1b",
    provider: "ollama",
    permissionMode: "default",
    source: "project",
    filePath: "/tmp/x.md",
    ...overrides,
  };
}

describe("PromptBuilder — memory injection", () => {
  let dir: string;
  let shared: SharedMemoryStore;
  let agent: AgentMemoryStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sophron-pbmem-"));
    shared = new SharedMemoryStore(join(dir, "shared"));
    agent = new AgentMemoryStore(join(dir, "memory"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("injects shared memory blocks into the system prompt", () => {
    shared.write(SHARED_FILES.OVERVIEW, "## Stack\nTypeScript + Node 22+\n");
    const map = shared.toInjectionMap();
    const messages = new PromptBuilder().build(makeAgent(), "do work", {
      workingDir: dir,
      sharedMemory: map,
    });
    const system = messages[0]!.content as string;
    expect(system).toContain("SHARED PROJECT CONTEXT");
    expect(system).toContain("## Stack");
    expect(system).toContain("TypeScript + Node 22+");
  });

  it("injects per-agent memory into the system prompt", () => {
    agent.append("builder", AGENT_MEMORY_SECTIONS.FAILURES, "bwrap masks /tmp workspaces", { date: "2026-07-05" });
    const mem = agent.readForInjection("builder");
    const messages = new PromptBuilder().build(makeAgent(), "do work", {
      workingDir: dir,
      agentMemory: mem,
    });
    const system = messages[0]!.content as string;
    expect(system).toContain("YOUR PAST MEMORY");
    expect(system).toContain("bwrap masks /tmp workspaces");
  });

  it("survives a full write-then-read cycle across stores (the across-runs proof)", () => {
    // Simulate run 1: agent records a gotcha.
    const r1 = agent.append("builder", AGENT_MEMORY_SECTIONS.ISSUES, "node lives at ~/.local/bin/node", {
      date: "2026-07-05",
    });
    expect(r1.appended).toBe(true);

    // Simulate run 2: a NEW store instance reads the same on-disk memory.
    const agentRun2 = new AgentMemoryStore(join(dir, "memory"));
    const mem = agentRun2.readForInjection("builder");
    expect(mem).toContain("node lives at ~/.local/bin/node");

    // And it flows into the prompt of the second run.
    const messages = new PromptBuilder().build(makeAgent(), "find node", {
      workingDir: dir,
      agentMemory: mem,
    });
    const system = messages[0]!.content as string;
    expect(system).toContain("node lives at ~/.local/bin/node");
  });

  it("injects both shared and per-agent memory together", () => {
    shared.write(SHARED_FILES.OVERVIEW, "## Goal\nShip Phase 3\n");
    agent.append("builder", AGENT_MEMORY_SECTIONS.KEY_POINTS, "memory is file-based", { date: "2026-07-05" });

    const messages = new PromptBuilder().build(makeAgent(), "do work", {
      workingDir: dir,
      sharedMemory: shared.toInjectionMap(),
      agentMemory: agent.readForInjection("builder"),
    });
    const system = messages[0]!.content as string;
    expect(system).toContain("Ship Phase 3");
    expect(system).toContain("memory is file-based");
  });

  it("omits memory sections when nothing is recorded", () => {
    const messages = new PromptBuilder().build(makeAgent(), "do work", {
      workingDir: dir,
      sharedMemory: shared.toInjectionMap(), // empty
      agentMemory: agent.readForInjection("builder"), // empty
    });
    const system = messages[0]!.content as string;
    expect(system).not.toContain("SHARED PROJECT CONTEXT");
    expect(system).not.toContain("YOUR PAST MEMORY");
  });
});
