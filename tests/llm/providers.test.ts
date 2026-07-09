import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  expandEnv,
  getProvider,
  listProviders,
  defaultForKind,
  resolveModel,
  resolveModelWithProvider,
  resolveModelSpec,
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

  describe("zero-config defaults", () => {
    it("creates built-in singletons when no config file exists", () => {
      _resetProviderCacheForTests();
      const list = listProviders();
      const names = list.map((p) => p.name);
      expect(names).toContain("ollama");
      expect(names).toContain("openrouter");
      expect(names).toContain("zai");
    });

    it("ollama default points at localhost:11434", () => {
      _resetProviderCacheForTests();
      const ollama = getProvider("ollama");
      expect(ollama.kind).toBe("ollama");
      expect(ollama.baseURL).toBe("http://localhost:11434/v1");
    });

    it("openrouter/zai have null apiKey when env unset", () => {
      _resetProviderCacheForTests();
      expect(getProvider("openrouter").apiKey).toBeNull();
      expect(getProvider("zai").apiKey).toBeNull();
    });
  });

  describe("array config form (named instances)", () => {
    it("loads multiple instances of the same kind", () => {
      writeConfig({
        providers: [
          { name: "ollama-laptop", kind: "ollama", baseURL: "http://laptop:11434/v1", defaultModel: "qwen3.5:9b" },
          { name: "ollama-desktop", kind: "ollama", baseURL: "http://desktop:11434/v1", defaultModel: "llama3.1:8b" },
        ],
      });
      _resetProviderCacheForTests();
      const laptop = getProvider("ollama-laptop");
      const desktop = getProvider("ollama-desktop");
      expect(laptop.baseURL).toBe("http://laptop:11434/v1");
      expect(laptop.defaultModel).toBe("qwen3.5:9b");
      expect(desktop.baseURL).toBe("http://desktop:11434/v1");
    });

    it("preserves built-in defaults alongside configured instances", () => {
      writeConfig({
        providers: [{ name: "ollama-laptop", kind: "ollama", baseURL: "http://laptop:11434/v1" }],
      });
      _resetProviderCacheForTests();
      // Configured instance present.
      expect(getProvider("ollama-laptop").baseURL).toBe("http://laptop:11434/v1");
      // Built-in singletons still available (mergeWithDefaults).
      expect(getProvider("openrouter").kind).toBe("openrouter");
      expect(getProvider("zai").kind).toBe("zai");
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
        providers: [{ name: "vllm", kind: "openai-compat", baseURL: "http://gpu:8000/v1", apiKey: "tok", defaultModel: "llama3:70b" }],
      });
      _resetProviderCacheForTests();
      const vllm = getProvider("vllm");
      expect(vllm.kind).toBe("openai-compat");
      expect(vllm.baseURL).toBe("http://gpu:8000/v1");
      expect(vllm.apiKey).toBe("tok");
    });

    it("expands ${VAR} in config values", () => {
      process.env["MY_KEY"] = "expanded-key";
      writeConfig({
        providers: [{ name: "or", kind: "openrouter", apiKey: "${MY_KEY}", defaultModel: "${MY_MODEL}" }],
      });
      process.env["MY_MODEL"] = "anthropic/claude-sonnet-4";
      _resetProviderCacheForTests();
      const or = getProvider("or");
      expect(or.apiKey).toBe("expanded-key");
      expect(or.defaultModel).toBe("anthropic/claude-sonnet-4");
      delete process.env["MY_KEY"];
      delete process.env["MY_MODEL"];
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
          ollama: { baseURL: "http://legacy:11434/v1", defaultModel: "legacy-model" },
        },
      });
      _resetProviderCacheForTests();
      const ollama = getProvider("ollama");
      expect(ollama.baseURL).toBe("http://legacy:11434/v1");
      expect(ollama.defaultModel).toBe("legacy-model");
    });

    it("still provides built-in defaults for unlisted kinds", () => {
      writeConfig({ providers: { ollama: { defaultModel: "x" } } });
      _resetProviderCacheForTests();
      expect(getProvider("openrouter").kind).toBe("openrouter");
    });
  });
});

// ── Resolution logic tests ──────────────────────────────────────────────────

describe("getProvider", () => {
  beforeEach(() => _resetProviderCacheForTests());

  it("throws a clear error for an unknown instance name", () => {
    expect(() => getProvider("nonexistent-instance")).toThrow(/Unknown provider instance/);
  });

  it("error message lists available instances", () => {
    try {
      getProvider("nope");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Error).message).toMatch(/ollama|openrouter|zai/);
    }
  });
});

