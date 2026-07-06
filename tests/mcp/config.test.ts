import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  normalizeServerConfig,
  parseConfigString,
  resolveAgentServers,
  loadGlobalConfig,
  DEFAULT_MAX_TOOLS_PER_SERVER,
  type McpGlobalConfig,
} from "../../src/mcp/config.js";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("normalizeServerConfig", () => {
  it("normalizes a stdio server", () => {
    const cfg = normalizeServerConfig({ name: "math", transport: "stdio", command: "node", args: ["srv.js"] });
    expect(cfg.transport).toBe("stdio");
    expect(cfg.command).toBe("node");
    expect(cfg.args).toEqual(["srv.js"]);
    expect(cfg.alwaysExpose).toBe(false);
    expect(cfg.maxTools).toBe(DEFAULT_MAX_TOOLS_PER_SERVER);
  });

  it("normalizes an http server", () => {
    const cfg = normalizeServerConfig({ name: "web", transport: "http", url: "http://localhost/mcp" });
    expect(cfg.transport).toBe("http");
    expect(cfg.url).toBe("http://localhost/mcp");
  });

  it("defaults transport to stdio", () => {
    const cfg = normalizeServerConfig({ name: "x", command: "node" });
    expect(cfg.transport).toBe("stdio");
  });

  it("throws on stdio without a command", () => {
    expect(() => normalizeServerConfig({ name: "x", transport: "stdio" })).toThrow(/command/);
  });

  it("throws on http without a url", () => {
    expect(() => normalizeServerConfig({ name: "x", transport: "http" })).toThrow(/url/);
  });

  it("throws on a missing name", () => {
    expect(() => normalizeServerConfig({ transport: "stdio", command: "node" } as never)).toThrow(/name/);
  });

  it("honors alwaysExpose and maxTools overrides", () => {
    const cfg = normalizeServerConfig({ name: "x", command: "node", alwaysExpose: true, maxTools: 5 });
    expect(cfg.alwaysExpose).toBe(true);
    expect(cfg.maxTools).toBe(5);
  });

  it("ignores invalid maxTools (falls back to default)", () => {
    const cfg = normalizeServerConfig({ name: "x", command: "node", maxTools: -1 });
    expect(cfg.maxTools).toBe(DEFAULT_MAX_TOOLS_PER_SERVER);
  });
});

describe("parseConfigString", () => {
  it("parses a bare array of servers", () => {
    const cfg = parseConfigString(
      JSON.stringify([{ name: "a", transport: "stdio", command: "node" }]),
      "test",
    );
    expect(cfg.servers).toHaveLength(1);
    expect(cfg.servers[0]!.name).toBe("a");
  });

  it("parses a { servers: [...] } object", () => {
    const cfg = parseConfigString(
      JSON.stringify({ servers: [{ name: "b", command: "node" }] }),
      "test",
    );
    expect(cfg.servers[0]!.name).toBe("b");
  });

  it("returns empty on invalid JSON", () => {
    const cfg = parseConfigString("not json", "test");
    expect(cfg.servers).toHaveLength(0);
  });

  it("returns empty on a non-array/object shape", () => {
    const cfg = parseConfigString(JSON.stringify({ other: 1 }), "test");
    expect(cfg.servers).toHaveLength(0);
  });

  it("skips invalid server entries but keeps valid ones", () => {
    const cfg = parseConfigString(
      JSON.stringify([
        { name: "good", command: "node" },
        { transport: "stdio" }, // missing name
        { name: "also-good", command: "node" },
      ]),
      "test",
    );
    expect(cfg.servers.map((s) => s.name)).toEqual(["good", "also-good"]);
  });
});

describe("resolveAgentServers", () => {
  const globalConfig: McpGlobalConfig = {
    servers: [
      normalizeServerConfig({ name: "math", command: "node" }),
      normalizeServerConfig({ name: "web", transport: "http", url: "http://x" }),
    ],
  };

  it("returns empty when the agent declares no servers", () => {
    expect(resolveAgentServers(globalConfig)).toEqual([]);
  });

  it("resolves declared names against the global config", () => {
    const out = resolveAgentServers(globalConfig, ["math"]);
    expect(out.map((s) => s.name)).toEqual(["math"]);
  });

  it("ignores names not in the global config", () => {
    const out = resolveAgentServers(globalConfig, ["math", "unknown"]);
    expect(out.map((s) => s.name)).toEqual(["math"]);
  });

  it("deduplicates", () => {
    const out = resolveAgentServers(globalConfig, ["math", "math"]);
    expect(out).toHaveLength(1);
  });

  it("accepts an inline ad-hoc server object", () => {
    const out = resolveAgentServers(globalConfig, [{ name: "inline", command: "node" }]);
    expect(out.map((s) => s.name)).toEqual(["inline"]);
  });
});

describe("loadGlobalConfig", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sophron-mcpcfg-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns empty config when no mcp.json exists", () => {
    expect(loadGlobalConfig(dir).servers).toHaveLength(0);
  });

  it("loads servers from .sophron/mcp.json", () => {
    mkdirSync(join(dir, ".sophron"), { recursive: true });
    writeFileSync(
      join(dir, ".sophron", "mcp.json"),
      JSON.stringify([{ name: "loaded", command: "node", args: ["s.js"] }]),
    );
    const cfg = loadGlobalConfig(dir);
    expect(cfg.servers).toHaveLength(1);
    expect(cfg.servers[0]!.name).toBe("loaded");
  });
});
