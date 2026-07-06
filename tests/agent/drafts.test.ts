import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDraftStore, DRAFT_DIR_NAME } from "../../src/agent/drafts.js";
import { propose_agent } from "../../src/tools/builtin/propose_agent.js";
import type { AgentDefinition, AgentRunState } from "../../src/types.js";
import type { SharedServices } from "../../src/tools/schema.js";

function makeState(workingDir: string): AgentRunState {
  return {
    runId: "r1",
    threadId: "t1",
    agentName: "architect",
    task: "create agents",
    messages: [],
    turn: 0,
    status: "running",
    workingDir,
    tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    startedAt: Date.now(),
  };
}

const stubServices = { agentMemoryStore: {} } as unknown as SharedServices;

describe("AgentDraftStore", () => {
  let dir: string;
  let store: AgentDraftStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sophron-drafts-"));
    store = new AgentDraftStore(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("starts with an empty, open ledger", () => {
    expect(store.isBootstrapClosed()).toBe(false);
    expect(store.pendingDrafts()).toEqual([]);
    expect(store.draftFiles()).toEqual([]);
  });

  it("writeDraft creates the draft file + ledger entry", () => {
    store.writeDraft("feature-agent", "---\nname: feature-agent\n---\nbody");
    expect(store.draftFiles()).toContain("feature-agent");
    expect(existsSync(join(dir, DRAFT_DIR_NAME, "feature-agent.md"))).toBe(true);
    expect(store.pendingDrafts().map((e) => e.name)).toContain("feature-agent");
    expect(store.isBootstrapClosed()).toBe(false);
  });

  it("approve moves the draft to agents/ and marks approved", () => {
    store.writeDraft("x", "content");
    store.approve("x");
    expect(existsSync(join(dir, "agents", "x.md"))).toBe(true);
    expect(existsSync(join(dir, DRAFT_DIR_NAME, "x.md"))).toBe(false);
    const ledger = store.readLedger();
    expect(ledger.entries.find((e) => e.name === "x")?.status).toBe("approved");
  });

  it("reject deletes the draft file and marks rejected", () => {
    store.writeDraft("y", "content");
    store.reject("y");
    expect(existsSync(join(dir, DRAFT_DIR_NAME, "y.md"))).toBe(false);
    expect(existsSync(join(dir, "agents", "y.md"))).toBe(false);
    expect(store.readLedger().entries.find((e) => e.name === "y")?.status).toBe("rejected");
  });

  it("closes bootstrap when all drafts are resolved", () => {
    store.writeDraft("a", "x");
    store.writeDraft("b", "y");
    expect(store.isBootstrapClosed()).toBe(false);
    store.approve("a");
    expect(store.isBootstrapClosed()).toBe(false);
    store.reject("b");
    expect(store.isBootstrapClosed()).toBe(true);
  });

  it("refuses new drafts after bootstrap closes", () => {
    store.writeDraft("a", "x");
    store.approve("a");
    expect(() => store.writeDraft("late", "x")).toThrow(/closed/);
  });

  it("refuses to re-draft an already-resolved agent", () => {
    store.writeDraft("a", "x");
    store.approve("a");
    expect(() => store.writeDraft("a", "x")).toThrow(/already approved/);
  });

  it("refuses to approve an unknown draft", () => {
    expect(() => store.approve("ghost")).toThrow(/No draft/);
  });

  it("refuses to approve an already-resolved draft", () => {
    store.writeDraft("a", "x");
    store.approve("a");
    expect(() => store.approve("a")).toThrow(/already approved/);
  });

  it("reopenBootstrap allows new drafts again", () => {
    store.writeDraft("a", "x");
    store.approve("a");
    expect(store.isBootstrapClosed()).toBe(true);
    store.reopenBootstrap();
    expect(store.isBootstrapClosed()).toBe(false);
    expect(() => store.writeDraft("b", "x")).not.toThrow();
  });

  it("persists the ledger across instances", () => {
    store.writeDraft("a", "x");
    const store2 = new AgentDraftStore(dir);
    expect(store2.pendingDrafts().map((e) => e.name)).toContain("a");
  });
});

describe("propose_agent tool", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sophron-propose-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes a draft and reports awaiting-approval", () => {
    const out = propose_agent.handler({
      args: {
        name: "feature-agent",
        description: "Builds features",
        systemPrompt: "You build features.",
        tools: ["write_file", "run_command"],
        model: "inherit",
        permissionMode: "auto",
      },
      agent: {} as AgentDefinition,
      state: makeState(dir),
      services: stubServices,
    });
    expect(out).toMatch(/Drafted agent 'feature-agent'/);
    expect(out).toMatch(/approval/);

    // Draft file exists in staging (NOT in agents/).
    const store = new AgentDraftStore(dir);
    expect(store.draftFiles()).toContain("feature-agent");
    expect(existsSync(join(dir, "agents", "feature-agent.md"))).toBe(false);

    // The draft content is valid frontmatter + body.
    const content = readFileSync(join(dir, DRAFT_DIR_NAME, "feature-agent.md"), "utf8");
    expect(content).toContain("name: feature-agent");
    expect(content).toContain("permissionMode: auto");
    expect(content).toContain("You build features.");
  });

  it("refuses full-auto permission for drafts", () => {
    const out = propose_agent.handler({
      args: {
        name: "risky",
        description: "x",
        systemPrompt: "y",
        permissionMode: "full-auto",
      },
      agent: {} as AgentDefinition,
      state: makeState(dir),
      services: stubServices,
    });
    expect(out).toMatch(/Refused.*full-auto/);
    expect(existsSync(join(dir, DRAFT_DIR_NAME, "risky.md"))).toBe(false);
  });

  it("refuses to propose after bootstrap closes", () => {
    const store = new AgentDraftStore(dir);
    store.writeDraft("a", "x");
    store.approve("a"); // closes bootstrap
    const out = propose_agent.handler({
      args: { name: "late", description: "x", systemPrompt: "y" },
      agent: {} as AgentDefinition,
      state: makeState(dir),
      services: stubServices,
    });
    expect(out).toMatch(/Could not draft/);
  });

  it("requires name, description, systemPrompt", () => {
    expect(() =>
      propose_agent.handler({
        args: { name: "x" },
        agent: {} as AgentDefinition,
        state: makeState(dir),
        services: stubServices,
      }),
    ).toThrow(/Missing.*systemPrompt|Missing.*description/);
  });
});
