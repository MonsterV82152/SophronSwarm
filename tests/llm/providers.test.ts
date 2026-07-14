import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  expandEnv,
  getProvider,
  listProviders,
  resolveModel,
  reresolveModel,
  addProviderInstance,
  removeProviderInstance,
  updateProviderInstance,
  getRawProviderEntry,
  configPath,
  _resetProviderCacheForTests,
  type ProviderConfig,
} from "../../src/llm/providers.js";

/**
 * Provider tests. The providers module reads config from ~/.sophron/config.json
 * (via os.homedir()). On Linux, os.homedir() respects the HOME env var, so we
 * point HOME at a temp dir per-test and write a config there, then reset the
 * module's lazy cache via _resetProviderCacheForTests().
 */

describe("expandEnv", () => {
  it("substitutes ${VAR} from process.env", () => {
    process.env["TEST_PROV_KEY"] = "secret123";
    expect(expandEnv("key-${TEST_PROV_KEY}")).toBe("key-secret123");
    delete process.env["TEST_PROV_KEY"];
  });

  it("expands unknown vars to empty string (not a literal ${...})", () => {
    expect(expandEnv("${DEFINITELY_NOT_SET_VAR_42}")).toBe("");
  });

  it("leaves strings without ${} untouched", () => {
    expect(expandEnv("http://localhost:11434/v1")).toBe("http://localhost:11434/v1");
  });

  it("handles multiple vars in one string", () => {
    process.env["A"] = "1";
    process.env["B"] = "2";
    expect(expandEnv("${A}-${B}")).toBe("1-2");
    delete process.env["A"];
    delete process.env["B"];
  });

  it("does NOT expand bare $VAR (only the ${VAR} form)", () => {
    process.env["FOO"] = "bar";
    expect(expandEnv("$FOO")).toBe("$FOO");
    delete process.env["FOO"];
  });
});

// ── Config-driven tests (HOME isolation) ────────────────────────────────────

