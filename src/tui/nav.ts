/**
 * Navigation state machine — the single source of truth for TUI navigation.
 *
 * The first M3 attempt was "broken and confusing" largely because navigation
 * logic was tangled across `useInput` handlers, `page` state, and ad-hoc flags.
 * This module fixes that: a **pure reducer** with an explicit state model and
 * documented transitions. No React, no Ink — fully unit-testable.
 *
 * ## The model
 *
 * Two **surfaces**, each with a horizontal tab bar:
 *   - **home**    — Overview · Orchestrator (global chat, M8) · Projects
 *   - **project** — Status · Agents · Runs · Checkpoint · Memory · Cost
 *
 * Three **focus zones** (where keystrokes go):
 *   - **tabs**    — ←/→ moves between the horizontal tabs.
 *   - **content** — ↑/↓ moves within the active tab's list; Enter drills in.
 *   - **input**   — the bottom input bar captures text.
 *
 * Plus a **detail** state: when drilled into an agent, the content area shows
 * the agent detail (config + live stream) and Esc returns to the Agents tab.
 *
 * ## Key transitions
 *   - tabs   + ←/→        → move tab
 *   - tabs   + Enter/↓    → focus content (drill into the tab)
 *   - content + ↑/↓       → move selection
 *   - content + Enter     → open selected item (project → switch; agent → detail; run → detail)
 *   - content + Esc/↑     → back to tabs
 *   - detail + Esc        → back to Agents content
 *   - project tabs + Esc  → back to home surface (breadcrumb up)
 *   - any printable char  → focus input (keeps the char)
 *   - input  + Enter      → submit, return to prior focus
 *   - input  + Esc        → cancel, return to prior focus
 *
 * See docs/ROADMAP.md (M3).
 */

// ── Surfaces & tabs ─────────────────────────────────────────────────────────

export type HomeTab = "overview" | "orchestrator" | "projects" | "drafts";
export type ProjectTab = "status" | "chat" | "agents" | "runs" | "checkpoint" | "memory" | "cost";

export const HOME_TABS: HomeTab[] = ["overview", "orchestrator", "projects", "drafts"];
export const PROJECT_TABS: ProjectTab[] = ["status", "chat", "agents", "runs", "checkpoint", "memory", "cost"];

/** Human-readable labels for the tab bar. */
export const HOME_TAB_LABELS: Record<HomeTab, string> = {
  overview: "Overview",
  orchestrator: "Orchestrator",
  projects: "Projects",
  drafts: "Drafts",
};
export const PROJECT_TAB_LABELS: Record<ProjectTab, string> = {
  status: "Status",
  chat: "Chat",
  agents: "Agents",
  runs: "Runs",
  checkpoint: "Checkpoint",
  memory: "Memory",
  cost: "Cost",
};

// ── Focus ───────────────────────────────────────────────────────────────────

export type Focus = "tabs" | "content" | "input";

// ── State ───────────────────────────────────────────────────────────────────

export interface NavState {
  /** Which surface is active. */
  surface: "home" | "project";
  /** Active tab index on each surface (kept even when not active, so switching
   *  back preserves position). */
  homeTabIndex: number;
  projectTabIndex: number;
  /** Where keystrokes currently go. */
  focus: Focus;
  /** Focus to restore after the input bar is dismissed. */
  focusBeforeInput: Exclude<Focus, "input">;
  /** Drill-down detail. Only one at a time. */
  agentDetail: string | null;
  /** Drill-down run detail (the runId/prefix). */
  runDetail: string | null;
  /** List selection indices, per navigable tab. */
  projectsIndex: number;
  agentsIndex: number;
  runsIndex: number;
  draftsIndex: number;
  chatThreadsIndex: number;
  /** The current input-bar text (composed in input focus). */
  input: string;
}

export function initialNavState(): NavState {
  return {
    surface: "home",
    homeTabIndex: 0,
    projectTabIndex: 0,
    focus: "tabs",
    focusBeforeInput: "tabs",
    agentDetail: null,
    runDetail: null,
    projectsIndex: 0,
    agentsIndex: 0,
    runsIndex: 0,
    draftsIndex: 0,
    chatThreadsIndex: 0,
    input: "",
  };
}

