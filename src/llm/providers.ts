/**
 * Provider configuration — named provider instances.
 *
 * Supports multiple endpoints per kind (e.g. two Ollama machines, several
 * OpenRouter accounts) plus generic OpenAI-compatible endpoints (vLLM, LM
 * Studio, LocalAI). All are OpenAI-compatible, so a single client
 * (src/llm/client.ts) covers them.
 *
 * ## Concepts
 * - **ProviderKind** — the *type* of endpoint: "openrouter" | "ollama" | "zai"
 *   | "openai-compat". Determines defaults (e.g. ollama ignores apiKey, z.ai
 *   has a fixed baseURL).
 * - **ProviderName** — a free-form *instance* name (string): "ollama-laptop",
 *   "ollama-desktop", "or-cloud". An operator-defined label for a concrete
 *   endpoint.
 *
 * ## Config (`~/.sophron/config.json`)
 * `providers` is an **array of named instances**:
 * ```json
 * {
 *   "providers": [
 *     { "name": "ollama-laptop",  "kind": "ollama",     "baseURL": "http://laptop:11434/v1",  "defaultModel": "qwen3.5:9b" },
 *     { "name": "ollama-desktop", "kind": "ollama",     "baseURL": "http://desktop:11434/v1", "defaultModel": "llama3.1:8b" },
 *     { "name": "or-cloud",       "kind": "openrouter", "apiKey": "${OPENROUTER_API_KEY}",   "defaultModel": "anthropic/claude-sonnet-4" }
 *   ]
 * }
 * ```
 *
 * `${VAR}` in any string value is substituted from `process.env`.
 *
 * ## Backward compatibility
 * - **Zero-config defaults:** when no providers are configured, three built-in
 *   singletons are created (named "ollama"/"openrouter"/"zai"), reading from
 *   env (OLLAMA_BASE_URL, OPENROUTER_API_KEY, …) exactly as before.
 * - **Legacy object config:** if `providers` is an object keyed by kind
 *   (`{ ollama: {...} }`), it's auto-migrated to instances named after each
 *   kind, with a deprecation warning.
 * - **Prefix shortcuts** (`ollama:foo`, `zai:bar`) resolve to the *default*
 *   instance of that kind.
 *
 * See docs/IDEAS.md (#1) + docs/ROADMAP.md (M2).
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "../util/log.js";

// ── Types ───────────────────────────────────────────────────────────────────

/** The type of endpoint. Determines defaults + how credentials are used. */
export type ProviderKind = "openrouter" | "ollama" | "zai" | "openai-compat";

/**
 * A provider *instance* name. Free-form string chosen by the operator
 * (e.g. "ollama-laptop"). The built-in singletons are named exactly
 * "ollama" / "openrouter" / "zai" for backward compatibility.
 */
export type ProviderName = string;

export interface ProviderConfig {
  /** Instance name (operator-chosen; unique within the config). */
  name: ProviderName;
  /** Endpoint type. */
  kind: ProviderKind;
  baseURL: string;
  apiKey: string | null;
  /** Human-readable description of this provider (for the operator + architect). */
  description: string | null;
}

export interface ModelResolution {
  /** Instance name serving `model`. */
  provider: ProviderName;
  model: string;
}

// ── Config schema ───────────────────────────────────────────────────────────

/** A provider instance as written in config.json (before env expansion). */
export interface RawProviderEntry {
  name: string;
  kind?: string; // optional for legacy/migration; inferred if missing
  baseURL?: string;
  apiKey?: string;
  /** Human-readable description of what this provider is / what it's good for. */
  description?: string;
  /** Mark this as the default instance for its kind. */
  default?: boolean;
}

interface OperatorConfig {
  providers?: RawProviderEntry[] | Record<string, Omit<RawProviderEntry, "name" | "kind">>;
}

// ── Env-var expansion ───────────────────────────────────────────────────────

/**
 * Expand `${VAR}` references in a string from process.env. Unknown vars expand
 * to empty string (so a missing API key becomes "" rather than a literal
 * "${OPENROUTER_API_KEY}" failure). Only the `${NAME}` form is supported (not
 * `$NAME`) to avoid accidentally expanding legitimate `$` characters.
 */
export function expandEnv(value: string): string {
  return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/gi, (_match, name: string) => process.env[name] ?? "");
}

// ── Config loading + migration ──────────────────────────────────────────────

