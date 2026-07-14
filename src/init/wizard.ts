/**
 * First-run provider wizard for `sophron init` (V3.1.0-M5).
 *
 * When no providers are configured, the wizard interactively gathers the
 * connection details for one provider and a default model, then returns them
 * so the caller can rewrite the scaffolded agent frontmatter.
 */
import chalk from "chalk";
import { addProviderInstance, type ProviderKind } from "../llm/providers.js";
import { prompt, promptSelect, promptSecret } from "../util/prompts.js";

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

export interface WizardResult {
  /** The configured provider instance name. */
  provider: string;
  /** The concrete model id chosen for the project. */
  model: string;
}

/**
 * Run the first-run provider wizard.
 *
 * @throws if stdin is not a TTY (so unattended runs get a clear error).
 */
export async function runProviderWizard(): Promise<WizardResult> {
  if (!process.stdin.isTTY) {
    throw new Error(
      "No providers configured. Run `sophron providers add` first, or set SOPHRON_SKIP_PROVIDER_CHECK=1.",
    );
  }

  console.log(
    chalk.yellow("⚠ No providers configured. Agents need a provider + model to run."),
  );
  console.log(chalk.gray("  Let's set one up first.\n"));

  const name = await prompt("Provider instance name", { required: true });
  const kind = await promptSelect("Endpoint type (kind)", KINDS, {
    default: "ollama",
    labels: kindLabels,
  });

  const baseURL = await prompt("Base URL", {
    default: kindDefaultUrl[kind],
    required: kind === "openai-compat",
  });

  let apiKey: string | undefined;
  if (kind !== "ollama") {
    console.log(
      chalk.gray(
        "  Tip: enter a ${ENV_VAR} reference (e.g. ${OPENROUTER_API_KEY}) to keep the secret out of the config file; it's expanded at load time.",
      ),
    );
    const k = await promptSecret("API key (or ${ENV_VAR} reference)");
    apiKey = k ?? undefined;
  }

  const description =
    (await prompt("Description (optional — what this provider is / what it's good for)")) || undefined;

  const stored = addProviderInstance(
    {
      name,
      kind: kind as ProviderKind,
      baseURL: baseURL || undefined,
      apiKey,
      description,
    },
    { replace: false },
  );

  console.log(chalk.green(`✓ Provider '${stored.name}' configured.`));
  console.log(chalk.gray("  Now pick a default model for this project's agents."));

  const model = await prompt("Model (e.g. deepseek/deepseek-v4-flash)", { required: true });

  return { provider: stored.name, model };
}
