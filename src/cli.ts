/**
 * CLI subcommands: run, agents, replay, providers, projects, init.
 *
 * Usage:
 *   sophron run <agent-name> "<task>" [--dir <path>]
 *   sophron agents                          list loaded agent definitions
 *   sophron agents edit <name> --model <m>  change an agent's model/provider
 *   sophron replay <runId-or-file>          print a run's JSONL events
 *   sophron providers                       manage provider instances
 */
import { Command, CommanderError } from "commander";
import chalk from "chalk";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { listProviders } from "./llm/providers.js";
import { AgentRegistry } from "./agent/registry.js";
import { AgentDraftStore } from "./agent/drafts.js";
import { updateAgentFrontmatter } from "./agent/loader.js";
import { buildServices, closeServices } from "./services/lifecycle.js";
import { registerProject, removeProject, renameProject, togglePin, listProjects, findByName } from "./project/registry.js";
import { scaffoldProject, installGlobalOrchestrator, listTemplates } from "./init/templates.js";
import { runProviderWizard } from "./init/wizard.js";
import { runAgent } from "./agent/loop.js";
import { log } from "./util/log.js";
import { prompt, promptConfirm } from "./util/prompts.js";
import {
  buildProvidersCommand,
  handleProvidersAdd,
  handleProvidersEdit,
  handleProvidersRemove,
  type AddProviderOpts,
  type EditProviderOpts,
} from "./cli/providers.js";
import { buildAgentsEditCommand } from "./cli/agents-edit.js";

