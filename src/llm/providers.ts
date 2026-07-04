/**
 * Provider configuration — OpenRouter / Ollama / z.ai.
 *
 * All three are OpenAI-compatible, so a single client (src/llm/client.ts)
 * covers them. The provider is chosen by model-id prefix:
 *   - "ollama:" or known Ollama tag shape  → Ollama (local)
 *   - "zai:"                              → z.ai
 *   - anything else (e.g. "anthropic/…")  → OpenRouter
 *
 * Concrete model resolution (tier → id) happens here, using operator config +
 * env defaults. Operators can override everything in ~/.sophron/config.json.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "../util/log.js";

export type ProviderName = "openrouter" | "ollama" | "zai";

export interface ProviderConfig {
  name: ProviderName;
  baseURL: string;
  apiKey: string | null;
  defaultModel: string | null;
}

export interface ModelResolution {
  provider: ProviderName;
  model: string;
}

interface OperatorConfig {
  providers?: {
    openrouter?: { apiKey?: string; defaultModel?: string };
    ollama?: { baseURL?: string; defaultModel?: string };
    zai?: { apiKey?: string; defaultModel?: string };
  };
  /** Tier → concrete model id overrides (e.g. { frontier: "anthropic/claude-sonnet-4" }). */
  tiers?: Record<string, string>;
}

function loadOperatorConfig(): OperatorConfig {
  const path = join(homedir(), ".sophron", "config.json");
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as OperatorConfig;
  } catch (e) {
    log.warn({ err: e, path }, "could not parse operator config; ignoring");
    return {};
  }
}

const cfg = loadOperatorConfig();

export function getProvider(name: ProviderName): ProviderConfig {
  switch (name) {
    case "openrouter":
      return {
        name,
        baseURL: "https://openrouter.ai/api/v1",
        apiKey: cfg.providers?.openrouter?.apiKey ?? process.env["OPENROUTER_API_KEY"] ?? null,
        defaultModel: cfg.providers?.openrouter?.defaultModel ?? process.env["OPENROUTER_DEFAULT_MODEL"] ?? null,
      };
    case "ollama":
      return {
        name,
        baseURL: cfg.providers?.ollama?.baseURL ?? process.env["OLLAMA_BASE_URL"] ?? "http://localhost:11434/v1",
        apiKey: process.env["OLLAMA_API_KEY"] ?? "ollama", // ollama ignores the key but SDK wants one
        defaultModel: cfg.providers?.ollama?.defaultModel ?? process.env["OLLAMA_DEFAULT_MODEL"] ?? null,
      };
    case "zai":
      return {
        name,
        baseURL: "https://api.z.ai/api/coding/paas/v4",
        apiKey: cfg.providers?.zai?.apiKey ?? process.env["ZAI_API_KEY"] ?? null,
        defaultModel: cfg.providers?.zai?.defaultModel ?? process.env["ZAI_DEFAULT_MODEL"] ?? null,
      };
  }
}

/**
 * Resolve an agent's model tier (or explicit prefixed id) to a concrete
 * (provider, model). Resolution order:
 *   1. Explicit prefix ("ollama:llama3.2:1b", "zai:glm-4.6") → that provider.
 *   2. Named tier ("frontier"/"mid"/"cheap"/"inherit") → operator tier map.
 *   3. Bare model id → OpenRouter (the cloud router handles most models).
 *   4. Fallback → first provider with a configured defaultModel + apiKey.
 */
export function resolveModel(tier: string): ModelResolution {
  // 1. Explicit prefix
  if (tier.startsWith("ollama:")) {
    return { provider: "ollama", model: tier.slice("ollama:".length) };
  }
  if (tier.startsWith("zai:")) {
    return { provider: "zai", model: tier.slice("zai:".length) };
  }
  if (tier.startsWith("openrouter:")) {
    return { provider: "openrouter", model: tier.slice("openrouter:".length) };
  }

  // 2. Named tier → operator override
  const tierOverride = cfg.tiers?.[tier];
  if (tierOverride) return resolveModel(tierOverride);

  // "inherit" with no override → fall through to default selection
  // 3 & 4. Provider defaults in priority order
  const order: ProviderName[] = ["openrouter", "zai", "ollama"];
  for (const name of order) {
    const p = getProvider(name);
    if (p.defaultModel && (p.apiKey || name === "ollama")) {
      return { provider: name, model: p.defaultModel };
    }
  }

  throw new Error(
    `Could not resolve model tier '${tier}'. Configure a provider in ~/.sophron/config.json or .env.`,
  );
}
