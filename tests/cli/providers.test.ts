import { describe, expect, it, vi, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCliAtHome } from "./helpers.js";
import { LLMClient } from "../../src/llm/client.js";

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("sophron providers", () => {
  it("lists nothing when no providers are configured", async () => {
    const home = mkdtempSync(join(tmpdir(), "sophron-cli-"));
    const result = await runCliAtHome(home, ["providers"]);
    expect(result.exitCode).toBeUndefined();
    expect(result.stdout).toContain("No providers configured");
  });

  it("adds a provider instance via the add subcommand", async () => {
    const home = mkdtempSync(join(tmpdir(), "sophron-cli-"));
    const add = await runCliAtHome(home, ["providers", "add", "--name", "ollama", "--kind", "ollama"]);
    expect(add.exitCode).toBeUndefined();
    expect(add.stdout).toContain("Added provider 'ollama'");

    const list = await runCliAtHome(home, ["providers"]);
    expect(list.stdout).toContain("ollama");
  });

  it("shows details and a successful connectivity test for view/test", async () => {
    const home = mkdtempSync(join(tmpdir(), "sophron-cli-"));
    vi.spyOn(LLMClient.prototype, "listModels").mockResolvedValue([{ id: "qwen3.5:9b" }]);

    await runCliAtHome(home, ["providers", "add", "--name", "ollama", "--kind", "ollama"]);

    const view = await runCliAtHome(home, ["providers", "view", "ollama"]);
    expect(view.exitCode).toBeUndefined();
    expect(view.stdout).toContain("ollama");
    expect(view.stdout).toContain("reachable");
    expect(view.stdout).toContain("qwen3.5:9b");

    const testCmd = await runCliAtHome(home, ["providers", "test", "ollama"]);
    expect(testCmd.exitCode).toBeUndefined();
    expect(testCmd.stdout).toContain("reachable");
  });

  it("edits a provider instance via the edit subcommand", async () => {
    const home = mkdtempSync(join(tmpdir(), "sophron-cli-"));
    await runCliAtHome(home, ["providers", "add", "--name", "ollama", "--kind", "ollama"]);

    const edit = await runCliAtHome(home, ["providers", "edit", "ollama", "--description", "local llm"]);
    expect(edit.exitCode).toBeUndefined();
    expect(edit.stdout).toContain("Updated provider 'ollama'");

    const list = await runCliAtHome(home, ["providers"]);
    expect(list.stdout).toContain("local llm");
  });

  it("removes a provider instance via the remove subcommand", async () => {
    const home = mkdtempSync(join(tmpdir(), "sophron-cli-"));
    await runCliAtHome(home, ["providers", "add", "--name", "ollama", "--kind", "ollama"]);

    const remove = await runCliAtHome(home, ["providers", "remove", "ollama"]);
    expect(remove.exitCode).toBeUndefined();
    expect(remove.stdout).toContain("Removed provider 'ollama'");

    const list = await runCliAtHome(home, ["providers"]);
    expect(list.stdout).toContain("No providers configured");
  });

  it("reports an error when removing an unknown provider", async () => {
    const home = mkdtempSync(join(tmpdir(), "sophron-cli-"));
    const result = await runCliAtHome(home, ["providers", "remove", "missing"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("No provider instance named 'missing'");
  });
});

describe("sophron providers hidden aliases", () => {
  it("add-provider writes the same config as providers add", async () => {
    const home = mkdtempSync(join(tmpdir(), "sophron-cli-"));
    const result = await runCliAtHome(home, ["add-provider", "--name", "or", "--kind", "openrouter", "--api-key", "${OR_KEY}"]);
    expect(result.exitCode).toBeUndefined();
    expect(result.stdout).toContain("Added provider 'or'");

    const list = await runCliAtHome(home, ["providers"]);
    expect(list.stdout).toContain("or");
    expect(list.stdout).toContain("openrouter");
  });

  it("edit-provider updates the instance", async () => {
    const home = mkdtempSync(join(tmpdir(), "sophron-cli-"));
    await runCliAtHome(home, ["providers", "add", "--name", "or", "--kind", "openrouter"]);

    const edit = await runCliAtHome(home, ["edit-provider", "or", "--description", "cloud router"]);
    expect(edit.exitCode).toBeUndefined();
    expect(edit.stdout).toContain("Updated provider 'or'");

    const list = await runCliAtHome(home, ["providers"]);
    expect(list.stdout).toContain("cloud router");
  });

  it("remove-provider removes the instance", async () => {
    const home = mkdtempSync(join(tmpdir(), "sophron-cli-"));
    await runCliAtHome(home, ["providers", "add", "--name", "or", "--kind", "openrouter"]);

    const remove = await runCliAtHome(home, ["remove-provider", "or"]);
    expect(remove.exitCode).toBeUndefined();
    expect(remove.stdout).toContain("Removed provider 'or'");

    const list = await runCliAtHome(home, ["providers"]);
    expect(list.stdout).toContain("No providers configured");
  });
});
