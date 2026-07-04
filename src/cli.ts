/**
 * CLI subcommands: run, agents, replay.
 *
 * Usage:
 *   sophron run <agent-name> "<task>" [--dir <path>]
 *   sophron agents                          list loaded agent definitions
 *   sophron replay <runId-or-file>          print a run's JSONL events
 */
import { Command } from "commander";
import chalk from "chalk";
import { resolve } from "node:path";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { LLMClient } from "./llm/client.js";
import { ToolRegistry } from "./tools/registry.js";
import { ToolDispatcher } from "./tools/dispatcher.js";
import { BUILTIN_TOOLS } from "./tools/builtin/index.js";
import { Checkpointer } from "./state/checkpointer.js";
import { AgentRegistry } from "./agent/registry.js";
import { runAgent } from "./agent/loop.js";
import { log } from "./util/log.js";

function buildRegistry(): { tools: ToolRegistry; dispatcher: ToolDispatcher } {
  const tools = new ToolRegistry();
  for (const t of BUILTIN_TOOLS) tools.register(t);
  const dispatcher = new ToolDispatcher(tools);
  return { tools, dispatcher };
}

export async function runCli(argv: string[]): Promise<void> {
  const program = new Command();

  program
    .name("sophron")
    .description("SophronSwarm V3 — modular multi-agent CLI")
    .version("0.1.0");

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

      // ── Wire dependencies ────────────────────────────────────────────────
      const { dispatcher } = buildRegistry();
      const llm = new LLMClient();
      const checkpointer = new Checkpointer(resolve(workingDir, ".sophron", "checkpoint.db"));

      try {
        const { state } = await runAgent({
          agent: def,
          task,
          workingDir,
          llm,
          dispatcher,
          checkpointer,
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
        // Note: better-sqlite3 handle stays open; process exit will close it.
      }
    });

  program
    .command("agents")
    .description("List loaded agent definitions")
    .action(() => {
      const registry = new AgentRegistry();
      const scan = registry.scan();
      if (scan.agents.length === 0) {
        console.log(chalk.gray("No agents loaded. Add a .md file under agents/ or ~/.sophron/agents/."));
        return;
      }
      for (const a of scan.agents) {
        console.log(chalk.bold(a.name) + chalk.gray(`  [${a.source}]  ${a.model}`));
        console.log(chalk.gray(`  ${a.description}`));
      }
      if (scan.errors.length) {
        console.warn(chalk.yellow(`\n${scan.errors.length} agent file(s) failed to load:`));
        for (const e of scan.errors) console.warn(chalk.gray(`  ${e.filePath}: ${e.error}`));
      }
    });

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

  await program.parseAsync(argv);
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
