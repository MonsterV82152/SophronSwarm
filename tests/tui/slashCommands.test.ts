import { describe, expect, it } from "vitest";
import { parseSlashCommand, HELP_TEXT } from "../../src/tui/slashCommands.js";

describe("parseSlashCommand — free text (tasks)", () => {
  it("treats non-slash input as a task", () => {
    expect(parseSlashCommand("do the thing")).toEqual({ kind: "task", text: "do the thing" });
  });

  it("trims whitespace", () => {
    expect(parseSlashCommand("  hello world  ")).toEqual({ kind: "task", text: "hello world" });
  });

  it("returns unknown for empty input", () => {
    expect(parseSlashCommand("   ")).toMatchObject({ kind: "unknown", reason: /empty/ });
  });
});

describe("parseSlashCommand — simple commands", () => {
  it.each([
    ["/help"], ["/h"], ["/?"],
  ])("parses %s as help", (cmd) => {
    expect(parseSlashCommand(cmd)).toEqual({ kind: "help" });
  });

  it.each([
    ["/agents"], ["/a"],
  ])("parses %s as agents", (cmd) => {
    expect(parseSlashCommand(cmd)).toEqual({ kind: "agents" });
  });

  it("parses /projects", () => {
    expect(parseSlashCommand("/projects")).toEqual({ kind: "projects" });
    expect(parseSlashCommand("/p")).toEqual({ kind: "projects" });
  });

  it("parses /checkpoint", () => {
    expect(parseSlashCommand("/checkpoint")).toEqual({ kind: "checkpoint" });
    expect(parseSlashCommand("/cp")).toEqual({ kind: "checkpoint" });
  });

  it("parses /advance", () => {
    expect(parseSlashCommand("/advance")).toEqual({ kind: "advance" });
  });

  it("parses /cost", () => {
    expect(parseSlashCommand("/cost")).toEqual({ kind: "cost" });
  });

  it("parses /clear and /quit", () => {
    expect(parseSlashCommand("/clear")).toEqual({ kind: "clear" });
    expect(parseSlashCommand("/quit")).toEqual({ kind: "quit" });
    expect(parseSlashCommand("/exit")).toEqual({ kind: "quit" });
  });

  it("parses /new and /chats", () => {
    expect(parseSlashCommand("/new")).toEqual({ kind: "new" });
    expect(parseSlashCommand("/chats")).toEqual({ kind: "chats" });
  });

  it("parses /switch and /chat", () => {
    expect(parseSlashCommand("/switch my-project")).toEqual({ kind: "switch", project: "my-project" });
    expect(parseSlashCommand("/s my-project")).toEqual({ kind: "switch", project: "my-project" });
    expect(parseSlashCommand("/chat my-project")).toEqual({ kind: "chat", project: "my-project" });
    expect(parseSlashCommand("/chat")).toEqual({ kind: "chat" });
  });
});

describe("parseSlashCommand — /runs with optional limit", () => {
  it("defaults to no limit", () => {
    expect(parseSlashCommand("/runs")).toEqual({ kind: "runs" });
  });

  it("accepts a numeric limit", () => {
    expect(parseSlashCommand("/runs 10")).toEqual({ kind: "runs", limit: 10 });
  });

  it("ignores a non-numeric limit", () => {
    expect(parseSlashCommand("/runs abc")).toEqual({ kind: "runs" });
  });
});

describe("parseSlashCommand — /run with agent + task", () => {
  it("parses agent + quoted task", () => {
    expect(parseSlashCommand('/run builder "scaffold a project"')).toEqual({
      kind: "run",
      agent: "builder",
      task: "scaffold a project",
    });
  });

  it("parses agent + unquoted task", () => {
    expect(parseSlashCommand("/run builder do the thing")).toEqual({
      kind: "run",
      agent: "builder",
      task: "do the thing",
    });
  });

  it("parses project/agent + quoted task", () => {
    expect(parseSlashCommand('/run my-app/builder "scaffold a project"')).toEqual({
      kind: "run",
      project: "my-app",
      agent: "builder",
      task: "scaffold a project",
    });
  });

  it("returns unknown when missing the task", () => {
    expect(parseSlashCommand("/run builder")).toMatchObject({ kind: "unknown", reason: /requires/ });
  });

  it("returns unknown when missing both args", () => {
    expect(parseSlashCommand("/run")).toMatchObject({ kind: "unknown" });
  });

  it("returns unknown for malformed project/agent", () => {
    expect(parseSlashCommand("/run /agent do thing")).toMatchObject({ kind: "unknown", reason: /both project and agent/ });
  });
});

