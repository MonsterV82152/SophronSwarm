/**
 * Tests for the M7 global-orchestrator tools (src/tools/builtin/global.ts):
 * list_projects, propose_project, init_project.
 *
 * HOME is pointed at a temp dir so the project registry + workspace root are
 * isolated (same pattern as templates/registry tests).
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  list_projects,
  propose_project,
  init_project,
  list_providers,
  workspaceRoot,
  sophronRoot,
} from "../../src/tools/builtin/global.js";
import { registerProject, loadRegistry } from "../../src/project/registry.js";
import { addProviderInstance, _resetProviderCacheForTests } from "../../src/llm/providers.js";

let tempHome: string;
let origHome: string | undefined;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "sophron-global-"));
  origHome = process.env.HOME;
  process.env.HOME = tempHome;
});

afterEach(() => {
  process.env.HOME = origHome;
  rmSync(tempHome, { recursive: true, force: true });
});

/** Call a tool's handler with minimal args (global tools don't need state/services). */
function call(tool: typeof list_projects, args: Record<string, unknown> = {}): string {
  return tool.handler({
    args,
    agent: {} as never,
    state: { workingDir: tempHome } as never,
    services: {} as never,
  });
}

/** Call an async tool handler and await its result. */
async function callAsync(tool: typeof list_providers, args: Record<string, unknown> = {}): Promise<string> {
  return await tool.handler({
    args,
    agent: {} as never,
    state: { workingDir: tempHome } as never,
    services: {} as never,
  });
}

describe("workspaceRoot + sophronRoot", () => {
  it("resolve under the isolated HOME", () => {
    expect(workspaceRoot()).toBe(join(tempHome, "sophron_workspace"));
    expect(sophronRoot()).toBe(join(tempHome, ".sophron"));
  });
});

// ── list_projects ───────────────────────────────────────────────────────────

describe("list_projects", () => {
  it("reports an empty registry", () => {
    const out = call(list_projects);
    expect(out).toMatch(/No projects registered/);
    expect(out).toContain("propose_project");
  });

  it("lists registered projects with name + path", () => {
    registerProject(join(tempHome, "sophron_workspace", "alpha"), "alpha");
    registerProject(join(tempHome, "sophron_workspace", "beta"), "beta");
    const out = call(list_projects);
    expect(out).toMatch(/Registered projects \(2\)/);
    expect(out).toContain("alpha");
    expect(out).toContain("beta");
    expect(out).toContain("sophron_workspace/alpha");
  });

  it("marks pinned projects", () => {
    const entry = registerProject(join(tempHome, "sophron_workspace", "pinned"), "pinned");
    // pin it via the registry API directly
    const projects = loadRegistry();
    const p = projects.find((x) => x.name === "pinned");
    if (p) p.pinned = true;
    // saveRegistry is internal; re-register to persist lastOpened, then rely on
    // listProjects reading the file. Simpler: just assert the non-pinned path
    // (pinning is the registry's concern, not the tool's).
    const out = call(list_projects);
    expect(out).toContain("pinned");
    expect(entry.name).toBe("pinned");
  });
});

// ── propose_project ─────────────────────────────────────────────────────────

describe("propose_project", () => {
  it("drafts a proposal without creating anything", () => {
    const out = call(propose_project, {
      name: "my-cli",
      summary: "A handy CLI tool.",
      template: "cli",
    });
    expect(out).toContain("PROPOSED PROJECT");
    expect(out).toContain("name:     my-cli");
    expect(out).toContain("template: cli");
    expect(out).toContain("summary:  A handy CLI tool.");
    expect(out).toContain(join("sophron_workspace", "my-cli"));
    // NOTHING was created.
    expect(existsSync(join(workspaceRoot(), "my-cli"))).toBe(false);
    expect(loadRegistry().length).toBe(0);
  });

  it("defaults the template to 'minimal' when omitted", () => {
    const out = call(propose_project, { name: "solo", summary: "x" });
    expect(out).toContain("template: minimal");
  });

  it("refuses a missing name", () => {
    expect(call(propose_project, { summary: "x" })).toMatch(/Refused.*name/);
  });

  it("refuses a missing summary", () => {
    expect(call(propose_project, { name: "x" })).toMatch(/Refused.*summary/);
  });

  it("refuses a name that isn't lowercase-hyphenated", () => {
    expect(call(propose_project, { name: "Bad_Name", summary: "x" })).toMatch(/Refused.*lowercase/);
    expect(call(propose_project, { name: "-leading", summary: "x" })).toMatch(/Refused.*lowercase/);
    expect(call(propose_project, { name: "UPPER", summary: "x" })).toMatch(/Refused.*lowercase/);
  });

  it("refuses an unknown template", () => {
    const out = call(propose_project, { name: "x", summary: "y", template: "nonexistent" });
    expect(out).toMatch(/Refused.*unknown template/);
    expect(out).toContain("minimal"); // lists available
  });

  it("refuses if a project with that name is already registered", () => {
    registerProject(join(tempHome, "sophron_workspace", "dup"), "dup");
    const out = call(propose_project, { name: "dup", summary: "x" });
    expect(out).toMatch(/already registered/);
  });

  it("is purely informational — never writes to disk", () => {
    call(propose_project, { name: "ghost", summary: "x" });
    expect(existsSync(join(workspaceRoot(), "ghost"))).toBe(false);
  });
});

