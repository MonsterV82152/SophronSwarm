import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runManager } from "../../src/agent/runManager.js";
import { Checkpointer } from "../../src/state/checkpointer.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { ToolDispatcher } from "../../src/tools/dispatcher.js";
import type { SharedServices, ToolSpec } from "../../src/tools/schema.js";
import type { AgentDefinition, LLMResponse, ToolCall } from "../../src/types.js";

function makeAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: "test-agent",
    description: "test",
    systemPrompt: "",
    model: "ollama:dummy",
    provider: "ollama",
    permissionMode: "default",
    source: "project",
    filePath: "/tmp/x.md",
    ...overrides,
  };
}

function makeCall(name: string, args: object): ToolCall {
  return { id: `call_${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

class FakeLLM {
  responses: LLMResponse[] = [];
  callCount = 0;
  async complete(): Promise<LLMResponse> {
    return this.responses[this.callCount++] ?? {
      content: "done",
      toolCalls: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      finishReason: "stop",
      model: "fake",
    };
  }
}

function makeServices(dir: string, registry: ToolRegistry, dispatcher: ToolDispatcher): SharedServices {
  return {
    sharedMemoryStore: { toInjectionMap: () => new Map() },
    agentMemoryStore: { readForInjection: () => "" },
    mcpPool: { configuredServers: () => [] },
    mcpCatalog: { refresh: async () => {}, forServer: () => [] },
    mcpCostMeter: {},
    approvals: {},
    purifier: undefined,
    llm: new FakeLLM() as unknown as SharedServices["llm"],
    agentRegistry: { get: () => undefined, list: () => [] },
    toolRegistry: registry,
    dispatcher,
    checkpointer: new Checkpointer(join(dir, "checkpoint.db")),
  } as unknown as SharedServices;
}

describe("runManager", () => {
  let dir: string;
  let registry: ToolRegistry;
  let dispatcher: ToolDispatcher;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sophron-runmgr-"));
    registry = new ToolRegistry();
    dispatcher = new ToolDispatcher(registry);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("tracks a started run and exposes it via listActive", async () => {
    const services = makeServices(dir, registry, dispatcher);
    const llm = services.llm as unknown as FakeLLM;
    llm.responses = [
      {
        content: "ok",
        toolCalls: [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "stop",
        model: "fake",
      },
    ];

    const { runId, promise } = runManager.start({
      agent: makeAgent(),
      task: "t",
      workingDir: dir,
      llm: llm as unknown as SharedServices["llm"],
      dispatcher,
      checkpointer: services.checkpointer,
      services,
    });

    expect(runId).toBeTruthy();
    expect(runManager.listActive().some((r) => r.runId === runId)).toBe(true);

    const state = await promise;
    expect(state.status).toBe("complete");
  });

  it("stops a running run and sets status to stopped", async () => {
    const services = makeServices(dir, registry, dispatcher);
    const llm = services.llm as unknown as FakeLLM;
    llm.responses = [
      {
        content: null,
        toolCalls: [makeCall("echo", { text: "hi" })],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "tool_calls",
        model: "fake",
      },
      {
        content: "should not run",
        toolCalls: [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "stop",
        model: "fake",
      },
    ];

    registry.register({
      name: "echo",
      description: "echo",
      parameters: { type: "object", properties: { text: { type: "string" } } },
      handler: ({ args }) => String(args["text"]),
    } as ToolSpec);

    const { runId, promise } = runManager.start({
      agent: makeAgent(),
      task: "t",
      workingDir: dir,
      llm: llm as unknown as SharedServices["llm"],
      dispatcher,
      checkpointer: services.checkpointer,
      services,
    });

    runManager.stop(runId);

    const state = await promise;
    expect(state.status).toBe("stopped");
  });

  it("finds a running agent by name", async () => {
    const services = makeServices(dir, registry, dispatcher);
    const llm = services.llm as unknown as FakeLLM;
    llm.responses = [
      {
        content: "ok",
        toolCalls: [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "stop",
        model: "fake",
      },
    ];

    const { runId } = runManager.start({
      agent: makeAgent({ name: "builder" }),
      task: "t",
      workingDir: dir,
      llm: llm as unknown as SharedServices["llm"],
      dispatcher,
      checkpointer: services.checkpointer,
      services,
    });

    const active = runManager.isRunning("builder");
    expect(active?.runId).toBe(runId);
  });

  it("cascades stop to child runs", async () => {
    const services = makeServices(dir, registry, dispatcher);
    const llm = services.llm as unknown as FakeLLM;

    // Parent run that never finishes on its own (infinite tool-call loop).
    llm.responses = [
      {
        content: null,
        toolCalls: [makeCall("noop", {})],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "tool_calls",
        model: "fake",
      },
    ];
    registry.register({
      name: "noop",
      description: "noop",
      parameters: { type: "object", properties: {} },
      handler: () => "noop",
    } as ToolSpec);

    const { runId: parentRunId } = runManager.start({
      agent: makeAgent({ name: "parent" }),
      task: "t",
      workingDir: dir,
      llm: llm as unknown as SharedServices["llm"],
      dispatcher,
      checkpointer: services.checkpointer,
      services,
    });

    // Child run that also never finishes.
    const childLLM = new FakeLLM();
    childLLM.responses = [
      {
        content: null,
        toolCalls: [makeCall("noop", {})],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "tool_calls",
        model: "fake",
      },
    ];
    const { runId: childRunId } = runManager.start({
      agent: makeAgent({ name: "child" }),
      task: "t",
      workingDir: dir,
      llm: childLLM as unknown as SharedServices["llm"],
      dispatcher,
      checkpointer: services.checkpointer,
      services,
      parentId: parentRunId,
    });

    // Let both runs start, then stop the parent.
    await new Promise((r) => setTimeout(r, 10));
    runManager.stop(parentRunId);

    expect(runManager.get(parentRunId)?.status).toBe("stopped");
    expect(runManager.get(childRunId)?.status).toBe("stopped");
  });
});
