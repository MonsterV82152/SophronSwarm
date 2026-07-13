/**
 * `sophron agents edit <name> --model <m> --provider <p>` (V3.1.0-M5).
 *
 * Validates the new (model, provider) pair through the single chokepoint
 * `resolveModel()` and writes a targeted frontmatter update.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { Command } from "commander";
import chalk from "chalk";
import matter from "gray-matter";
import { updateAgentFrontmatter } from "../agent/loader.js";
import { resolveModel } from "../llm/providers.js";

export interface AgentEditOpts {
  model?: string;
  provider?: string;
}

/** Register the `sophron agents edit` subcommand. */
export function buildAgentsEditCommand(agentsCmd: Command): Command {
  return agentsCmd
    .command("edit <name>")
    .description("Edit an agent's model and/or provider frontmatter fields")
    .option("--model <model>", "new concrete model id")
    .option("--provider <provider>", "configured provider instance name")
    .action(async (name: string, opts: AgentEditOpts, command: Command) => {
      const globals = command.optsWithGlobals() as { dir?: string };
      const workingDir = resolve(globals.dir ?? process.cwd());
      const filePath = join(workingDir, "agents", `${name}.md`);
      if (!existsSync(filePath)) {
        console.error(chalk.red(`Agent '${name}' not found at ${filePath}.`));
        process.exitCode = 1;
        return;
      }

      let raw: string;
      try {
        raw = readFileSync(filePath, "utf8");
      } catch (e) {
        console.error(chalk.red(`Could not read agent file '${filePath}': ${(e as Error).message}`));
        process.exitCode = 1;
        return;
      }

      let parsed;
      try {
        // Disable gray-matter's body-content cache; keeps each edit isolated.
        parsed = matter(raw, {});
      } catch (e) {
        console.error(chalk.red(`Invalid frontmatter in '${filePath}': ${(e as Error).message}`));
        process.exitCode = 1;
        return;
      }

      if (opts.model === undefined && opts.provider === undefined) {
        console.error(chalk.red("Specify --model and/or --provider."));
        process.exitCode = 1;
        return;
      }

      const curModel = parsed.data.model ?? "";
      const curProvider = parsed.data.provider ?? "";
      const newModel = opts.model ?? curModel;
      const newProvider = opts.provider ?? curProvider;

      if (!newProvider) {
        console.error(chalk.red(`Agent '${name}' has no provider configured; use --provider.`));
        process.exitCode = 1;
        return;
      }

      try {
        resolveModel(newModel, newProvider);
      } catch (e) {
        console.error(chalk.red(`Invalid model/provider pair: ${(e as Error).message}`));
        process.exitCode = 1;
        return;
      }

      updateAgentFrontmatter(filePath, { model: newModel, provider: newProvider });
      console.log(chalk.green(`✓ Updated '${name}': model=${newModel} provider=${newProvider}`));
    });
}
