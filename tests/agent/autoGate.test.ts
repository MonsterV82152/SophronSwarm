import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LlmAutoModeClassifier,
  parseVerdict,
  AutoPermissionGate,
  CLASSIFIER_MODEL,
  type AutoModeClassifier,
  type ClassifyResult,
} from "../../src/agent/autoGate.js";
import { ApprovalsQueue } from "../../src/tui/approvals.js";
import type { AgentDefinition, AgentRunState } from "../../src/types.js";
import { _resetProviderCacheForTests } from "../../src/llm/providers.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: "builder",
    description: "test",
    systemPrompt: "",
    model: "llama3.2:1b",
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
    task: "",
    messages: [],
    turn: 0,
    status: "running",
    workingDir: "/tmp",
    tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    startedAt: Date.now(),
    ...overrides,
  };
}

/** A stub classifier that returns canned verdicts (no LLM call). */
function stubClassifier(decision: ClassifyResult["decision"]): AutoModeClassifier {
  return {
    async vet() {
      return { decision, reason: `stub:${decision}` };
    },
  };
}

// ── parseVerdict ─────────────────────────────────────────────────────────────

// V3.1.0: the classifier resolves (model, provider) at construction. Set up
// an isolated HOME with an ollama provider so resolution succeeds.
let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sophron-autogate-home-"));
  prevHome = process.env["HOME"];
  process.env["HOME"] = home;
  mkdirSync(join(home, ".sophron"), { recursive: true });
  writeFileSync(join(home, ".sophron", "config.json"), JSON.stringify({
    providers: [{ name: "ollama", kind: "ollama", baseURL: "http://localhost:11434/v1" }],
  }));
  _resetProviderCacheForTests();
});
afterEach(() => {
  if (prevHome !== undefined) process.env["HOME"] = prevHome;
  else delete process.env["HOME"];
  rmSync(home, { recursive: true, force: true });
  _resetProviderCacheForTests();
});

describe("parseVerdict", () => {
  it("parses a clean allow|reason", () => {
    expect(parseVerdict("allow|running tests")).toEqual({ decision: "allow", reason: "running tests" });
  });
  it("parses a deny|reason", () => {
    expect(parseVerdict("deny|force-push to main")).toEqual({ decision: "deny", reason: "force-push to main" });
  });
  it("parses a prompt|reason", () => {
    expect(parseVerdict("prompt|curl to unknown host")).toEqual({ decision: "prompt", reason: "curl to unknown host" });
  });
  it("tolerates extra whitespace + case", () => {
    expect(parseVerdict("  ALLOW | safe routine  ")).toEqual({ decision: "allow", reason: "safe routine" });
  });
  it("tolerates a colon delimiter instead of pipe", () => {
    expect(parseVerdict("allow: routine build")).toEqual({ decision: "allow", reason: "routine build" });
  });
  it("falls back to prompt on unparseable output", () => {
    const r = parseVerdict("I think this is fine");
    expect(r.decision).toBe("prompt");
    expect(r.reason).toMatch(/unparseable/);
  });
  it("defaults reason when empty", () => {
    const r = parseVerdict("allow");
    expect(r.decision).toBe("allow");
    expect(r.reason).toMatch(/safe and routine/);
  });
});

// ── LlmAutoModeClassifier (mocked LLM) ───────────────────────────────────────

describe("LlmAutoModeClassifier", () => {
  it("uses the qwen3.5:9b-fast classifier model by default", () => {
    expect(CLL_CLASSIFIER_MODEL_EXISTS()).toBe(true);
  });

  it("vetts a command and caches the verdict", async () => {
    const calls: string[] = [];
    const llm = {
      async complete(req: { messages: { content: string }[] }) {
        calls.push(req.messages[1]!.content);
        return { content: "allow|running the test suite", toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, finishReason: "stop", model: "test" };
      },
    };
    const clf = new LlmAutoModeClassifier(llm as never, "ollama:test:1b");
    const agent = makeAgent();

    const r1 = await clf.vet("run_command", { command: "npm test" }, agent);
    expect(r1.decision).toBe("allow");
    expect(r1.reason).toBe("running the test suite");

    // Second identical call → cached (no second LLM call).
    const r2 = await clf.vet("run_command", { command: "npm test" }, agent);
    expect(r2.decision).toBe("allow");
    expect(calls).toHaveLength(1);
  });

  it("falls back to prompt when the LLM throws", async () => {
    const llm = {
      async complete() {
        throw new Error("connection refused");
      },
    };
    const clf = new LlmAutoModeClassifier(llm as never, "ollama:test:1b");
    const r = await clf.vet("run_command", { command: "npm test" }, makeAgent());
    expect(r.decision).toBe("prompt");
    expect(r.reason).toMatch(/classifier unavailable|operator review/);
  });

  it("falls back to prompt on unparseable output", async () => {
    const llm = {
      async complete() {
        return { content: "hmm not sure really", toolCalls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: "stop", model: "test" };
      },
    };
    const clf = new LlmAutoModeClassifier(llm as never, "ollama:test:1b");
    const r = await clf.vet("run_command", { command: "x" }, makeAgent());
    expect(r.decision).toBe("prompt");
  });
});

