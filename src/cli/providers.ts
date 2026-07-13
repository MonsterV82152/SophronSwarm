/**
 * `sophron providers <subcommand>` implementation (V3.1.0-M5).
 *
 * Consolidates the old top-level `add-provider`, `edit-provider`, and
 * `remove-provider` commands under a single `providers` namespace.
 */
import { Command } from "commander";
import chalk from "chalk";
import { LLMClient } from "../llm/client.js";
import {
  listProviders,
  getProvider,
  addProviderInstance,
  removeProviderInstance,
  updateProviderInstance,
  getRawProviderEntry,
  configPath,
  type ProviderKind,
} from "../llm/providers.js";
import { prompt, promptSelect, promptConfirm, promptSecret } from "../util/prompts.js";

/** Mask an API key for display: show only the last 4 chars (or ${ENV} refs verbatim). */
function maskKey(key: string): string {
  if (key.startsWith("${")) return key;
  if (key.length <= 4) return "****";
  return `****${key.slice(-4)}`;
}

const KINDS = ["openrouter", "ollama", "zai", "openai-compat"] as const;

const kindLabels: Record<string, string> = {
  openrouter: "OpenRouter (cloud router for many models)",
  ollama: "Ollama (local, no API key needed)",
  zai: "z.ai (GLM models)",
  "openai-compat": "Generic OpenAI-compatible (vLLM, LM Studio, LocalAI, …)",
};

const kindDefaultUrl: Record<(typeof KINDS)[number], string | undefined> = {
  openrouter: "https://openrouter.ai/api/v1",
  ollama: "http://localhost:11434/v1",
  zai: "https://api.z.ai/api/coding/paas/v4",
  "openai-compat": undefined,
};

export interface AddProviderOpts {
  name?: string;
  kind?: string;
  baseUrl?: string;
  apiKey?: string;
  description?: string;
  default?: boolean;
  replace?: boolean;
}

export interface EditProviderOpts {
  baseUrl?: string;
  apiKey?: string;
  description?: string;
  default?: boolean;
  noDefault?: boolean;
  clearKey?: boolean;
  clearDescription?: boolean;
}

/** List all configured provider instances. */
export function renderProvidersList(): void {
  const providers = listProviders();
  if (providers.length === 0) {
    console.log(
      chalk.gray(
        "No providers configured. Add one with 'sophron providers add' or edit ~/.sophron/config.json.",
      ),
    );
    return;
  }

  for (const p of providers) {
    const creds = p.apiKey ? chalk.green("✓ key") : chalk.gray("no key");
    const desc = p.description ? chalk.gray(`  ${p.description}`) : "";
    console.log(`${chalk.bold(p.name)}  ${chalk.cyan(p.kind)}  ${chalk.gray(p.baseURL)}  ${creds}${desc}`);
  }
  console.log(chalk.gray(`\n${providers.length} instance(s). View one with: sophron providers view <name>`));
}

/** Add a provider instance (interactive or flag-driven). */
export async function handleProvidersAdd(opts: AddProviderOpts): Promise<void> {
  // Non-interactive when both essentials are given via flags OR stdin isn't a TTY.
  const nonInteractive = Boolean(opts.name && opts.kind) || !process.stdin.isTTY;

  const name = opts.name ?? (nonInteractive ? "" : await prompt("Provider instance name", { required: true }));
  if (!name) {
    console.error(chalk.red("--name is required (or run interactively without flags)."));
    process.exitCode = 1;
    return;
  }

  let kind: ProviderKind;
  if (opts.kind) {
    if (!KINDS.includes(opts.kind as (typeof KINDS)[number])) {
      console.error(chalk.red(`Invalid --kind '${opts.kind}'. Choose from: ${KINDS.join(", ")}`));
      process.exitCode = 1;
      return;
    }
    kind = opts.kind as ProviderKind;
  } else if (nonInteractive) {
    kind = "ollama";
  } else {
    kind = await promptSelect("Endpoint type (kind)", KINDS, { default: "ollama", labels: kindLabels });
  }

  if (nonInteractive && kind === "openai-compat" && !opts.baseUrl) {
    console.error(chalk.red("--base-url is required for kind 'openai-compat'."));
    process.exitCode = 1;
    return;
  }

  const baseURL =
    opts.baseUrl ??
    (nonInteractive
      ? kindDefaultUrl[kind]
      : await prompt("Base URL", { default: kindDefaultUrl[kind], required: kind === "openai-compat" }));

  let apiKey: string | undefined = opts.apiKey;
  if (apiKey === undefined && kind !== "ollama") {
    if (!nonInteractive) {
      console.log(
        chalk.gray(
          "  Tip: enter a ${ENV_VAR} reference (e.g. ${OPENROUTER_API_KEY}) to keep the secret out of the config file; it's expanded at load time.",
        ),
      );
      const k = await promptSecret("API key (or ${ENV_VAR} reference)");
      apiKey = k ?? undefined;
    }
  }

  const description =
    opts.description ??
    (nonInteractive ? undefined : (await prompt("Description (optional — what this provider is / what it's good for)")) || undefined);

  const markDefault = opts.default ?? (nonInteractive ? false : await promptConfirm("Mark as the default instance for this kind?", false));

  try {
    const stored = addProviderInstance(
      { name, kind, baseURL: baseURL || undefined, apiKey, description, default: markDefault },
      { replace: opts.replace },
    );
    console.log(chalk.green(`✓ Added provider '${stored.name}' (${stored.kind}) → ${configPath()}`));
    const creds = apiKey ? chalk.green("key set") : chalk.gray("no key");
    console.log(
      chalk.gray(`  ${stored.baseURL ?? "(kind default)"}  ${creds}${stored.description ? "  " + stored.description : ""}`),
    );
    console.log(chalk.gray(`  Test it with: sophron providers view ${stored.name}`));
  } catch (e) {
    console.error(chalk.red(`Could not add provider: ${(e as Error).message}`));
    process.exitCode = 1;
  }
}