export async function runCli(argv: string[]): Promise<void> {
  const program = new Command();

  program
    .name("sophron")
    .description("SophronSwarm V3 — modular multi-agent CLI")
    .version("0.1.0")
    .exitOverride();

  program
    .command("run")
    .description("Run an agent on a task")
    .argument("<agent>", "agent name")
    .argument("<task>", "task prompt")
    .option("-d, --dir <path>", "working directory", process.cwd())
    .action(async (agent: string, task: string, opts: { dir: string }) => {
      const workingDir = resolve(opts.dir);

      // ── Load agent ──────────────────────────────────────────────────────
      const registry = new AgentRegistry();
      const scan = registry.scan();
      for (const err of scan.errors) {
        console.warn(chalk.yellow(`agent load error: ${err.filePath}: ${err.error}`));
      }
      const def = registry.get(agent);
      if (!def) {
        console.error(chalk.red(`Agent '${agent}' not found.`));
        console.error(chalk.gray(`Available: ${scan.agents.map((a) => a.name).join(", ") || "(none)"}`));
        process.exitCode = 1;
        return;
      }
      if (scan.overCap) {
        console.warn(chalk.yellow(`Warning: agent roster (${scan.agents.length}) exceeds soft cap of 12.`));
      }

      // ── Wire dependencies ──────────────────────────────────────────────
      const services = buildServices(workingDir, registry);

      try {
        const { state } = await runAgent({
          agent: def,
          task,
          workingDir,
          llm: services.llm,
          dispatcher: services.dispatcher,
          checkpointer: services.checkpointer,
          services,
        });

        // ── Print result ──────────────────────────────────────────────────
        const lastAssistant = [...state.messages].reverse().find((m) => m.role === "assistant");
        console.log();
        console.log(chalk.bold("Agent result") + chalk.gray(`  [${state.status}, ${state.turn + 1} turn(s), ${state.tokenUsage.totalTokens} tokens]`));
        if (state.error) console.error(chalk.red(`Error: ${state.error}`));
        if (lastAssistant?.content) console.log(lastAssistant.content);
      } catch (e) {
        console.error(chalk.red(`Fatal: ${(e as Error).message}`));
        log.error({ err: e }, "run failed");
        process.exitCode = 1;
      } finally {
        // Tear down services (MCP pool, DB, watcher).
        await closeServices(services);
      }
    });

  program
    .command("tui", { isDefault: true })
    .description("Launch the interactive TUI dashboard")
    .option("-d, --dir <path>", "working directory", process.cwd())
    .action(async (opts: { dir: string }) => {
      const workingDir = resolve(opts.dir);
      // Register this project so it appears in the switcher / overview.
      registerProject(workingDir);
      const registry = new AgentRegistry();
      registry.scan();
      registry.startWatch();
      const services = buildServices(workingDir, registry);
      const { launchTui } = await import("./tui/launch.js");
      try {
        await launchTui({ services, workspaceDir: workingDir, registry });
      } finally {
        await closeServices(services, registry);
      }
    });

  const agentsCmd = program
    .command("agents")
    .description("List loaded agent definitions; manage pending agent drafts (M6)")
    .option("-d, --dir <path>", "working directory", process.cwd())
    .option("--drafts", "list pending agent drafts awaiting approval")
    .option("--approve <names...>", "approve one or more drafts by name (promotes to agents/)")
    .option("--reject <names...>", "reject one or more drafts by name (deletes the draft)")
    .option("--approve-all", "approve ALL pending drafts")
    .option("--reject-all", "reject ALL pending drafts")
    .action((opts: {
      dir: string;
      drafts?: boolean;
      approve?: string[];
      reject?: string[];
      approveAll?: boolean;
      rejectAll?: boolean;
    }) => {
      const workingDir = resolve(opts.dir);
      const store = new AgentDraftStore(workingDir);

      // ── Draft-management paths (M6) ────────────────────────────────────
      const wantsDraftAction =
        opts.drafts || opts.approveAll || opts.rejectAll ||
        (opts.approve && opts.approve.length > 0) || (opts.reject && opts.reject.length > 0);
      if (wantsDraftAction) {
        if (opts.approveAll && opts.rejectAll) {
          console.error(chalk.red("--approve-all and --reject-all are mutually exclusive."));
          process.exitCode = 1;
          return;
        }
        if (opts.drafts) {
          const pending = store.pendingDrafts();
          if (pending.length === 0) {
            console.log(chalk.gray("No pending agent drafts. Bootstrap is " +
              (store.isBootstrapClosed() ? "closed." : "open (none drafted yet).")));
          } else {
            console.log(chalk.bold(`${pending.length} pending agent draft(s) awaiting approval:`));
            for (const e of pending) {
              console.log(chalk.cyan(`  ${e.name}`) + chalk.gray(`  (drafted ${e.createdAt})`));
            }
            const first = pending[0];
            console.log(chalk.gray(`\nApprove with: sophron agents --approve${pending.length > 1 ? "-all" : ` ${first?.name ?? ""}`}`));
          }
          return;
        }
        if (opts.approveAll) {
          const resolved = store.approveAll();
          if (resolved.length === 0) { console.log(chalk.gray("No pending drafts to approve.")); return; }
          console.log(chalk.green(`Approved ${resolved.length} draft(s): ${resolved.map((e) => e.name).join(", ")}`));
          if (store.isBootstrapClosed()) console.log(chalk.gray("Bootstrap creation is now closed (all drafts resolved)."));
          return;
        }
        if (opts.rejectAll) {
          const resolved = store.rejectAll();
          if (resolved.length === 0) { console.log(chalk.gray("No pending drafts to reject.")); return; }
          console.log(chalk.yellow(`Rejected ${resolved.length} draft(s): ${resolved.map((e) => e.name).join(", ")}`));
          if (store.isBootstrapClosed()) console.log(chalk.gray("Bootstrap creation is now closed (all drafts resolved)."));
          return;
        }
        if (opts.approve && opts.approve.length > 0) {
          try {
            const resolved = store.approveMany(opts.approve);
            console.log(chalk.green(`Approved ${resolved.length} draft(s): ${resolved.map((e) => e.name).join(", ")}`));
            if (store.isBootstrapClosed()) console.log(chalk.gray("Bootstrap creation is now closed (all drafts resolved)."));
          } catch (e) {
            console.error(chalk.red(`Could not approve: ${(e as Error).message}`));
            process.exitCode = 1;
          }
          return;
        }
        if (opts.reject && opts.reject.length > 0) {
          try {
            const resolved = store.rejectMany(opts.reject);
            console.log(chalk.yellow(`Rejected ${resolved.length} draft(s): ${resolved.map((e) => e.name).join(", ")}`));
            if (store.isBootstrapClosed()) console.log(chalk.gray("Bootstrap creation is now closed (all drafts resolved)."));
          } catch (e) {
            console.error(chalk.red(`Could not reject: ${(e as Error).message}`));
            process.exitCode = 1;
          }
          return;
        }
      }

      // ── Default: list loaded agents ────────────────────────────────────
      const registry = new AgentRegistry();
      const scan = registry.scan();
      if (scan.agents.length === 0) {
        console.log(chalk.gray("No agents loaded. Add a .md file under agents/ or ~/.sophron/agents/."));
      } else {
        for (const a of scan.agents) {
          console.log(chalk.bold(a.name) + chalk.gray(`  [${a.source}]  ${a.model}`));
          console.log(chalk.gray(`  ${a.description}`));
        }
        if (scan.errors.length) {
          console.warn(chalk.yellow(`\n${scan.errors.length} agent file(s) failed to load:`));
          for (const e of scan.errors) console.warn(chalk.gray(`  ${e.filePath}: ${e.error}`));
        }
      }

      // Surface pending drafts as a hint when listing (if any exist).
      const pending = store.pendingDrafts();
      if (pending.length > 0) {
        console.log(chalk.cyan(`\n${pending.length} agent draft(s) awaiting approval. Run 'sophron agents --drafts' to review.`));
      }
    });

  buildAgentsEditCommand(agentsCmd);

  program
    .command("replay")
    .description("Print a run's recorded events")
    .argument("<file>", "path to the events .jsonl file (or a runId prefix)")
    .action((arg: string) => {
      let file = arg;
      if (!existsSync(file)) {
        // Treat as runId prefix under runs/
        if (!existsSync("runs")) {
          console.error(chalk.red(`No runs/ directory; '${arg}' is not a path either.`));
          process.exitCode = 1;
          return;
        }
        const hit = readdirSync("runs").find((f) => f.includes(arg));
        if (!hit) {
          console.error(chalk.red(`No events file for '${arg}'.`));
          process.exitCode = 1;
          return;
        }
        file = resolve("runs", hit);
      }
      const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const ev = JSON.parse(line);
          printEvent(ev);
        } catch {
          console.log(chalk.gray(line));
        }
      }
    });

  // ── Provider commands (consolidated under `sophron providers`) ────────
  buildProvidersCommand(program);

  // Backward-compatible hidden aliases for the old top-level commands.
  program
    .command("add-provider", { hidden: true })
    .description("[deprecated] Use 'sophron providers add'")
    .option("-n, --name <name>", "instance name (e.g. ollama-laptop)")
    .option("-k, --kind <kind>", "endpoint type: openrouter | ollama | zai | openai-compat")
    .option("--base-url <url>", "OpenAI-compatible base URL")
    .option("--api-key <key>", "API key (or a ${ENV_VAR} reference)")
    .option("--description <text>", "human-readable description of this provider")
    .option("--default", "mark this instance as the default for its kind")
    .option("--replace", "overwrite an existing instance with the same name")
    .action(async (opts: AddProviderOpts) => handleProvidersAdd(opts));

  program
    .command("remove-provider <name>", { hidden: true })
    .description("[deprecated] Use 'sophron providers remove'")
    .action((name: string) => handleProvidersRemove(name));

  program
    .command("edit-provider <name>", { hidden: true })
    .description("[deprecated] Use 'sophron providers edit'")
    .option("--base-url <url>", "new base URL")
    .option("--api-key <key>", "new API key (or a ${ENV_VAR} reference; use --clear-key to remove)")
    .option("--description <text>", "new description (use --clear-description to remove)")
    .option("--default", "mark this instance as the default for its kind")
    .option("--no-default", "remove the default-for-kind flag")
    .option("--clear-key", "remove the API key from this instance")
    .option("--clear-description", "remove the description from this instance")
    .action(async (name: string, opts: EditProviderOpts) => handleProvidersEdit(name, opts));

  program
    .command("projects")
    .description("List and manage registered SophronSwarm projects (remove / rename / pin)")
    .argument("[action]", "list (default) | remove | rename | pin | unpin")
    .argument("[name]", "project name (or path for remove)")
    .argument("[newName]", "new alias (for 'rename')")
    .option("-y, --yes", "skip the confirmation prompt for remove")
    .action(async (action: string | undefined, name: string | undefined, newName: string | undefined, opts: { yes?: boolean }) => {
      const act = action ?? "list";

      // ── list ──────────────────────────────────────────────────────────
      if (act === "list") {
        const projects = listProjects();
        if (projects.length === 0) {
          console.log(chalk.gray("No projects registered. Use 'sophron init' to create one."));
          return;
        }
        for (const p of projects) {
          const pin = p.pinned ? chalk.magenta(" ★") : "";
          console.log(`${chalk.bold(p.name)}${pin}  ${chalk.gray(p.path)}`);
        }
        console.log(chalk.gray(`\n${projects.length} project(s). Remove with: sophron projects remove <name>`));
        return;
      }

      // All other actions need a name.
      if (!name) {
        console.error(chalk.red(`'sophron projects ${act}' needs a project name.`));
        process.exitCode = 1;
        return;
      }

      // ── remove (accepts a name OR a path) ─────────────────────────────
      if (act === "remove") {
        // Resolve name → path if needed.
        let targetPath = name;
        const byName = findByName(name);
        if (byName) targetPath = byName.path;
        // If the arg was a path and it's registered, remove by path.
        const entry = listProjects().find((p) => p.path === name || p.name === name);
        if (!entry) {
          console.error(chalk.yellow(`No registered project matching '${name}'.`));
          process.exitCode = 1;
          return;
        }
        const confirm = opts.yes ?? (await promptConfirm(`Remove '${entry.name}' (${entry.path}) from the registry? This does NOT delete the files on disk.`, false));
        if (!confirm) {
          console.log(chalk.gray("Cancelled."));
          return;
        }
        const ok = removeProject(entry.path);
        if (ok) {
          console.log(chalk.green(`✓ Removed '${entry.name}' from the registry.`));
          console.log(chalk.gray(`  The files at ${entry.path} were NOT deleted. Delete them manually if no longer needed.`));
        } else {
          console.error(chalk.red(`Could not remove '${entry.name}'.`));
          process.exitCode = 1;
        }
        return;
      }

      // ── rename ────────────────────────────────────────────────────────
      if (act === "rename") {
        if (!newName) {
          console.error(chalk.red("'sophron projects rename' needs <name> <newName>."));
          process.exitCode = 1;
          return;
        }
        const entry = findByName(name);
        if (!entry) {
          console.error(chalk.yellow(`No registered project named '${name}'.`));
          process.exitCode = 1;
          return;
        }
        try {
          const updated = renameProject(entry.path, newName);
          console.log(chalk.green(`✓ Renamed '${name}' → '${updated.name}'.`));
        } catch (e) {
          console.error(chalk.red(`Could not rename: ${(e as Error).message}`));
          process.exitCode = 1;
        }
        return;
      }

      // ── pin / unpin ───────────────────────────────────────────────────
      if (act === "pin" || act === "unpin") {
        const entry = findByName(name);
        if (!entry) {
          console.error(chalk.yellow(`No registered project named '${name}'.`));
          process.exitCode = 1;
          return;
        }
        const want = act === "pin";
        if ((entry.pinned ?? false) === want) {
          console.log(chalk.gray(`'${entry.name}' is already ${want ? "pinned" : "not pinned"}.`));
          return;
        }
        const updated = togglePin(entry.path);
        console.log(chalk.green(`✓ '${updated!.name}' is now ${updated!.pinned ? "pinned ★" : "unpinned"}.`));
        return;
      }

      console.error(chalk.red(`Unknown action '${act}'. Use: list | remove | rename | pin | unpin`));
      process.exitCode = 1;
    });

  program
    .command("init")
    .description("Scaffold a new project from a template (seeds the standardized orchestrator + specialist agents)")
    .option("-t, --template <name>", "template name (minimal, cli, webapp, data-pipeline, or a user template)", "minimal")
    .option("-n, --name <alias>", "project alias (defaults to directory basename)")
    .option("-p, --path <dir>", "project path (defaults to ~/sophron_workspace/<name>)")
    .option("-f, --force", "overwrite an existing agents/ directory")
    .option("--list", "list available templates and exit")
    .option("--install-orchestrator", "install/update the global orchestrator template at ~/.sophron/agents/global-orchestrator.md (M7)")
    .action(async (opts: { template?: string; name?: string; path?: string; force?: boolean; list?: boolean; installOrchestrator?: boolean }) => {
      // ── --list: print templates + exit ──
      if (opts.list) {
        const templates = listTemplates();
        console.log(chalk.bold("Available templates:"));
        for (const t of templates) {
          console.log(`  ${chalk.cyan(t.name.padEnd(16))} ${chalk.gray(t.description)}`);
        }
        console.log(chalk.gray("\nUsage: sophron init --template <name> --name <alias>"));
        return;
      }

      // ── --install-orchestrator: write the global orchestrator + exit (M7) ──
      if (opts.installOrchestrator) {
        const written = installGlobalOrchestrator(opts.force);
        if (written) {
          console.log(chalk.green(`✓ Installed global orchestrator → ${written}`));
        } else {
          console.log(chalk.yellow("Global orchestrator already exists (use --force to overwrite)."));
        }
        return;
      }

      // ── Scaffold a project ──
      const templateName = opts.template ?? "minimal";
      const name = opts.name ?? templateName;
      const projectPath = opts.path
        ? resolve(opts.path)
        : resolve(homedir(), "sophron_workspace", name);

      // First-run provider wizard when no providers are configured.
      let wizardProvider: string | undefined;
      let wizardModel: string | undefined;
      if (listProviders().length === 0 && process.env.SOPHRON_SKIP_PROVIDER_CHECK !== "1") {
        try {
          const result = await runProviderWizard();
          wizardProvider = result.provider;
          wizardModel = result.model;
        } catch (e) {
          console.error(chalk.red(`Error: ${(e as Error).message}`));
          process.exitCode = 1;
          return;
        }
      }

      try {
        const result = scaffoldProject(projectPath, { template: templateName, name: opts.name, force: opts.force });

        // If the wizard ran, rewrite the scaffolded agents to use the chosen model/provider.
        if (wizardProvider && wizardModel) {
          for (const filename of result.created.agents) {
            updateAgentFrontmatter(join(result.projectPath, "agents", filename), {
              provider: wizardProvider,
              model: wizardModel,
            });
          }
        }

        console.log(chalk.green(`✓ Scaffolded project '${result.entry.name}' from template '${result.template}'`));
        console.log(chalk.gray(`  path: ${result.projectPath}`));
        console.log(chalk.gray(`  agents (${result.created.agents.length}): ${result.created.agents.join(", ")}`));
        if (result.created.shared.length > 0) {
          console.log(chalk.gray(`  shared: ${result.created.shared.join(", ")}`));
        }
        console.log(chalk.gray(`\nRun it: sophron --dir ${result.projectPath}`));
      } catch (e) {
        console.error(chalk.red(`Error: ${(e as Error).message}`));
        process.exitCode = 1;
      }
    });

  try {
    await program.parseAsync(argv);
  } catch (e) {
    if (e instanceof CommanderError) {
      // Parse-time errors (unknown option, missing argument, etc.) become
      // stderr + a non-zero exitCode so tests can observe them.
      const message = e.message.startsWith("error:") ? e.message : `error: ${e.message}`;
      console.error(chalk.red(message));
      process.exitCode = e.exitCode ?? 1;
      return;
    }
    throw e;
  }
}

