import { describe, expect, it } from "vitest";
import { resolveModelTarget } from "../../src/tui/modelTarget.js";
import type { NavState } from "../../src/tui/nav.js";
import type { DashboardModel } from "../../src/tui/dashboard.js";

function makeNav(overrides: Partial<NavState> = {}): NavState {
  return {
    surface: "home",
    homeTabIndex: 0,
    projectTabIndex: 0,
    focus: "tabs",
    focusBeforeInput: "tabs",
    agentDetail: null,
    runDetail: null,
    projectsIndex: 0,
    agentsIndex: 0,
    runsIndex: 0,
    input: "",
    ...overrides,
  };
}

function makeModel(agents: DashboardModel["agents"] = []): DashboardModel {
  return {
    workspaceDir: "/tmp/proj",
    agents,
    checkpoint: { current: "Phase 0", milestones: [] },
    mcpCost: { perServer: [], total: 0, configuredServers: [] },
    recentRuns: [],
    approvalsPending: 0,
  } as DashboardModel;
}

describe("resolveModelTarget", () => {
  it("prefers an explicit agent name", () => {
    const nav = makeNav({ agentDetail: "builder" });
    const model = makeModel([{ name: "tester", model: "x", description: "", source: "project" }]);
    expect(resolveModelTarget(nav, model, "tester")).toBe("tester");
  });

  it("uses the open agent detail when no explicit agent is given", () => {
    const nav = makeNav({ surface: "project", projectTabIndex: 1, agentDetail: "builder" });
    const model = makeModel();
    expect(resolveModelTarget(nav, model)).toBe("builder");
  });

  it("resolves to global-orchestrator on the Orchestrator tab", () => {
    const nav = makeNav({ surface: "home", homeTabIndex: 1 }); // orchestrator tab
    const model = makeModel();
    expect(resolveModelTarget(nav, model)).toBe("global-orchestrator");
  });

  it("resolves to the selected agent on the Agents tab", () => {
    const nav = makeNav({ surface: "project", projectTabIndex: 1, agentsIndex: 1 }); // agents tab
    const model = makeModel([
      { name: "builder", model: "x", description: "", source: "project" },
      { name: "tester", model: "x", description: "", source: "project" },
    ]);
    expect(resolveModelTarget(nav, model)).toBe("tester");
  });

  it("returns null outside any agent context", () => {
    const nav = makeNav({ surface: "home", homeTabIndex: 0 }); // overview tab
    const model = makeModel();
    expect(resolveModelTarget(nav, model)).toBeNull();
  });

  it("returns null on Agents tab when the list is empty", () => {
    const nav = makeNav({ surface: "project", projectTabIndex: 1 });
    const model = makeModel([]);
    expect(resolveModelTarget(nav, model)).toBeNull();
  });
});
