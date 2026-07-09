/**
 * Tests for the navigation state machine (src/tui/nav.ts).
 *
 * Pure reducer — no React, no Ink. These tests lock down the navigation model
 * that the first M3 attempt got wrong.
 */
import { describe, expect, it } from "vitest";
import {
  initialNavState,
  navReducer,
  HOME_TABS,
  PROJECT_TABS,
  activeHomeTab,
  activeProjectTab,
  type NavState,
} from "../../src/tui/nav.js";

function reduceAll(state: NavState, actions: Parameters<typeof navReducer>[1][]): NavState {
  return actions.reduce((s, a) => navReducer(s, a), state);
}

describe("nav state machine — initial state", () => {
  it("starts on the home surface, Overview tab, tabs focused", () => {
    const s = initialNavState();
    expect(s.surface).toBe("home");
    expect(s.homeTabIndex).toBe(0);
    expect(activeHomeTab(s)).toBe("overview");
    expect(s.focus).toBe("tabs");
    expect(s.agentDetail).toBeNull();
    expect(s.runDetail).toBeNull();
    expect(s.input).toBe("");
  });
});

describe("nav state machine — tab bar movement", () => {
  it("←/→ moves across the home tabs", () => {
    let s = initialNavState();
    s = navReducer(s, { kind: "tabRight" });
    expect(activeHomeTab(s)).toBe("orchestrator");
    s = navReducer(s, { kind: "tabRight" });
    expect(activeHomeTab(s)).toBe("projects");
    s = navReducer(s, { kind: "tabRight" });
    expect(activeHomeTab(s)).toBe("drafts");
    // Clamp at the end.
    s = navReducer(s, { kind: "tabRight" });
    expect(activeHomeTab(s)).toBe("drafts");
    // Back left.
    s = navReducer(s, { kind: "tabLeft" });
    expect(activeHomeTab(s)).toBe("projects");
  });

  it("←/→ moves across the project tabs", () => {
    let s = navReducer(initialNavState(), { kind: "enterProject" });
    expect(s.surface).toBe("project");
    expect(activeProjectTab(s)).toBe("status");
    s = navReducer(s, { kind: "tabRight" });
    expect(activeProjectTab(s)).toBe("chat");
    s = navReducer(s, { kind: "tabRight" });
    expect(activeProjectTab(s)).toBe("agents");
    s = navReducer(s, { kind: "tabRight" });
    expect(activeProjectTab(s)).toBe("runs");
    // Clamp at the start.
    s = reduceAll(s, [
      { kind: "tabLeft" },
      { kind: "tabLeft" },
      { kind: "tabLeft" },
      { kind: "tabLeft" },
      { kind: "tabLeft" },
      { kind: "tabLeft" },
      { kind: "tabLeft" },
    ]);
    expect(activeProjectTab(s)).toBe("status");
  });

  it("←/→ is a no-op when the input bar is focused", () => {
    let s = navReducer(initialNavState(), { kind: "focusInput", char: "a" });
    expect(s.focus).toBe("input");
    const before = s.homeTabIndex;
    s = navReducer(s, { kind: "tabRight" });
    expect(s.homeTabIndex).toBe(before);
  });

  it("←/→ is a no-op when in a drill-down detail", () => {
    let s = navReducer(initialNavState(), { kind: "enterProject", tabIndex: 1 });
    s = navReducer(s, { kind: "openAgentDetail", name: "builder" });
    const before = s.projectTabIndex;
    s = navReducer(s, { kind: "tabRight" });
    expect(s.projectTabIndex).toBe(before);
  });

  it("tab movement sets focus to tabs", () => {
    // Orchestrator supports drill-in (content focus); Overview is display-only.
    let s = navReducer(initialNavState(), { kind: "tabRight" }); // orchestrator
    s = navReducer(s, { kind: "enterTab" });
    expect(s.focus).toBe("content");
    s = navReducer(s, { kind: "tabRight" });
    expect(s.focus).toBe("tabs");
  });
});

