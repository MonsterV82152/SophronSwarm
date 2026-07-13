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
        model: "qwen3.5:9b",
        provider: "ollama",
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
      args: { name: "late", description: "x", systemPrompt: "y", model: "qwen3.5:9b", provider: "ollama" },
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

describe("AgentDraftStore — batched roster (M6)", () => {
  let dir: string;
  let store: AgentDraftStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sophron-roster-"));
    store = new AgentDraftStore(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  describe("writeRoster", () => {
    it("writes all drafts + ledger entries in one pass", () => {
      store.writeRoster([
        { name: "a", content: "---\nname: a\n---\nbody-a" },
        { name: "b", content: "---\nname: b\n---\nbody-b" },
      ]);
      expect(store.draftFiles().sort()).toEqual(["a", "b"]);
      expect(store.pendingDrafts().map((e) => e.name).sort()).toEqual(["a", "b"]);
      expect(store.isBootstrapClosed()).toBe(false); // pending → still open
    });

    it("trims names", () => {
      store.writeRoster([{ name: "  spaced  ", content: "x" }]);
      expect(store.draftFiles()).toContain("spaced");
    });

    it("refuses an empty roster", () => {
      expect(() => store.writeRoster([])).toThrow(/at least one/);
    });

    it("refuses duplicate names within the batch (atomically — nothing written)", () => {
      expect(() =>
        store.writeRoster([
          { name: "dup", content: "x" },
          { name: "dup", content: "y" },
        ]),
      ).toThrow(/Duplicate name in roster/);
      // Atomicity: no files, no ledger entries.
      expect(store.draftFiles()).toEqual([]);
      expect(store.pendingDrafts()).toEqual([]);
    });

    it("refuses if bootstrap is closed (atomically)", () => {
      store.writeRoster([{ name: "a", content: "x" }]);
      store.approve("a"); // closes bootstrap
      expect(() =>
        store.writeRoster([{ name: "b", content: "y" }]),
      ).toThrow(/closed/);
      expect(store.draftFiles()).toEqual([]); // nothing written
    });

    it("refuses to re-draft an already-resolved agent (atomically)", () => {
      store.writeRoster([{ name: "a", content: "x" }]);
      store.approve("a");
      expect(() =>
        store.writeRoster([
          { name: "a", content: "new" },
          { name: "b", content: "ok" },
        ]),
      ).toThrow(/already approved/);
      // Atomicity: 'b' (which was valid) must NOT have been written.
      expect(store.draftFiles()).toEqual([]);
      expect(store.pendingDrafts()).toEqual([]);
    });

    it("allows re-drafting an entry that is still 'draft' (updating it)", () => {
      store.writeRoster([{ name: "a", content: "v1" }]);
      // Re-writing a still-draft entry updates its content + timestamp.
      store.writeRoster([{ name: "a", content: "v2" }]);
      expect(readFileSync(join(dir, DRAFT_DIR_NAME, "a.md"), "utf8")).toBe("v2");
      expect(store.pendingDrafts().length).toBe(1); // no duplicate ledger entry
    });

    it("refuses an entry with an empty name", () => {
      expect(() => store.writeRoster([{ name: "   ", content: "x" }])).toThrow(/missing or empty name/);
    });
  });

  describe("approveMany", () => {
    it("promotes all named drafts to agents/ in one ledger write", () => {
      store.writeRoster([
        { name: "a", content: "x" },
        { name: "b", content: "y" },
      ]);
      store.approveMany(["a", "b"]);
      expect(existsSync(join(dir, "agents", "a.md"))).toBe(true);
      expect(existsSync(join(dir, "agents", "b.md"))).toBe(true);
      expect(existsSync(join(dir, DRAFT_DIR_NAME, "a.md"))).toBe(false);
      expect(existsSync(join(dir, DRAFT_DIR_NAME, "b.md"))).toBe(false);
      const ledger = store.readLedger();
      expect(ledger.entries.every((e) => e.status === "approved")).toBe(true);
      expect(ledger.bootstrapClosed).toBe(true); // all resolved → closed
    });

    it("closes bootstrap only when ALL drafts are resolved", () => {
      store.writeRoster([
        { name: "a", content: "x" },
        { name: "b", content: "y" },
        { name: "c", content: "z" },
      ]);
      store.approveMany(["a", "b"]);
      expect(store.isBootstrapClosed()).toBe(false); // c still pending
      store.reject("c");
      expect(store.isBootstrapClosed()).toBe(true);
    });

    it("is atomic: an unknown name resolves NOTHING", () => {
      store.writeRoster([{ name: "a", content: "x" }]);
      expect(() => store.approveMany(["a", "ghost"])).toThrow(/No draft named 'ghost'/);
      // 'a' must NOT have been promoted — the batch failed atomically.
      expect(existsSync(join(dir, "agents", "a.md"))).toBe(false);
      expect(existsSync(join(dir, DRAFT_DIR_NAME, "a.md"))).toBe(true);
      const ledger = store.readLedger();
      expect(ledger.entries.find((e) => e.name === "a")?.status).toBe("draft");
    });

    it("is atomic: an already-resolved name resolves NOTHING", () => {
      store.writeRoster([
        { name: "a", content: "x" },
        { name: "b", content: "y" },
      ]);
      store.approve("a");
      expect(() => store.approveMany(["a", "b"])).toThrow(/already approved/);
      // 'b' must still be a draft.
      expect(store.readLedger().entries.find((e) => e.name === "b")?.status).toBe("draft");
      expect(existsSync(join(dir, DRAFT_DIR_NAME, "b.md"))).toBe(true);
    });

    it("returns [] for an empty name list (no-op)", () => {
      store.writeRoster([{ name: "a", content: "x" }]);
      expect(store.approveMany([])).toEqual([]);
      expect(store.readLedger().entries.find((e) => e.name === "a")?.status).toBe("draft");
    });
  });

  describe("rejectMany", () => {
    it("deletes all named draft files + marks rejected", () => {
      store.writeRoster([
        { name: "a", content: "x" },
        { name: "b", content: "y" },
      ]);
      store.rejectMany(["a", "b"]);
      expect(existsSync(join(dir, DRAFT_DIR_NAME, "a.md"))).toBe(false);
      expect(existsSync(join(dir, DRAFT_DIR_NAME, "b.md"))).toBe(false);
      expect(store.readLedger().entries.every((e) => e.status === "rejected")).toBe(true);
      expect(store.isBootstrapClosed()).toBe(true);
    });
  });

  describe("approveAll / rejectAll", () => {
    it("approveAll promotes every pending draft", () => {
      store.writeRoster([
        { name: "a", content: "x" },
        { name: "b", content: "y" },
      ]);
      const resolved = store.approveAll();
      expect(resolved.map((e) => e.name).sort()).toEqual(["a", "b"]);
      expect(readdirSync(join(dir, "agents")).sort()).toEqual(["a.md", "b.md"]);
      expect(store.isBootstrapClosed()).toBe(true);
    });

    it("rejectAll deletes every pending draft", () => {
      store.writeRoster([
        { name: "a", content: "x" },
        { name: "b", content: "y" },
      ]);
      const resolved = store.rejectAll();
      expect(resolved.map((e) => e.name).sort()).toEqual(["a", "b"]);
      expect(store.draftFiles()).toEqual([]);
      expect(existsSync(join(dir, "agents"))).toBe(false);
      expect(store.isBootstrapClosed()).toBe(true);
    });

    it("approveAll is a no-op (returns []) when there are no pending drafts", () => {
      expect(store.approveAll()).toEqual([]);
      expect(store.rejectAll()).toEqual([]);
    });

    it("approveAll only resolves pending drafts (leaves already-resolved alone)", () => {
      store.writeRoster([
        { name: "a", content: "x" },
        { name: "b", content: "y" },
        { name: "c", content: "z" },
      ]);
      store.reject("b"); // resolve one ahead of time
      const resolved = store.approveAll();
      expect(resolved.map((e) => e.name).sort()).toEqual(["a", "c"]);
      expect(store.readLedger().entries.find((e) => e.name === "b")?.status).toBe("rejected");
      expect(store.isBootstrapClosed()).toBe(true);
    });
  });

  it("batch round-trips with a second store instance (persistence)", () => {
    store.writeRoster([
      { name: "a", content: "x" },
      { name: "b", content: "y" },
    ]);
    const store2 = new AgentDraftStore(dir);
    expect(store2.pendingDrafts().map((e) => e.name).sort()).toEqual(["a", "b"]);
    store2.approveAll();
    const store3 = new AgentDraftStore(dir);
    expect(store3.isBootstrapClosed()).toBe(true);
    expect(store3.pendingDrafts()).toEqual([]);
  });
});
