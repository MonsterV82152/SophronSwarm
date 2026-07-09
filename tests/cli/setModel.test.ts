import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runCli } from "../../src/cli.js";
import { _resetProviderCacheForTests } from "../../src/llm/providers.js";

describe("sophron set-model", () => {
  let cwd: string;
  let home: string;
  let originalCwd: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    _resetProviderCacheForTests();
    originalCwd = process.cwd();
    originalHome = process.env["HOME"];
    cwd = mkdtempSync(join(tmpdir(), "sophron-setmodel-cwd-"));
    home = mkdtempSync(join(tmpdir(), "sophron-setmodel-home-"));
    process.chdir(cwd);
    process.env["HOME"] = home;

    mkdirSync(join(cwd, "agents"));
    writeFileSync(
      join(cwd, "agents", "builder.md"),
      "---\nname: builder\ndescription: builds things\nmodel: ollama:base:1b\n---\n\nYou are a builder.\n",
      "utf8",
    );
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome !== undefined) process.env["HOME"] = originalHome;
    else delete process.env["HOME"];
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    process.exitCode = 0;
  });

  function captureConsole<T>(fn: () => Promise<T>): Promise<{ result: T; logs: string[]; errors: string[] }> {
    const logs: string[] = [];
    const errors: string[] = [];
    const origLog = console.log;
    const origError = console.error;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
    return fn()
      .then((result) => ({ result, logs, errors }))
      .finally(() => {
        console.log = origLog;
        console.error = origError;
      });
  }

  it("persists a resolved model to the agent markdown file", async () => {
    const { logs, errors } = await captureConsole(() =>
      runCli(["node", "cli", "set-model", "builder", "openrouter:anthropic/claude-sonnet-4"]),
    );

    const updated = readFileSync(join(cwd, "agents", "builder.md"), "utf8");
    expect(updated).toContain("model: anthropic/claude-sonnet-4");
    expect(updated).toContain("provider: openrouter");
    expect(logs.some((l) => l.includes("Updated builder model file"))).toBe(true);
    expect(errors).toHaveLength(0);
  });

  it("supports --dir to target a project without cd-ing into it", async () => {
    const otherDir = mkdtempSync(join(tmpdir(), "sophron-setmodel-other-"));
    mkdirSync(join(otherDir, "agents"));
    writeFileSync(
      join(otherDir, "agents", "tester.md"),
      "---\nname: tester\ndescription: tests things\nmodel: ollama:base:1b\n---\n\nYou are a tester.\n",
      "utf8",
    );

    const { logs, errors } = await captureConsole(() =>
      runCli(["node", "cli", "set-model", "tester", "openrouter:anthropic/claude-sonnet-4", "--dir", otherDir]),
    );

    const updated = readFileSync(join(otherDir, "agents", "tester.md"), "utf8");
    expect(updated).toContain("model: anthropic/claude-sonnet-4");
    expect(updated).toContain("provider: openrouter");
    expect(logs.some((l) => l.includes("Updated tester model file"))).toBe(true);
    expect(errors).toHaveLength(0);

    rmSync(otherDir, { recursive: true, force: true });
  });

  it("errors when the agent is not found", async () => {
    const { logs, errors } = await captureConsole(() =>
      runCli(["node", "cli", "set-model", "missing", "openrouter:foo"]),
    );

    expect(process.exitCode).toBe(1);
    expect(errors.some((e) => e.includes("Agent 'missing' not found"))).toBe(true);
    expect(logs).toHaveLength(0);
  });

  it("errors for an unresolvable model spec", async () => {
    // Ensure no env defaults so a bare model id cannot resolve.
    for (const k of ["OPENROUTER_API_KEY", "OPENROUTER_DEFAULT_MODEL", "ZAI_API_KEY", "ZAI_DEFAULT_MODEL", "OLLAMA_DEFAULT_MODEL"]) {
      delete process.env[k];
    }
    _resetProviderCacheForTests();

    const { logs, errors } = await captureConsole(() =>
      runCli(["node", "cli", "set-model", "builder", "some-unresolvable-bare-model"]),
    );

    expect(process.exitCode).toBe(1);
    expect(errors.some((e) => e.includes("Could not set model"))).toBe(true);
    expect(logs).toHaveLength(0);
  });
});