// ── Actions ─────────────────────────────────────────────────────────────────

export type NavAction =
  // Tab bar movement (←/→).
  | { kind: "tabLeft" }
  | { kind: "tabRight" }
  // Drill into / out of the active tab (Enter / Esc / ↑).
  | { kind: "enterTab" } // focus content / open tab
  | { kind: "exitUp" } // Esc/↑: content→tabs, tabs(home project)→home surface
  // List movement (↑/↓) within a tab's content.
  | { kind: "listUp" }
  | { kind: "listDown" }
  // Open the selected item (Enter in content focus).
  | { kind: "openSelected" }
  // Enter / leave a drill-down detail (set by openSelected / Esc in detail).
  | { kind: "closeDetail" }
  // Input bar.
  | { kind: "focusInput"; char: string }
  | { kind: "inputType"; char: string }
  | { kind: "inputBackspace" }
  | { kind: "inputSubmit" }
  | { kind: "inputCancel" }
  // Programmatic surface switches (from command handlers / project entry).
  | { kind: "goHome" }
  | { kind: "enterProject"; tabIndex?: number }
  | { kind: "openAgentDetail"; name: string }
  | { kind: "openRunDetail"; runId: string };

// ── Helpers ─────────────────────────────────────────────────────────────────

function clamp(n: number, length: number): number {
  if (length <= 0) return 0;
  if (n < 0) return 0;
  if (n >= length) return length - 1;
  return n;
}

/** The active tab index for the current surface. */
export function activeTabIndex(s: NavState): number {
  return s.surface === "home" ? s.homeTabIndex : s.projectTabIndex;
}

export function activeHomeTab(s: NavState): HomeTab {
  return HOME_TABS[s.homeTabIndex] ?? "overview";
}

export function activeProjectTab(s: NavState): ProjectTab {
  return PROJECT_TABS[s.projectTabIndex] ?? "status";
}

// ── Reducer ─────────────────────────────────────────────────────────────────

/**
 * The pure navigation reducer. Given the current state + an action, returns
 * the next state. **No side effects.** All keyboard interpretation lives here.
 *
 * `listLengths` is a side-input giving the current number of items in each
 * navigable list (needed to clamp selection). Omitted entries default to 0.
 */