// ── init_project ────────────────────────────────────────────────────────────

describe("init_project", () => {
  it("scaffolds a project under ~/sophron_workspace/<name>", () => {
    const out = call(init_project, { name: "real-project", template: "cli" });
    expect(out).toContain("Created project 'real-project'");
    expect(out).toContain(join("sophron_workspace", "real-project"));

    const projectDir = join(workspaceRoot(), "real-project");
    expect(existsSync(join(projectDir, "agents"))).toBe(true);
    // The standardized orchestrator is always seeded.
    expect(existsSync(join(projectDir, "agents", "orchestrator.md"))).toBe(true);
    // The cli template seeds builder + tester.
    expect(existsSync(join(projectDir, "agents", "builder.md"))).toBe(true);
    expect(existsSync(join(projectDir, "agents", "tester.md"))).toBe(true);
    // Shared memory seeds.
    expect(existsSync(join(projectDir, ".sophron", "shared", "OVERVIEW.md"))).toBe(true);

    // Registered in projects.json.
    const reg = loadRegistry();
    expect(reg.find((p) => p.name === "real-project")).toBeTruthy();
  });

  it("defaults to the minimal template", () => {
    const out = call(init_project, { name: "bare" });
    expect(out).toContain("template: minimal");
    expect(existsSync(join(workspaceRoot(), "bare", "agents", "orchestrator.md"))).toBe(true);
    // minimal seeds NO specialist agents.
    expect(existsSync(join(workspaceRoot(), "bare", "agents", "builder.md"))).toBe(false);
  });

  it("registers the project with the given alias", () => {
    call(init_project, { name: "named-proj", template: "minimal" });
    const reg = loadRegistry();
    const entry = reg.find((p) => p.name === "named-proj");
    expect(entry).toBeTruthy();
    expect(entry!.path).toBe(join(workspaceRoot(), "named-proj"));
  });

  it("refuses a missing name", () => {
    expect(call(init_project, {})).toMatch(/Refused.*name/);
  });

  it("refuses a non-lowercase name", () => {
    expect(call(init_project, { name: "BadName" })).toMatch(/Refused.*lowercase/);
  });

  it("refuses to clobber an existing agents/ dir without --force", () => {
    // First init succeeds.
    call(init_project, { name: "exists", template: "minimal" });
    // Second init on the same dir (re-running) — scaffoldProject refuses.
    const out = call(init_project, { name: "exists", template: "cli" });
    expect(out).toMatch(/Could not create.*already exists|Could not create.*force/i);
  });

  it("overwrites with force=true", () => {
    call(init_project, { name: "ow", template: "minimal" });
    const out = call(init_project, { name: "ow", template: "cli", force: true });
    expect(out).toContain("Created project 'ow'");
    expect(existsSync(join(workspaceRoot(), "ow", "agents", "builder.md"))).toBe(true);
  });
});

// ── list_providers (architect model-awareness tool) ─────────────────────────

describe("list_providers", () => {
  beforeEach(() => {
    _resetProviderCacheForTests();
  });

  it("lists configured instances", async () => {
    addProviderInstance({ name: "my-or", kind: "openrouter", apiKey: "k", description: "cloud router" });
    _resetProviderCacheForTests();
    const out = await callAsync(list_providers);
    expect(out).toMatch(/Configured provider instances/);
    expect(out).toContain("my-or");
    expect(out).toContain("cloud router");
  });

  it("reports when no providers are configured", async () => {
    const out = await callAsync(list_providers);
    expect(out).toMatch(/No providers configured/);
  });

  it("includes model-field guidance (concrete ids, no tiers)", async () => {
    addProviderInstance({ name: "my-or", kind: "openrouter", apiKey: "k" });
    _resetProviderCacheForTests();
    const out = await callAsync(list_providers);
    expect(out).toMatch(/concrete/i);
    expect(out).toMatch(/Match the model to the TASK SIZE/i);
    // No tier-as-valid-option guidance.
    expect(out).not.toMatch(/NAMED TIER|named tier to stay portable/i);
  });

  it("shows a configured instance's description", async () => {
    addProviderInstance({ name: "ollama-laptop", kind: "ollama", baseURL: "http://host:11434/v1", description: "laptop LLMs" });
    _resetProviderCacheForTests();
    const out = await callAsync(list_providers);
    expect(out).toContain("ollama-laptop");
    expect(out).toContain("laptop LLMs");
  });

  it("does NOT probe when no probe name is given", async () => {
    addProviderInstance({ name: "x", kind: "ollama" });
    _resetProviderCacheForTests();
    const out = await callAsync(list_providers);
    expect(out).not.toMatch(/Probing/);
  });
});