/**
 * Apply sensible defaults for a kind when the config entry omits them.
 * - openrouter: baseURL.
 * - ollama: localhost baseURL, dummy apiKey.
 * - zai: fixed baseURL.
 * - openai-compat: no defaults — baseURL + apiKey must come from the entry.
 *
 * NOTE: V3.1.0 removed `defaultModel` env fallbacks and built-in zero-config
 * defaults. Every agent must declare a concrete `model:` + `provider:`.
 *
 * Accepts a partial entry (name is added by the caller) so it works for both
 * the array form and the legacy-object migration.
 */
function applyKindDefaults(entry: Omit<RawProviderEntry, "name"> & { name?: string }): Omit<ProviderConfig, "name"> {
  const kind = (entry.kind ?? "openai-compat") as ProviderKind;
  const description = entry.description ? expandEnv(entry.description) : null;
  switch (kind) {
    case "openrouter":
      return {
        kind,
        baseURL: entry.baseURL ? expandEnv(entry.baseURL) : "https://openrouter.ai/api/v1",
        apiKey: entry.apiKey != null ? expandEnv(entry.apiKey) : null,
        description,
      };
    case "ollama":
      return {
        kind,
        baseURL: entry.baseURL ? expandEnv(entry.baseURL) : "http://localhost:11434/v1",
        apiKey: entry.apiKey != null ? expandEnv(entry.apiKey) : "ollama",
        description,
      };
    case "zai":
      return {
        kind,
        baseURL: entry.baseURL ? expandEnv(entry.baseURL) : "https://api.z.ai/api/coding/paas/v4",
        apiKey: entry.apiKey != null ? expandEnv(entry.apiKey) : null,
        description,
      };
    case "openai-compat":
    default:
      return {
        kind: "openai-compat",
        baseURL: expandEnv(entry.baseURL ?? ""),
        apiKey: entry.apiKey != null ? expandEnv(entry.apiKey) : null,
        description,
      };
  }
}

/** Raw config loaded from disk — cached after first read (env can change). */
let cachedRaw: OperatorConfig | undefined;

/** Where the operator config lives on disk (`~/.sophron/config.json`). */
export function configPath(): string {
  return join(homedir(), ".sophron", "config.json");
}

/**
 * Read the raw config from disk WITHOUT touching the cache (used by the
 * `sophron add-provider` / `remove-provider` read-modify-write flow so we
 * always see the latest on-disk state, not a stale snapshot).
 */
function readRawConfigFresh(): OperatorConfig {
  const path = configPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as OperatorConfig;
  } catch (e) {
    log.warn({ err: e, path }, "could not parse operator config; ignoring");
    return {};
  }
}

function loadRawConfig(): OperatorConfig {
  if (cachedRaw) return cachedRaw;
  cachedRaw = readRawConfigFresh();
  return cachedRaw;
}

/** Write the config to disk (atomic via tmp+rename) + reset the read cache. */
function writeRawConfig(cfg: OperatorConfig): void {
  const path = configPath();
  mkdirSync(join(homedir(), ".sophron"), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), "utf8");
  renameSync(tmp, path);
  // Reset the lazy cache so the running process sees the new config.
  _resetProviderCacheForTests();
}

/**
 * Load + normalize the operator config into a list of named instances.
 * Migration rules:
 *   - `providers: [...]`  → array form (preferred).
 *   - `providers: {kind: {...}}` → legacy object form → migrated to instances
 *     named after each kind, with a deprecation warning.
 *   - missing/empty → returns `[]` (no built-in defaults in V3.1.0).
 * Duplicate instance names: last wins (logged).
 */
function loadInstances(): ProviderConfig[] {
  const raw = loadRawConfig();

  // No providers configured → empty list (V3.1.0: no built-in defaults).
  if (!raw.providers) {
    return [];
  }

  // Legacy object form: { ollama: {...}, openrouter: {...} }.
  if (!Array.isArray(raw.providers)) {
    log.warn("config.providers is an object (legacy form); migrating to named instances. Switch to an array in ~/.sophron/config.json.");
    const entries: ProviderConfig[] = [];
    for (const [kind, fields] of Object.entries(raw.providers)) {
      const defaults = applyKindDefaults({ kind, ...(fields as object) });
      entries.push({ name: kind, ...defaults });
    }
    return entries;
  }

  // Array form: normalize each entry.
  const configured: ProviderConfig[] = [];
  const seen = new Set<string>();
  for (const entry of raw.providers) {
    if (!entry.name || typeof entry.name !== "string") {
      log.warn({ entry }, "config.providers entry missing 'name'; skipping");
      continue;
    }
    const defaults = applyKindDefaults(entry);
    if (seen.has(entry.name)) {
      log.warn({ name: entry.name }, "duplicate provider instance name; last entry wins");
    }
    seen.add(entry.name);
    configured.push({ name: entry.name, ...defaults });
  }
  return configured;
}

