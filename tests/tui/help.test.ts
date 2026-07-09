/**
 * Tests for context-aware help (src/tui/help.ts).
 *
 * Pure logic — no React, no Ink. Verifies that helpForView returns the core
 * section on every view and the right per-view section for each view, and that
 * helpViewFor maps the nav state to the correct HelpView.
 */
import { describe, expect, it } from "vitest";
import { helpForView, helpViewFor, type HelpView } from "../../src/tui/help.js";

const ALL_VIEWS: HelpView[] = [
  "home:overview",
  "home:orchestrator",
  "home:projects",
  "home:drafts",
  "project:status",
  "project:chat",
  "project:agents",
  "project:agentDetail",
  "project:runs",
  "project:runDetail",
  "project:checkpoint",
  "project:memory",
  "project:cost",
];

describe("helpForView — core section", () => {
  it("includes the core navigation keys on every view", () => {
    for (const view of ALL_VIEWS) {
      const text = helpForView(view);
      expect(text).toContain("←/→");
      expect(text).toContain("↑/↓");
      expect(text).toContain("Enter");
      expect(text).toContain("Esc");
      expect(text).toContain("Ctrl+C");
    }
  });

  it("includes always-available commands on every view", () => {
    for (const view of ALL_VIEWS) {
      const text = helpForView(view);
      expect(text).toContain("/help");
      expect(text).toContain("/projects");
      expect(text).toContain("/clear");
      expect(text).toContain("/quit");
      expect(text).toContain("/model [<agent>] <spec>");
    }
  });

  it("starts with the SophronSwarm help title", () => {
    for (const view of ALL_VIEWS) {
      expect(helpForView(view)).toContain("SophronSwarm V3 — help");
    }
  });
});

describe("helpForView — per-view sections", () => {
  it("home:overview mentions cross-project health + display-only", () => {
    const text = helpForView("home:overview");
    expect(text).toContain("Overview");
    expect(text).toContain("cross-project");
    expect(text).toContain("Display-only");
  });

  it("home:orchestrator describes the global chat (M8) + /model", () => {
    const text = helpForView("home:orchestrator");
    expect(text).toContain("Orchestrator");
    expect(text).toContain("global");
    expect(text).toContain("propose");
    expect(text).toContain("install-orchestrator");
    expect(text).toContain("/model <spec>");
    expect(text).toContain("global orchestrator's model");
  });

  it("home:projects shows ↑/↓ + Enter to switch", () => {
    const text = helpForView("home:projects");
    expect(text).toContain("Projects");
    expect(text).toContain("Enter to open");
    expect(text).toContain("switches workspace");
  });

  it("home:drafts shows ↑/↓ + Enter to approve + R to reject", () => {
    const text = helpForView("home:drafts");
    expect(text).toContain("Drafts");
    expect(text).toContain("Enter to approve");
    expect(text).toContain("R to reject");
  });

  it("project:status mentions health/approvals", () => {
    const text = helpForView("project:status");
    expect(text).toContain("Status");
    expect(text).toContain("approvals");
  });

  it("project:chat mentions streaming chat + persistence", () => {
    const text = helpForView("project:chat");
    expect(text).toContain("Chat");
    expect(text).toContain("streaming");
    expect(text).toContain("persist");
    expect(text).toContain("orchestrator");
  });

  it("project:agents shows Enter to open + /memory + /run + context /model", () => {
    const text = helpForView("project:agents");
    expect(text).toContain("Agents");
    expect(text).toContain("live stream");
    expect(text).toContain("/memory");
    expect(text).toContain("/run");
    expect(text).toContain("/model <spec>");
    expect(text).toContain("selected agent's model");
    expect(text).toContain("/model <agent> <spec>");
  });

  it("project:agentDetail shows /approve + /rewind + Esc", () => {
    const text = helpForView("project:agentDetail");
    expect(text).toContain("Agent detail");
    expect(text).toContain("/approve");
    expect(text).toContain("/rewind");
    expect(text).toContain("Esc");
  });

  it("project:runs shows Enter to expand + /runs", () => {
    const text = helpForView("project:runs");
    expect(text).toContain("Runs");
    expect(text).toContain("/runs");
  });

  it("project:runDetail shows event log + Esc", () => {
    const text = helpForView("project:runDetail");
    expect(text).toContain("Run detail");
    expect(text).toContain("event log");
    expect(text).toContain("Esc");
  });

  it("project:checkpoint shows /advance", () => {
    const text = helpForView("project:checkpoint");
    expect(text).toContain("Checkpoint");
    expect(text).toContain("/advance");
  });

  it("project:memory shows /memory shared + per-agent", () => {
    const text = helpForView("project:memory");
    expect(text).toContain("Memory");
    expect(text).toContain("/memory");
  });

  it("project:cost mentions MCP + lazy", () => {
    const text = helpForView("project:cost");
    expect(text).toContain("Cost");
    expect(text).toContain("MCP");
    expect(text).toContain("lazy");
  });
});

describe("helpForView — structure", () => {
  it("per-view section appears after the core section", () => {
    const text = helpForView("project:agents");
    const coreIdx = text.indexOf("Always-available commands");
    const viewIdx = text.indexOf("Agents");
    expect(coreIdx).toBeGreaterThan(-1);
    expect(viewIdx).toBeGreaterThan(coreIdx);
  });

  it("core section has navigation + commands subsections", () => {
    const text = helpForView("home:overview");
    expect(text).toContain("Navigation");
    expect(text).toContain("Always-available commands");
  });
});

describe("helpViewFor — nav state → HelpView mapping", () => {
  it("maps home surface + tab to home:<tab>", () => {
    expect(helpViewFor("home", "overview", "status", null)).toBe("home:overview");
    expect(helpViewFor("home", "orchestrator", "status", null)).toBe("home:orchestrator");
    expect(helpViewFor("home", "projects", "status", null)).toBe("home:projects");
    expect(helpViewFor("home", "drafts", "status", null)).toBe("home:drafts");
  });

  it("maps project surface + tab (no detail) to project:<tab>", () => {
    expect(helpViewFor("project", "overview", "status", null)).toBe("project:status");
    expect(helpViewFor("project", "overview", "chat", null)).toBe("project:chat");
    expect(helpViewFor("project", "overview", "agents", null)).toBe("project:agents");
    expect(helpViewFor("project", "overview", "runs", null)).toBe("project:runs");
    expect(helpViewFor("project", "overview", "checkpoint", null)).toBe("project:checkpoint");
    expect(helpViewFor("project", "overview", "memory", null)).toBe("project:memory");
    expect(helpViewFor("project", "overview", "cost", null)).toBe("project:cost");
  });

  it("agent detail takes precedence over the tab", () => {
    expect(helpViewFor("project", "overview", "agents", "agent")).toBe("project:agentDetail");
    expect(helpViewFor("project", "overview", "status", "agent")).toBe("project:agentDetail");
  });

  it("run detail takes precedence over the tab", () => {
    expect(helpViewFor("project", "overview", "runs", "run")).toBe("project:runDetail");
    expect(helpViewFor("project", "overview", "status", "run")).toBe("project:runDetail");
  });

  it("agent detail takes precedence over run detail (only one detail at a time in nav)", () => {
    expect(helpViewFor("project", "overview", "agents", "agent")).toBe("project:agentDetail");
  });
});
