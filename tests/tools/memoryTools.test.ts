import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { remember } from "../../src/tools/builtin/remember.js";
import { advance_checkpoint } from "../../src/tools/builtin/advance_checkpoint.js";
import { SharedMemoryStore, SHARED_FILES } from "../../src/memory/sharedStore.js";
import { AgentMemoryStore, AGENT_MEMORY_SECTIONS } from "../../src/memory/agentStore.js";
import type { SharedServices } from "../../src/tools/schema.js";
import type { AgentDefinition, AgentRunState } from "../../src/types.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: "builder",
    description: "test",
    systemPrompt: "",
    model: "ollama:llama3.2:1b",
    provider: "ollama",
    permissionMode: "default",
    source: "project",
    filePath: "/tmp/x.md",
    ...overrides,
  };
}

function makeState(overrides: Partial<AgentRunState> = {}): AgentRunState {
  return {
    runId: "r1",
    threadId: "t1",
    agentName: "builder",
    task: "do work",
    messages: [],
    turn: 0,
    status: "running",
    workingDir: "/tmp",
    tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    startedAt: Date.now(),
    ...overrides,
  };
}

function makeServices(shared: SharedMemoryStore, agent: AgentMemoryStore): SharedServices {
  return {
    llm: {} as never,
    agentRegistry: {} as never,
    toolRegistry: {} as never,
    dispatcher: {} as never,
    checkpointer: {} as never,
    sharedMemoryStore: shared,
    agentMemoryStore: agent,
  };
}

// ── remember tool ────────────────────────────────────────────────────────────

describe("remember tool", () => {
  let dir: string;
  let shared: SharedMemoryStore;
  let agent: AgentMemoryStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sophron-remember-"));
    shared = new SharedMemoryStore(join(dir, "shared"));
    agent = new AgentMemoryStore(join(dir, "memory"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes a per-agent note with a friendly section alias", () => {
    const out = remember.handler({
      args: { scope: "per-agent", section: "failure", note: "bwrap masks /tmp workspaces" },
      agent: makeAgent(),
      state: makeState(),
      services: makeServices(shared, agent),
    });
    expect(out).toMatch(/saved to per-agent/i);
    const body = agent.readSection("builder", AGENT_MEMORY_SECTIONS.FAILURES);
    expect(body).toContain("bwrap masks /tmp workspaces");
  });

  it("writes a shared note to the overview file", () => {
    const out = remember.handler({
      args: { scope: "shared", section: "Stack", note: "TypeScript primary", file: "overview" },
      agent: makeAgent(),
      state: makeState(),
      services: makeServices(shared, agent),
    });
    expect(out).toMatch(/saved to shared memory/i);
    expect(shared.readSection(SHARED_FILES.OVERVIEW, "Stack")).toContain("TypeScript primary");
  });

  it("rejects an unknown per-agent section", () => {
    const out = remember.handler({
      args: { scope: "per-agent", section: "bogus", note: "some note that is long enough" },
      agent: makeAgent(),
      state: makeState(),
      services: makeServices(shared, agent),
    });
    expect(out).toMatch(/unknown per-agent section/i);
  });

  it("rejects a too-short note", () => {
    const out = remember.handler({
      args: { scope: "per-agent", section: "issue", note: "x" },
      agent: makeAgent(),
      state: makeState(),
      services: makeServices(shared, agent),
    });
    expect(out).toMatch(/not saved/i);
  });

  it("denies a scope not in the agent's memoryScopes", () => {
    const out = remember.handler({
      args: { scope: "shared", section: "X", note: "some long enough note here" },
      agent: makeAgent({ memoryScopes: ["per-agent"] }),
      state: makeState(),
      services: makeServices(shared, agent),
    });
    expect(out).toMatch(/not permitted/i);
  });

  it("accepts the full canonical section name", () => {
    const out = remember.handler({
      args: { scope: "per-agent", section: "Past Points of Failure", note: "a meaningful failure note here" },
      agent: makeAgent(),
      state: makeState(),
      services: makeServices(shared, agent),
    });
    expect(out).toMatch(/saved to per-agent/i);
  });
});

// ── advance_checkpoint tool ──────────────────────────────────────────────────

describe("advance_checkpoint tool", () => {
  let dir: string;
  let shared: SharedMemoryStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sophron-advck-"));
    shared = new SharedMemoryStore(join(dir, "shared"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("advances and reports the new current checkpoint", () => {
    shared.write(SHARED_FILES.CHECKPOINTS, "1. [ ] A\n2. [ ] B\n");
    shared.write(SHARED_FILES.CURRENT_CHECKPOINT, "# Current Checkpoint\n\nA\n");
    const out = advance_checkpoint.handler({
      args: {},
      agent: makeAgent(),
      state: makeState(),
      services: makeServices(shared, new AgentMemoryStore(join(dir, "m"))),
    });
    expect(out).toMatch(/checkpoint advanced/i);
    expect(out).toContain("Now current: B");
    expect(shared.read(SHARED_FILES.CURRENT_CHECKPOINT)).toContain("B");
  });

  it("reports when there is nothing to advance to", () => {
    shared.write(SHARED_FILES.CHECKPOINTS, "1. [x] A\n");
    const out = advance_checkpoint.handler({
      args: {},
      agent: makeAgent(),
      state: makeState(),
      services: makeServices(shared, new AgentMemoryStore(join(dir, "m"))),
    });
    expect(out).toMatch(/not advanced/i);
  });
});
