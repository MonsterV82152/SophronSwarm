import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { runCliAtHome } from "./helpers.js";

vi.mock("../../src/util/prompts.js", () => ({
  prompt: vi.fn(),
  promptSelect: vi.fn(),
  promptConfirm: vi.fn(),
  promptSecret: vi.fn(),
}));

import { prompt, promptSelect, promptConfirm, promptSecret } from "../../src/util/prompts.js";

function seedProvider(home: string) {
  const dir = join(home, ".sophron");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({ providers: [{ name: "ollama", kind: "ollama" }] }, null, 2),
    "utf8",
  );
}

describe("sophron init provider wizard", () => {
  let origIsTTY: boolean | undefined;
  beforeEach(() => {
    vi.clearAllMocks();
    origIsTTY = process.stdin.isTTY;
    process.stdin.isTTY = true;
  });
  afterEach(() => {
    process.stdin.isTTY = origIsTTY;
  });

  it("errors when no providers are configured and not a TTY", async () => {
    const home = mkdtempSync(join(tmpdir(), "sophron-init-"));
    process.stdin.isTTY = false;
    const result = await runCliAtHome(home, ["init", "--template", "cli", "--name", "my-app"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("No providers configured");
  });

  it("scaffolds with template defaults when SOPHRON_SKIP_PROVIDER_CHECK=1", async () => {
    const home = mkdtempSync(join(tmpdir(), "sophron-init-"));
    process.env.SOPHRON_SKIP_PROVIDER_CHECK = "1";
    try {
      const result = await runCliAtHome(home, ["init", "--template", "cli", "--name", "my-app"]);
      expect(result.exitCode).toBeUndefined();
      expect(result.stdout).toContain("Scaffolded project 'my-app'");

      const builder = readFileSync(join(home, "sophron_workspace", "my-app", "agents", "builder.md"), "utf8");
      expect(builder).toContain("provider: ollama");
      expect(builder).toContain("model: qwen3.5:9b-thinking");
    } finally {
      delete process.env.SOPHRON_SKIP_PROVIDER_CHECK;
    }
  });

  it("leaves template defaults unchanged when providers already exist", async () => {
    const home = mkdtempSync(join(tmpdir(), "sophron-init-"));
    seedProvider(home);

    const result = await runCliAtHome(home, ["init", "--template", "cli", "--name", "my-app"]);
    expect(result.exitCode).toBeUndefined();

    const builder = readFileSync(join(home, "sophron_workspace", "my-app", "agents", "builder.md"), "utf8");
    expect(builder).toContain("provider: ollama");
    expect(builder).toContain("model: qwen3.5:9b-thinking");
  });

  it("runs the wizard interactively and rewrites scaffolded agents", async () => {
    const home = mkdtempSync(join(tmpdir(), "sophron-init-"));

    // Wizard prompts, in order.
    (prompt as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce("openrouter") // instance name
      .mockResolvedValueOnce("") // base URL (empty → default)
      .mockResolvedValueOnce("Cloud router") // description
      .mockResolvedValueOnce("deepseek/deepseek-v4-flash"); // model
    (promptSelect as unknown as ReturnType<typeof vi.fn>).mockResolvedValue("openrouter");
    (promptConfirm as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    (promptSecret as unknown as ReturnType<typeof vi.fn>).mockResolvedValue("${OPENROUTER_API_KEY}");

    const result = await runCliAtHome(home, ["init", "--template", "cli", "--name", "my-app"]);
    expect(result.exitCode).toBeUndefined();
    expect(result.stdout).toContain("Scaffolded project 'my-app'");

    const config = JSON.parse(readFileSync(join(home, ".sophron", "config.json"), "utf8"));
    expect(config.providers).toHaveLength(1);
    expect(config.providers[0].name).toBe("openrouter");
    expect(config.providers[0].kind).toBe("openrouter");

    const builder = readFileSync(join(home, "sophron_workspace", "my-app", "agents", "builder.md"), "utf8");
    expect(builder).toContain("provider: openrouter");
    expect(builder).toContain("model: deepseek/deepseek-v4-flash");

    const orchestrator = readFileSync(join(home, "sophron_workspace", "my-app", "agents", "orchestrator.md"), "utf8");
    expect(orchestrator).toContain("provider: openrouter");
    expect(orchestrator).toContain("model: deepseek/deepseek-v4-flash");
  });
});
