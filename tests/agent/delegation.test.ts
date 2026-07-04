import { describe, expect, it } from "vitest";
import { checkPolicy, buildChildCtx, buildHandoffPacket, formatHandoffPacket } from "../../src/agent/delegation.js";
import { MAX_DEPTH } from "../../src/agent/delegation.js";
import type { AgentDefinition, AgentRunState, DelegationContext } from "../../src/types.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: "orchestrator",
    description: "test",
    systemPrompt: "",
    model: "ollama:llama3.2:1b",
    modelTier: "inherit",
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
    agentName: "orchestrator",
    task: "do work",
    messages: [],
    turn: 3,
    status: "complete",
    workingDir: "/tmp",
    tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    startedAt: Date.now(),
    ...overrides,
  };
}

// ── checkPolicy ───────────────────────────────────────────────────────────────

describe("checkPolicy", () => {
  it("allows when no ctx and no allowlist", () => {
    const r = checkPolicy("coder", makeAgent(), undefined);
    expect(r.allowed).toBe(true);
  });

  it("blocks when depth equals MAX_DEPTH", () => {
    const ctx: DelegationContext = {
      parentRunId: "p",
      parentThreadId: "pt",
      depth: MAX_DEPTH,
      ancestry: [],
    };
    const r = checkPolicy("coder", makeAgent(), ctx);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/depth/i);
  });

  it("blocks when depth exceeds MAX_DEPTH", () => {
    const ctx: DelegationContext = { parentRunId: "p", parentThreadId: "pt", depth: MAX_DEPTH + 2, ancestry: [] };
    expect(checkPolicy("coder", makeAgent(), ctx).allowed).toBe(false);
  });

  it("blocks on cycle — target already in ancestry", () => {
    const ctx: DelegationContext = {
      parentRunId: "p",
      parentThreadId: "pt",
      depth: 2,
      ancestry: ["orchestrator", "coder"],
    };
    const r = checkPolicy("coder", makeAgent(), ctx);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/cycle/i);
  });

  it("allows target not yet in ancestry", () => {
    const ctx: DelegationContext = { parentRunId: "p", parentThreadId: "pt", depth: 1, ancestry: ["orchestrator"] };
    const r = checkPolicy("reviewer", makeAgent(), ctx);
    expect(r.allowed).toBe(true);
  });

  it("blocks when target not in allowlist", () => {
    const agent = makeAgent({ delegateAllowlist: ["coder", "reviewer"] });
    const r = checkPolicy("security", agent, undefined);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/allowlist/i);
  });

  it("allows when target is in allowlist", () => {
    const agent = makeAgent({ delegateAllowlist: ["coder", "reviewer"] });
    expect(checkPolicy("coder", agent, undefined).allowed).toBe(true);
  });

  it("ignores allowlist when it is empty (no restriction)", () => {
    const agent = makeAgent({ delegateAllowlist: [] });
    expect(checkPolicy("anyone", agent, undefined).allowed).toBe(true);
  });
});

// ── buildChildCtx ────────────────────────────────────────────────────────────

describe("buildChildCtx", () => {
  it("depth is 1 for first delegation from main session", () => {
    const ctx = buildChildCtx(makeAgent(), makeState());
    expect(ctx.depth).toBe(1);
  });

  it("depth increments correctly in a chain", () => {
    const state = makeState({
      delegationCtx: { parentRunId: "p", parentThreadId: "pt", depth: 2, ancestry: ["root", "mid"] },
    });
    const ctx = buildChildCtx(makeAgent(), state);
    expect(ctx.depth).toBe(3);
    expect(ctx.ancestry).toEqual(["root", "mid", "orchestrator"]);
  });

  it("appends the caller's name to ancestry", () => {
    const agent = makeAgent({ name: "architect" });
    const ctx = buildChildCtx(agent, makeState());
    expect(ctx.ancestry).toContain("architect");
  });

  it("preserves parentRunId and parentThreadId", () => {
    const state = makeState({ runId: "myrun", threadId: "mythread" });
    const ctx = buildChildCtx(makeAgent(), state);
    expect(ctx.parentRunId).toBe("myrun");
    expect(ctx.parentThreadId).toBe("mythread");
  });
});

// ── buildHandoffPacket ───────────────────────────────────────────────────────

describe("buildHandoffPacket", () => {
  it("extracts the last assistant message as summary", () => {
    const state = makeState({
      messages: [
        { role: "user", content: "do x" },
        { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "echo", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "c1", content: "ok" },
        { role: "assistant", content: "All done. I wrote the file." },
      ],
    });
    const p = buildHandoffPacket(state, "the task");
    expect(p.summary).toBe("All done. I wrote the file.");
  });

  it("falls back summary when no final text message", () => {
    const state = makeState({
      status: "halted",
      messages: [{ role: "user", content: "go" }],
    });
    const p = buildHandoffPacket(state, "t");
    expect(p.summary).toBe("(no final response)");
    expect(p.outcome).toBe("halted");
  });

  it("extracts files from write_file calls", () => {
    const state = makeState({
      messages: [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "src/app.ts", content: "x" }) } }],
        },
        { role: "tool", tool_call_id: "c1", content: "Wrote 1 chars to src/app.ts" },
        { role: "assistant", content: "done" },
      ],
    });
    const p = buildHandoffPacket(state, "t");
    expect(p.filesChanged).toContain("src/app.ts");
  });

  it("outcome is success for complete status", () => {
    expect(buildHandoffPacket(makeState({ status: "complete" }), "t").outcome).toBe("success");
  });

  it("outcome is failure for error status", () => {
    expect(buildHandoffPacket(makeState({ status: "error" }), "t").outcome).toBe("failure");
  });

  it("carries error message when present", () => {
    const p = buildHandoffPacket(makeState({ status: "error", error: "boom" }), "t");
    expect(p.error).toBe("boom");
  });
});

// ── formatHandoffPacket ───────────────────────────────────────────────────────

describe("formatHandoffPacket", () => {
  it("includes agent name, outcome, and summary", () => {
    const packet = buildHandoffPacket(
      makeState({
        messages: [{ role: "assistant", content: "Report: all checks passed." }],
      }),
      "security audit",
    );
    const s = formatHandoffPacket(packet);
    expect(s).toContain("orchestrator");
    expect(s).toContain("success");
    expect(s).toContain("Report: all checks passed.");
  });

  it("includes file list when files were changed", () => {
    const state = makeState({
      messages: [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "README.md" }) } }],
        },
        { role: "tool", tool_call_id: "c1", content: "Wrote 10 chars to README.md" },
        { role: "assistant", content: "done" },
      ],
    });
    const s = formatHandoffPacket(buildHandoffPacket(state, "t"));
    expect(s).toContain("README.md");
  });
});
