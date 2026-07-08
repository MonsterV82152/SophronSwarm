/**
 * Tests for the `sophron init` templates module (src/init/templates.ts).
 *
 * Uses mkdtempSync to isolate the filesystem (HOME is pointed at a temp dir
 * via the vitest setup, same pattern as providers/registry tests).
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scaffoldProject,
  installGlobalArchitect,
  installGlobalOrchestrator,
  listTemplates,
  getTemplate,
  BUILTIN_TEMPLATES,
  STANDARD_ORCHESTRATOR,
  GLOBAL_ARCHITECT,
  GLOBAL_ORCHESTRATOR,
  userTemplatesDir,
} from "../../src/init/templates.js";

let tempHome: string;
let origHome: string | undefined;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "sophron-init-"));
  origHome = process.env.HOME;
  process.env.HOME = tempHome;
});

afterEach(() => {
  process.env.HOME = origHome;
  rmSync(tempHome, { recursive: true, force: true });
});

describe("listTemplates", () => {
  it("lists the 4 built-in templates", () => {
    const names = listTemplates().map((t) => t.name).sort();
    expect(names).toEqual(["cli", "data-pipeline", "minimal", "webapp"]);
  });

  it("each built-in has a name + description", () => {
    for (const t of listTemplates()) {
      expect(t.name).toBeTruthy();
      expect(t.description.length).toBeGreaterThan(0);
    }
  });

  it("user templates override built-ins of the same name", () => {
    const userDir = userTemplatesDir();
    mkdirSync(join(userDir, "minimal", "agents"), { recursive: true });
    writeFileSync(join(userDir, "minimal", "agents", "custom.md"), "---\nname: custom\n---\n", "utf8");
    writeFileSync(join(userDir, "minimal", "template.json"), JSON.stringify({ name: "minimal", description: "my custom minimal" }), "utf8");

    const minimal = getTemplate("minimal")!;
    expect(minimal.description).toBe("my custom minimal");
    expect(minimal.agents["custom.md"]).toBeTruthy();
  });
});

describe("getTemplate", () => {
  it("returns built-in templates by name", () => {
    expect(getTemplate("minimal")?.name).toBe("minimal");
    expect(getTemplate("cli")?.name).toBe("cli");
    expect(getTemplate("webapp")?.name).toBe("webapp");
    expect(getTemplate("data-pipeline")?.name).toBe("data-pipeline");
  });

  it("returns null for an unknown template", () => {
    expect(getTemplate("nonexistent")).toBeNull();
  });
});

describe("BUILTIN_TEMPLATES", () => {
  it("minimal has no specialist agents (just orchestrator is added at scaffold)", () => {
    expect(Object.keys(BUILTIN_TEMPLATES.minimal.agents)).toHaveLength(0);
  });

  it("cli has builder + tester", () => {
    expect(BUILTIN_TEMPLATES.cli.agents["builder.md"]).toBeTruthy();
    expect(BUILTIN_TEMPLATES.cli.agents["tester.md"]).toBeTruthy();
  });

  it("webapp has frontend + backend + tester", () => {
    expect(Object.keys(BUILTIN_TEMPLATES.webapp.agents).sort()).toEqual(["backend.md", "frontend.md", "tester.md"]);
  });

  it("data-pipeline has ingestion + transform + analysis", () => {
    expect(Object.keys(BUILTIN_TEMPLATES["data-pipeline"].agents).sort()).toEqual(["analysis.md", "ingestion.md", "transform.md"]);
  });

  it("every template ships shared seeds", () => {
    for (const t of Object.values(BUILTIN_TEMPLATES)) {
      expect(t.shared?.["OVERVIEW.md"]).toBeTruthy();
      expect(t.shared?.["CHECKPOINTS.md"]).toBeTruthy();
    }
  });
});

describe("scaffoldProject", () => {
  it("creates the project dir + agents/ + .sophron/shared/", () => {
    const path = join(tempHome, "myproj");
    const result = scaffoldProject(path, { template: "minimal" });

    expect(existsSync(join(path, "agents"))).toBe(true);
    expect(existsSync(join(path, ".sophron", "shared"))).toBe(true);
    expect(result.projectPath).toBe(path);
    expect(result.template).toBe("minimal");
  });

  it("always seeds the standardized orchestrator", () => {
    const path = join(tempHome, "myproj");
    const result = scaffoldProject(path, { template: "minimal" });

    expect(result.created.agents).toContain("orchestrator.md");
    const content = readFileSync(join(path, "agents", "orchestrator.md"), "utf8");
    expect(content).toContain("name: orchestrator");
    expect(content).toBe(STANDARD_ORCHESTRATOR);
  });

  it("seeds the template's specialist agents", () => {
    const path = join(tempHome, "myproj");
    const result = scaffoldProject(path, { template: "cli" });

    expect(result.created.agents).toContain("orchestrator.md");
    expect(result.created.agents).toContain("builder.md");
    expect(result.created.agents).toContain("tester.md");
  });

  it("seeds shared memory files", () => {
    const path = join(tempHome, "myproj");
    const result = scaffoldProject(path, { template: "cli" });

    expect(result.created.shared).toContain("OVERVIEW.md");
    expect(result.created.shared).toContain("CHECKPOINTS.md");
    expect(existsSync(join(path, ".sophron", "shared", "OVERVIEW.md"))).toBe(true);
  });

  it("registers the project in the registry", () => {
    const path = join(tempHome, "myproj");
    const result = scaffoldProject(path, { template: "minimal", name: "my-alias" });

    expect(result.entry.name).toBe("my-alias");
    expect(result.entry.path).toBe(path);
  });

  it("defaults to the minimal template", () => {
    const path = join(tempHome, "myproj");
    const result = scaffoldProject(path);
    expect(result.template).toBe("minimal");
  });

  it("refuses to overwrite a non-empty agents/ without --force", () => {
    const path = join(tempHome, "myproj");
    scaffoldProject(path, { template: "minimal" });

    expect(() => scaffoldProject(path, { template: "cli" })).toThrow(/already exists/);
  });

  it("overwrites with --force", () => {
    const path = join(tempHome, "myproj");
    scaffoldProject(path, { template: "minimal" });
    const result = scaffoldProject(path, { template: "cli", force: true });

    expect(result.created.agents).toContain("builder.md");
    expect(result.created.agents).toContain("tester.md");
  });

  it("allows re-scaffold over an EMPTY agents/ without --force", () => {
    const path = join(tempHome, "myproj");
    mkdirSync(join(path, "agents"), { recursive: true }); // empty dir

    const result = scaffoldProject(path, { template: "minimal" });
    expect(result.created.agents).toContain("orchestrator.md");
  });

  it("throws for an unknown template", () => {
    const path = join(tempHome, "myproj");
    expect(() => scaffoldProject(path, { template: "nope" } as never)).toThrow(/Unknown template/);
  });
});

describe("installGlobalArchitect", () => {
  it("writes the architect to ~/.sophron/agents/architect.md", () => {
    const result = installGlobalArchitect();
    expect(result).toBeTruthy();
    expect(existsSync(join(tempHome, ".sophron", "agents", "architect.md"))).toBe(true);

    const content = readFileSync(join(tempHome, ".sophron", "agents", "architect.md"), "utf8");
    expect(content).toBe(GLOBAL_ARCHITECT);
    expect(content).toContain("name: architect");
  });

  it("returns null without overwriting if it already exists (no force)", () => {
    installGlobalArchitect();
    const second = installGlobalArchitect();
    expect(second).toBeNull();
  });

  it("overwrites with force=true", () => {
    installGlobalArchitect();
    const second = installGlobalArchitect(true);
    expect(second).toBeTruthy();
  });
});

describe("STANDARD_ORCHESTRATOR + GLOBAL_ARCHITECT + GLOBAL_ORCHESTRATOR", () => {
  it("orchestrator is the per-project coordinator (delegates)", () => {
    expect(STANDARD_ORCHESTRATOR).toContain("orchestrator");
    expect(STANDARD_ORCHESTRATOR).toContain("delegate");
    expect(STANDARD_ORCHESTRATOR).toContain("remember");
  });

  it("global architect drafts rosters + does not run agents", () => {
    expect(GLOBAL_ARCHITECT).toContain("architect");
    expect(GLOBAL_ARCHITECT).toContain("roster");
    expect(GLOBAL_ARCHITECT).toContain("plan"); // permissionMode: plan
  });

  it("global orchestrator is the no-memory CEO (M7)", () => {
    expect(GLOBAL_ORCHESTRATOR).toContain("name: global-orchestrator");
    expect(GLOBAL_ORCHESTRATOR).toContain("noMemory: true"); // CRITICAL: no memory injection
    expect(GLOBAL_ORCHESTRATOR).toContain("list_projects");
    expect(GLOBAL_ORCHESTRATOR).toContain("propose_project");
    expect(GLOBAL_ORCHESTRATOR).toContain("init_project");
    expect(GLOBAL_ORCHESTRATOR).toContain("delegate");
    // The global orchestrator must NOT have run_command / apply_patch.
    expect(GLOBAL_ORCHESTRATOR).not.toContain("run_command");
    expect(GLOBAL_ORCHESTRATOR).not.toContain("apply_patch");
    // It may only delegate to the architect.
    expect(GLOBAL_ORCHESTRATOR).toContain("architect");
  });
});

describe("installGlobalOrchestrator (M7)", () => {
  it("writes the global orchestrator to ~/.sophron/agents/global-orchestrator.md", () => {
    const result = installGlobalOrchestrator();
    expect(result).toBeTruthy();
    expect(existsSync(join(tempHome, ".sophron", "agents", "global-orchestrator.md"))).toBe(true);

    const content = readFileSync(join(tempHome, ".sophron", "agents", "global-orchestrator.md"), "utf8");
    expect(content).toBe(GLOBAL_ORCHESTRATOR);
    expect(content).toContain("name: global-orchestrator");
    expect(content).toContain("noMemory: true");
  });

  it("returns null without overwriting if it already exists (no force)", () => {
    installGlobalOrchestrator();
    const second = installGlobalOrchestrator();
    expect(second).toBeNull();
  });

  it("overwrites with force=true", () => {
    installGlobalOrchestrator();
    const second = installGlobalOrchestrator(true);
    expect(second).toBeTruthy();
  });

  it("the global orchestrator + architect can coexist (distinct names)", () => {
    const orch = installGlobalOrchestrator();
    const arch = installGlobalArchitect();
    expect(orch).toBeTruthy();
    expect(arch).toBeTruthy();
    expect(orch).not.toBe(arch);
  });
});
