/**
 * Smoke tests for the new (M3 rewrite) Ink TUI components.
 *
 * These render the components to a string via ink-testing-library (no real
 * TTY) and assert on the output. The navigation logic is covered separately
 * by nav.test.ts (pure reducer); here we verify rendering of the chrome +
 * surface/tab components.
 */
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { TabBar } from "../../src/tui/components/TabBar.js";
import { InputBar } from "../../src/tui/components/InputBar.js";
import { Banner } from "../../src/tui/components/Banner.js";
import { OverviewTab } from "../../src/tui/components/OverviewTab.js";
import { OrchestratorChat, type ChatMessage } from "../../src/tui/components/OrchestratorChat.js";
import { ProjectsTab } from "../../src/tui/components/ProjectsTab.js";
import {
  StatusTab,
  AgentsTab,
  RunsTab,
  CheckpointTab,
  MemoryTab,
  CostTab,
} from "../../src/tui/components/ProjectTabs.js";
import { AgentDetail } from "../../src/tui/components/AgentDetail.js";
import { SelectList, clampIndex, type SelectListItem } from "../../src/tui/components/SelectList.js";
import type { ProjectEntry } from "../../src/project/registry.js";
import type { DashboardModel, OverviewModel } from "../../src/tui/dashboard.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeModel(overrides: Partial<DashboardModel> = {}): DashboardModel {
  return {
    workspaceDir: "/tmp/proj",
    agents: [{ name: "builder", model: "ollama:test:1b", description: "builds things", source: "project" }],
    checkpoint: { current: "Phase 0", milestones: [{ index: 1, title: "Phase 0", done: false }] },
    mcpCost: { perServer: [], total: 0, configuredServers: [] },
    recentRuns: [],
    approvalsPending: 0,
    ...overrides,
  };
}

function makeOverview(overrides: Partial<OverviewModel> = {}): OverviewModel {
  return {
    projects: [],
    totalProjects: 0,
    totalRuns: 0,
    totalTokens: 0,
    failedRuns: 0,
    needingAttention: [],
    activeApprovalsPending: 0,
    ...overrides,
  };
}

function makeProject(overrides: Partial<ProjectEntry> = {}): ProjectEntry {
  return { name: "my-app", path: "/tmp/my-app", lastOpened: 0, ...overrides };
}

// ── SelectList (reused, regression coverage) ────────────────────────────────