describe("provider config loading", () => {
  let home: string;
  let prevHome: string | undefined;
  const prevEnv = { ...process.env };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sophron-prov-home-"));
    prevHome = process.env["HOME"];
    process.env["HOME"] = home;
    // Clear provider-related env so built-in defaults are predictable.
    for (const k of ["OPENROUTER_API_KEY", "OPENROUTER_DEFAULT_MODEL", "ZAI_API_KEY", "ZAI_DEFAULT_MODEL", "OLLAMA_BASE_URL", "OLLAMA_API_KEY", "OLLAMA_DEFAULT_MODEL"]) {
      delete process.env[k];
    }
  });

  afterEach(() => {
    if (prevHome !== undefined) process.env["HOME"] = prevHome;
    else delete process.env["HOME"];
    // Restore env.
    for (const k of Object.keys(prevEnv)) {
      if (!(k in process.env)) process.env[k] = prevEnv[k];
    }
    rmSync(home, { recursive: true, force: true });
    _resetProviderCacheForTests();
  });

  function writeConfig(json: unknown): void {
    const sophronDir = join(home, ".sophron");
    mkdirSync(sophronDir, { recursive: true });
    writeFileSync(join(sophronDir, "config.json"), JSON.stringify(json));
  }

  describe("empty config", () => {
    it("returns an empty list when no config file exists (no built-in defaults in V3.1.0)", () => {
      _resetProviderCacheForTests();
      const list = listProviders();
      expect(list).toHaveLength(0);
    });

    it("getProvider throws for any name when nothing is configured", () => {
      _resetProviderCacheForTests();
      expect(() => getProvider("ollama")).toThrow(/Unknown provider instance/);
    });
  });

  describe("array config form (named instances)", () => {
    it("loads multiple instances of the same kind", () => {
      writeConfig({
        providers: [
          { name: "ollama-laptop", kind: "ollama", baseURL: "http://laptop:11434/v1", description: "laptop ollama" },
          { name: "ollama-desktop", kind: "ollama", baseURL: "http://desktop:11434/v1", description: "desktop ollama" },
        ],
      });
      _resetProviderCacheForTests();
      const laptop = getProvider("ollama-laptop");
      const desktop = getProvider("ollama-desktop");
      expect(laptop.baseURL).toBe("http://laptop:11434/v1");
      expect(laptop.description).toBe("laptop ollama");
      expect(desktop.baseURL).toBe("http://desktop:11434/v1");
    });

    it("does NOT merge built-in defaults (V3.1.0: only configured instances)", () => {
      writeConfig({
        providers: [{ name: "ollama-laptop", kind: "ollama", baseURL: "http://laptop:11434/v1" }],
      });
      _resetProviderCacheForTests();
      // Configured instance present.
      expect(getProvider("ollama-laptop").baseURL).toBe("http://laptop:11434/v1");
      // Built-in singletons NOT available (no defaults).
      expect(() => getProvider("openrouter")).toThrow(/Unknown provider instance/);
      expect(() => getProvider("zai")).toThrow(/Unknown provider instance/);
    });

    it("applies kind defaults for omitted fields", () => {
      writeConfig({
        providers: [{ name: "or", kind: "openrouter", apiKey: "k123" }],
      });
      _resetProviderCacheForTests();
      const or = getProvider("or");
      expect(or.baseURL).toBe("https://openrouter.ai/api/v1"); // default for openrouter
      expect(or.apiKey).toBe("k123");
    });

    it("supports openai-compat kind for generic endpoints", () => {
      writeConfig({
        providers: [{ name: "vllm", kind: "openai-compat", baseURL: "http://gpu:8000/v1", apiKey: "tok", description: "GPU server" }],
      });
      _resetProviderCacheForTests();
      const vllm = getProvider("vllm");
      expect(vllm.kind).toBe("openai-compat");
      expect(vllm.baseURL).toBe("http://gpu:8000/v1");
      expect(vllm.apiKey).toBe("tok");
      expect(vllm.description).toBe("GPU server");
    });

    it("expands ${VAR} in config values", () => {
      process.env["MY_KEY"] = "expanded-key";
      writeConfig({
        providers: [{ name: "or", kind: "openrouter", apiKey: "${MY_KEY}", description: "${MY_DESC}" }],
      });
      process.env["MY_DESC"] = "cloud router";
      _resetProviderCacheForTests();
      const or = getProvider("or");
      expect(or.apiKey).toBe("expanded-key");
      expect(or.description).toBe("cloud router");
      delete process.env["MY_KEY"];
      delete process.env["MY_DESC"];
    });

    it("last instance wins on duplicate names", () => {
      writeConfig({
        providers: [
          { name: "dup", kind: "ollama", baseURL: "http://first:11434/v1" },
          { name: "dup", kind: "ollama", baseURL: "http://second:11434/v1" },
        ],
      });
      _resetProviderCacheForTests();
      expect(getProvider("dup").baseURL).toBe("http://second:11434/v1");
    });
  });

  describe("legacy object config migration", () => {
    it("migrates { ollama: {...} } to instances named after each kind", () => {
      writeConfig({
        providers: {
          ollama: { baseURL: "http://legacy:11434/v1", description: "legacy" },
        },
      });
      _resetProviderCacheForTests();
      const ollama = getProvider("ollama");
      expect(ollama.baseURL).toBe("http://legacy:11434/v1");
      expect(ollama.description).toBe("legacy");
    });

    it("does NOT add built-in defaults for unlisted kinds (V3.1.0)", () => {
      writeConfig({ providers: { ollama: { description: "x" } } });
      _resetProviderCacheForTests();
      expect(() => getProvider("openrouter")).toThrow(/Unknown provider instance/);
    });
  });
});

// ── Resolution logic tests ──────────────────────────────────────────────────

describe("getProvider", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sophron-getprov-"));
    prevHome = process.env["HOME"];
    process.env["HOME"] = home;
    _resetProviderCacheForTests();
  });

  afterEach(() => {
    if (prevHome !== undefined) process.env["HOME"] = prevHome;
    else delete process.env["HOME"];
    rmSync(home, { recursive: true, force: true });
    _resetProviderCacheForTests();
  });

  it("throws a clear error for an unknown instance name", () => {
    expect(() => getProvider("nonexistent-instance")).toThrow(/Unknown provider instance/);
  });

  it("error message lists available instances (or none)", () => {
    addProviderInstance({ name: "my-or", kind: "openrouter", apiKey: "k" });
    try {
      getProvider("nope");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Error).message).toMatch(/my-or/);
    }
  });
});