describe("defaultForKind", () => {
  beforeEach(() => _resetProviderCacheForTests());

  it("returns the built-in singleton for a known kind", () => {
    const d = defaultForKind("ollama");
    expect(d).toBeDefined();
    expect(d!.name).toBe("ollama");
    expect(d!.kind).toBe("ollama");
  });

  it("returns undefined for a kind with no instances", () => {
    expect(defaultForKind("openai-compat")).toBeUndefined();
  });
});

describe("resolveModel", () => {
  beforeEach(() => _resetProviderCacheForTests());

  it("prefix ollama: → default ollama instance + stripped model id", () => {
    const r = resolveModel("ollama:llama3.2:1b");
    expect(r.provider).toBe("ollama");
    expect(r.model).toBe("llama3.2:1b");
  });

  it("prefix zai: → zai instance", () => {
    const r = resolveModel("zai:glm-4.6");
    expect(r.provider).toBe("zai");
    expect(r.model).toBe("glm-4.6");
  });

  it("prefix openrouter: → openrouter instance", () => {
    const r = resolveModel("openrouter:anthropic/claude-sonnet-4");
    expect(r.provider).toBe("openrouter");
    expect(r.model).toBe("anthropic/claude-sonnet-4");
  });

  it("inherit → fallback to first instance with a defaultModel (ollama if OLLAMA_DEFAULT_MODEL set)", () => {
    process.env["OLLAMA_DEFAULT_MODEL"] = "qwen3.5:9b";
    _resetProviderCacheForTests();
    const r = resolveModel("inherit");
    expect(r.model).toBe("qwen3.5:9b");
    delete process.env["OLLAMA_DEFAULT_MODEL"];
    _resetProviderCacheForTests();
  });

  it("tier override → resolves through the tier map", () => {
    // We can't easily set a tier map without a config file, so test the path
    // indirectly: a bare model id with no creds anywhere should fall to the
    // error path. Set OLLAMA_DEFAULT_MODEL so there IS a fallback.
    process.env["OLLAMA_DEFAULT_MODEL"] = "fallback-model";
    _resetProviderCacheForTests();
    const r = resolveModel("some-unknown-tier");
    expect(r.model).toBe("fallback-model");
    delete process.env["OLLAMA_DEFAULT_MODEL"];
    _resetProviderCacheForTests();
  });

  it("throws when no provider can resolve the tier", () => {
    // No env defaults, no config → nothing resolves.
    for (const k of ["OPENROUTER_API_KEY", "OPENROUTER_DEFAULT_MODEL", "ZAI_API_KEY", "ZAI_DEFAULT_MODEL", "OLLAMA_DEFAULT_MODEL"]) {
      delete process.env[k];
    }
    _resetProviderCacheForTests();
    expect(() => resolveModel("inherit")).toThrow(/Could not resolve model tier/);
  });
});

