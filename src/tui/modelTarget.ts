/**
 * Context-aware target-agent resolution for the `/model` slash command.
 *
 * Keeps the "what agent does `/model <spec>` affect?" logic in one place so it
 * can be unit-tested without rendering the full App shell.
 */
import { activeHomeTab, activeProjectTab } from "./nav.js";
import type { NavState } from "./nav.js";
import type { DashboardModel } from "./dashboard.js";

export function resolveModelTarget(
  nav: NavState,
  model: Pick<DashboardModel, "agents">,
  explicitAgent?: string,
): string | null {
  return (
    explicitAgent ??
    nav.agentDetail ??
    (nav.surface === "home" && activeHomeTab(nav) === "orchestrator" ? "global-orchestrator" : null) ??
    (nav.surface === "project" && activeProjectTab(nav) === "agents" ? model.agents[nav.agentsIndex]?.name ?? null : null)
  );
}