describe("resolveModel", () => {
  let home: string;
  let prevHome: string | undefined;
  const prevEnv = { ...process.env };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sophron-resolve-home-"));
    prevHome = process.env["HOME"];
    process.env["HOME"] = home;
    for (const k of ["OPENROUTER_API_KEY", "OPENROUTER_DEFAULT_MODEL", "ZAI_API_KEY", "ZAI_DEFAULT_MODEL", "OLLAMA_BASE_URL", "OLLAMA_API_KEY", "OLLAMA_DEFAULT_MODEL"]) {
      delete process.env[k];
    }
    // Seed a config with two providers so resolveModel has something to resolve against.
    const sophronDir = join(home, ".sophron");
    mkdirSync(sophronDir, { recursive: true });
    writeFileSync(join(sophronDir, "config.json"), JSON.stringify({
      providers: [
        { name: "ollama", kind: "ollama", baseURL: "http://localhost:11434/v1" },
        { name: "openrouter", kind: "openrouter", baseURL: "https://openrouter.ai/api/v1", apiKey: "key" },
      ],
    }));
    _resetProviderCacheForTests();
  });

  afterEach(() => {
    if (prevHome !== undefined) process.env["HOME"] = prevHome;
    else delete process.env["HOME"];
    for (const k of Object.keys(prevEnv)) {
      if (!(k in process.env)) process.env[k] = prevEnv[k];
    }
    rmSync(home, { recursive: true, force: true });
    _resetProviderCacheForTests();
  });

  it("returns the model as-is for a valid (model, provider) pair", () => {
    const r = resolveModel("qwen3.5:9b", "ollama");
    expect(r.provider).toBe("ollama");
    expect(r.model).toBe("qwen3.5:9b");
  });

  it("returns the model as-is for an openrouter concrete id", () => {
    const r = resolveModel("anthropic/claude-sonnet-4", "openrouter");
    expect(r.provider).toBe("openrouter");
    expect(r.model).toBe("anthropic/claude-sonnet-4");
  });

  it("throws when the provider is not configured", () => {
    expect(() => resolveModel("some-model", "nonexistent")).toThrow(/Unknown provider instance/);
  });

  it("reresolveModel validates and returns the current pair when no overrides", () => {
    const agent = { name: "tester", model: "qwen3.5:9b", provider: "ollama" } as import("../../src/types.js").AgentDefinition;
    const r = reresolveModel(agent);
    expect(r.provider).toBe("ollama");
    expect(r.model).toBe("qwen3.5:9b");
  });

  it("reresolveModel applies a new model against the agent's provider", () => {
    const agent = { name: "tester", model: "qwen3.5:9b", provider: "ollama" } as import("../../src/types.js").AgentDefinition;
    const r = reresolveModel(agent, "llama3.1:8b");
    expect(r.provider).toBe("ollama");
    expect(r.model).toBe("llama3.1:8b");
  });

  it("reresolveModel throws when the provider is unknown", () => {
    const agent = { name: "tester", model: "qwen3.5:9b", provider: "nonexistent" } as import("../../src/types.js").AgentDefinition;
    expect(() => reresolveModel(agent, "x")).toThrow(/Unknown provider instance/);
  });

  it("reresolveModel throws when the agent has no provider", () => {
    const agent = { name: "tester", model: "qwen3.5:9b" } as import("../../src/types.js").AgentDefinition;
    expect(() => reresolveModel(agent, "x")).toThrow(/no provider/);
  });
});

// ── Type-level sanity ───────────────────────────────────────────────────────

describe("ProviderName type", () => {
  it("ProviderName is a string alias (instance names are free-form)", () => {
    // If this compiles, ProviderName accepts arbitrary strings.
    const name: ProviderConfig["name"] = "my-custom-instance";
    expect(typeof name).toBe("string");
  });
});

// ── addProviderInstance / removeProviderInstance (sophron add-provider) ──────