describe("SelectList", () => {
  it("renders items with the selected one highlighted", () => {
    const items: SelectListItem[] = [
      { id: "a", label: "Alpha" },
      { id: "b", label: "Beta" },
    ];
    const { lastFrame } = render(<SelectList items={items} selectedIndex={1} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Alpha");
    expect(frame).toContain("Beta");
    expect(frame).toContain("❯"); // selected marker
  });

  it("shows (empty) for an empty list", () => {
    const { lastFrame } = render(<SelectList items={[]} selectedIndex={0} />);
    expect(lastFrame() ?? "").toContain("(empty)");
  });

  it("clampIndex clamps into range", () => {
    expect(clampIndex(-1, 3)).toBe(0);
    expect(clampIndex(5, 3)).toBe(2);
    expect(clampIndex(1, 3)).toBe(1);
    expect(clampIndex(0, 0)).toBe(0);
  });
});

// ── Chrome: Banner, TabBar, InputBar ────────────────────────────────────────

describe("Banner", () => {
  it("renders the SophronSwarm ASCII art + version", () => {
    const { lastFrame } = render(<Banner version="V3" />);
    const frame = lastFrame() ?? "";
    // The ASCII art spells "SophronSwarm" across lines; check figlet fragments.
    expect(frame).toContain("____"); // top of the S
    expect(frame).toContain("V3");
    expect(frame.split("\n").length).toBeGreaterThanOrEqual(5); // multi-line art
  });
});

describe("TabBar", () => {
  it("renders all tab labels", () => {
    const { lastFrame } = render(<TabBar labels={["Overview", "Orchestrator", "Projects"]} selectedIndex={1} focused={false} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Overview");
    expect(frame).toContain("Orchestrator");
    expect(frame).toContain("Projects");
  });

  it("renders without crashing when focused", () => {
    const { lastFrame } = render(<TabBar labels={["A", "B"]} selectedIndex={0} focused={true} />);
    expect(lastFrame() ?? "").toContain("A");
  });
});

describe("InputBar", () => {
  it("shows the prompt + value + cursor when focused", () => {
    const { lastFrame } = render(<InputBar value="hello" focused={true} prompt=">" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("hello");
    expect(frame).toContain("▏");
  });

  it("shows the hint line when not focused", () => {
    const { lastFrame } = render(<InputBar value="" focused={false} prompt=">" />);
    expect(lastFrame() ?? "").toContain("type to enter");
  });

  it("shows disabled message when disabled", () => {
    const { lastFrame } = render(<InputBar value="" focused={false} disabled={true} />);
    expect(lastFrame() ?? "").toContain("switching");
  });

  it("uses the agent prompt when given", () => {
    const { lastFrame } = render(<InputBar value="task" focused={true} prompt="builder>" />);
    expect(lastFrame() ?? "").toContain("builder>");
  });
});

// ── Home surface tabs ───────────────────────────────────────────────────────

describe("OverviewTab", () => {
  it("shows aggregate stats + healthy message when no failures", () => {
    const { lastFrame } = render(<OverviewTab overview={makeOverview({ totalProjects: 2, totalRuns: 5, totalTokens: 1200 })} activeProjectName="x" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("projects: 2");
    expect(frame).toContain("runs: 5");
    expect(frame).toContain("All projects healthy");
  });

  it("lists needing-attention projects when there are failures", () => {
    const ov = makeOverview({
      totalProjects: 1,
      failedRuns: 1,
      needingAttention: ["broken-app"],
      projects: [makeProject({ name: "broken-app" })],
    });
    const { lastFrame } = render(<OverviewTab overview={ov} activeProjectName="x" />);
    expect(lastFrame() ?? "").toContain("Needs attention: broken-app");
  });

  it("shows the empty hint when no projects registered", () => {
    const { lastFrame } = render(<OverviewTab overview={makeOverview()} activeProjectName="x" />);
    expect(lastFrame() ?? "").toContain("no projects registered");
  });

  it("renders per-project rows with active highlight", () => {
    const ov = makeOverview({
      totalProjects: 2,
      projects: [
        makeProject({ name: "active-one", path: "/x/active-one", runCount: 3, lastRunStatus: "complete" }),
        makeProject({ name: "other", path: "/x/other" }),
      ],
    });
    const { lastFrame } = render(<OverviewTab overview={ov} activeProjectName="active-one" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("active-one");
    expect(frame).toContain("(active)");
    expect(frame).toContain("complete");
  });

  it("shows pending approvals badge", () => {
    const { lastFrame } = render(<OverviewTab overview={makeOverview({ activeApprovalsPending: 3 })} activeProjectName="x" />);
    expect(lastFrame() ?? "").toContain("pending approval");
  });
});

describe("OrchestratorChat", () => {
  const sampleMessages: ChatMessage[] = [
    { id: 1, role: "user", text: "I want to build a CLI tool." },
    { id: 2, role: "orchestrator", text: "Great. What language?" },
  ];

  it("renders the chat thread with user + orchestrator messages", () => {
    const { lastFrame } = render(
      <OrchestratorChat messages={sampleMessages} running={false} installed={true} onSubmit={() => {}} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Global Orchestrator");
    expect(frame).toContain("you ›");
    expect(frame).toContain("CLI tool");
    expect(frame).toContain("🧭 ›");
    expect(frame).toContain("What language?");
  });

  it("shows a thinking indicator when running", () => {
    const { lastFrame } = render(
      <OrchestratorChat messages={sampleMessages} running={true} installed={true} onSubmit={() => {}} />,
    );
    expect(lastFrame() ?? "").toContain("thinking");
  });

  it("shows an install hint when not installed", () => {
    const { lastFrame } = render(
      <OrchestratorChat messages={[]} running={false} installed={false} onSubmit={() => {}} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("not installed");
    expect(frame).toContain("install-orchestrator");
  });

  it("shows a prompt when installed + no messages yet", () => {
    const { lastFrame } = render(
      <OrchestratorChat messages={[]} running={false} installed={true} onSubmit={() => {}} />,
    );
    expect(lastFrame() ?? "").toContain("No messages yet");
  });
});

describe("ProjectsTab", () => {
  it("lists registered projects", () => {
    const projects = [makeProject({ name: "alpha", path: "/x/alpha" }), makeProject({ name: "beta", path: "/x/beta" })];
    const { lastFrame } = render(<ProjectsTab projects={projects} selectedIndex={0} activePath="/x/alpha" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("alpha");
    expect(frame).toContain("beta");
    expect(frame).toContain("(active)");
  });

  it("shows empty hint when no projects", () => {
    const { lastFrame } = render(<ProjectsTab projects={[]} selectedIndex={0} activePath="" />);
    expect(lastFrame() ?? "").toContain("no projects registered");
  });
});

// ── Project surface tabs ────────────────────────────────────────────────────

describe("StatusTab", () => {
  it("renders project summary stats", () => {
    const { lastFrame } = render(<StatusTab model={makeModel({ approvalsPending: 2 })} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("agents: 1");
    expect(frame).toContain("Phase 0");
    expect(frame).toContain("pending approval");
  });

  it("shows healthy message when no pending approvals", () => {
    const { lastFrame } = render(<StatusTab model={makeModel()} />);
    expect(lastFrame() ?? "").toContain("no pending approvals");
  });
});

describe("AgentsTab", () => {
  it("lists loaded agents", () => {
    const { lastFrame } = render(<AgentsTab model={makeModel()} selectedIndex={0} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("builder");
    expect(frame).toContain("builds things");
    expect(frame).toContain("Enter to open");
  });

  it("shows empty hint when no agents", () => {
    const { lastFrame } = render(<AgentsTab model={makeModel({ agents: [] })} selectedIndex={0} />);
    expect(lastFrame() ?? "").toContain("no agents loaded");
  });
});

describe("RunsTab", () => {
  it("lists recent runs", () => {
    const model = makeModel({
      recentRuns: [{ runId: "abc12345", agent: "builder", status: "complete", turns: 3, tokens: 1500, startedAt: "2026-07-05T00:00:00.000Z" }],
    });
    const { lastFrame } = render(<RunsTab model={model} selectedIndex={0} />);
    expect(lastFrame() ?? "").toContain("builder");
  });

  it("shows empty hint when no runs", () => {
    const { lastFrame } = render(<RunsTab model={makeModel()} selectedIndex={0} />);
    expect(lastFrame() ?? "").toContain("no runs yet");
  });
});

describe("CheckpointTab", () => {
  it("renders the current checkpoint + milestones", () => {
    const { lastFrame } = render(<CheckpointTab model={makeModel()} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("current:");
    expect(frame).toContain("Phase 0");
  });
});

describe("MemoryTab", () => {
  it("renders content lines", () => {
    const { lastFrame } = render(<MemoryTab content={"- OVERVIEW.md\n- CHECKPOINTS.md"} label="shared" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("OVERVIEW.md");
    expect(frame).toContain("shared");
  });

  it("shows empty for no content", () => {
    const { lastFrame } = render(<MemoryTab content="" label="x" />);
    expect(lastFrame() ?? "").toContain("(empty)");
  });
});

describe("CostTab", () => {
  it("renders configured servers + lazy hint when none promoted", () => {
    const { lastFrame } = render(<CostTab model={makeModel({ mcpCost: { perServer: [], total: 0, configuredServers: ["math"] } })} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("math");
    expect(frame).toContain("lazy by default");
  });

  it("renders per-server breakdown when tools promoted", () => {
    const { lastFrame } = render(<CostTab model={makeModel({ mcpCost: { perServer: [{ server: "math", tokens: 84 }], total: 84, configuredServers: ["math"] } })} />);
    expect(lastFrame() ?? "").toContain("per-server");
  });
});

// ── AgentDetail ─────────────────────────────────────────────────────────────

describe("AgentDetail", () => {
  it("renders the agent config", () => {
    const { lastFrame } = render(<AgentDetail model={makeModel()} agentName="builder" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("builder");
    expect(frame).toContain("builds things");
    expect(frame).toContain("ollama:test:1b");
  });

  it("shows the live-stream section", () => {
    const { lastFrame } = render(<AgentDetail model={makeModel()} agentName="builder" />);
    expect(lastFrame() ?? "").toContain("live stream");
  });

  it("shows the no-runs hint when the agent has no runs", () => {
    const { lastFrame } = render(<AgentDetail model={makeModel()} agentName="builder" />);
    expect(lastFrame() ?? "").toContain("no run activity");
  });

  it("shows (agent not found) for an unknown agent", () => {
    const { lastFrame } = render(<AgentDetail model={makeModel()} agentName="ghost" />);
    expect(lastFrame() ?? "").toContain("agent not found");
  });
});
