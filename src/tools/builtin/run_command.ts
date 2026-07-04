/**
 * run_command tool — execute shell under sandbox isolation with the
 * dangerous-command blocker gate.
 *
 * See docs/PHASE_1_DESIGN.md §3.1.
 */
import { getBackend, type BackendName } from "../../sandbox/backend.js";
import { classifyCommand } from "../../sandbox/dangerousCommands.js";
import { log } from "../../util/log.js";
import type { ToolSpec } from "../schema.js";

const MAX_OUTPUT = 8 * 1024; // 8 KB cap on returned stdout+stderr
const HEAD = 2 * 1024; // keep first 2 KB
const TAIL = 4 * 1024; // and last 4 KB (where build errors usually live)

function truncateOutput(text: string): string {
  if (text.length <= MAX_OUTPUT) return text;
  const head = text.slice(0, HEAD);
  const tail = text.slice(text.length - TAIL);
  const omitted = text.length - HEAD - TAIL;
  return `${head}\n\n[…${omitted} bytes truncated…]\n\n${tail}`;
}

function formatExecResult(res: {
  exitCode: number;
  stdout: string;
  stderr: string;
  output: string;
  durationMs: number;
  backend: string;
  timedOut: boolean;
}): string {
  const body = truncateOutput(res.output.trimEnd());
  const meta = `exit=${res.exitCode} backend=${res.backend} ${res.durationMs}ms${res.timedOut ? " TIMEOUT" : ""}`;
  return `${meta}\n${body}`;
}

function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string") throw new Error(`Missing or non-string argument '${key}'`);
  return v;
}

export const run_command: ToolSpec = {
  name: "run_command",
  description:
    "Run a shell command in the workspace under sandbox isolation. Use for builds, tests, installs, git, and any shell work. " +
    "Network is off by default. Dangerous commands are blocked. Output is truncated to keep context small.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The shell command to run." },
      network: { type: "boolean", description: "Allow network access (default false)." },
      backend: {
        type: "string",
        enum: ["bubblewrap", "docker", "host"],
        description: "Optional execution backend. Defaults to bubblewrap.",
      },
      timeoutMs: { type: "integer", description: "Optional timeout in ms (default 120000)." },
    },
    required: ["command"],
  },
  handler: async ({ args, agent, state }) => {
    const command = requireString(args, "command");

    // ── 1. Permission mode gate: plan mode denies execution entirely ───────
    if (agent.permissionMode === "plan") {
      return `Blocked: run_command is not allowed in plan mode (read-only).`;
    }

    // ── 2. Dangerous-command blocker (always runs, all modes) ─────────────
    const verdict = classifyCommand(command);
    if (verdict.severity === "block") {
      log.warn({ cmd: command, rule: verdict.rule }, "command blocked by safety policy");
      return `Blocked by safety policy: ${verdict.reason} (rule: ${verdict.rule}). Choose a safer command.`;
    }
    // Heuristic flags: block in full-auto (conservative under autopilot); allow+warn otherwise.
    if (verdict.severity === "heuristic" && agent.permissionMode === "full-auto") {
      return `Blocked under full-auto (heuristic: ${verdict.reason}, rule: ${verdict.rule}). Run in default mode or use a safer command.`;
    }
    if (verdict.severity === "heuristic") {
      log.warn({ cmd: command, rule: verdict.rule }, "heuristic flag — allowing with warning");
    }

    // ── 3. Pick backend ────────────────────────────────────────────────────
    const requestedBackend = typeof args["backend"] === "string" ? (args["backend"] as BackendName) : undefined;
    const backend = getBackend(requestedBackend);

    // ── 4. Execute ─────────────────────────────────────────────────────────
    const res = await backend.exec({
      command,
      workspace: state.workingDir,
      network: args["network"] === true,
      timeoutMs: typeof args["timeoutMs"] === "number" ? args["timeoutMs"] : undefined,
    });

    let formatted = formatExecResult(res);
    if (verdict.severity === "heuristic") {
      formatted = `[warning: ${verdict.reason} (rule: ${verdict.rule})]\n${formatted}`;
    }
    return formatted;
  },
};
