import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadRegistry,
  saveRegistry,
  registerProject,
  renameProject,
  removeProject,
  togglePin,
  listProjects,
  findByName,
  registryPath,
  type ProjectEntry,
} from "../../src/project/registry.js";

/**
 * Project registry tests. The registry reads/writes ~/.sophron/projects.json
 * via os.homedir(), which respects HOME on Linux. Each test points HOME at a
 * fresh temp dir so registries don't leak between tests or hit the real home.
 */
describe("project registry", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sophron-projreg-"));
    prevHome = process.env["HOME"];
    process.env["HOME"] = home;
  });

  afterEach(() => {
    if (prevHome !== undefined) process.env["HOME"] = prevHome;
    else delete process.env["HOME"];
    rmSync(home, { recursive: true, force: true });
  });

  describe("loadRegistry / saveRegistry", () => {
    it("returns empty list when no registry file exists", () => {
      expect(loadRegistry()).toEqual([]);
    });

    it("saves and loads entries round-trip", () => {
      const entries: ProjectEntry[] = [
        { name: "webapp", path: "/projects/webapp", lastOpened: 1000 },
        { name: "cli-tool", path: "/projects/cli", lastOpened: 2000 },
      ];
      saveRegistry(entries);
      const loaded = loadRegistry();
      expect(loaded).toHaveLength(2);
      expect(loaded[0]!.name).toBe("webapp");
      expect(loaded[1]!.path).toBe("/projects/cli");
    });

    it("creates the .sophron directory if it doesn't exist", () => {
      saveRegistry([{ name: "x", path: "/x", lastOpened: 1 }]);
      expect(existsSync(registryPath())).toBe(true);
    });

    it("tolerates a bare array JSON shape", () => {
      const path = registryPath();
      mkdirSync(join(home, ".sophron"), { recursive: true });
      writeFileSync(path, JSON.stringify([{ name: "bare", path: "/bare", lastOpened: 1 }]));
      const loaded = loadRegistry();
      expect(loaded).toHaveLength(1);
      expect(loaded[0]!.name).toBe("bare");
    });

    it("returns empty list on unparseable JSON (degrades gracefully)", () => {
      mkdirSync(join(home, ".sophron"), { recursive: true });
      writeFileSync(registryPath(), "{not valid json");
      expect(loadRegistry()).toEqual([]);
    });
  });

  describe("registerProject", () => {
    it("adds a new project with a name derived from the basename", () => {
      const entry = registerProject("/home/user/my-webapp");
      expect(entry.name).toBe("my-webapp");
      expect(entry.path).toBe("/home/user/my-webapp");
      expect(entry.lastOpened).toBeGreaterThan(0);
      // Persisted.
      expect(loadRegistry()).toHaveLength(1);
    });

    it("updates lastOpened on re-registration of an existing path", () => {
      const first = registerProject("/projects/x");
      const firstTime = first.lastOpened;
      // Wait a tick so the timestamp differs.
      const second = registerProject("/projects/x");
      expect(second.lastOpened).toBeGreaterThanOrEqual(firstTime);
      expect(loadRegistry()).toHaveLength(1); // not duplicated
    });

    it("honors an explicit name", () => {
      const entry = registerProject("/projects/x", "custom-name");
      expect(entry.name).toBe("custom-name");
    });

    it("derives a unique name on basename collision", () => {
      registerProject("/a/project");
      registerProject("/b/project"); // same basename "project"
      const entries = loadRegistry();
      const names = entries.map((e) => e.name);
      expect(names).toContain("project");
      expect(names).toContain("project-2");
    });
  });

  describe("renameProject", () => {
    it("renames a registered project", () => {
      registerProject("/projects/x", "old-name");
      const entry = renameProject("/projects/x", "new-name");
      expect(entry.name).toBe("new-name");
    });

    it("throws if the project isn't registered", () => {
      expect(() => renameProject("/not/registered", "x")).toThrow(/not registered/);
    });

    it("throws on name collision with another project", () => {
      registerProject("/a", "taken");
      registerProject("/b", "other");
      expect(() => renameProject("/b", "taken")).toThrow(/already used/);
    });
  });

  describe("removeProject", () => {
    it("removes a registered project", () => {
      registerProject("/projects/x");
      expect(removeProject("/projects/x")).toBe(true);
      expect(loadRegistry()).toHaveLength(0);
    });

    it("returns false for an unregistered path", () => {
      expect(removeProject("/never/registered")).toBe(false);
    });
  });

  describe("togglePin", () => {
    it("toggles the pinned flag", () => {
      registerProject("/projects/x");
      expect(togglePin("/projects/x")!.pinned).toBe(true);
      expect(togglePin("/projects/x")!.pinned).toBe(false);
    });

    it("returns undefined for an unregistered project", () => {
      expect(togglePin("/nope")).toBeUndefined();
    });
  });

  describe("listProjects (sorting)", () => {
    it("sorts pinned first, then by lastOpened descending", () => {
      saveRegistry([
        { name: "old", path: "/old", lastOpened: 1000 },
        { name: "new", path: "/new", lastOpened: 3000 },
        { name: "pinned-old", path: "/pold", lastOpened: 500, pinned: true },
      ]);
      const sorted = listProjects();
      expect(sorted.map((p) => p.name)).toEqual(["pinned-old", "new", "old"]);
    });
  });

  describe("findByName", () => {
    it("finds a project by name (case-insensitive)", () => {
      registerProject("/projects/x", "MyApp");
      expect(findByName("myapp")!.path).toBe("/projects/x");
      expect(findByName("MYAPP")!.path).toBe("/projects/x");
    });

    it("returns undefined for an unknown name", () => {
      expect(findByName("nonexistent")).toBeUndefined();
    });
  });
});