describe("resolveModelWithProvider", () => {
  beforeEach(() => _resetProviderCacheForTests());

  it("uses the explicit provider name and trusts the model id", () => {
    const r = resolveModelWithProvider("any-model-id", "ollama");
    expect(r.provider).toBe("ollama");
    expect(r.model).toBe("any-model-id");
  });

  it("validates the provider exists (throws on unknown)", () => {
    expect(() => resolveModelWithProvider("m", "nonexistent")).toThrow(/Unknown provider instance/);
  });

  it("falls back to resolveModel when no provider given", () => {
    process.env["OLLAMA_DEFAULT_MODEL"] = "fb-model";
    _resetProviderCacheForTests();
    const r = resolveModelWithProvider("inherit");
    expect(r.model).toBe("fb-model");
    delete process.env["OLLAMA_DEFAULT_MODEL"];
    _resetProviderCacheForTests();
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
    const stored = addProviderInstance({ name: "my-ollama", kind: "ollama", baseURL: "http://host:11434/v1", defaultModel: "qwen3.5:9b" });
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
    addProviderInstance({ name: "dup", kind: "ollama", defaultModel: "old" });
    addProviderInstance({ name: "dup", kind: "ollama", defaultModel: "new" }, { replace: true });
    const cfg = readConfigFile() as { providers: { name: string; defaultModel?: string }[] };
    expect(cfg.providers).toHaveLength(1);
    expect(cfg.providers[0]!.defaultModel).toBe("new");
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

  it("persists the default flag", () => {
    addProviderInstance({ name: "primary", kind: "openrouter", apiKey: "k", default: true });
    const cfg = readConfigFile() as { providers: { name: string; default?: boolean }[] };
    expect(cfg.providers[0]!.default).toBe(true);
  });

  it("persists a description", () => {
    const stored = addProviderInstance({
      name: "described",
      kind: "ollama",
      baseURL: "http://host:11434/v1",
      description: "Local reasoning model on the workstation",
    });
    expect(stored.description).toBe("Local reasoning model on the workstation");
    const cfg = readConfigFile() as { providers: { name: string; description?: string }[] };
    expect(cfg.providers[0]!.description).toBe("Local reasoning model on the workstation");
  });

  it("drops an empty description", () => {
    const stored = addProviderInstance({ name: "no-desc", kind: "ollama", description: "   " });
    expect(stored).not.toHaveProperty("description");
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
    addProviderInstance({ name: "or", kind: "openrouter", apiKey: "${OPENROUTER_API_KEY}", defaultModel: "claude-sonnet-4" });
    const raw = getRawProviderEntry("or");
    expect(raw).toBeDefined();
    expect(raw!.apiKey).toBe("${OPENROUTER_API_KEY}"); // NOT expanded
    expect(raw!.defaultModel).toBe("claude-sonnet-4");
  });

  it("returns the raw description", () => {
    addProviderInstance({ name: "or-desc", kind: "openrouter", description: "Cloud provider for frontier reasoning" });
    const raw = getRawProviderEntry("or-desc");
    expect(raw!.description).toBe("Cloud provider for frontier reasoning");
  });

  it("returns undefined for a built-in with no config entry", () => {
    // "ollama" exists as a built-in singleton, but has no config.json entry.
    expect(getRawProviderEntry("ollama")).toBeUndefined();
    expect(getRawProviderEntry("openrouter")).toBeUndefined();
  });

  it("returns undefined for a non-existent name", () => {
    expect(getRawProviderEntry("ghost")).toBeUndefined();
  });
});

describe("resolveModelSpec", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sophron-spec-home-"));
    prevHome = process.env["HOME"];
    process.env["HOME"] = home;
    for (const k of ["OPENROUTER_API_KEY", "OPENROUTER_DEFAULT_MODEL", "ZAI_API_KEY", "ZAI_DEFAULT_MODEL", "OLLAMA_DEFAULT_MODEL"]) {
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

  function writeConfig(json: unknown): void {
    const sophronDir = join(home, ".sophron");
    mkdirSync(sophronDir, { recursive: true });
    writeFileSync(join(sophronDir, "config.json"), JSON.stringify(json));
  }

  it("prefers a configured provider instance name before the first colon", () => {
    writeConfig({
      providers: [{ name: "ollama", kind: "ollama", baseURL: "http://custom:11434/v1", defaultModel: "custom-model" }],
    });
    _resetProviderCacheForTests();
    // "ollama:qwen3.5:9b" — the configured instance named "ollama" wins over the
    // kind-prefix fallback.
    const r = resolveModelSpec("ollama:qwen3.5:9b");
    expect(r.provider).toBe("ollama");
    expect(r.model).toBe("qwen3.5:9b");
  });

  it("falls back to resolveModel for kind prefixes when no instance name matches", () => {
    process.env["OLLAMA_DEFAULT_MODEL"] = "fallback-model";
    _resetProviderCacheForTests();
    const r = resolveModelSpec("ollama:llama3.2:1b");
    expect(r.provider).toBe("ollama");
    expect(r.model).toBe("llama3.2:1b");
    delete process.env["OLLAMA_DEFAULT_MODEL"];
  });

  it("resolves a named tier through the tier map", () => {
    writeConfig({ tiers: { frontier: "openrouter:anthropic/claude-sonnet-4" } });
    _resetProviderCacheForTests();
    const r = resolveModelSpec("frontier");
    expect(r.provider).toBe("openrouter");
    expect(r.model).toBe("anthropic/claude-sonnet-4");
  });

  it("throws when no provider can resolve the spec", () => {
    _resetProviderCacheForTests();
    expect(() => resolveModelSpec("definitely-not-a-tier")).toThrow(/Could not resolve model tier/);
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

  function readConfig(): { providers: { name: string; apiKey?: string; baseURL?: string; defaultModel?: string; default?: boolean }[] } {
    return JSON.parse(readFileSync(join(home, ".sophron", "config.json"), "utf8"));
  }

  it("updates a single field without touching the others", () => {
    addProviderInstance({ name: "or", kind: "openrouter", baseURL: "https://openrouter.ai/api/v1", defaultModel: "old-model" });
    const stored = updateProviderInstance("or", { apiKey: "sk-new-key" });
    expect(stored.apiKey).toBe("sk-new-key");
    // Other fields preserved.
    expect(stored.baseURL).toBe("https://openrouter.ai/api/v1");
    expect(stored.defaultModel).toBe("old-model");
  });

  it("adds an API key to a provider that has none (the primary use case)", () => {
    addProviderInstance({ name: "keyless", kind: "openrouter", baseURL: "https://openrouter.ai/api/v1", defaultModel: "claude" });
    // Verify it has no key initially.
    expect(readConfig().providers[0]!.apiKey).toBeUndefined();
    updateProviderInstance("keyless", { apiKey: "sk-secret" });
    expect(readConfig().providers[0]!.apiKey).toBe("sk-secret");
    // Resolves after cache reset.
    _resetProviderCacheForTests();
    expect(getProvider("keyless").apiKey).toBe("sk-secret");
  });

  it("preserves ${ENV_VAR} references in untouched fields", () => {
    addProviderInstance({ name: "envref", kind: "openrouter", apiKey: "${OPENROUTER_API_KEY}", defaultModel: "claude" });
    updateProviderInstance("envref", { defaultModel: "gpt-4o" });
    // The apiKey reference must be preserved verbatim (not expanded to "").
    expect(readConfig().providers[0]!.apiKey).toBe("${OPENROUTER_API_KEY}");
    expect(readConfig().providers[0]!.defaultModel).toBe("gpt-4o");
  });

  it("clears a field when given an empty string", () => {
    addProviderInstance({ name: "to-clear", kind: "ollama", apiKey: "k", defaultModel: "m" });
    updateProviderInstance("to-clear", { apiKey: "", defaultModel: "" });
    expect(readConfig().providers[0]!.apiKey).toBeUndefined();
    expect(readConfig().providers[0]!.defaultModel).toBeUndefined();
  });

  it("sets the default flag", () => {
    addProviderInstance({ name: "flag", kind: "ollama" });
    updateProviderInstance("flag", { default: true });
    expect(readConfig().providers[0]!.default).toBe(true);
    updateProviderInstance("flag", { default: false });
    expect(readConfig().providers[0]!.default).toBeUndefined();
  });

  it("creates a config entry for a built-in singleton that has none", () => {
    // "openrouter" exists as a built-in (env-backed) but has no config entry.
    process.env["OPENROUTER_API_KEY"] = "env-key";
    _resetProviderCacheForTests();
    expect(getRawProviderEntry("openrouter")).toBeUndefined();
    // Now edit it — should create a config entry.
    const stored = updateProviderInstance("openrouter", { defaultModel: "claude-sonnet-4" });
    expect(stored.kind).toBe("openrouter");
    expect(stored.defaultModel).toBe("claude-sonnet-4");
    // The config entry now exists on disk.
    expect(getRawProviderEntry("openrouter")).toBeDefined();
    delete process.env["OPENROUTER_API_KEY"];
  });

  it("throws for a non-existent provider", () => {
    expect(() => updateProviderInstance("ghost", { apiKey: "x" })).toThrow(/No provider instance/);
  });

  it("resets the in-process cache so getProvider reflects the change", () => {
    addProviderInstance({ name: "cache", kind: "ollama", baseURL: "http://h:11434/v1" });
    expect(getProvider("cache").apiKey).toBe("ollama"); // default dummy key
    updateProviderInstance("cache", { apiKey: "real-key" });
    expect(getProvider("cache").apiKey).toBe("real-key");
  });

  it("updates multiple fields in one call", () => {
    addProviderInstance({ name: "multi", kind: "openrouter", baseURL: "old-url", apiKey: "old-key", defaultModel: "old-model" });
    const stored = updateProviderInstance("multi", { baseURL: "new-url", apiKey: "new-key", defaultModel: "new-model", default: true });
    expect(stored.baseURL).toBe("new-url");
    expect(stored.apiKey).toBe("new-key");
    expect(stored.defaultModel).toBe("new-model");
    expect(stored.default).toBe(true);
  });

  it("sets a description", () => {
    addProviderInstance({ name: "set-desc", kind: "ollama" });
    const stored = updateProviderInstance("set-desc", { description: "Fast local model for cheap tasks" });
    expect(stored.description).toBe("Fast local model for cheap tasks");
  });

  it("clears a description when given an empty string", () => {
    addProviderInstance({ name: "clear-desc", kind: "ollama", description: "will be removed" });
    const stored = updateProviderInstance("clear-desc", { description: "" });
    expect(stored).not.toHaveProperty("description");
  });

  it("round-trips description through config load", () => {
    addProviderInstance({ name: "roundtrip", kind: "openrouter", description: "Round-trip description" });
    _resetProviderCacheForTests();
    const loaded = getProvider("roundtrip");
    expect(loaded.description).toBe("Round-trip description");
    expect(listProviders().find((p) => p.name === "roundtrip")?.description).toBe("Round-trip description");
  });
});
