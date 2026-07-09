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
  defaultModel: string | null;
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
  defaultModel?: string;
  /** Mark this as the default instance for its kind (prefix shortcuts target it). */
  default?: boolean;
}

interface OperatorConfig {
  providers?: RawProviderEntry[] | Record<string, Omit<RawProviderEntry, "name" | "kind">>;
  /** Tier → concrete model id overrides (e.g. { frontier: "anthropic/claude-sonnet-4" }). */
  tiers?: Record<string, string>;
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

/** Built-in zero-config defaults (one instance per known kind). */
function builtinDefaults(): ProviderConfig[] {
  return [
    {
      name: "openrouter",
      kind: "openrouter",
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: process.env["OPENROUTER_API_KEY"] ?? null,
      defaultModel: process.env["OPENROUTER_DEFAULT_MODEL"] ?? null,
    },
    {
      name: "zai",
      kind: "zai",
      baseURL: "https://api.z.ai/api/coding/paas/v4",
      apiKey: process.env["ZAI_API_KEY"] ?? null,
      defaultModel: process.env["ZAI_DEFAULT_MODEL"] ?? null,
    },
    {
      name: "ollama",
      kind: "ollama",
      baseURL: process.env["OLLAMA_BASE_URL"] ?? "http://localhost:11434/v1",
      // ollama ignores the key but the OpenAI SDK wants one.
      apiKey: process.env["OLLAMA_API_KEY"] ?? "ollama",
      defaultModel: process.env["OLLAMA_DEFAULT_MODEL"] ?? null,
    },
  ];
}

/**
 * Apply sensible defaults for a kind when the config entry omits them.
 * - openrouter: baseURL + env apiKey.
 * - ollama: localhost baseURL, dummy apiKey, env defaultModel.
 * - zai: fixed baseURL + env apiKey.
 * - openai-compat: no defaults — baseURL + apiKey must come from the entry.
 *
 * Accepts a partial entry (name is added by the caller) so it works for both
 * the array form and the legacy-object migration.
 */
function applyKindDefaults(entry: Omit<RawProviderEntry, "name"> & { name?: string }): Omit<ProviderConfig, "name"> {
  const kind = (entry.kind ?? "openai-compat") as ProviderKind;
  switch (kind) {
    case "openrouter":
      return {
        kind,
        baseURL: entry.baseURL ? expandEnv(entry.baseURL) : "https://openrouter.ai/api/v1",
        apiKey: entry.apiKey != null ? expandEnv(entry.apiKey) : (process.env["OPENROUTER_API_KEY"] ?? null),
        defaultModel: entry.defaultModel ? expandEnv(entry.defaultModel) : (process.env["OPENROUTER_DEFAULT_MODEL"] ?? null),
      };
    case "ollama":
      return {
        kind,
        baseURL: entry.baseURL ? expandEnv(entry.baseURL) : (process.env["OLLAMA_BASE_URL"] ?? "http://localhost:11434/v1"),
        apiKey: entry.apiKey != null ? expandEnv(entry.apiKey) : (process.env["OLLAMA_API_KEY"] ?? "ollama"),
        defaultModel: entry.defaultModel ? expandEnv(entry.defaultModel) : (process.env["OLLAMA_DEFAULT_MODEL"] ?? null),
      };
    case "zai":
      return {
        kind,
        baseURL: entry.baseURL ? expandEnv(entry.baseURL) : "https://api.z.ai/api/coding/paas/v4",
        apiKey: entry.apiKey != null ? expandEnv(entry.apiKey) : (process.env["ZAI_API_KEY"] ?? null),
        defaultModel: entry.defaultModel ? expandEnv(entry.defaultModel) : (process.env["ZAI_DEFAULT_MODEL"] ?? null),
      };
    case "openai-compat":
    default:
      return {
        kind: "openai-compat",
        baseURL: expandEnv(entry.baseURL ?? ""),
        apiKey: entry.apiKey != null ? expandEnv(entry.apiKey) : null,
        defaultModel: entry.defaultModel ? expandEnv(entry.defaultModel) : null,
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
 *   - missing/empty → built-in zero-config defaults.
 * Duplicate instance names: last wins (logged).
 */
function loadInstances(): ProviderConfig[] {
  const raw = loadRawConfig();

  // No providers configured → built-in defaults (zero-config).
  if (!raw.providers) {
    return builtinDefaults();
  }

  // Legacy object form: { ollama: {...}, openrouter: {...} }.
  if (!Array.isArray(raw.providers)) {
    log.warn("config.providers is an object (legacy form); migrating to named instances. Switch to an array in ~/.sophron/config.json.");
    const entries: ProviderConfig[] = [];
    for (const [kind, fields] of Object.entries(raw.providers)) {
      const defaults = applyKindDefaults({ kind, ...(fields as object) });
      entries.push({ name: kind, ...defaults });
    }
    // Merge with built-in defaults so unlisted kinds still resolve.
    return mergeWithDefaults(entries);
  }

  // Array form: normalize each entry, then merge with built-in defaults so the
  // prefix shortcuts (ollama:, zai:, openrouter:) always resolve.
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
  return mergeWithDefaults(configured);
}

/**
 * Merge configured instances with built-in defaults. A configured instance
 * whose name matches a built-in default (e.g. "ollama") overrides it. Built-in
 * defaults fill in any kind that isn't represented, so prefix shortcuts always
 * have a target.
 */
function mergeWithDefaults(configured: ProviderConfig[]): ProviderConfig[] {
  const byName = new Map<string, ProviderConfig>();
  // Built-ins first (lower priority).
  for (const d of builtinDefaults()) byName.set(d.name, d);
  // Configured overrides.
  for (const c of configured) byName.set(c.name, c);
  return [...byName.values()];
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
let _byKind: Map<ProviderKind, ProviderConfig[]> | undefined;

function instances(): ProviderConfig[] {
  if (!_instances) buildRegistry();
  return _instances!;
}
function byNameMap(): Map<string, ProviderConfig> {
  if (!_byName) buildRegistry();
  return _byName!;
}
function byKindMap(): Map<ProviderKind, ProviderConfig[]> {
  if (!_byKind) buildRegistry();
  return _byKind!;
}

function buildRegistry(): void {
  const list = loadInstances();
  _instances = list;
  _byName = new Map(list.map((p) => [p.name, p]));
  _byKind = groupByKind(list);
}

/** Group instances by kind, preserving config order. */
function groupByKind(insts: ProviderConfig[]): Map<ProviderKind, ProviderConfig[]> {
  const m = new Map<ProviderKind, ProviderConfig[]>();
  for (const p of insts) {
    const arr = m.get(p.kind) ?? [];
    arr.push(p);
    m.set(p.kind, arr);
  }
  return m;
}

/**
 * Force the registry to rebuild on next access. Used by tests that change env
 * vars or config between cases. In production, config is static per process.
 */
export function _resetProviderCacheForTests(): void {
  _instances = undefined;
  _byName = undefined;
  _byKind = undefined;
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
 * The default instance of a given kind. Resolution:
 *   1. An instance explicitly marked `default: true` for that kind.
 *   2. An instance whose name equals the kind (the built-in singletons).
 *   3. The first instance of that kind in config order.
 * Returns undefined if no instance of that kind exists.
 */
export function defaultForKind(kind: ProviderKind): ProviderConfig | undefined {
  const arr = byKindMap().get(kind);
  if (!arr || arr.length === 0) return undefined;
  const marked = arr.find((p) => (p as RawProviderEntry & ProviderConfig).default === true);
  if (marked) return marked;
  const named = arr.find((p) => p.name === kind);
  if (named) return named;
  return arr[0];
}

/**
 * Resolve an agent's model tier (or explicit prefixed id / named provider) to
 * a concrete (instance, model). Resolution order:
 *   1. Explicit prefix ("ollama:llama3.2:1b", "zai:glm-4.6", "openrouter:x")
 *      → default instance of that kind.
 *   2. Named tier ("frontier"/"mid"/"cheap"/"inherit") → operator tier map.
 *   3. Bare model id → OpenRouter (the cloud router handles most models).
 *   4. Fallback → first instance with a configured defaultModel + valid creds.
 *
 * Note: when an agent sets an explicit `provider:` in frontmatter, the LOADER
 * resolves the instance directly and passes it through; this function is only
 * called to resolve the *model id* (the tier/prefix logic). See loader.ts.
 */
export function resolveModel(tier: string): ModelResolution {
  // 1. Explicit prefix → default instance of that kind.
  for (const kind of ["ollama", "zai", "openrouter"] as const) {
    const prefix = `${kind}:`;
    if (tier.startsWith(prefix)) {
      const inst = defaultForKind(kind);
      if (!inst) {
        throw new Error(`No '${kind}' provider instance is configured (model prefix '${tier}').`);
      }
      return { provider: inst.name, model: tier.slice(prefix.length) };
    }
  }

  // 2. Named tier → operator override.
  const cfg = loadRawConfig();
  const tierOverride = cfg.tiers?.[tier];
  if (tierOverride) return resolveModel(tierOverride);

  // "inherit" with no override → fall through to default selection.

  // 3 & 4. Provider defaults in priority order (openrouter, zai, ollama, then
  // any configured instance with a defaultModel).
  const order: ProviderKind[] = ["openrouter", "zai", "ollama"];
  for (const kind of order) {
    const inst = defaultForKind(kind);
    if (inst?.defaultModel && (inst.apiKey || inst.kind === "ollama")) {
      return { provider: inst.name, model: inst.defaultModel };
    }
  }
  // Any other instance (e.g. openai-compat) with a default model.
  for (const inst of instances()) {
    if (inst.defaultModel && (inst.apiKey || inst.kind === "ollama")) {
      return { provider: inst.name, model: inst.defaultModel };
    }
  }

  throw new Error(
    `Could not resolve model tier '${tier}'. Configure a provider in ~/.sophron/config.json or set an env default (e.g. OLLAMA_DEFAULT_MODEL).`,
  );
}

/**
 * Resolve a (model, optional explicit provider name) pair. When the caller
 * supplies an explicit provider name (from agent frontmatter), trust it and
 * only validate it exists. Otherwise resolve via resolveModel().
 */
export function resolveModelWithProvider(model: string, provider?: ProviderName): ModelResolution {
  if (provider) {
    // Validate the named instance exists; throw a clear error if not.
    getProvider(provider);
    return { provider, model };
  }
  return resolveModel(model);
}

/**
 * Resolve a free-form model specification from an operator command (`/model`,
 * `--model`) to a concrete (provider, model) pair.
 *
 * Resolution order:
 *   1. If the spec contains a colon and the part before the first colon matches
 *      a configured provider *instance* name, use that provider and treat the
 *      rest as the model id. This lets operators target named instances like
 *      `my-ollama:qwen3.5:9b`.
 *   2. Otherwise fall back to `resolveModel()`, which handles named tiers
 *      (`frontier`/`mid`/`cheap`/`inherit`), kind prefixes (`ollama:...`,
 *      `zai:...`, `openrouter:...`), bare model ids, and tier overrides.
 *
 * @throws if the provider instance is unknown or no provider can resolve the
 *         tier/model.
 */
export function resolveModelSpec(spec: string): ModelResolution {
  const colonIdx = spec.indexOf(":");
  if (colonIdx > 0) {
    const maybeProvider = spec.slice(0, colonIdx);
    if (byNameMap().has(maybeProvider)) {
      return { provider: maybeProvider, model: spec.slice(colonIdx + 1) };
    }
  }
  return resolveModel(spec);
}

// ── Mutators (sophron add-provider / remove-provider) ───────────────────────

/** A provider entry as the operator supplies it to `add-provider`. */
export interface AddProviderInput {
  name: string;
  kind: ProviderKind;
  baseURL?: string;
  apiKey?: string;
  defaultModel?: string;
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
  if (input.defaultModel && input.defaultModel.trim()) entry.defaultModel = input.defaultModel.trim();
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
 * Never removes the built-in singletons (they always exist via mergeWithDefaults
 * when no config entry overrides them — removing the config entry just restores
 * the env-backed default).
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
  defaultModel?: string;
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
  if (patch.defaultModel !== undefined) {
    const v = patch.defaultModel.trim();
    if (v) entry.defaultModel = v;
    else delete entry.defaultModel;
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
 * Handles the built-in-singleton case: if the named instance exists in the
 * resolved list (e.g. the env-backed "openrouter") but has NO config.json
 * entry, a new entry is created from its current resolved state + the patch.
 *
 * @returns the resulting raw entry (post-patch, exactly what's on disk).
 * @throws if the name doesn't match any provider (config or built-in).
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

  if (idx >= 0) {
    // ── Existing config entry: merge the patch (partial update) ──
    const updated: RawProviderEntry = { ...arr[idx]! };
    applyPatchToEntry(updated, patch);
    arr[idx] = updated;
  } else {
    // ── No config entry: must be a built-in singleton (or unknown) ──
    // Resolve the current state so we can persist a concrete config entry.
    _resetProviderCacheForTests();
    let resolved: ProviderConfig;
    try {
      resolved = getProvider(name);
    } catch {
      throw new Error(`No provider instance named '${name}'. Use 'sophron add-provider' to create one, or 'sophron providers' to list configured instances.`);
    }
    // Seed a new entry from the resolved (env-expanded) state, then apply patch.
    const entry: RawProviderEntry = { name, kind: resolved.kind };
    if (resolved.baseURL) entry.baseURL = resolved.baseURL;
    if (resolved.apiKey) entry.apiKey = resolved.apiKey;
    if (resolved.defaultModel) entry.defaultModel = resolved.defaultModel;
    applyPatchToEntry(entry, patch);
    arr.push(entry);
  }

  cfg.providers = arr;
  writeRawConfig(cfg);
  return arr.find((e) => e.name === name)!;
}
