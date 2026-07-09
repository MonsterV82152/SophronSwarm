import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "../../src/tools/registry.js";
import { ToolDispatcher } from "../../src/tools/dispatcher.js";
import { BUILTIN_TOOLS } from "../../src/tools/builtin/index.js";
import { Purifier } from "../../src/tools/purifier.js";
import type { SharedServices } from "../../src/tools/schema.js";
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

  it("reads a file via absolute path under the workspace", async () => {
    writeFileSync(join(dir, "abs.txt"), "absolute");
    const r = await dispatcher.dispatch(
      makeCall("read_file", { path: join(dir, "abs.txt") }),
      makeAgent(),
      makeState(dir),
    );
    expect(r.isError).toBeFalsy();
    expect(r.content).toBe("absolute");
  });

  it("lists a directory via absolute path", async () => {
    writeFileSync(join(dir, "abs-dir-file.txt"), "x");
    const r = await dispatcher.dispatch(
      makeCall("list_dir", { path: dir }),
      makeAgent(),
      makeState(dir),
    );
    const parsed = JSON.parse(r.content);
    expect(parsed.some((e: { name: string }) => e.name === "abs-dir-file.txt")).toBe(true);
  });

  it("rejects absolute path outside workspace for project agents", async () => {
    const outside = mkdtempSync(join(tmpdir(), "sophron-out-"));
    writeFileSync(join(outside, "secret.txt"), "x");
    const r = await dispatcher.dispatch(
      makeCall("read_file", { path: join(outside, "secret.txt") }),
      makeAgent(),
      makeState(dir),
    );
    rmSync(outside, { recursive: true, force: true });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/outside allowed workspaces/);
  });

  it("allows global agents to read absolute paths under the workspace root", async () => {
    const origHome = process.env.HOME;
    const fakeHome = mkdtempSync(join(tmpdir(), "sophron-home-"));
    process.env.HOME = fakeHome;
    try {
      const projectRoot = join(fakeHome, "sophron_workspace", "demo-project");
      mkdirSync(projectRoot, { recursive: true });
      writeFileSync(join(projectRoot, "note.txt"), "hello project");

      const r = await dispatcher.dispatch(
        makeCall("read_file", { path: join(projectRoot, "note.txt") }),
        makeAgent({ name: "global-orchestrator", noMemory: true }),
        makeState(join(fakeHome, ".sophron")),
      );
      expect(r.isError).toBeFalsy();
      expect(r.content).toBe("hello project");
    } finally {
      process.env.HOME = origHome;
      rmSync(fakeHome, { recursive: true, force: true });
    }
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

  describe("output purifier integration", () => {
    it("purifies run_command output when a purifier is wired into services", async () => {
      // Register a fake "run_command" that returns noisy ANSI output.
      registry.register({
        name: "run_command",
        description: "test noisy tool",
        parameters: { type: "object", properties: { cmd: { type: "string" } } },
        handler: () => "\x1b[32mBUILD SUCCESS\x1b[0m\n\n\n\nDone",
      });
      const purifier = new Purifier(); // deterministic-only (no llm)
      const services = { purifier } as unknown as SharedServices;
      const r = await dispatcher.dispatch(
        makeCall("run_command", { cmd: "echo hi" }),
        makeAgent(),
        makeState(dir),
        services,
      );
      expect(r.isError).toBeFalsy();
      expect(r.content).not.toContain("\x1b[");
      expect(r.content).toContain("BUILD SUCCESS");
      expect(r.content).toContain("Done");
      expect(r.rawPath).toBeDefined();
      // ANSI stripped (the whole point of purification).
      expect(r.content).not.toContain("\x1b[");
      // The collapseBlankLines rule is unit-tested in purifier.test.ts;
      // here we only confirm the marker points at the saved raw path.
      expect(r.content).toContain("[output purified");
    });

    it("skips purification for read_file even with a purifier wired", async () => {
      writeFileSync(join(dir, "code.txt"), "function foo() {}\n");
      const purifier = new Purifier();
      const services = { purifier } as unknown as SharedServices;
      const r = await dispatcher.dispatch(
        makeCall("read_file", { path: "code.txt" }),
        makeAgent(),
        makeState(dir),
        services,
      );
      // read_file is not in the noisy set → passthrough, no rawPath.
      expect(r.content).toBe("function foo() {}\n");
      expect(r.rawPath).toBeUndefined();
    });

    it("does not purify when outputPurifier is off", async () => {
      registry.register({
        name: "run_command",
        description: "test noisy tool",
        parameters: { type: "object", properties: { cmd: { type: "string" } } },
        handler: () => "\x1b[32mraw\x1b[0m",
      });
      const purifier = new Purifier();
      const services = { purifier } as unknown as SharedServices;
      const r = await dispatcher.dispatch(
        makeCall("run_command", { cmd: "x" }),
        makeAgent({ outputPurifier: "off" }),
        makeState(dir),
        services,
      );
      // Off mode: content unchanged, ANSI preserved, no rawPath.
      expect(r.content).toBe("\x1b[32mraw\x1b[0m");
      expect(r.rawPath).toBeUndefined();
    });
  });
});