describe("nav state machine — enter / exit (drill)", () => {
  it("enterTab moves focus from tabs to content", () => {
    // Orchestrator tab (content but non-navigable).
    let s = navReducer(initialNavState(), { kind: "tabRight" }); // orchestrator
    s = navReducer(s, { kind: "enterTab" });
    expect(s.focus).toBe("content");
  });

  it("enterTab on Overview (display-only) is a no-op", () => {
    const s0 = initialNavState(); // overview
    const s = navReducer(s0, { kind: "enterTab" });
    expect(s.focus).toBe("tabs"); // unchanged
  });

  it("exitUp: content → tabs", () => {
    let s = navReducer(initialNavState(), { kind: "tabRight" }); // orchestrator
    s = navReducer(s, { kind: "enterTab" });
    expect(s.focus).toBe("content");
    s = navReducer(s, { kind: "exitUp" });
    expect(s.focus).toBe("tabs");
  });

  it("exitUp: agent detail → content", () => {
    let s = navReducer(initialNavState(), { kind: "enterProject", tabIndex: 1 });
    s = navReducer(s, { kind: "openAgentDetail", name: "builder" });
    expect(s.agentDetail).toBe("builder");
    s = navReducer(s, { kind: "exitUp" });
    expect(s.agentDetail).toBeNull();
    expect(s.focus).toBe("content");
  });

  it("exitUp: run detail → content", () => {
    let s = navReducer(initialNavState(), { kind: "enterProject", tabIndex: 2 }); // runs
    s = navReducer(s, { kind: "openRunDetail", runId: "abc123" });
    expect(s.runDetail).toBe("abc123");
    s = navReducer(s, { kind: "exitUp" });
    expect(s.runDetail).toBeNull();
  });

  it("exitUp on project tab bar returns to home surface", () => {
    let s = navReducer(initialNavState(), { kind: "enterProject" });
    expect(s.surface).toBe("project");
    s = navReducer(s, { kind: "exitUp" });
    expect(s.surface).toBe("home");
    expect(s.focus).toBe("tabs");
  });

  it("closeDetail clears both agent and run detail", () => {
    let s = navReducer(initialNavState(), { kind: "enterProject", tabIndex: 1 });
    s = navReducer(s, { kind: "openAgentDetail", name: "builder" });
    s = navReducer(s, { kind: "closeDetail" });
    expect(s.agentDetail).toBeNull();
  });
});

