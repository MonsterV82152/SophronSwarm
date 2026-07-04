import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "../../src/tools/registry.js";
import { ToolDispatcher } from "../../src/tools/dispatcher.js";
import { BUILTIN_TOOLS } from "../../src/tools/builtin/index.js";
import type { AgentDefinition, AgentRunState, ToolCall } from "../../src/types.js";

function makeCall(name: string, args: object): ToolCall {
  return { id: `call_${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function makeAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: "test-agent",
    description: "test",
    systemPrompt: "",
    model: "ollama:dummy",
    modelTier: "inherit",
    permissionMode: "default",
    source: "project",
    filePath: "/tmp/x.md",
    ...overrides,
  };
}

function makeState(workingDir: string): AgentRunState {
  return {
    runId: "r1",
    threadId: "t1",
    agentName: "test-agent",
    task: "t",
    messages: [],
    turn: 0,
    status: "running",
    workingDir,
    tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    startedAt: Date.now(),
  };
}

describe("ToolDispatcher", () => {
  let dir: string;
  let registry: ToolRegistry;
  let dispatcher: ToolDispatcher;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sophron-tools-"));
    registry = new ToolRegistry();
    for (const t of BUILTIN_TOOLS) registry.register(t);
    dispatcher = new ToolDispatcher(registry);
  });

  it("echoes text back", async () => {
    const r = await dispatcher.dispatch(makeCall("echo", { text: "hi" }), makeAgent(), makeState(dir));
    expect(r.isError).toBeFalsy();
    expect(r.content).toBe("hi");
  });

  it("returns isError for unknown tool", async () => {
    const r = await dispatcher.dispatch(makeCall("nope", {}), makeAgent(), makeState(dir));
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/Unknown tool/);
  });

  it("returns isError for invalid JSON arguments", async () => {
    const call: ToolCall = { id: "c", type: "function", function: { name: "echo", arguments: "{bad" } };
    const r = await dispatcher.dispatch(call, makeAgent(), makeState(dir));
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/Invalid JSON/);
  });

  it("enforces the allowlist", async () => {
    const agent = makeAgent({ tools: ["read_file"] });
    const r = await dispatcher.dispatch(makeCall("echo", { text: "hi" }), agent, makeState(dir));
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/not in this agent's allowlist/);
  });

  it("enforces the denylist", async () => {
    const agent = makeAgent({ disallowedTools: ["echo"] });
    const r = await dispatcher.dispatch(makeCall("echo", { text: "hi" }), agent, makeState(dir));
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/disallowed/);
  });

  it("reads a file that exists", async () => {
    writeFileSync(join(dir, "hello.txt"), "world");
    const r = await dispatcher.dispatch(makeCall("read_file", { path: "hello.txt" }), makeAgent(), makeState(dir));
    expect(r.content).toBe("world");
  });

  it("returns explicit marker for missing file", async () => {
    const r = await dispatcher.dispatch(makeCall("read_file", { path: "missing.txt" }), makeAgent(), makeState(dir));
    expect(r.content).toBe("(file does not exist on disk)");
  });

  it("writes a file (creates parent dirs)", async () => {
    const r = await dispatcher.dispatch(
      makeCall("write_file", { path: "sub/dir/a.txt", content: "hi" }),
      makeAgent(),
      makeState(dir),
    );
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/Wrote 2 chars/);
  });

  it("lists a directory", async () => {
    writeFileSync(join(dir, "a.txt"), "x");
    const r = await dispatcher.dispatch(makeCall("list_dir", {}), makeAgent(), makeState(dir));
    const parsed = JSON.parse(r.content);
    expect(parsed.some((e: { name: string }) => e.name === "a.txt")).toBe(true);
  });

  it("rejects path traversal", async () => {
    const r = await dispatcher.dispatch(
      makeCall("read_file", { path: "../../../../etc/passwd" }),
      makeAgent(),
      makeState(dir),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/escapes workspace root/);
  });

  it("surfaces handler exceptions as isError (never throws)", async () => {
    // write_file to a path that's actually an existing directory → throw → isError
    const r = await dispatcher.dispatch(
      makeCall("write_file", { path: ".", content: "x" }),
      makeAgent(),
      makeState(dir),
    );
    expect(r.isError).toBe(true);
  });
});
