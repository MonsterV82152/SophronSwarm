/**
 * Context-aware help for the TUI (M4).
 *
 * Replaces the old single static `HELP_TEXT` string with `helpForView(view)`:
 *   - A **core** section, always present (navigation keys + always-available
 *     slash commands).
 *   - A **per-view** section, showing the keys/commands relevant to the active
 *     view (derived from the nav state machine in nav.ts).
 *
 * The view descriptor is a union over the M3 view set:
 *   - Home surface tabs: overview / orchestrator / projects
 *   - Project surface tabs: status / agents / runs / checkpoint / memory / cost
 *   - Detail views: agentDetail / runDetail
 *
 * Pure — no I/O, no React. Fully unit-testable.
 *
 * See docs/ROADMAP.md (M4).
 */

/** Every navigable view the help system knows about. */
export type HelpView =
  // Home surface
  | "home:overview"
  | "home:orchestrator"
  | "home:projects"
  // Project surface — list/detail tabs
  | "project:status"
  | "project:agents"
  | "project:agentDetail"
  | "project:runs"
  | "project:runDetail"
  | "project:checkpoint"
  | "project:memory"
  | "project:cost";

/** The core commands + keys shown on EVERY view. */
const CORE_HELP = `SophronSwarm V3 — help

── Navigation ──
  ←/→         Move across horizontal tabs
  ↑/↓         Move within a list (↑ at top → back to tabs)
  Enter       Open / drill into the selected item
  Esc         Go back (detail → list → tabs → home → quit)
  type        Any printable char focuses the input bar
  Ctrl+C      Quit

── Always-available commands ──
  /help         Show this help
  /projects     Jump to the Projects tab
  /model [<agent>] <spec>  Change an agent's model (updates the .md file; agent inferred from context)
  /clear        Clear the output log
  /quit         Exit SophronSwarm`;

/**
 * Per-view help sections. Each entry is appended after the core section when
 * its view is active. Omitted views fall back to core-only.
 */
const VIEW_HELP: Partial<Record<HelpView, string>> = {
  "home:overview": `── Overview ──
  Display-only. Shows cross-project health: total projects, runs, tokens,
  and projects needing attention (failed last run).
  No drill-in — use ←/→ to reach Orchestrator or Projects.`,

  "home:orchestrator": `── Orchestrator (global) ──
  Chat with the global orchestrator — your "CEO" for the whole workspace.
  It manages the project lifecycle (propose / create / list projects) with
  NO memory and NO codebase workspace.
  Type below to chat (e.g. "I want to build a CLI tool for X").
  /projects  Jump to the Projects tab to enter a created project
  /model <spec>  Change the global orchestrator's model (updates the .md file)
  /clear     Clear the output log (chat history persists for the session)

  Install: sophron init --install-orchestrator`,

  "home:projects": `── Projects ──
  ↑/↓ to select a project · Enter to open it (switches workspace).
  The active project is marked (active). Esc back to tabs.`,

  "project:status": `── Status ──
  At-a-glance project health: agent count, recent runs, current checkpoint,
  token usage, and pending approvals.`,

  "project:agents": `── Agents ──
  ↑/↓ to select an agent · Enter to open its detail (config + live stream).
  /memory <agent>  Show that agent's per-agent memory
  /model <spec>  Change the selected agent's model (updates the .md file)
  /model <agent> <spec>  Change a specific agent's model for this session
  /run <agent> "<task>"  Queue a task for an agent (use CLI for now)`,

  "project:agentDetail": `── Agent detail ──
  Shows the agent's config + a live stream of its latest run (refreshes
  every 500ms). Type a task below to queue it for this agent.
  /model <spec>      Change this agent's model (updates the .md file)
  /approve <id> y|n  Resolve a pending approval for this agent
  /rewind <runId>    Rewind to a prior checkpoint of this agent's run
  Esc                Back to the Agents list`,

  "project:runs": `── Runs ──
  ↑/↓ to select a run · Enter to expand its event log.
  /runs [n]  Refresh the list (optional limit)`,

  "project:runDetail": `── Run detail ──
  Full JSONL event log for a single run (turns, LLM responses, tool calls).
  Esc back to the Runs list.`,

  "project:checkpoint": `── Checkpoint ──
  Shows the current project milestone + the ordered list.
  /advance   Mark the current checkpoint complete + advance to the next`,

  "project:memory": `── Memory ──
  /memory           List shared memory files
  /memory <agent>   Show a specific agent's per-agent memory`,

  "project:cost": `── Cost ──
  MCP token-cost meter: configured servers + per-server promoted-tool cost.
  Tools are lazy by default — promote them via mcp_tool_search in an agent.`,
};

/**
 * Build the help text for a specific view. Always includes the core section;
 * appends the per-view section when available.
 */
export function helpForView(view: HelpView): string {
  const section = VIEW_HELP[view];
  return section ? `${CORE_HELP}\n\n${section}` : CORE_HELP;
}

/**
 * Derive the active help view from the nav state. Mirrors the M3 view model
 * (nav.ts): surface + active tab + detail drill-down.
 *
 * @param surface   "home" | "project"
 * @param homeTab   active home tab ("overview" | "orchestrator" | "projects")
 * @param projectTab active project tab ("status" | "agents" | "runs" | ...)
 * @param detail    "agent" | "run" | null — the drill-down detail type
 */
export function helpViewFor(
  surface: "home" | "project",
  homeTab: string,
  projectTab: string,
  detail: "agent" | "run" | null,
): HelpView {
  if (surface === "home") {
    return `home:${homeTab}` as HelpView;
  }
  // Project surface — detail drill-down takes precedence.
  if (detail === "agent") return "project:agentDetail";
  if (detail === "run") return "project:runDetail";
  return `project:${projectTab}` as HelpView;
}
