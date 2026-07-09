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
  | { kind: "run"; agent: string; task: string; project?: string }
  | { kind: "model"; agent?: string; spec: string }
  | { kind: "drafts" }
  | { kind: "approveDraft"; project: string; name: string }
  | { kind: "rejectDraft"; project: string; name: string }
  | { kind: "approveAllDrafts"; project?: string }
  | { kind: "rejectAllDrafts"; project?: string }
  | { kind: "approve"; id: string; decision: "yes" | "no" }
  | { kind: "rewind"; runId: string }
  | { kind: "checkpoints"; milestones?: string[] }
  | { kind: "clear" }
  | { kind: "new" }
  | { kind: "chats" }
  | { kind: "switch"; project: string }
  | { kind: "chat"; project?: string }
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
        return { kind: "unknown", raw: trimmed, reason: "/run requires <agent> \"<task>\" or <project>/<agent> \"<task>\"" };
      }
      const first = tokens[0]!;
      if (first.includes("/")) {
        const slashIdx = first.indexOf("/");
        const project = first.slice(0, slashIdx);
        const agent = first.slice(slashIdx + 1);
        if (!project || !agent) {
          return { kind: "unknown", raw: trimmed, reason: "/run project/agent must contain both project and agent names" };
        }
        return { kind: "run", project, agent, task: tokens.slice(1).join(" ") };
      }
      return { kind: "run", agent: first, task: tokens.slice(1).join(" ") };
    }
    case "/model": {
      if (tokens.length === 0) {
        return {
          kind: "unknown",
          raw: trimmed,
          reason: "/model requires <model-spec> (agent is inferred in agent/orchestrator views) or <agent> <model-spec>",
        };
      }
      if (tokens.length === 1) {
        return { kind: "model", spec: tokens[0]! };
      }
      return { kind: "model", agent: tokens[0]!, spec: tokens.slice(1).join(" ") };
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
    case "/checkpoints":
    case "/cp": {
      // /checkpoints                -> list
      // /checkpoints "A" "B" "C"    -> replace milestone list
      if (tokens.length === 0) return { kind: "checkpoints" };
      return { kind: "checkpoints", milestones: tokens };
    }
    case "/clear":
      return { kind: "clear" };
    case "/new":
      return { kind: "new" };
    case "/chats":
      return { kind: "chats" };
    case "/switch":
    case "/s": {
      if (tokens.length < 1) {
        return { kind: "unknown", raw: trimmed, reason: "/switch requires a project name or path" };
      }
      return { kind: "switch", project: tokens[0]! };
    }
    case "/chat": {
      return { kind: "chat", project: tokens[0] };
    }
    case "/drafts":
      return { kind: "drafts" };
    case "/approve-draft":
    case "/ad": {
      if (tokens.length < 2) {
        return { kind: "unknown", raw: trimmed, reason: "/approve-draft requires <project> <agent>" };
      }
      return { kind: "approveDraft", project: tokens[0]!, name: tokens[1]! };
    }
    case "/reject-draft":
    case "/rd": {
      if (tokens.length < 2) {
        return { kind: "unknown", raw: trimmed, reason: "/reject-draft requires <project> <agent>" };
      }
      return { kind: "rejectDraft", project: tokens[0]!, name: tokens[1]! };
    }
    case "/approve-all-drafts":
      return { kind: "approveAllDrafts", project: tokens[0] };
    case "/reject-all-drafts":
      return { kind: "rejectAllDrafts", project: tokens[0] };
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

/**
 * Static command list — kept for backward compatibility.
 *
 * @deprecated since M4 — use `helpForView(view)` from `./help.js` instead.
 * The TUI now shows context-aware help based on the active view (see app.tsx).
 * This constant is the command reference a view-agnostic caller would get.
 */
export const HELP_TEXT = `SophronSwarm V3 — TUI commands:

  /projects            Jump to the Projects tab (switch project)
  /agents              List loaded agent definitions (project surface)
  /runs [n]            Show recent runs (default 5)
  /checkpoint          Show the current project milestone
  /advance             Mark the current checkpoint complete + advance
  /cost                Show MCP token-cost meter
  /memory [agent]      Show per-agent memory (or shared if no agent)
  /run <agent> "<t>"              Run an agent on a task
  /run <project>/<agent> "<t>"    Run an agent in another project (no cd)
  /model <agent> <id>             Change an agent's model for this session
  /approve <id> y|n               Resolve a pending tool approval
  /drafts                         List pending agent drafts across projects
  /approve-draft <p> <a>          Approve a pending agent draft
  /reject-draft <p> <a>           Reject a pending agent draft
  /approve-all-drafts [p]         Approve all pending drafts (optionally per project)
  /rewind <runId>      Rewind to a prior checkpoint
  /checkpoints ["A" ...]  List or replace project milestones
  /clear               Clear the output log
  /new                 Start a new chat thread (global or project)
  /chats               Show saved chat threads
  /switch <project>    Jump to a project (cached, no cd needed)
  /chat [project]      Open a project's chat tab
  /help                Show context-aware help
  /quit                Exit

Navigation: ←/→ tabs · ↑/↓ lists · Enter open · Esc back · type for input.
Use /help on any view for its specific keys + commands.`;
