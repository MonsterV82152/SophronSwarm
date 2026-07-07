/**
 * Smoke tests for the Ink TUI components via ink-testing-library.
 *
 * These render the components to a string (no real TTY) and assert on the
 * output. The interactive App shell's input handling is exercised via the
 * pure parser tests (slashCommands.test.ts); here we verify the rendering.
 */
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { DashboardView } from "../../src/tui/components/DashboardView.js";
import { SelectList, clampIndex, type SelectListItem } from "../../src/tui/components/SelectList.js";
import {
  HomePage,
  ProjectsPage,
  AgentsPage,
  AgentDetailPage,
  RunsPage,
  RunDetailPage,
  CheckpointPage,
  CostPage,
  HelpPage,
  HOME_MENU,
  type Page,
} from "../../src/tui/components/pages.js";
import { ProjectSwitcher } from "../../src/tui/components/projectSwitcher.js";
import type { ProjectEntry } from "../../src/project/registry.js";
import type { DashboardModel, RunDetail } from "../../src/tui/dashboard.js";
import React from "react";

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

describe("DashboardView", () => {
  it("renders the header + workspace", () => {
    const { lastFrame } = render(<DashboardView model={makeModel()} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("SophronSwarm V3 — Dashboard");
    expect(frame).toContain("/tmp/proj");
  });

  it("lists agents", () => {
    const { lastFrame } = render(<DashboardView model={makeModel()} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("builder");
    expect(frame).toContain("builds things");
    expect(frame).toContain("ollama:test:1b");
  });

  it("renders the current checkpoint", () => {
    const { lastFrame } = render(<DashboardView model={makeModel()} />);
    expect(lastFrame() ?? "").toContain("Phase 0");
  });

  it("shows the pending-approvals badge when > 0", () => {
    const { lastFrame } = render(<DashboardView model={makeModel({ approvalsPending: 2 })} />);
    expect(lastFrame() ?? "").toContain("pending approval");
  });

  it("shows MCP cost when tools are promoted", () => {
    const model = makeModel({
      mcpCost: {
        perServer: [{ server: "math", tokens: 84 }],
        total: 84,
        configuredServers: ["math"],
      },
    });
    const { lastFrame } = render(<DashboardView model={model} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("math");
    expect(frame).toContain("tokens/turn");
  });

  it("shows lazy-MCP hint when nothing promoted", () => {
    const { lastFrame } = render(<DashboardView model={makeModel()} />);
    expect(lastFrame() ?? "").toContain("lazy");
  });

  it("renders recent runs", () => {
    const model = makeModel({
      recentRuns: [{ runId: "abc123", agent: "builder", status: "complete", turns: 3, tokens: 1500, startedAt: "2026-07-05T00:00:00.000Z" }],
    });
    const { lastFrame } = render(<DashboardView model={model} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("builder");
    expect(frame).toContain("complete");
    expect(frame).toContain("1.5k"); // 1500 tokens → 1.5k
  });

  it("degrades gracefully with an empty workspace", () => {
    const model: DashboardModel = {
      workspaceDir: "/tmp/empty",
      agents: [],
      checkpoint: { current: "(none set)", milestones: [] },
      mcpCost: { perServer: [], total: 0, configuredServers: [] },
      recentRuns: [],
      approvalsPending: 0,
    };
    const { lastFrame } = render(<DashboardView model={model} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("no agents loaded");
    expect(frame).toContain("no milestones defined");
    expect(frame).toContain("no runs yet");
  });
});

// ── SelectList ─────────────────────────────────────────────────────────────

describe("SelectList", () => {
  const items: SelectListItem[] = [
    { id: "a", label: "Alpha", hint: "first" },
    { id: "b", label: "Beta", hint: "second" },
    { id: "c", label: "Gamma", icon: "🎯" },
  ];

  it("renders all items with the selected one highlighted (❯ marker)", () => {
    const { lastFrame } = render(<SelectList items={items} selectedIndex={1} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Alpha");
    expect(frame).toContain("Beta");
    expect(frame).toContain("Gamma");
    // Only the selected item (Beta, index 1) has the ❯ marker.
    const lines = frame.split("\n").map((l) => l.trim());
    const markerLine = lines.find((l) => l.includes("❯"));
    expect(markerLine).toContain("Beta");
  });

  it("renders a title when provided", () => {
    const { lastFrame } = render(<SelectList items={items} selectedIndex={0} title="Menu" />);
    expect(lastFrame() ?? "").toContain("Menu");
  });

  it("shows (empty) for an empty list", () => {
    const { lastFrame } = render(<SelectList items={[]} selectedIndex={0} />);
    expect(lastFrame() ?? "").toContain("(empty)");
  });

  it("renders the hint line for items that have one", () => {
    const { lastFrame } = render(<SelectList items={items} selectedIndex={0} />);
    expect(lastFrame() ?? "").toContain("first");
  });
});

describe("clampIndex", () => {
  it("clamps below 0 to 0", () => {
    expect(clampIndex(-3, 5)).toBe(0);
  });
  it("clamps above length-1 to length-1", () => {
    expect(clampIndex(10, 5)).toBe(4);
  });
  it("passes through valid indices", () => {
    expect(clampIndex(2, 5)).toBe(2);
  });
  it("returns 0 for an empty list", () => {
    expect(clampIndex(5, 0)).toBe(0);
    expect(clampIndex(-1, 0)).toBe(0);
  });
});

// ── Pages ───────────────────────────────────────────────────────────────────

describe("HomePage menu", () => {
  it("HOME_MENU has 8 entries including quit", () => {
    expect(HOME_MENU).toHaveLength(8);
    expect(HOME_MENU.map((m) => m.page)).toContain("quit");
    expect(HOME_MENU.map((m) => m.page)).toContain("projects");
    expect(HOME_MENU.map((m) => m.page)).toContain("memory");
  });

  it("renders the menu with all page labels", () => {
    const { lastFrame } = render(<HomePage model={makeModel()} selectedIndex={0} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Projects");
    expect(frame).toContain("Agents");
    expect(frame).toContain("Runs");
    expect(frame).toContain("Checkpoint");
    expect(frame).toContain("MCP Cost");
    expect(frame).toContain("Memory");
    expect(frame).toContain("Quit");
  });

  it("highlights the selected menu item", () => {
    const { lastFrame } = render(<HomePage model={makeModel()} selectedIndex={2} />);
    const frame = lastFrame() ?? "";
    // selectedIndex 2 = "Runs"
    const markerLine = frame.split("\n").map((l) => l.trim()).find((l) => l.includes("❯"));
    expect(markerLine).toContain("Runs");
  });
});

describe("ProjectsPage", () => {
  it("shows the workspace path + agent/run/server counts", () => {
    const { lastFrame } = render(<ProjectsPage model={makeModel()} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("/tmp/proj");
    expect(frame).toContain("agents: 1");
    expect(frame).toContain("Phase 0");
  });
});

describe("AgentsPage", () => {
  it("lists agents as a navigable list", () => {
    const { lastFrame } = render(<AgentsPage model={makeModel()} selectedIndex={0} />);
    expect(lastFrame() ?? "").toContain("builder");
  });
  it("shows empty hint with no agents", () => {
    const { lastFrame } = render(<AgentsPage model={makeModel({ agents: [] })} selectedIndex={0} />);
    expect(lastFrame() ?? "").toContain("no agents");
  });
  it("highlights the selected agent", () => {
    const { lastFrame } = render(<AgentsPage model={makeModel()} selectedIndex={0} />);
    const frame = lastFrame() ?? "";
    const markerLine = frame.split("\n").map((l) => l.trim()).find((l) => l.includes("❯"));
    expect(markerLine).toContain("builder");
  });
});

describe("AgentDetailPage", () => {
  it("shows the agent's full config + dedicated input", () => {
    const { lastFrame } = render(
      <AgentDetailPage model={makeModel()} agentName="builder" input="" mode="navigate" />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("builder");
    expect(frame).toContain("ollama:test:1b");
    expect(frame).toContain("send a task");
    expect(frame).toContain("builds things");
  });
  it("shows not-found for an unknown agent", () => {
    const { lastFrame } = render(
      <AgentDetailPage model={makeModel()} agentName="ghost" input="" mode="navigate" />,
    );
    expect(lastFrame() ?? "").toContain("not found");
  });
});

describe("RunsPage", () => {
  it("shows empty hint with no runs", () => {
    const { lastFrame } = render(<RunsPage model={makeModel()} selectedIndex={0} />);
    expect(lastFrame() ?? "").toContain("no runs");
  });
  it("lists runs as navigable when present", () => {
    const model = makeModel({
      recentRuns: [{ runId: "abc12345", agent: "builder", status: "complete", turns: 3, tokens: 1500, startedAt: "2026-07-05" }],
    });
    const { lastFrame } = render(<RunsPage model={model} selectedIndex={0} />);
    expect(lastFrame() ?? "").toContain("builder");
    expect(lastFrame() ?? "").toContain("complete");
  });
});

describe("RunDetailPage", () => {
  it("renders the event log when a detail is provided", () => {
    const detail: RunDetail = {
      runId: "abc12345",
      agent: "builder",
      status: "complete",
      task: "do the thing",
      turns: 2,
      tokens: 500,
      events: [
        { type: "run_start", label: "run start", detail: "builder" },
        { type: "tool_call_start", turn: 0, label: "→ echo", detail: '{"text":"hi"}' },
        { type: "tool_call_result", turn: 0, label: "← echo", detail: "hi" },
        { type: "run_end", label: "run end", detail: "complete · 2 turns · 500 tokens" },
      ],
    };
    const { lastFrame } = render(<RunDetailPage detail={detail} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("builder");
    expect(frame).toContain("do the thing");
    expect(frame).toContain("event log");
    expect(frame).toContain("→ echo");
    expect(frame).toContain("← echo");
  });
  it("shows not-found when detail is null", () => {
    const { lastFrame } = render(<RunDetailPage detail={null} />);
    expect(lastFrame() ?? "").toContain("not found");
  });
});

describe("CheckpointPage", () => {
  it("shows the current checkpoint + milestones", () => {
    const { lastFrame } = render(<CheckpointPage model={makeModel()} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Phase 0");
    expect(frame).toContain("/advance");
  });
});

describe("CostPage", () => {
  it("shows lazy hint when no tools promoted", () => {
    const { lastFrame } = render(<CostPage model={makeModel()} />);
    expect(lastFrame() ?? "").toContain("lazy");
  });
  it("shows per-server cost when tools are promoted", () => {
    const model = makeModel({
      mcpCost: { perServer: [{ server: "math", tokens: 84 }], total: 84, configuredServers: ["math"] },
    });
    const { lastFrame } = render(<CostPage model={model} />);
    expect(lastFrame() ?? "").toContain("math");
  });
});

describe("HelpPage", () => {
  it("renders the command reference", () => {
    const { lastFrame } = render(<HelpPage />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("/agents");
    expect(frame).toContain("/run");
  });
});

// ── Project Switcher ────────────────────────────────────────────────────────

function makeProject(overrides: Partial<ProjectEntry> = {}): ProjectEntry {
  return { name: "test-proj", path: "/projects/test", lastOpened: 1000, ...overrides };
}

describe("ProjectSwitcher", () => {
  it("shows empty hint when no projects registered", () => {
    const { lastFrame } = render(<ProjectSwitcher projects={[]} activePath="/x" selectedIndex={0} />);
    expect(lastFrame() ?? "").toContain("no projects registered");
  });

  it("lists registered projects with names", () => {
    const projects = [
      makeProject({ name: "webapp", path: "/projects/webapp" }),
      makeProject({ name: "cli", path: "/projects/cli" }),
    ];
    const { lastFrame } = render(<ProjectSwitcher projects={projects} activePath="/projects/webapp" selectedIndex={0} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("webapp");
    expect(frame).toContain("cli");
    expect(frame).toContain("Switch Project");
  });

  it("marks the active project", () => {
    const projects = [makeProject({ name: "active", path: "/active" }), makeProject({ name: "other", path: "/other" })];
    const { lastFrame } = render(<ProjectSwitcher projects={projects} activePath="/active" selectedIndex={0} />);
    expect(lastFrame() ?? "").toContain("(active)");
  });

  it("shows the selection marker on the selected row", () => {
    const projects = [makeProject({ name: "a", path: "/a" }), makeProject({ name: "b", path: "/b" })];
    const { lastFrame } = render(<ProjectSwitcher projects={projects} activePath="/a" selectedIndex={1} />);
    const frame = lastFrame() ?? "";
    // The second item should have the ▸ marker; the first should not.
    const lines = frame.split("\n");
    const selectedLine = lines.find((l) => l.includes("▸"));
    expect(selectedLine).toBeDefined();
    expect(selectedLine!).toContain("b");
  });

  it("shows a pinned marker on pinned projects", () => {
    const projects = [makeProject({ name: "pinned", path: "/p", pinned: true })];
    const { lastFrame } = render(<ProjectSwitcher projects={projects} activePath="/x" selectedIndex={0} />);
    expect(lastFrame() ?? "").toContain("📌");
  });
});