// ── Instance registry (lazy — reads env at first access) ────────────────────

/**
 * The instance registry is built lazily on first access (NOT at module load),
 * so environment variables set by callers after importing the module (e.g. test
 * setup) are honored. This matches the legacy behavior where getProvider()
 * read process.env at call time.
 */
let _instances: ProviderConfig[] | undefined;
let _byName: Map<string, ProviderConfig> | undefined;

function instances(): ProviderConfig[] {
  if (!_instances) buildRegistry();
  return _instances!;
}
function byNameMap(): Map<string, ProviderConfig> {
  if (!_byName) buildRegistry();
  return _byName!;
}

function buildRegistry(): void {
  const list = loadInstances();
  _instances = list;
  _byName = new Map(list.map((p) => [p.name, p]));
}

/**
 * Force the registry to rebuild on next access. Used by tests that change env
 * vars or config between cases. In production, config is static per process.
 */
export function _resetProviderCacheForTests(): void {
  _instances = undefined;
  _byName = undefined;
  cachedRaw = undefined;
}

// ── Public API ──────────────────────────────────────────────────────────────

/** All configured provider instances (for the `sophron providers` listing). */
export function listProviders(): ProviderConfig[] {
  return [...instances()];
}

/** Look up a provider instance by name. Throws if unknown. */
export function getProvider(name: ProviderName): ProviderConfig {
  const map = byNameMap();
  const p = map.get(name);
  if (!p) {
    const available = [...map.keys()].join(", ") || "(none)";
    throw new Error(`Unknown provider instance '${name}'. Configured: ${available}`);
  }
  return p;
}

/**
 * Resolve an agent's model + provider to a validated (instance, model) pair.
 *
 * V3.1.0: BOTH arguments are required. There are no tiers, no `inherit`, no
 * prefix shortcuts, and no fallback chain — `model` is always a concrete model
 * id, and `provider` must be a configured instance name.
 *
 * @throws if the provider instance is not configured.
 */
export function resolveModel(model: string, provider: ProviderName): ModelResolution {
  // 1. Validate the provider exists (throws a clear error if not).
  const inst = getProvider(provider);
  // 2. Return the model as-is (always a concrete id — no tier indirection).
  return { provider: inst.name, model };
}

// ── Mutators (sophron add-provider / remove-provider) ───────────────────────

/** A provider entry as the operator supplies it to `add-provider`. */
export interface AddProviderInput {
  name: string;
  kind: ProviderKind;
  baseURL?: string;
  apiKey?: string;
  /** Human-readable description of this provider. */
  description?: string;
  /** Mark as the default instance for its kind (prefix shortcuts target it). */
  default?: boolean;
}

/**
 * Add a named provider instance to `~/.sophron/config.json` (read-modify-write).
 * Creates the file/array if absent. Migrates the legacy object form to the
 * array form. Refuses a duplicate instance name (use removeProviderInstance
 * first, or set `replace` to overwrite).
 *
 * Empty string fields are dropped (so the stored entry omits them and the
 * kind defaults apply). Returns the stored entry (post kind-defaults, pre
 * env-expansion — exactly what's on disk).
 *
 * @throws if the name is invalid or already exists (and `replace` is false).
 */
export function addProviderInstance(input: AddProviderInput, opts: { replace?: boolean } = {}): RawProviderEntry {
  const name = input.name.trim();
  if (!name) throw new Error("Provider 'name' is required.");
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) {
    throw new Error(`Provider name '${name}' is invalid. Use letters, digits, hyphens, or underscores (must start alphanumeric).`);
  }

  const cfg = readRawConfigFresh();

  // Build the entry to store. Drop empty fields so kind defaults apply at load.
  const entry: RawProviderEntry = { name, kind: input.kind };
  if (input.baseURL && input.baseURL.trim()) entry.baseURL = input.baseURL.trim();
  if (input.apiKey && input.apiKey.trim()) entry.apiKey = input.apiKey.trim();
  if (input.description && input.description.trim()) entry.description = input.description.trim();
  if (input.default) entry.default = true;

  // Normalize providers to the array form.
  let arr: RawProviderEntry[];
  if (!cfg.providers) {
    arr = [];
  } else if (Array.isArray(cfg.providers)) {
    arr = cfg.providers;
  } else {
    // Legacy object form → migrate to instances named after each kind.
    log.warn("config.providers is an object (legacy form); migrating to a named-instance array.");
    arr = Object.entries(cfg.providers).map(([kind, fields]) => ({ name: kind, kind, ...(fields as object) }));
  }

  const idx = arr.findIndex((e) => e.name === name);
  if (idx >= 0) {
    if (!opts.replace) {
      throw new Error(`A provider instance named '${name}' already exists. Use removeProviderInstance('${name}') first, or pass { replace: true }.`);
    }
    arr[idx] = entry;
  } else {
    arr.push(entry);
  }

  cfg.providers = arr;
  writeRawConfig(cfg);
  return entry;
}

