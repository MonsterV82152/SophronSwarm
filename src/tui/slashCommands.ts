/**
 * Slash-command parser for the TUI.
 *
 * Parses operator input (starting with `/`) into a structured command. Free
 * text (not starting with `/`) is treated as a task for the default agent.
 *
 * Pure — no I/O, no React. Fully unit-testable.
 *
 * See docs/PHASE_5_DESIGN.md §3.2.
 */

export type SlashCommand =
  | { kind: "help" }
  | { kind: "projects" }
  | { kind: "agents" }
  | { kind: "runs"; limit?: number }
  | { kind: "checkpoint" }
  | { kind: "advance" }
  | { kind: "cost" }
  | { kind: "memory"; agent?: string }
  | { kind: "run"; agent: string; task: string }
  | { kind: "approve"; id: string; decision: "yes" | "no" }
  | { kind: "rewind"; runId: string }
  | { kind: "clear" }
  | { kind: "quit" }
  | { kind: "unknown"; raw: string; reason: string }
  | { kind: "task"; text: string }; // free-text (not a slash command)

/**
 * Parse a line of operator input into a structured command.
 *
 * - Input starting with `/` is a slash command.
 * - Otherwise it's free-text task (delegated to the default agent / last-used).
 * - Quoted arguments are respected: `/run builder "do the thing"` → { agent, task }.
 */
export function parseSlashCommand(input: string): SlashCommand {
  const trimmed = input.trim();
  if (trimmed === "") return { kind: "unknown", raw: input, reason: "empty input" };
  if (!trimmed.startsWith("/")) return { kind: "task", text: trimmed };

  // Split into the command word + the remainder, then tokenize the remainder
  // respecting double-quoted strings.
  const spaceIdx = trimmed.indexOf(" ");
  const cmdWord = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
  const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();
  const tokens = tokenize(rest);

  switch (cmdWord) {
    case "/help":
    case "/h":
    case "/?":
      return { kind: "help" };
    case "/projects":
    case "/p":
      return { kind: "projects" };
    case "/agents":
    case "/a":
      return { kind: "agents" };
    case "/runs":
    case "/r": {
      if (tokens.length >= 1) {
        const n = Number(tokens[0]);
        if (Number.isInteger(n) && n > 0) return { kind: "runs", limit: n };
      }
      return { kind: "runs" };
    }
    case "/checkpoint":
    case "/cp":
      return { kind: "checkpoint" };
    case "/advance":
      return { kind: "advance" };
    case "/cost":
      return { kind: "cost" };
    case "/memory":
    case "/mem":
      return { kind: "memory", agent: tokens[0] };
    case "/run": {
      if (tokens.length < 2) {
        return { kind: "unknown", raw: trimmed, reason: "/run requires <agent> \"<task>\"" };
      }
      return { kind: "run", agent: tokens[0]!, task: tokens.slice(1).join(" ") };
    }
    case "/approve": {
      if (tokens.length < 2) {
        return { kind: "unknown", raw: trimmed, reason: "/approve requires <id> yes|no" };
      }
      const decision = tokens[1]!.toLowerCase();
      if (decision !== "yes" && decision !== "no" && decision !== "y" && decision !== "n") {
        return { kind: "unknown", raw: trimmed, reason: "/approve decision must be yes or no" };
      }
      return { kind: "approve", id: tokens[0]!, decision: decision.startsWith("y") ? "yes" : "no" };
    }
    case "/rewind": {
      if (tokens.length < 1) {
        return { kind: "unknown", raw: trimmed, reason: "/rewind requires a runId" };
      }
      return { kind: "rewind", runId: tokens[0]! };
    }
    case "/clear":
      return { kind: "clear" };
    case "/quit":
    case "/exit":
      return { kind: "quit" };
    default:
      return { kind: "unknown", raw: trimmed, reason: `unknown command '${cmdWord}'` };
  }
}

/**
 * Tokenize a string respecting double-quoted segments.
 * `add numbers "a quoted phrase"` → ["add", "numbers", "a quoted phrase"].
 */
function tokenize(input: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < input.length) {
    // skip whitespace
    while (i < input.length && /\s/.test(input[i]!)) i++;
    if (i >= input.length) break;
    if (input[i] === '"') {
      // quoted segment — read until closing quote
      i++; // skip opening quote
      let buf = "";
      while (i < input.length && input[i] !== '"') {
        buf += input[i];
        i++;
      }
      i++; // skip closing quote (if present)
      out.push(buf);
    } else {
      // bare token — read until whitespace
      let buf = "";
      while (i < input.length && !/\s/.test(input[i]!)) {
        buf += input[i];
        i++;
      }
      out.push(buf);
    }
  }
  return out;
}

/** Human-readable list of available slash-commands (for /help). */
export const HELP_TEXT = `SophronSwarm V3 — TUI commands:

  /agents              List loaded agent definitions
  /runs [n]            Show recent runs (default 5)
  /checkpoint          Show the current project milestone
  /advance             Mark the current checkpoint complete + advance
  /cost                Show MCP token-cost meter
  /memory [agent]      Show per-agent memory (or shared if no agent)
  /run <agent> "<t>"   Run an agent on a task
  /approve <id> y|n    Resolve a pending approval
  /rewind <runId>      Rewind to a prior checkpoint
  /clear               Clear the screen
  /help                Show this help
  /quit                Exit

Any text not starting with / is sent to the last-used agent as a task.`;
