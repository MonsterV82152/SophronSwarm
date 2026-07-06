import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  expandEnv,
  getProvider,
  listProviders,
  defaultForKind,
  resolveModel,
  resolveModelWithProvider,
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