/**
 * Remove a named provider instance from `~/.sophron/config.json`.
 * Returns true if an entry was removed, false if it wasn't found.
 */
export function removeProviderInstance(name: string): boolean {
  const cfg = readRawConfigFresh();
  if (!cfg.providers || !Array.isArray(cfg.providers)) return false;
  const before = cfg.providers.length;
  const filtered = cfg.providers.filter((e) => e.name !== name);
  if (filtered.length === before) return false;
  cfg.providers = filtered;
  writeRawConfig(cfg);
  return true;
}

// ── Edit (partial update) ───────────────────────────────────────────────────

/**
 * A partial update to an existing provider instance. Each field is optional:
 *   - `undefined` (field absent) → keep the current value untouched.
 *   - a non-empty string → set the field to this value.
 *   - an empty string `""` → CLEAR the field (remove it).
 *   - (`default`) `true`/`false` → set/clear the default-for-kind flag.
 *
 * Note: `kind` cannot be changed via a patch (changing kind = a fundamentally
 * different provider; remove + re-add instead). `name` is the lookup key.
 */
export interface ProviderPatch {
  baseURL?: string;
  apiKey?: string;
  description?: string;
  default?: boolean;
}

/**
 * Read the RAW (unexpanded) provider entry from config.json by name. Returns
 * `undefined` if no config entry exists for this name — which includes the
 * built-in singletons ("ollama"/"openrouter"/"zai") when they exist only via
 * env-backed defaults. Useful for pre-filling edit prompts with the exact
 * on-disk values (including `${ENV_VAR}` references, pre-expansion).
 */
export function getRawProviderEntry(name: string): RawProviderEntry | undefined {
  const cfg = readRawConfigFresh();
  if (!cfg.providers || !Array.isArray(cfg.providers)) return undefined;
  return cfg.providers.find((e) => e.name === name);
}

/** Apply a patch to a raw entry in place. See ProviderPatch semantics. */
function applyPatchToEntry(entry: RawProviderEntry, patch: ProviderPatch): void {
  if (patch.baseURL !== undefined) {
    const v = patch.baseURL.trim();
    if (v) entry.baseURL = v;
    else delete entry.baseURL;
  }
  if (patch.apiKey !== undefined) {
    const v = patch.apiKey.trim();
    if (v) entry.apiKey = v;
    else delete entry.apiKey;
  }
  if (patch.description !== undefined) {
    const v = patch.description.trim();
    if (v) entry.description = v;
    else delete entry.description;
  }
  if (patch.default !== undefined) {
    if (patch.default) entry.default = true;
    else delete entry.default;
  }
}

/**
 * Partially update an existing provider instance in `~/.sophron/config.json`.
 * Only the fields present in `patch` are touched; all others keep their current
 * value. This is the "edit" counterpart to addProviderInstance — no need to
 * remove + re-add just to set an API key.
 *
 * @returns the resulting raw entry (post-patch, exactly what's on disk).
 * @throws if the name doesn't match any configured provider.
 */
export function updateProviderInstance(name: string, patch: ProviderPatch): RawProviderEntry {
  if (!name.trim()) throw new Error("Provider 'name' is required.");
  const cfg = readRawConfigFresh();

  // Normalize providers to the array form (same as addProviderInstance).
  let arr: RawProviderEntry[];
  if (!cfg.providers) {
    arr = [];
  } else if (Array.isArray(cfg.providers)) {
    arr = cfg.providers;
  } else {
    log.warn("config.providers is an object (legacy form); migrating to a named-instance array.");
    arr = Object.entries(cfg.providers).map(([kind, fields]) => ({ name: kind, kind, ...(fields as object) }));
  }

  const idx = arr.findIndex((e) => e.name === name);

  if (idx < 0) {
    throw new Error(
      `No provider instance named '${name}'. Use 'sophron providers add' to create one, or 'sophron providers' to list configured instances.`,
    );
  }

  // ── Existing config entry: merge the patch (partial update) ──
  const updated: RawProviderEntry = { ...arr[idx]! };
  applyPatchToEntry(updated, patch);
  arr[idx] = updated;

  cfg.providers = arr;
  writeRawConfig(cfg);
  return arr.find((e) => e.name === name)!;
}