describe("addProviderInstance", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sophron-add-prov-"));
    prevHome = process.env["HOME"];
    process.env["HOME"] = home;
    _resetProviderCacheForTests();
  });

  afterEach(() => {
    if (prevHome !== undefined) process.env["HOME"] = prevHome;
    else delete process.env["HOME"];
    rmSync(home, { recursive: true, force: true });
    _resetProviderCacheForTests();
  });

  function readConfigFile(): unknown {
    const p = join(home, ".sophron", "config.json");
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8"));
  }

  it("creates config.json when none exists", () => {
    const stored = addProviderInstance({ name: "my-ollama", kind: "ollama", baseURL: "http://host:11434/v1", description: "my local ollama" });
    expect(stored.name).toBe("my-ollama");
    const cfg = readConfigFile() as { providers: { name: string; kind: string }[] };
    expect(cfg.providers).toHaveLength(1);
    expect(cfg.providers[0]!.name).toBe("my-ollama");
  });

  it("appends to an existing array without clobbering", () => {
    const dir = join(home, ".sophron");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), JSON.stringify({ providers: [{ name: "first", kind: "ollama" }] }));
    addProviderInstance({ name: "second", kind: "openai-compat", baseURL: "http://x/v1", apiKey: "k" });
    const cfg = readConfigFile() as { providers: { name: string }[] };
    expect(cfg.providers.map((p) => p.name)).toEqual(["first", "second"]);
  });

  it("migrates the legacy object form to an array on write", () => {
    const dir = join(home, ".sophron");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), JSON.stringify({ providers: { ollama: { baseURL: "http://h:11434/v1" } } }));
    addProviderInstance({ name: "extra", kind: "openai-compat", baseURL: "http://x/v1" });
    const cfg = readConfigFile() as { providers: { name: string }[] };
    const names = cfg.providers.map((p) => p.name);
    expect(names).toContain("ollama"); // migrated
    expect(names).toContain("extra"); // added
    expect(Array.isArray(cfg.providers)).toBe(true);
  });

  it("refuses a duplicate name without replace", () => {
    addProviderInstance({ name: "dup", kind: "ollama" });
    expect(() => addProviderInstance({ name: "dup", kind: "ollama" })).toThrow(/already exists/);
  });

  it("overwrites a duplicate when replace is true", () => {
    addProviderInstance({ name: "dup", kind: "ollama", description: "old" });
    addProviderInstance({ name: "dup", kind: "ollama", description: "new" }, { replace: true });
    const cfg = readConfigFile() as { providers: { name: string; description?: string }[] };
    expect(cfg.providers).toHaveLength(1);
    expect(cfg.providers[0]!.description).toBe("new");
  });

  it("validates the name format", () => {
    expect(() => addProviderInstance({ name: "", kind: "ollama" })).toThrow(/required/i);
    expect(() => addProviderInstance({ name: "bad name!", kind: "ollama" })).toThrow(/invalid/i);
    expect(() => addProviderInstance({ name: "-leading", kind: "ollama" })).toThrow(/invalid/i);
  });

  it("drops empty optional fields so kind defaults apply at load", () => {
    const stored = addProviderInstance({ name: "minimal", kind: "ollama" });
    expect(stored).not.toHaveProperty("baseURL");
    expect(stored).not.toHaveProperty("apiKey");
    // And loading resolves it with the ollama default baseURL.
    _resetProviderCacheForTests();
    const got = getProvider("minimal");
    expect(got.baseURL).toBe("http://localhost:11434/v1");
  });

  it("ignores a default flag if passed (vestigial field)", () => {
    // V3.1.0 removed prefix shortcuts; the `default` field is no longer accepted.
    addProviderInstance({ name: "primary", kind: "openrouter", apiKey: "k" } as never);
    const cfg = readConfigFile() as { providers: { name: string }[] };
    expect(cfg.providers[0]!.name).toBe("primary");
  });

  it("resets the in-process cache so listProviders reflects the write", () => {
    const before = listProviders().map((p) => p.name);
    expect(before).not.toContain("fresh-instance");
    addProviderInstance({ name: "fresh-instance", kind: "ollama", baseURL: "http://h:11434/v1" });
    const after = listProviders().map((p) => p.name);
    expect(after).toContain("fresh-instance");
  });

  it("configPath resolves under the isolated HOME", () => {
    expect(configPath()).toBe(join(home, ".sophron", "config.json"));
  });
});

describe("removeProviderInstance", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sophron-rm-prov-"));
    prevHome = process.env["HOME"];
    process.env["HOME"] = home;
    _resetProviderCacheForTests();
  });

  afterEach(() => {
    if (prevHome !== undefined) process.env["HOME"] = prevHome;
    else delete process.env["HOME"];
    rmSync(home, { recursive: true, force: true });
    _resetProviderCacheForTests();
  });

  it("removes a named instance and returns true", () => {
    addProviderInstance({ name: "to-remove", kind: "ollama" });
    addProviderInstance({ name: "keep", kind: "ollama" });
    expect(removeProviderInstance("to-remove")).toBe(true);
    const cfg = JSON.parse(readFileSync(join(home, ".sophron", "config.json"), "utf8")) as { providers: { name: string }[] };
    expect(cfg.providers.map((p) => p.name)).toEqual(["keep"]);
  });

  it("returns false when the instance is not found", () => {
    expect(removeProviderInstance("never-existed")).toBe(false);
  });

  it("is a no-op when no config / legacy form exists", () => {
    expect(removeProviderInstance("x")).toBe(false);
  });
});

// ── updateProviderInstance / getRawProviderEntry (sophron edit-provider) ─────

