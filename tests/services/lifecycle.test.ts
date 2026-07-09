/**
 * Tests for SharedServices lifecycle: building, tearing down, and switching
 * between project working directories.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "../../src/agent/registry.js";
import { buildServices, closeServices, switchServices } from "../../src/services/lifecycle.js";

let originalHome: string | undefined;
let tempHome: string;
let dir1: string;
let dir2: string;
let services = buildServices("/tmp", new AgentRegistry("/tmp"));

beforeEach(() => {
  originalHome = process.env["HOME"];
  tempHome = mkdtempSync(join(tmpdir(), "sophron-home-"));
  process.env["HOME"] = tempHome;

  dir1 = mkdtempSync(join(tmpdir(), "sophron-proj1-"));
  dir2 = mkdtempSync(join(tmpdir(), "sophron-proj2-"));

  mkdirSync(join(dir1, "agents"), { recursive: true });
  mkdirSync(join(dir2, "agents"), { recursive: true });
  writeFileSync(
    join(dir1, "agents", "alpha.md"),
    "---\nname: alpha\ndescription: project 1\nmodel: ollama:qwen3.5:9b-thinking\n---\nalpha body",
  );
  writeFileSync(
    join(dir2, "agents", "beta.md"),
    "---\nname: beta\ndescription: project 2\nmodel: ollama:qwen3.5:9b-thinking\n---\nbeta body",
  );

  const registry = new AgentRegistry(dir1);
  registry.scan();
  services = buildServices(dir1, registry);
});

afterEach(async () => {
  await closeServices(services).catch(() => undefined);
  process.env["HOME"] = originalHome;
  rmSync(tempHome, { recursive: true, force: true });
  rmSync(dir1, { recursive: true, force: true });
  rmSync(dir2, { recursive: true, force: true });
});

describe("switchServices", () => {
  it("rebuilds the agent registry for the new working directory", async () => {
    const oldRegistry = services.agentRegistry;
    expect(oldRegistry.get("alpha")).toBeDefined();

    const { services: newServices, registry: newRegistry } = await switchServices(services, oldRegistry, dir2);
    services = newServices; // so afterEach tears down the new instance

    expect(newRegistry.get("beta")).toBeDefined();
    expect(newRegistry.get("alpha")).toBeUndefined();
  });
});
