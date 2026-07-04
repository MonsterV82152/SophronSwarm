import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgentFile } from "../../src/agent/loader.js";

// Make `model: inherit` resolve to a local Ollama default in tests.
process.env["OLLAMA_DEFAULT_MODEL"] = "llama3.2:1b";

const VALID_AGENT = `---
name: echo-bot
description: A trivial agent for testing the loop.
tools:
  - echo
  - read_file
model: inherit
permissionMode: default
maxTurns: 5
---

You are an echo bot. Use the echo tool to repeat text back, then stop.
`;

describe("agent loader", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sophron-loader-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("loads a valid agent file", () => {
    const file = join(dir, "echo-bot.md");
    writeFileSync(file, VALID_AGENT);
    const r = loadAgentFile({ source: "project", filePath: file });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.agent.name).toBe("echo-bot");
    expect(r.agent.tools).toEqual(["echo", "read_file"]);
    expect(r.agent.permissionMode).toBe("default");
    expect(r.agent.maxTurns).toBe(5);
    expect(r.agent.systemPrompt).toMatch(/echo bot/);
  });

  it("fails on missing required fields", () => {
    const file = join(dir, "bad.md");
    writeFileSync(file, "---\ndescription: no name\n---\nbody");
    const r = loadAgentFile({ source: "project", filePath: file });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/name/);
  });

  it("fails on empty system prompt body", () => {
    const file = join(dir, "empty.md");
    writeFileSync(file, "---\nname: x\ndescription: y\nmodel: inherit\n---\n   \n");
    const r = loadAgentFile({ source: "project", filePath: file });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/empty/i);
  });

  it("fails on unreadable file", () => {
    const r = loadAgentFile({ source: "project", filePath: join(dir, "nope.md") });
    expect(r.ok).toBe(false);
  });

  it("strips markdown fences tolerance is handled at extract step (Phase 0: n/a)", () => {
    // sanity: bodies with code fences are preserved verbatim in the system prompt
    const file = join(dir, "fenced.md");
    writeFileSync(file, "---\nname: x\ndescription: y\nmodel: inherit\n---\n\nDo stuff.\n\n\`\`\`js\nconst x = 1;\n\`\`\`\n");
    const r = loadAgentFile({ source: "project", filePath: file });
    expect(r.ok).toBe(true);
  });
});

describe("agent registry", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sophron-reg-"));
    process.chdir(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("scopes and overrides", async () => {
    const { AgentRegistry } = await import("../../src/agent/registry.js");
    // project
    mkdirSync(join(dir, "agents"), { recursive: true });
    writeFileSync(join(dir, "agents", "a.md"), "---\nname: shared\ndescription: project\nmodel: inherit\n---\nproject body");
    // user (simulate by pointing HOME at a temp) — we just confirm project loads
    const reg = new AgentRegistry();
    const result = reg.scan();
    expect(result.errors).toHaveLength(0);
    const a = reg.get("shared");
    expect(a?.systemPrompt).toBe("project body");
  });

  it("collects per-file errors without crashing", async () => {
    const { AgentRegistry } = await import("../../src/agent/registry.js");
    mkdirSync(join(dir, "agents"), { recursive: true });
    writeFileSync(join(dir, "agents", "good.md"), "---\nname: g\ndescription: g\nmodel: inherit\n---\nok");
    writeFileSync(join(dir, "agents", "bad.md"), "---\ndescription: nope\n---\nbody");
    const reg = new AgentRegistry();
    const result = reg.scan();
    expect(result.agents.map((a) => a.name)).toContain("g");
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