describe("parseSlashCommand — /approve", () => {
  it("parses yes decision", () => {
    expect(parseSlashCommand("/approve abc12345 yes")).toEqual({
      kind: "approve",
      id: "abc12345",
      decision: "yes",
    });
  });

  it("accepts y/n shorthand", () => {
    expect(parseSlashCommand("/approve abc12345 y")).toMatchObject({ decision: "yes" });
    expect(parseSlashCommand("/approve abc12345 n")).toMatchObject({ decision: "no" });
  });

  it("rejects an invalid decision", () => {
    expect(parseSlashCommand("/approve abc12345 maybe")).toMatchObject({ kind: "unknown", reason: /yes or no/ });
  });

  it("rejects missing args", () => {
    expect(parseSlashCommand("/approve abc12345")).toMatchObject({ kind: "unknown" });
  });
});

describe("parseSlashCommand — /rewind", () => {
  it("parses a runId", () => {
    expect(parseSlashCommand("/rewind abc-123")).toEqual({ kind: "rewind", runId: "abc-123" });
  });

  it("rejects missing runId", () => {
    expect(parseSlashCommand("/rewind")).toMatchObject({ kind: "unknown" });
  });
});

describe("parseSlashCommand — /memory", () => {
  it("parses with an agent name", () => {
    expect(parseSlashCommand("/memory builder")).toEqual({ kind: "memory", agent: "builder" });
  });

  it("parses without an agent (shared)", () => {
    expect(parseSlashCommand("/memory")).toEqual({ kind: "memory", agent: undefined });
  });
});

describe("parseSlashCommand — /model", () => {
  it("parses agent + model spec", () => {
    expect(parseSlashCommand("/model builder frontier")).toEqual({
      kind: "model",
      agent: "builder",
      spec: "frontier",
    });
  });

  it("parses agent + provider-prefixed model", () => {
    expect(parseSlashCommand("/model builder openrouter:anthropic/claude-sonnet-4")).toEqual({
      kind: "model",
      agent: "builder",
      spec: "openrouter:anthropic/claude-sonnet-4",
    });
  });

  it("parses a bare model spec (context determines agent)", () => {
    expect(parseSlashCommand("/model frontier")).toEqual({ kind: "model", spec: "frontier" });
  });

  it("rejects missing spec", () => {
    expect(parseSlashCommand("/model")).toMatchObject({ kind: "unknown", reason: /requires/ });
  });
});

describe("parseSlashCommand — draft commands", () => {
  it("parses /drafts", () => {
    expect(parseSlashCommand("/drafts")).toEqual({ kind: "drafts" });
  });

  it("parses /approve-draft with project + agent", () => {
    expect(parseSlashCommand("/approve-draft my-app builder")).toEqual({
      kind: "approveDraft",
      project: "my-app",
      name: "builder",
    });
  });

  it("parses /ad alias", () => {
    expect(parseSlashCommand("/ad my-app builder")).toEqual({
      kind: "approveDraft",
      project: "my-app",
      name: "builder",
    });
  });

  it("parses /reject-draft with project + agent", () => {
    expect(parseSlashCommand("/reject-draft my-app builder")).toEqual({
      kind: "rejectDraft",
      project: "my-app",
      name: "builder",
    });
  });

  it("parses /rd alias", () => {
    expect(parseSlashCommand("/rd my-app builder")).toEqual({
      kind: "rejectDraft",
      project: "my-app",
      name: "builder",
    });
  });

  it("parses /approve-all-drafts without project", () => {
    expect(parseSlashCommand("/approve-all-drafts")).toEqual({ kind: "approveAllDrafts", project: undefined });
  });

  it("parses /approve-all-drafts with project", () => {
    expect(parseSlashCommand("/approve-all-drafts my-app")).toEqual({ kind: "approveAllDrafts", project: "my-app" });
  });

  it("parses /reject-all-drafts with project", () => {
    expect(parseSlashCommand("/reject-all-drafts my-app")).toEqual({ kind: "rejectAllDrafts", project: "my-app" });
  });

  it("rejects /approve-draft missing args", () => {
    expect(parseSlashCommand("/approve-draft my-app")).toMatchObject({ kind: "unknown", reason: /requires/ });
  });
});

describe("parseSlashCommand — unknown commands", () => {
  it("returns unknown for an unrecognized command", () => {
    expect(parseSlashCommand("/bogus")).toMatchObject({ kind: "unknown", reason: /unknown command/ });
  });
});

describe("HELP_TEXT", () => {
  it("lists the core commands", () => {
    expect(HELP_TEXT).toContain("/agents");
    expect(HELP_TEXT).toContain("/run");
    expect(HELP_TEXT).toContain("/cost");
    expect(HELP_TEXT).toContain("/help");
    expect(HELP_TEXT).toContain("/new");
    expect(HELP_TEXT).toContain("/chats");
    expect(HELP_TEXT).toContain("/switch");
    expect(HELP_TEXT).toContain("/chat");
  });
});
