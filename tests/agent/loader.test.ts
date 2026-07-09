import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgentFile } from "../../src/agent/loader.js";
import { AgentRegistry } from "../../src/agent/registry.js";

const VALID_AGENT = `---
name: echo-bot
description: A trivial agent for testing the loop.
tools:
  - echo
  - read_file
model: ollama:qwen3.5:9b-thinking
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
    writeFileSync(file, "---\nname: x\ndescription: y\nmodel: ollama:qwen3.5:9b-thinking\n---\n   \n");
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
    writeFileSync(file, "---\nname: x\ndescription: y\nmodel: ollama:qwen3.5:9b-thinking\n---\n\nDo stuff.\n\n\`\`\`js\nconst x = 1;\n\`\`\`\n");
    const r = loadAgentFile({ source: "project", filePath: file });
    expect(r.ok).toBe(true);
  });
  it("parses the noMemory flag (M7 — global orchestrator)", () => {
    const file = join(dir, "nomem.md");
    writeFileSync(
      file,
      "---\nname: global-orchestrator\ndescription: CEO\nmodel: openrouter:deepseek/deepseek-v4-flash\nnoMemory: true\n---\nYou are the CEO.",
    );
    const r = loadAgentFile({ source: "project", filePath: file });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.agent.noMemory).toBe(true);
  });

  it("defaults noMemory to undefined when not set", () => {
    const file = join(dir, "echo-bot.md");
    writeFileSync(file, VALID_AGENT);
    const r = loadAgentFile({ source: "project", filePath: file });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.agent.noMemory).toBeUndefined();
  });});

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
    writeFileSync(join(dir, "agents", "a.md"), "---\nname: shared\ndescription: project\nmodel: ollama:qwen3.5:9b-thinking\n---\nproject body");
    // user (simulate by pointing HOME at a temp) — we just confirm project loads
    const reg = new AgentRegistry(dir);
    const result = reg.scan();
    expect(result.errors).toHaveLength(0);
    const a = reg.get("shared");
    expect(a?.systemPrompt).toBe("project body");
  });

  it("collects per-file errors without crashing", async () => {
    const { AgentRegistry } = await import("../../src/agent/registry.js");
    mkdirSync(join(dir, "agents"), { recursive: true });
    writeFileSync(join(dir, "agents", "good.md"), "---\nname: g\ndescription: g\nmodel: ollama:qwen3.5:9b-thinking\n---\nok");
    writeFileSync(join(dir, "agents", "bad.md"), "---\ndescription: nope\n---\nbody");
    const reg = new AgentRegistry(dir);
    const result = reg.scan();
    expect(result.agents.map((a) => a.name)).toContain("g");
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("loads project agents from an explicit root without changing cwd", () => {
    const explicitDir = mkdtempSync(join(tmpdir(), "sophron-reg-explicit-"));
    try {
      mkdirSync(join(explicitDir, "agents"), { recursive: true });
      writeFileSync(
        join(explicitDir, "agents", "local.md"),
        "---\nname: local-agent\ndescription: local\nmodel: ollama:qwen3.5:9b-thinking\n---\nlocal body",
      );
      const cwd = process.cwd();
      const reg = new AgentRegistry(explicitDir);
      const result = reg.scan();
      expect(process.cwd()).toBe(cwd); // did not mutate cwd
      expect(result.agents.map((a) => a.name)).toContain("local-agent");
      expect(reg.get("local-agent")?.source).toBe("project");
    } finally {
      rmSync(explicitDir, { recursive: true, force: true });
    }
  });

  it("excludes global agents from project-scoped lists but keeps them gettable", () => {
    const home = mkdtempSync(join(tmpdir(), "sophron-reg-home-"));
    const originalHome = process.env["HOME"];
    try {
      process.env["HOME"] = home;
      mkdirSync(join(home, ".sophron", "agents"), { recursive: true });
      writeFileSync(
        join(home, ".sophron", "agents", "global-orchestrator.md"),
        "---\nname: global-orchestrator\ndescription: g\nmodel: openrouter:deepseek/deepseek-v4-flash\n---\nbody",
      );
      writeFileSync(
        join(home, ".sophron", "agents", "architect.md"),
        "---\nname: architect\ndescription: g\nmodel: openrouter:deepseek/deepseek-v4-flash\n---\nbody",
      );
      mkdirSync(join(dir, "agents"), { recursive: true });
      writeFileSync(
        join(dir, "agents", "builder.md"),
        "---\nname: builder\ndescription: g\nmodel: ollama:qwen3.5:9b-thinking\n---\nbody",
      );
      const reg = new AgentRegistry(dir);
      reg.scan();
      expect(reg.list().map((a) => a.name)).toContain("global-orchestrator");
      expect(reg.listProjectAgents().map((a) => a.name)).toEqual(["builder"]);
      expect(reg.get("architect")).toBeDefined();
    } finally {
      process.env["HOME"] = originalHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