describe("nav state machine — list movement", () => {
  it("↑/↓ moves the projects selection on the home Projects tab", () => {
    let s = navReducer(initialNavState(), { kind: "tabRight" }); // orchestrator
    s = navReducer(s, { kind: "tabRight" }); // projects
    s = navReducer(s, { kind: "enterTab" }); // content
    expect(s.focus).toBe("content");
    s = navReducer(s, { kind: "listDown" }, { projects: 3 });
    expect(s.projectsIndex).toBe(1);
    s = navReducer(s, { kind: "listDown" }, { projects: 3 });
    expect(s.projectsIndex).toBe(2);
    // Clamp at end.
    s = navReducer(s, { kind: "listDown" }, { projects: 3 });
    expect(s.projectsIndex).toBe(2);
    // Back up.
    s = navReducer(s, { kind: "listUp" }, { projects: 3 });
    expect(s.projectsIndex).toBe(1);
  });

  it("↑/↓ moves the drafts selection on the home Drafts tab", () => {
    let s = navReducer(initialNavState(), { kind: "tabRight" }); // orchestrator
    s = navReducer(s, { kind: "tabRight" }); // projects
    s = navReducer(s, { kind: "tabRight" }); // drafts
    s = navReducer(s, { kind: "enterTab" }); // content
    expect(s.focus).toBe("content");
    s = navReducer(s, { kind: "listDown" }, { drafts: 3 });
    expect(s.draftsIndex).toBe(1);
    s = navReducer(s, { kind: "listDown" }, { drafts: 3 });
    expect(s.draftsIndex).toBe(2);
    // Clamp at end.
    s = navReducer(s, { kind: "listDown" }, { drafts: 3 });
    expect(s.draftsIndex).toBe(2);
  });

  it("↑/↓ moves the agents selection on the project Agents tab", () => {
    let s = navReducer(initialNavState(), { kind: "enterProject", tabIndex: 2 }); // agents
    s = navReducer(s, { kind: "enterTab" });
    s = navReducer(s, { kind: "listDown" }, { agents: 4 });
    expect(s.agentsIndex).toBe(1);
    s = navReducer(s, { kind: "listDown" }, { agents: 4 });
    expect(s.agentsIndex).toBe(2);
  });

  it("↑/↓ moves the runs selection on the project Runs tab", () => {
    let s = navReducer(initialNavState(), { kind: "enterProject", tabIndex: 3 }); // runs
    s = navReducer(s, { kind: "enterTab" });
    s = navReducer(s, { kind: "listDown" }, { runs: 2 });
    expect(s.runsIndex).toBe(1);
    s = navReducer(s, { kind: "listDown" }, { runs: 2 });
    expect(s.runsIndex).toBe(1); // clamped
  });

  it("↑/↓ is a no-op when not in content focus", () => {
    let s = initialNavState();
    s = navReducer(s, { kind: "listDown" }, { projects: 3 });
    expect(s.projectsIndex).toBe(0);
  });

  it("↑/↓ is a no-op in a drill-down detail", () => {
    let s = navReducer(initialNavState(), { kind: "enterProject", tabIndex: 1 });
    s = navReducer(s, { kind: "openAgentDetail", name: "x" });
    s = navReducer(s, { kind: "listDown" }, { agents: 4 });
    expect(s.agentsIndex).toBe(0);
  });

  it("↑/↓ on non-list tabs (checkpoint/memory/cost/status) is a no-op", () => {
    let s = navReducer(initialNavState(), { kind: "enterProject" }); // status
    s = navReducer(s, { kind: "enterTab" });
    s = navReducer(s, { kind: "listDown" }, { agents: 4 });
    expect(s.agentsIndex).toBe(0);
  });

  it("↑/↓ moves the chat thread selection on the project Chat tab", () => {
    let s = navReducer(initialNavState(), { kind: "enterProject", tabIndex: 1 }); // chat
    s = navReducer(s, { kind: "enterTab" });
    s = navReducer(s, { kind: "listDown" }, { chatThreads: 3 });
    expect(s.chatThreadsIndex).toBe(1);
    s = navReducer(s, { kind: "listDown" }, { chatThreads: 3 });
    expect(s.chatThreadsIndex).toBe(2);
    s = navReducer(s, { kind: "listDown" }, { chatThreads: 3 });
    expect(s.chatThreadsIndex).toBe(2); // clamped
  });
});

