import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgentFile, updateAgentFrontmatter } from "../../src/agent/loader.js";
import { _resetProviderCacheForTests } from "../../src/llm/providers.js";

// V3.1.0: agents require concrete model + provider. We set up a config with
// an ollama provider so the fixtures resolve.
let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sophron-loader-home-"));
  prevHome = process.env["HOME"];
  process.env["HOME"] = home;
  mkdirSync(join(home, ".sophron"), { recursive: true });
  writeFileSync(join(home, ".sophron", "config.json"), JSON.stringify({
    providers: [{ name: "ollama", kind: "ollama", baseURL: "http://localhost:11434/v1" }],
  }));
  _resetProviderCacheForTests();
});
afterEach(() => {
  if (prevHome !== undefined) process.env["HOME"] = prevHome;
  else delete process.env["HOME"];
  rmSync(home, { recursive: true, force: true });
  _resetProviderCacheForTests();
});

const VALID_AGENT = `---
name: echo-bot
description: A trivial agent for testing the loop.
tools:
  - echo
  - read_file
model: llama3.2:1b
provider: ollama
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
    writeFileSync(file, "---\nname: x\ndescription: y\nmodel: llama3.2:1b\nprovider: ollama\n---\n   \n");
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
    writeFileSync(file, "---\nname: x\ndescription: y\nmodel: llama3.2:1b\nprovider: ollama\n---\n\nDo stuff.\n\n\`\`\`js\nconst x = 1;\n\`\`\`\n");
    const r = loadAgentFile({ source: "project", filePath: file });
    expect(r.ok).toBe(true);
  });
  it("parses the noMemory flag (M7 — global orchestrator)", () => {
    const file = join(dir, "nomem.md");
    writeFileSync(
      file,
      "---\nname: global-orchestrator\ndescription: CEO\nmodel: llama3.2:1b\nprovider: ollama\nnoMemory: true\n---\nYou are the CEO.",
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
  });

  it("updateAgentFrontmatter patches model and provider", () => {
    const file = join(dir, "echo-bot.md");
    writeFileSync(file, VALID_AGENT);
    updateAgentFrontmatter(file, { model: "qwen3.5:9b", provider: "ollama" });
    const r = loadAgentFile({ source: "project", filePath: file });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.agent.model).toBe("qwen3.5:9b");
    expect(r.agent.provider).toBe("ollama");
  });

  it("updateAgentFrontmatter preserves the system prompt body", () => {
    const file = join(dir, "echo-bot.md");
    writeFileSync(file, VALID_AGENT);
    updateAgentFrontmatter(file, { model: "qwen3.5:9b" });
    const r = loadAgentFile({ source: "project", filePath: file });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.agent.systemPrompt).toMatch(/echo bot/);
  });

  it("updateAgentFrontmatter throws for a missing file", () => {
    expect(() => updateAgentFrontmatter(join(dir, "nope.md"), { model: "x" })).toThrow(/Could not read/);
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
    writeFileSync(join(dir, "agents", "a.md"), "---\nname: shared\ndescription: project\nmodel: llama3.2:1b\nprovider: ollama\n---\nproject body");
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
    writeFileSync(join(dir, "agents", "good.md"), "---\nname: g\ndescription: g\nmodel: llama3.2:1b\nprovider: ollama\n---\nok");
    writeFileSync(join(dir, "agents", "bad.md"), "---\ndescription: nope\n---\nbody");
    const reg = new AgentRegistry();
    const result = reg.scan();
    expect(result.agents.map((a) => a.name)).toContain("g");
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
