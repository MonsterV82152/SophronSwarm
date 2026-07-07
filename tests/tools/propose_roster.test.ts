import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { propose_roster } from "../../src/tools/builtin/propose_roster.js";
import { AgentDraftStore, DRAFT_DIR_NAME } from "../../src/agent/drafts.js";
import type { AgentDefinition, AgentRunState } from "../../src/types.js";
import type { SharedServices } from "../../src/tools/schema.js";

function makeState(workingDir: string): AgentRunState {
  return {
    runId: "r1",
    threadId: "t1",
    agentName: "architect",
    task: "create roster",
    messages: [],
    turn: 0,
    status: "running",
    workingDir,
    tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    startedAt: Date.now(),
  };
}

/** Minimal services stub — propose_roster only reads agentRegistry.scan().agents.length. */
function makeServices(approvedAgentCount = 0): SharedServices {
  return {
    agentRegistry: { scan: () => ({ agents: Array(approvedAgentCount).fill(null) }) },
  } as unknown as SharedServices;
}

const baseAgent = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  description: `${name} description`,
  systemPrompt: `You are ${name}.`,
  ...extra,
});

describe("propose_roster tool", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sophron-propose-roster-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("drafts all agents in the batch + reports awaiting-approval", () => {
    const out = propose_roster.handler({
      args: {
        summary: "core team",
        agents: [
          baseAgent("builder", { tools: ["write_file"], model: "inherit", permissionMode: "auto" }),
          baseAgent("tester", { tools: ["run_command"], model: "mid" }),
        ],
      },
      agent: {} as AgentDefinition,
      state: makeState(dir),
      services: makeServices(),
    });

    expect(out).toMatch(/Drafted 2 agent\(s\)/);
    expect(out).toContain("builder");
    expect(out).toContain("tester");
    expect(out).toMatch(/approval/);

    const store = new AgentDraftStore(dir);
    expect(store.draftFiles().sort()).toEqual(["builder", "tester"]);
    expect(existsSync(join(dir, "agents", "builder.md"))).toBe(false); // NOT promoted
    expect(store.isBootstrapClosed()).toBe(false); // pending

    // Each draft content is valid frontmatter + body.
    const builder = readFileSync(join(dir, DRAFT_DIR_NAME, "builder.md"), "utf8");
    expect(builder).toContain("name: builder");
    expect(builder).toContain("permissionMode: auto");
    expect(builder).toContain("You are builder.");
  });

  it("works without a summary field", () => {
    const out = propose_roster.handler({
      args: { agents: [baseAgent("solo")] },
      agent: {} as AgentDefinition,
      state: makeState(dir),
      services: makeServices(),
    });
    expect(out).toMatch(/Drafted 1 agent\(s\)/);
    expect(new AgentDraftStore(dir).draftFiles()).toEqual(["solo"]);
  });

  it("defaults permissionMode to 'default' when omitted", () => {
    propose_roster.handler({
      args: { agents: [baseAgent("x")] },
      agent: {} as AgentDefinition,
      state: makeState(dir),
      services: makeServices(),
    });
    const content = readFileSync(join(dir, DRAFT_DIR_NAME, "x.md"), "utf8");
    expect(content).toContain("permissionMode: default");
  });

  it("refuses if ANY entry uses full-auto (atomic — nothing written)", () => {
    const out = propose_roster.handler({
      args: {
        agents: [
          baseAgent("safe"),
          baseAgent("risky", { permissionMode: "full-auto" }),
        ],
      },
      agent: {} as AgentDefinition,
      state: makeState(dir),
      services: makeServices(),
    });
    expect(out).toMatch(/Refused.*full-auto/);
    // Atomicity: neither file written, no ledger entry.
    expect(new AgentDraftStore(dir).draftFiles()).toEqual([]);
    expect(new AgentDraftStore(dir).pendingDrafts()).toEqual([]);
  });

  it("refuses if ANY entry is missing a required field (atomic)", () => {
    const out = propose_roster.handler({
      args: {
        agents: [
          baseAgent("ok"),
          { name: "bad", description: "no prompt" } as Record<string, unknown>,
        ],
      },
      agent: {} as AgentDefinition,
      state: makeState(dir),
      services: makeServices(),
    });
    expect(out).toMatch(/Refused.*systemPrompt/);
    expect(new AgentDraftStore(dir).draftFiles()).toEqual([]);
  });

  it("refuses duplicate names within the batch", () => {
    const out = propose_roster.handler({
      args: {
        agents: [baseAgent("dup"), baseAgent("dup")],
      },
      agent: {} as AgentDefinition,
      state: makeState(dir),
      services: makeServices(),
    });
    expect(out).toMatch(/Refused.*duplicate.*'dup'/);
    expect(new AgentDraftStore(dir).draftFiles()).toEqual([]);
  });

  it("refuses a non-array / empty agents argument", () => {
    const out1 = propose_roster.handler({
      args: { agents: [] },
      agent: {} as AgentDefinition,
      state: makeState(dir),
      services: makeServices(),
    });
    expect(out1).toMatch(/Refused.*non-empty array/);

    const out2 = propose_roster.handler({
      args: { agents: "not an array" },
      agent: {} as AgentDefinition,
      state: makeState(dir),
      services: makeServices(),
    });
    expect(out2).toMatch(/Refused.*non-empty array/);
  });

  it("refuses to propose after bootstrap closes", () => {
    const store = new AgentDraftStore(dir);
    store.writeRoster([{ name: "a", content: "x" }]);
    store.approve("a"); // closes bootstrap

    const out = propose_roster.handler({
      args: { agents: [baseAgent("late")] },
      agent: {} as AgentDefinition,
      state: makeState(dir),
      services: makeServices(),
    });
    expect(out).toMatch(/Could not draft.*closed/);
  });

  it("warns when the resulting roster exceeds the soft cap", () => {
    // Make 11 already-approved agents; proposing 2 more → 13 > 12 soft cap.
    const out = propose_roster.handler({
      args: { agents: [baseAgent("twelve"), baseAgent("thirteen")] },
      agent: {} as AgentDefinition,
      state: makeState(dir),
      services: makeServices(11),
    });
    expect(out).toMatch(/soft cap/);
    expect(out).toContain("13");
  });

  it("does NOT warn when under the soft cap", () => {
    const out = propose_roster.handler({
      args: { agents: [baseAgent("a"), baseAgent("b")] },
      agent: {} as AgentDefinition,
      state: makeState(dir),
      services: makeServices(2),
    });
    expect(out).not.toMatch(/soft cap/);
  });

  it("mentions both --approve-all and per-name approve in the result", () => {
    const out = propose_roster.handler({
      args: { agents: [baseAgent("a"), baseAgent("b")] },
      agent: {} as AgentDefinition,
      state: makeState(dir),
      services: makeServices(),
    });
    expect(out).toContain("--approve-all");
    expect(out).toContain("--approve a b");
  });

  it("serializes arrays (tools, delegateAllowlist, mcpServers) into the drafts", () => {
    propose_roster.handler({
      args: {
        agents: [
          baseAgent("full", {
            tools: ["write_file", "run_command"],
            delegateAllowlist: ["helper"],
            mcpServers: ["github"],
            maxTurns: 30,
          }),
        ],
      },
      agent: {} as AgentDefinition,
      state: makeState(dir),
      services: makeServices(),
    });
    const content = readFileSync(join(dir, DRAFT_DIR_NAME, "full.md"), "utf8");
    expect(content).toContain("tools:\n  - write_file\n  - run_command");
    expect(content).toContain("delegateAllowlist:\n  - helper");
    expect(content).toContain("mcpServers:\n  - github");
    expect(content).toContain("maxTurns: 30");
  });
});