describe("nav state machine — input bar", () => {
  it("focusInput from tabs captures the char and records prior focus", () => {
    let s = initialNavState(); // tabs
    s = navReducer(s, { kind: "focusInput", char: "/" });
    expect(s.focus).toBe("input");
    expect(s.input).toBe("/");
    expect(s.focusBeforeInput).toBe("tabs");
  });

  it("focusInput from content records content as the prior focus", () => {
    let s = navReducer(initialNavState(), { kind: "tabRight" });
    s = navReducer(s, { kind: "enterTab" }); // content
    s = navReducer(s, { kind: "focusInput", char: "x" });
    expect(s.focusBeforeInput).toBe("content");
  });

  it("inputType appends while in input focus", () => {
    let s = navReducer(initialNavState(), { kind: "focusInput", char: "a" });
    s = navReducer(s, { kind: "inputType", char: "b" });
    s = navReducer(s, { kind: "inputType", char: "c" });
    expect(s.input).toBe("abc");
  });

  it("inputType is a no-op when not in input focus", () => {
    let s = initialNavState();
    s = navReducer(s, { kind: "inputType", char: "x" });
    expect(s.input).toBe("");
  });

  it("inputBackspace removes the last char", () => {
    let s = reduceAll(initialNavState(), [
      { kind: "focusInput", char: "a" },
      { kind: "inputType", char: "b" },
      { kind: "inputType", char: "c" },
    ]);
    s = navReducer(s, { kind: "inputBackspace" });
    expect(s.input).toBe("ab");
  });

  it("inputSubmit clears input and restores prior focus", () => {
    let s = navReducer(initialNavState(), { kind: "focusInput", char: "/" }); // from tabs
    s = navReducer(s, { kind: "inputSubmit" });
    expect(s.focus).toBe("tabs");
    expect(s.input).toBe("");
  });

  it("inputCancel clears input and restores prior focus", () => {
    let s = navReducer(initialNavState(), { kind: "tabRight" });
    s = navReducer(s, { kind: "enterTab" }); // content
    s = navReducer(s, { kind: "focusInput", char: "x" });
    s = navReducer(s, { kind: "inputCancel" });
    expect(s.focus).toBe("content");
    expect(s.input).toBe("");
  });
});

describe("nav state machine — programmatic navigation", () => {
  it("goHome resets to the home surface", () => {
    let s = navReducer(initialNavState(), { kind: "enterProject" });
    s = navReducer(s, { kind: "openAgentDetail", name: "x" });
    s = navReducer(s, { kind: "goHome" });
    expect(s.surface).toBe("home");
    expect(s.agentDetail).toBeNull();
    expect(s.runDetail).toBeNull();
    expect(s.focus).toBe("tabs");
  });

  it("enterProject sets the project surface + optional tab", () => {
    let s = navReducer(initialNavState(), { kind: "enterProject", tabIndex: 4 });
    expect(s.surface).toBe("project");
    expect(s.projectTabIndex).toBe(4);
    expect(activeProjectTab(s)).toBe("checkpoint");
  });

  it("openAgentDetail sets detail + content focus", () => {
    let s = navReducer(initialNavState(), { kind: "enterProject" });
    s = navReducer(s, { kind: "openAgentDetail", name: "builder" });
    expect(s.agentDetail).toBe("builder");
    expect(s.runDetail).toBeNull();
    expect(s.focus).toBe("content");
  });

  it("openRunDetail sets detail + content focus", () => {
    let s = navReducer(initialNavState(), { kind: "enterProject" });
    s = navReducer(s, { kind: "openRunDetail", runId: "deadbeef" });
    expect(s.runDetail).toBe("deadbeef");
    expect(s.agentDetail).toBeNull();
  });
});

describe("nav state machine — tab index preservation", () => {
  it("switching surfaces preserves the other surface's tab position", () => {
    let s = navReducer(initialNavState(), { kind: "tabRight" }); // home → orchestrator
    s = navReducer(s, { kind: "tabRight" }); // home → projects
    expect(s.homeTabIndex).toBe(2);
    s = navReducer(s, { kind: "enterProject", tabIndex: 4 }); // project → memory
    s = navReducer(s, { kind: "tabRight" }); // project → cost
    expect(s.projectTabIndex).toBe(5);
    // Go home and back — project tab preserved.
    s = navReducer(s, { kind: "goHome" });
    expect(s.homeTabIndex).toBe(2); // preserved
    s = navReducer(s, { kind: "enterProject" });
    expect(s.projectTabIndex).toBe(5); // preserved
  });
});

describe("nav state machine — constants", () => {
  it("HOME_TABS has 4 tabs in the right order", () => {
    expect(HOME_TABS).toEqual(["overview", "orchestrator", "projects", "drafts"]);
  });

  it("PROJECT_TABS has 7 tabs in the right order", () => {
    expect(PROJECT_TABS).toEqual(["status", "chat", "agents", "runs", "checkpoint", "memory", "cost"]);
  });
});