export function navReducer(
  state: NavState,
  action: NavAction,
  listLengths?: Partial<Record<"projects" | "agents" | "runs" | "drafts" | "chatThreads", number>>,
): NavState {
  const projectsLen = listLengths?.projects ?? 0;
  const agentsLen = listLengths?.agents ?? 0;
  const runsLen = listLengths?.runs ?? 0;
  const draftsLen = listLengths?.drafts ?? 0;
  const chatThreadsLen = listLengths?.chatThreads ?? 0;

  switch (action.kind) {
    // ── Tab bar horizontal movement ────────────────────────────────────────
    case "tabLeft":
    case "tabRight": {
      if (state.focus === "input") return state; // input swallows arrows
      if (state.agentDetail || state.runDetail) return state; // detail owns its Esc
      const delta = action.kind === "tabLeft" ? -1 : 1;
      if (state.surface === "home") {
        return { ...state, homeTabIndex: clamp(state.homeTabIndex + delta, HOME_TABS.length), focus: "tabs" };
      }
      return { ...state, projectTabIndex: clamp(state.projectTabIndex + delta, PROJECT_TABS.length), focus: "tabs" };
    }

    // ── Enter a tab (drill from tab bar into content) ──────────────────────
    case "enterTab": {
      if (state.focus === "input") return state;
      if (state.agentDetail || state.runDetail) return state;
      // Overview is display-only — no content focus. Stay on tabs (no-op).
      if (state.surface === "home" && activeHomeTab(state) === "overview") return state;
      // All other tabs (incl. Orchestrator chat) drill into content focus.
      return { ...state, focus: "content" };
    }

    // ── Exit up (Esc / ↑ at top) ───────────────────────────────────────────
    case "exitUp": {
      if (state.focus === "input") return state;
      // Detail → back to its parent content.
      if (state.agentDetail) return { ...state, agentDetail: null, focus: "content" };
      if (state.runDetail) return { ...state, runDetail: null, focus: "content" };
      // Content → back to tabs.
      if (state.focus === "content") return { ...state, focus: "tabs" };
      // Project tab bar → back to home surface (breadcrumb up).
      if (state.surface === "project" && state.focus === "tabs") {
        return { ...state, surface: "home", focus: "tabs" };
      }
      return state;
    }

    // ── List vertical movement (only in content focus, not detail) ─────────
    case "listUp":
    case "listDown": {
      if (state.focus !== "content" || state.agentDetail || state.runDetail) return state;
      const delta = action.kind === "listUp" ? -1 : 1;
      if (state.surface === "home" && activeHomeTab(state) === "projects") {
        return { ...state, projectsIndex: clamp(state.projectsIndex + delta, Math.max(projectsLen, 1)) };
      }
      if (state.surface === "home" && activeHomeTab(state) === "drafts") {
        return { ...state, draftsIndex: clamp(state.draftsIndex + delta, Math.max(draftsLen, 1)) };
      }
      if (state.surface === "project") {
        const tab = activeProjectTab(state);
        if (tab === "agents") return { ...state, agentsIndex: clamp(state.agentsIndex + delta, Math.max(agentsLen, 1)) };
        if (tab === "runs") return { ...state, runsIndex: clamp(state.runsIndex + delta, Math.max(runsLen, 1)) };
        if (tab === "chat") return { ...state, chatThreadsIndex: clamp(state.chatThreadsIndex + delta, Math.max(chatThreadsLen, 1)) };
      }
      return state;
    }

    // ── Open the selected item ─────────────────────────────────────────────
    case "openSelected": {
      if (state.focus !== "content" || state.agentDetail || state.runDetail) return state;
      // Handled by the App (which knows the data + can switch services). The
      // reducer just signals intent via openAgentDetail / openRunDetail /
      // enterProject, which the App dispatches. So this is a no-op here; the
      // App intercepts openSelected before it reaches the reducer for these.
      // (Kept in the union for completeness; the App handles it directly.)
      return state;
    }

    case "closeDetail": {
      if (state.agentDetail) return { ...state, agentDetail: null, focus: "content" };
      if (state.runDetail) return { ...state, runDetail: null, focus: "content" };
      return state;
    }

    // ── Input bar ──────────────────────────────────────────────────────────
    case "focusInput": {
      if (state.focus === "input") {
        return { ...state, input: state.input + action.char };
      }
      // Reaching here means focus was "tabs" or "content" — record it as the
      // focus to restore after the input bar is dismissed.
      return {
        ...state,
        focus: "input",
        focusBeforeInput: state.focus,
        input: action.char,
      };
    }
    case "inputType":
      return state.focus === "input" ? { ...state, input: state.input + action.char } : state;
    case "inputBackspace":
      return state.focus === "input" ? { ...state, input: state.input.slice(0, -1) } : state;
    case "inputSubmit":
    case "inputCancel":
      return state.focus === "input"
        ? { ...state, focus: state.focusBeforeInput, input: "" }
        : state;

    // ── Programmatic navigation (from command handlers) ────────────────────
    case "goHome":
      return { ...state, surface: "home", focus: "tabs", agentDetail: null, runDetail: null };
    case "enterProject":
      return {
        ...state,
        surface: "project",
        projectTabIndex: action.tabIndex ?? state.projectTabIndex,
        focus: "tabs",
        agentDetail: null,
        runDetail: null,
      };
    case "openAgentDetail":
      return { ...state, agentDetail: action.name, runDetail: null, focus: "content" };
    case "openRunDetail":
      return { ...state, runDetail: action.runId, agentDetail: null, focus: "content" };

    default:
      return state;
  }
}