describe("getRawProviderEntry", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sophron-raw-"));
    prevHome = process.env["HOME"];
    process.env["HOME"] = home;
    _resetProviderCacheForTests();
  });

  afterEach(() => {
    if (prevHome !== undefined) process.env["HOME"] = prevHome;
    else delete process.env["HOME"];
    rmSync(home, { recursive: true, force: true });
    _resetProviderCacheForTests();
  });

  it("returns the raw (unexpanded) entry from config.json", () => {
    addProviderInstance({ name: "or", kind: "openrouter", apiKey: "${OPENROUTER_API_KEY}", description: "cloud router" });
    const raw = getRawProviderEntry("or");
    expect(raw).toBeDefined();
    expect(raw!.apiKey).toBe("${OPENROUTER_API_KEY}"); // NOT expanded
    expect(raw!.description).toBe("cloud router");
  });

  it("returns undefined for a non-existent name", () => {
    expect(getRawProviderEntry("ghost")).toBeUndefined();
  });
});

describe("updateProviderInstance", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sophron-edit-"));
    prevHome = process.env["HOME"];
    process.env["HOME"] = home;
    // Clear provider env so built-in defaults are predictable.
    for (const k of ["OPENROUTER_API_KEY", "OPENROUTER_DEFAULT_MODEL", "ZAI_API_KEY", "OLLAMA_BASE_URL"]) {
      delete process.env[k];
    }
    _resetProviderCacheForTests();
  });

  afterEach(() => {
    if (prevHome !== undefined) process.env["HOME"] = prevHome;
    else delete process.env["HOME"];
    rmSync(home, { recursive: true, force: true });
    _resetProviderCacheForTests();
  });

  function readConfig(): { providers: { name: string; apiKey?: string; baseURL?: string; description?: string; default?: boolean }[] } {
    return JSON.parse(readFileSync(join(home, ".sophron", "config.json"), "utf8"));
  }

  it("updates a single field without touching the others", () => {
    addProviderInstance({ name: "or", kind: "openrouter", baseURL: "https://openrouter.ai/api/v1", description: "old desc" });
    const stored = updateProviderInstance("or", { apiKey: "sk-new-key" });
    expect(stored.apiKey).toBe("sk-new-key");
    // Other fields preserved.
    expect(stored.baseURL).toBe("https://openrouter.ai/api/v1");
    expect(stored.description).toBe("old desc");
  });

  it("adds an API key to a provider that has none (the primary use case)", () => {
    addProviderInstance({ name: "keyless", kind: "openrouter", baseURL: "https://openrouter.ai/api/v1", description: "d" });
    // Verify it has no key initially.
    expect(readConfig().providers[0]!.apiKey).toBeUndefined();
    updateProviderInstance("keyless", { apiKey: "sk-secret" });
    expect(readConfig().providers[0]!.apiKey).toBe("sk-secret");
    // Resolves after cache reset.
    _resetProviderCacheForTests();
    expect(getProvider("keyless").apiKey).toBe("sk-secret");
  });

  it("preserves ${ENV_VAR} references in untouched fields", () => {
    addProviderInstance({ name: "envref", kind: "openrouter", apiKey: "${OPENROUTER_API_KEY}", description: "d" });
    updateProviderInstance("envref", { description: "new desc" });
    // The apiKey reference must be preserved verbatim (not expanded to "").
    expect(readConfig().providers[0]!.apiKey).toBe("${OPENROUTER_API_KEY}");
    expect(readConfig().providers[0]!.description).toBe("new desc");
  });

  it("clears a field when given an empty string", () => {
    addProviderInstance({ name: "to-clear", kind: "ollama", apiKey: "k", description: "m" });
    updateProviderInstance("to-clear", { apiKey: "", description: "" });
    expect(readConfig().providers[0]!.apiKey).toBeUndefined();
    expect(readConfig().providers[0]!.description).toBeUndefined();
  });

  it("throws for a non-existent provider (no built-in singletons in V3.1.0)", () => {
    expect(() => updateProviderInstance("ghost", { apiKey: "x" })).toThrow(/No provider instance/);
  });

  it("resets the in-process cache so getProvider reflects the change", () => {
    addProviderInstance({ name: "cache", kind: "ollama", baseURL: "http://h:11434/v1" });
    expect(getProvider("cache").apiKey).toBe("ollama"); // default dummy key
    updateProviderInstance("cache", { apiKey: "real-key" });
    expect(getProvider("cache").apiKey).toBe("real-key");
  });

  it("updates multiple fields in one call", () => {
    addProviderInstance({ name: "multi", kind: "openrouter", baseURL: "old-url", apiKey: "old-key", description: "old desc" });
    const stored = updateProviderInstance("multi", { baseURL: "new-url", apiKey: "new-key", description: "new desc" });
    expect(stored.baseURL).toBe("new-url");
    expect(stored.apiKey).toBe("new-key");
    expect(stored.description).toBe("new desc");
  });
});
