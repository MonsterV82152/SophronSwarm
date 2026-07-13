import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { runCliAtHome } from "../cli/helpers.js";

function seedOllama(home: string) {
  const dir = join(home, ".sophron");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({ providers: [{ name: "ollama", kind: "ollama" }] }, null, 2),
    "utf8",
  );
}

function createAgent(cwd: string, name: string, model = "qwen3.5:9b-thinking", provider = "ollama") {
  const agentsDir = join(cwd, "agents");
  mkdirSync(agentsDir, { recursive: true });
  const content = `---
name: ${name}
description: test agent
model: ${model}
provider: ${provider}
tools:
  - read_file
---

You are a test agent.
`;
  writeFileSync(join(agentsDir, `${name}.md`), content, "utf8");
}

describe.sequential("sophron agents edit", () => {
  it("updates only the model when --model is given", async () => {
    const home = mkdtempSync(join(tmpdir(), "sophron-edit-"));
    const cwd = mkdtempSync(join(tmpdir(), "sophron-cwd-"));
    seedOllama(home);
    createAgent(cwd, "test-agent");

    const result = await runCliAtHome(home, ["agents", "edit", "test-agent", "--model", "llama3.1:8b", "--dir", cwd]);
    expect(result.exitCode).toBeUndefined();
    expect(result.stdout).toContain("Updated 'test-agent'");

    const updated = readFileSync(join(cwd, "agents", "test-agent.md"), "utf8");
    expect(updated).toContain("llama3.1:8b");
    expect(updated).toContain("provider: ollama");
  });

  it("updates only the provider when --provider is given", async () => {
    const home = mkdtempSync(join(tmpdir(), "sophron-edit-"));
    const cwd = mkdtempSync(join(tmpdir(), "sophron-cwd-"));
    // Seed a second provider.
    mkdirSync(join(home, ".sophron"), { recursive: true });
    writeFileSync(
      join(home, ".sophron", "config.json"),
      JSON.stringify({ providers: [{ name: "ollama", kind: "ollama" }, { name: "or", kind: "openrouter" }] }, null, 2),
      "utf8",
    );
    createAgent(cwd, "test-agent");
    const result = await runCliAtHome(home, ["agents", "edit", "test-agent", "--provider", "or", "--dir", cwd]);
    expect(result.exitCode).toBeUndefined();

    const updated = readFileSync(join(cwd, "agents", "test-agent.md"), "utf8");
    expect(updated).toContain("provider: or");
    expect(updated).toContain("qwen3.5:9b-thinking");
  });

  it("rejects an unknown provider/model pair", async () => {
    const home = mkdtempSync(join(tmpdir(), "sophron-edit-"));
    const cwd = mkdtempSync(join(tmpdir(), "sophron-cwd-"));
    seedOllama(home);
    createAgent(cwd, "test-agent");

    const result = await runCliAtHome(home, ["agents", "edit", "test-agent", "--model", "x", "--provider", "missing", "--dir", cwd]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Invalid model/provider pair");

    const content = readFileSync(join(cwd, "agents", "test-agent.md"), "utf8");
    expect(content).toContain("provider: ollama");
  });

  it("rejects an unknown agent", async () => {
    const home = mkdtempSync(join(tmpdir(), "sophron-edit-"));
    const cwd = mkdtempSync(join(tmpdir(), "sophron-cwd-"));
    seedOllama(home);

    const result = await runCliAtHome(home, ["agents", "edit", "unknown", "--model", "x", "--dir", cwd]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Agent 'unknown' not found");
  });

  it("errors when neither --model nor --provider is given", async () => {
    const home = mkdtempSync(join(tmpdir(), "sophron-edit-"));
    const cwd = mkdtempSync(join(tmpdir(), "sophron-cwd-"));
    seedOllama(home);
    createAgent(cwd, "test-agent");

    const result = await runCliAtHome(home, ["agents", "edit", "test-agent", "--dir", cwd]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Specify --model and/or --provider");
  });
});