function printEvent(ev: Record<string, unknown>): void {
  const type = String(ev["type"] ?? "?");
  const turn = ev["turn"] !== undefined ? chalk.gray(` t${ev["turn"]}`) : "";
  switch (type) {
    case "run_start":
      console.log(chalk.green("▶ run_start") + chalk.gray(` agent=${ev["agent"]}`));
      break;
    case "turn_start":
      console.log(chalk.cyan(`  ─ turn ${ev["turn"]}`));
      break;
    case "llm_response":
      console.log(
        chalk.blue("  ◆ llm") +
          turn +
          chalk.gray(` finish=${ev["finishReason"]} calls=${ev["toolCallCount"]} tokens=${(ev["usage"] as { totalTokens?: number })?.totalTokens ?? "?"}`),
      );
      break;
    case "tool_call_start":
      console.log(chalk.magenta(`    → ${ev["tool"]}`) + chalk.gray(` ${JSON.stringify(ev["args"])}`));
      break;
    case "tool_call_result":
      console.log(
        chalk.magenta(`    ← ${ev["tool"]}`) +
          (ev["isError"] ? chalk.red(" [error]") : "") +
          chalk.gray(` ${String(ev["resultPreview"]).slice(0, 80)}`),
      );
      break;
    case "turn_end":
      break;
    case "run_end":
      console.log(chalk.green("■ run_end") + chalk.gray(` status=${ev["status"]} tokens=${(ev["totalUsage"] as { totalTokens?: number })?.totalTokens ?? "?"}`));
      break;
    case "run_error":
      console.log(chalk.red("✖ run_error") + chalk.gray(` ${ev["error"]}`));
      break;
    default:
      console.log(chalk.gray(`${type}`));
  }
}