/** Remove a provider instance by name. */
export function handleProvidersRemove(name: string): void {
  const removed = removeProviderInstance(name);
  if (removed) {
    console.log(chalk.green(`✓ Removed provider '${name}' from ${configPath()}`));
  } else {
    console.error(chalk.yellow(`No provider instance named '${name}' in ${configPath()}.`));
    process.exitCode = 1;
  }
}

/** Edit an existing provider instance (interactive or flag-driven partial update). */
export async function handleProvidersEdit(name: string, opts: EditProviderOpts): Promise<void> {
  const raw = getRawProviderEntry(name);
  if (!raw) {
    console.error(chalk.red(`No provider instance named '${name}' in ${configPath()}.`));
    console.error(chalk.gray(`List configured instances with: sophron providers`));
    process.exitCode = 1;
    return;
  }

  const keyDisplay = raw.apiKey ? maskKey(raw.apiKey) : chalk.gray("(none)");
  console.log(chalk.bold(`Editing '${name}'`) + chalk.gray(`  [${raw.kind ?? "?"}]`));
  console.log(chalk.gray(`  base URL:    ${raw.baseURL ?? "(kind default)"}`));
  console.log(chalk.gray(`  api key:     ${keyDisplay}`));
  console.log(chalk.gray(`  description: ${raw.description ?? chalk.gray("(none)")}`));
  console.log();

  const hasFieldFlag = Boolean(
    opts.baseUrl !== undefined ||
      opts.apiKey !== undefined ||
      opts.description !== undefined ||
      opts.default !== undefined ||
      opts.noDefault ||
      opts.clearKey ||
      opts.clearDescription,
  );
  const nonInteractive = hasFieldFlag || !process.stdin.isTTY;

  const patch: { baseURL?: string; apiKey?: string; description?: string; default?: boolean } = {};

  if (nonInteractive) {
    if (opts.clearKey) patch.apiKey = "";
    else if (opts.apiKey !== undefined) patch.apiKey = opts.apiKey;
    if (opts.clearDescription) patch.description = "";
    else if (opts.description !== undefined) patch.description = opts.description;
    if (opts.baseUrl !== undefined) patch.baseURL = opts.baseUrl;
    if (opts.default === false || opts.noDefault) patch.default = false;
    else if (opts.default === true) patch.default = true;
  } else {
    const baseURL = await prompt("Base URL", { default: raw.baseURL ?? "" });
    if ((raw.baseURL ?? "") !== baseURL) patch.baseURL = baseURL;

    console.log(
      chalk.gray(
        "  Tip: enter a ${ENV_VAR} reference (e.g. ${OPENROUTER_API_KEY}) to keep the secret out of the file.",
      ),
    );
    const curKeyHint = raw.apiKey ? maskKey(raw.apiKey) : "(none)";
    const apiKeyAns = await promptSecret(`API key (current: ${curKeyHint}, Enter to keep)`, {
      default: undefined as unknown as string,
    });
    if (apiKeyAns !== null) patch.apiKey = apiKeyAns;

    const curDesc = raw.description ?? "";
    const descAns = await prompt("Description", { default: curDesc });
    if (curDesc !== descAns) patch.description = descAns;

    const curDefault = Boolean(raw.default);
    const wantDefault = await promptConfirm("Mark as the default instance for this kind?", curDefault);
    if (curDefault !== wantDefault) patch.default = wantDefault;
  }

  if (Object.keys(patch).length === 0) {
    console.log(chalk.gray("No changes."));
    return;
  }

  try {
    const stored = updateProviderInstance(name, patch);
    const changed = Object.keys(patch).join(", ");
    console.log(chalk.green(`✓ Updated provider '${stored.name}' (${changed}) → ${configPath()}`));
    const keyOut = stored.apiKey ? chalk.green("key set") : chalk.gray("no key");
    console.log(
      chalk.gray(`  ${stored.baseURL ?? "(kind default)"}  ${keyOut}${stored.description ? "  " + stored.description : ""}`),
    );
  } catch (e) {
    console.error(chalk.red(`Could not update provider: ${(e as Error).message}`));
    process.exitCode = 1;
  }
}

