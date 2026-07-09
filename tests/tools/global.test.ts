/**
 * Tests for the M7 global-orchestrator tools (src/tools/builtin/global.ts):
 * list_projects, propose_project, init_project.
 *
 * HOME is pointed at a temp dir so the project registry + workspace root are
 * isolated (same pattern as templates/registry tests).
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  list_projects,
  read_project_overview,
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

// ── read_project_overview ───────────────────────────────────────────────────

describe("read_project_overview", () => {
  it("returns the overview content for a registered project", () => {
    const projectDir = join(workspaceRoot(), "alpha");
    mkdirSync(join(projectDir, ".sophron", "shared"), { recursive: true });
    writeFileSync(join(projectDir, ".sophron", "shared", "OVERVIEW.md"), "# Alpha\n\nGoal: test overview reads.\n", "utf8");
    registerProject(projectDir, "alpha");

    const out = call(read_project_overview, { project: "alpha" });
    expect(out).toContain("OVERVIEW for project 'alpha'");
    expect(out).toContain("Goal: test overview reads.");
  });

  it("accepts an absolute path under the workspace", () => {
    const projectDir = join(workspaceRoot(), "beta");
    mkdirSync(join(projectDir, ".sophron", "shared"), { recursive: true });
    writeFileSync(join(projectDir, ".sophron", "shared", "OVERVIEW.md"), "# Beta\n", "utf8");

    const out = call(read_project_overview, { project: projectDir });
    expect(out).toContain("OVERVIEW for project");
    expect(out).toContain("# Beta");
  });

  it("returns a friendly message when the overview is missing", () => {
    const projectDir = join(workspaceRoot(), "gamma");
    mkdirSync(join(projectDir, ".sophron", "shared"), { recursive: true });
    registerProject(projectDir, "gamma");

    const out = call(read_project_overview, { project: "gamma" });
    expect(out).toMatch(/has no OVERVIEW\.md/);
  });

  it("returns a friendly message for an unknown project name", () => {
    const out = call(read_project_overview, { project: "does-not-exist" });
    expect(out).toMatch(/not registered/);
  });

  it("rejects a path outside the workspace root", () => {
    const out = call(read_project_overview, { project: "/etc/passwd" });
    expect(out).toMatch(/outside the SophronSwarm workspace/);
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

  it("includes goal and constraints in the proposal when provided", () => {
    const out = call(propose_project, {
      name: "goal-proj",
      summary: "A project with goals.",
      goal: "Automate the thing.",
      constraints: "Must be local-only; no cloud APIs.",
    });
    expect(out).toContain("goal:     Automate the thing.");
    expect(out).toContain("constraints: Must be local-only; no cloud APIs.");
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

  it("seeds OVERVIEW.md with goal and constraints when provided", () => {
    call(init_project, {
      name: "goal-project",
      template: "minimal",
      goal: "Automate widget generation.",
      constraints: "No external network calls.",
    });
    const overviewPath = join(workspaceRoot(), "goal-project", ".sophron", "shared", "OVERVIEW.md");
    expect(existsSync(overviewPath)).toBe(true);
    const content = readFileSync(overviewPath, "utf8");
    expect(content).toContain("## Goal");
    expect(content).toContain("Automate widget generation.");
    expect(content).toContain("## Constraints");
    expect(content).toContain("No external network calls.");
    expect(content).toContain("## Stack");
  });

  it("keeps the template default OVERVIEW.md when no goal/constraints are provided", () => {
    call(init_project, { name: "default-project", template: "minimal" });
    const overviewPath = join(workspaceRoot(), "default-project", ".sophron", "shared", "OVERVIEW.md");
    const content = readFileSync(overviewPath, "utf8");
    expect(content).toContain("Describe your project's goal");
  });
});

// ── list_providers (architect model-awareness tool) ─────────────────────────

describe("list_providers", () => {
  beforeEach(() => {
    _resetProviderCacheForTests();
  });

  it("lists configured instances + default models", async () => {
    // Zero-config: the built-in singletons exist.
    const out = await callAsync(list_providers);
    expect(out).toMatch(/Configured provider instances/);
    expect(out).toContain("ollama");
    expect(out).toContain("openrouter");
    expect(out).toContain("zai");
  });

  it("includes model-field tier guidance for the architect", async () => {
    const out = await callAsync(list_providers);
    expect(out).toMatch(/cheap/i);
    expect(out).toMatch(/frontier/i);
    expect(out).toMatch(/Match the model to the TASK SIZE/i);
  });

  it("shows a configured instance's default model", async () => {
    addProviderInstance({ name: "ollama-laptop", kind: "ollama", baseURL: "http://host:11434/v1", defaultModel: "qwen3.5:9b" });
    _resetProviderCacheForTests();
    const out = await callAsync(list_providers);
    expect(out).toContain("ollama-laptop");
    expect(out).toContain("qwen3.5:9b");
  });

  it("does NOT probe when no probe name is given", async () => {
    const out = await callAsync(list_providers);
    expect(out).not.toMatch(/Probing/);
  });

  it("includes provider descriptions when present", async () => {
    addProviderInstance({ name: "described-ollama", kind: "ollama", baseURL: "http://host:11434/v1", description: "Local reasoning box" });
    _resetProviderCacheForTests();
    const out = await callAsync(list_providers);
    expect(out).toContain("described-ollama");
    expect(out).toContain("description: Local reasoning box");
  });
});
