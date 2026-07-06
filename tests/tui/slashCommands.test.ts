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

  it("returns unknown when missing the task", () => {
    expect(parseSlashCommand("/run builder")).toMatchObject({ kind: "unknown", reason: /requires/ });
  });

  it("returns unknown when missing both args", () => {
    expect(parseSlashCommand("/run")).toMatchObject({ kind: "unknown" });
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
  });
});