/** Show full provider details and run a connectivity test. */
export async function handleProvidersView(name: string): Promise<void> {
  let cfg;
  try {
    cfg = getProvider(name);
  } catch (e) {
    console.error(chalk.red((e as Error).message));
    process.exitCode = 1;
    return;
  }

  const raw = getRawProviderEntry(name);

  console.log(chalk.bold(cfg.name) + chalk.gray(`  [${cfg.kind}]`));
  console.log(chalk.gray(`  base URL:    ${cfg.baseURL}`));
  console.log(chalk.gray(`  api key:     ${cfg.apiKey ? maskKey(cfg.apiKey) : "(none)"}`));
  console.log(chalk.gray(`  description: ${cfg.description ?? "(none)"}`));
  console.log(chalk.gray(`  default:     ${raw?.default ? "yes" : "no"}`));
  console.log();

  process.stdout.write(chalk.gray(`Testing ${cfg.name} (${cfg.kind}) at ${cfg.baseURL} … `));
  const llm = new LLMClient();
  try {
    const start = Date.now();
    const models = await llm.listModels(cfg.name);
    const ms = Date.now() - start;
    console.log(chalk.green(`✓ reachable`) + chalk.gray(` (${ms}ms, ${models.length} model(s))`));
    if (models.length > 0) {
      const sample = models.slice(0, 5).map((m) => m.id).join(", ");
      console.log(chalk.gray(`  sample: ${sample}${models.length > 5 ? ", …" : ""}`));
    }
  } catch (e) {
    console.log(chalk.red(`✗ unreachable`) + chalk.gray(` — ${(e as Error).message}`));
    process.exitCode = 1;
  }
}

/** Register the `sophron providers` command tree on the given program. */
export function buildProvidersCommand(program: Command): Command {
  const providers = program
    .command("providers")
    .description("Manage configured LLM provider instances");

  providers.action(() => renderProvidersList());

  providers
    .command("add")
    .description("Add a named LLM provider instance (writes ~/.sophron/config.json)")
    .option("-n, --name <name>", "instance name (e.g. ollama-laptop)")
    .option("-k, --kind <kind>", "endpoint type: openrouter | ollama | zai | openai-compat")
    .option("--base-url <url>", "OpenAI-compatible base URL")
    .option("--api-key <key>", "API key (or a ${ENV_VAR} reference)")
    .option("--description <text>", "human-readable description of this provider")
    .option("--default", "mark this instance as the default for its kind")
    .option("--replace", "overwrite an existing instance with the same name")
    .action(async (opts: AddProviderOpts) => handleProvidersAdd(opts));

  providers
    .command("edit <name>")
    .description("Edit an existing provider instance (partial update)")
    .option("--base-url <url>", "new base URL")
    .option("--api-key <key>", "new API key (or a ${ENV_VAR} reference; use --clear-key to remove)")
    .option("--description <text>", "new description (use --clear-description to remove)")
    .option("--default", "mark this instance as the default for its kind")
    .option("--no-default", "remove the default-for-kind flag")
    .option("--clear-key", "remove the API key from this instance")
    .option("--clear-description", "remove the description from this instance")
    .action(async (name: string, opts: EditProviderOpts) => handleProvidersEdit(name, opts));

  providers
    .command("remove <name>")
    .description("Remove a named provider instance from ~/.sophron/config.json")
    .action((name: string) => handleProvidersRemove(name));

  providers
    .command("view <name>")
    .description("Show provider details and test connectivity (GET /v1/models)")
    .alias("test")
    .action(async (name: string) => handleProvidersView(name));

  return providers;
}
