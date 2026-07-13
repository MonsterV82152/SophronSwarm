import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "../../src/agent/loop.js";
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
    const r = this.responses[this.callCount++] ?? {
      content: "done",
      toolCalls: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      finishReason: "stop" as const,
      model: "fake",
    };
    return r;
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

describe("runAgent", () => {
  let dir: string;
  let registry: ToolRegistry;
  let dispatcher: ToolDispatcher;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sophron-loop-"));
    registry = new ToolRegistry();
    dispatcher = new ToolDispatcher(registry);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("injects attachments into the first user message", async () => {
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

    const { state } = await runAgent({
      agent: makeAgent(),
      task: "read the file",
      workingDir: dir,
      llm: llm as unknown as SharedServices["llm"],
      dispatcher,
      checkpointer: services.checkpointer,
      services,
      attachments: [{ path: "src/app.ts", content: "export const x = 1;" }],
    });

    const firstUser = state.messages.find((m) => m.role === "user");
    expect(firstUser?.content).toContain("ATTACHMENTS:");
    expect(firstUser?.content).toContain('<file path="src/app.ts">');
    expect(firstUser?.content).toContain("export const x = 1;");
  });

  it("stops before the first turn when abortSignal is already aborted", async () => {
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

    const controller = new AbortController();
    controller.abort();

    const { state } = await runAgent({
      agent: makeAgent(),
      task: "t",
      workingDir: dir,
      llm: llm as unknown as SharedServices["llm"],
      dispatcher,
      checkpointer: services.checkpointer,
      services,
      abortSignal: controller.signal,
    });

    expect(state.status).toBe("stopped");
    expect(llm.callCount).toBe(0);
  });

  it("stops between turns when abortSignal fires during a tool call", async () => {
    const services = makeServices(dir, registry, dispatcher);
    const llm = services.llm as unknown as FakeLLM;
    const controller = new AbortController();
    let toolRan = false;

    registry.register({
      name: "abort_trigger",
      description: "triggers abort then returns",
      parameters: { type: "object", properties: {} },
      handler: () => {
        toolRan = true;
        controller.abort();
        return "abort triggered";
      },
    } as ToolSpec);

    llm.responses = [
      {
        content: null,
        toolCalls: [makeCall("abort_trigger", {})],
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

    const { state } = await runAgent({
      agent: makeAgent(),
      task: "t",
      workingDir: dir,
      llm: llm as unknown as SharedServices["llm"],
      dispatcher,
      checkpointer: services.checkpointer,
      services,
      abortSignal: controller.signal,
    });

    expect(toolRan).toBe(true);
    expect(state.status).toBe("stopped");
    expect(llm.callCount).toBe(1);
  });

  it("passes abort signal to the tool context", async () => {
    const services = makeServices(dir, registry, dispatcher);
    const llm = services.llm as unknown as FakeLLM;
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;

    registry.register({
      name: "signal_probe",
      description: "captures the signal",
      parameters: { type: "object", properties: {} },
      handler: ({ signal }) => {
        receivedSignal = signal;
        return "ok";
      },
    } as ToolSpec);

    llm.responses = [
      {
        content: null,
        toolCalls: [makeCall("signal_probe", {})],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "tool_calls",
        model: "fake",
      },
      {
        content: "done",
        toolCalls: [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "stop",
        model: "fake",
      },
    ];

    await runAgent({
      agent: makeAgent(),
      task: "t",
      workingDir: dir,
      llm: llm as unknown as SharedServices["llm"],
      dispatcher,
      checkpointer: services.checkpointer,
      services,
      abortSignal: controller.signal,
    });

    expect(receivedSignal).toBe(controller.signal);
  });
});
