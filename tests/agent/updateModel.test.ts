import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateAgentModelFile } from "../../src/agent/updateModel.js";

describe("updateAgentModelFile", () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sophron-update-model-"));
    filePath = join(dir, "builder.md");
    writeFileSync(
      filePath,
      `---\nname: builder\ndescription: builds things\nmodel: ollama:test:1b\n---\n\nYou are a builder.\n`,
      "utf8",
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("updates the model field in the agent markdown file", () => {
    updateAgentModelFile(filePath, { provider: "openrouter", model: "deepseek-v4-flash" });
    const updated = readFileSync(filePath, "utf8");
    expect(updated).toContain("model: deepseek-v4-flash");
    expect(updated).toContain("provider: openrouter");
    expect(updated).toContain("name: builder");
    expect(updated).toContain("You are a builder.");
  });

  it("removes the provider field when the resolution has no provider", () => {
    writeFileSync(
      filePath,
      `---\nname: builder\ndescription: builds things\nmodel: ollama:test:1b\nprovider: ollama\n---\n\nYou are a builder.\n`,
      "utf8",
    );
    updateAgentModelFile(filePath, { provider: undefined as unknown as string, model: "deepseek-v4-flash" });
    const updated = readFileSync(filePath, "utf8");
    expect(updated).toContain("model: deepseek-v4-flash");
    expect(updated).not.toContain("provider:");
  });
});