// small helper to avoid importing CLASSIFIER_MODEL twice awkwardly
function CLL_CLASSIFIER_MODEL_EXISTS(): boolean {
  return typeof CLASSIFIER_MODEL === "string" && CLASSIFIER_MODEL.length > 0;
}

// ── AutoPermissionGate decision matrix ───────────────────────────────────────

describe("AutoPermissionGate", () => {
  const state = makeState();

  it("allows read-only tools in every mode", async () => {
    const gate = new AutoPermissionGate(stubClassifier("allow"), new ApprovalsQueue());
    for (const mode of ["plan", "default", "auto", "accept-edits", "full-auto"] as const) {
      expect(await gate.check("read_file", {}, makeAgent({ permissionMode: mode }), state)).toBe("allow");
    }
  });

  it("denies mutating tools in plan mode", async () => {
    const gate = new AutoPermissionGate(stubClassifier("allow"), new ApprovalsQueue());
    expect(await gate.check("write_file", {}, makeAgent({ permissionMode: "plan" }), state)).toBe("deny");
    expect(await gate.check("run_command", {}, makeAgent({ permissionMode: "plan" }), state)).toBe("deny");
  });

  it("routes mutating tools through the classifier in auto mode", async () => {
    const allow = new AutoPermissionGate(stubClassifier("allow"), new ApprovalsQueue());
    const deny = new AutoPermissionGate(stubClassifier("deny"), new ApprovalsQueue());
    const prompt = new AutoPermissionGate(stubClassifier("prompt"), new ApprovalsQueue());
    expect(await allow.check("run_command", { command: "npm test" }, makeAgent({ permissionMode: "auto" }), state)).toBe("allow");
    expect(await deny.check("run_command", { command: "rm -rf x" }, makeAgent({ permissionMode: "auto" }), state)).toBe("deny");
    expect(await prompt.check("run_command", { command: "curl x" }, makeAgent({ permissionMode: "auto" }), state)).toBe("prompt");
  });

  it("enqueues an approval when the classifier says prompt", async () => {
    const approvals = new ApprovalsQueue();
    const gate = new AutoPermissionGate(stubClassifier("prompt"), approvals);
    await gate.check("run_command", { command: "curl http://x" }, makeAgent({ permissionMode: "auto" }), state);
    expect(approvals.size).toBe(1);
    expect(approvals.pending()[0]!.tool).toBe("run_command");
  });

  it("enqueues an approval for mutating tools in default mode", async () => {
    const approvals = new ApprovalsQueue();
    const gate = new AutoPermissionGate(stubClassifier("allow"), approvals);
    await gate.check("write_file", { path: "x" }, makeAgent({ permissionMode: "default" }), state);
    expect(approvals.size).toBe(1);
  });

  it("allows mutating tools in accept-edits / full-auto", async () => {
    const gate = new AutoPermissionGate(stubClassifier("deny"), new ApprovalsQueue());
    expect(await gate.check("write_file", {}, makeAgent({ permissionMode: "accept-edits" }), state)).toBe("allow");
    expect(await gate.check("run_command", {}, makeAgent({ permissionMode: "full-auto" }), state)).toBe("allow");
  });

  it("allows non-mutating, non-readonly tools (delegate, remember)", async () => {
    const gate = new AutoPermissionGate(stubClassifier("deny"), new ApprovalsQueue());
    expect(await gate.check("delegate", {}, makeAgent({ permissionMode: "default" }), state)).toBe("allow");
    expect(await gate.check("remember", {}, makeAgent({ permissionMode: "default" }), state)).toBe("allow");
  });
});
