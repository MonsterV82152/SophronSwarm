/**
 * App — the Ink TUI shell with page-based navigation.
 *
 * Ollama/claude-code-style: a navigable main menu (arrow keys + Enter) switches
 * between pages (Projects, Agents, Runs, Checkpoint, MCP Cost, Memory, Help).
 * Slash-commands still work — typing any printable char enters "compose" mode.
 *
 * Dual input modes:
 *   - navigate: ↑/↓ move selection (home menu), Enter select, Esc back, any
 *     printable char → switches to compose mode.
 *   - compose:  type a command/task, Enter submits (slash command or task),
 *     Esc cancels back to navigate mode.
 *
 * Both modes: Ctrl+C exits.
 *
 * See docs/PHASE_5_DESIGN.md.
 */
import React, { useState, useCallback, useMemo } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { resolve } from "node:path";
import { parseSlashCommand, HELP_TEXT } from "./slashCommands.js";
import { buildDashboard, readRunDetail, type RunDetail } from "./dashboard.js";
import { CheckpointManager } from "../memory/checkpoints.js";
import { clampIndex } from "./components/SelectList.js";
import {
  HOME_MENU,
  HomePage,
  ProjectsPage,
  AgentsPage,
  AgentDetailPage,
  RunsPage,
  RunDetailPage,
  CheckpointPage,
  CostPage,
  MemoryPage,
  HelpPage,
  type Page,
} from "./components/pages.js";
import { ProjectSwitcher } from "./components/projectSwitcher.js";
import { switchServices } from "../services/lifecycle.js";
import { listProjects, registerProject, type ProjectEntry } from "../project/registry.js";
import type { SharedServices } from "../tools/schema.js";
import type { ApprovalsQueue } from "./approvals.js";
import type { AgentRegistry } from "../agent/registry.js";

export interface AppProps {
  services: SharedServices;
  workspaceDir: string;
  approvals: ApprovalsQueue;
  registry: AgentRegistry;
}

type Mode = "navigate" | "compose";

interface OutputBlock {
  id: number;
  text: string;
  color?: string;
}

/** Human-readable page titles for the breadcrumb. */
const PAGE_TITLES: Record<Page, string> = {
  home: "Home",
  projects: "Projects",
  agents: "Agents",
  runs: "Runs",
  checkpoint: "Checkpoint",
  cost: "MCP Cost",
  memory: "Memory",
  help: "Help",
  agentDetail: "Agent",
  runDetail: "Run",
};

export function App({ services: initialServices, workspaceDir: initialDir, approvals: initialApprovals, registry: initialRegistry }: AppProps) {
  // Services + workspace are in STATE so we can rebuild them on project switch.
  // (The switch tears down the old services and builds fresh ones bound to the
  // new project's working directory.)
  const [services, setServices] = useState<SharedServices>(initialServices);
  const [registry, setRegistry] = useState<AgentRegistry>(initialRegistry);
  const [workspaceDir, setWorkspaceDir] = useState(initialDir);
  const [activeProjectName, setActiveProjectName] = useState(() => {
    const entry = listProjects().find((p) => p.path === resolve(initialDir));
    return entry?.name ?? (initialDir.split("/").pop() || "project");
  });
  const [approvals, setApprovals] = useState<ApprovalsQueue>(initialApprovals);
  // Project switcher overlay (Ctrl+P).
  const [showSwitcher, setShowSwitcher] = useState(false);
  const [switcherIndex, setSwitcherIndex] = useState(0);
  // Whether a project switch is in progress (disables input during rebuild).
  const [switching, setSwitching] = useState(false);

  const [page, setPage] = useState<Page>("home");
  // Per-list selection indices (each navigable list owns its own cursor).
  const [homeIndex, setHomeIndex] = useState(0);
  const [agentsIndex, setAgentsIndex] = useState(0);
  const [runsIndex, setRunsIndex] = useState(0);
  const [mode, setMode] = useState<Mode>("navigate");
  const [input, setInput] = useState("");
  const [blocks, setBlocks] = useState<OutputBlock[]>([]);
  // Memory viewer state: what to show on the Memory page.
  const [memoryContent, setMemoryContent] = useState("");
  const [memoryLabel, setMemoryLabel] = useState("shared memory files");
  // Drill-down detail state.
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [runDetail, setRunDetail] = useState<RunDetail | null>(null);
  const { exit } = useApp();

  const model = useMemo(
    () => buildDashboard(services, { workspaceDir, approvalsPending: approvals.size }),
    [services, workspaceDir, approvals.size],
  );

  const pushBlock = useCallback((text: string, color?: string) => {
    setBlocks((prev) => [...prev.slice(-7), { id: prev.length, text, color }]);
  }, []);

  /**
   * Switch to a different project. Tears down the current services (DB, MCP
   * pool, watcher) and rebuilds fresh ones bound to the new working directory.
   * Registers the project if it's new. Disables input during the rebuild.
   */
  const switchProject = useCallback(
    async (projectPath: string) => {
      const absPath = resolve(projectPath);
      setSwitching(true);
      setShowSwitcher(false);
      pushBlock(`Switching to ${absPath}…`, "yellow");
      try {
        const entry = registerProject(absPath);
        const { services: newServices, registry: newRegistry } = await switchServices(services, registry, absPath);
        setServices(newServices);
        setRegistry(newRegistry);
        setApprovals(newServices.approvals);
        setWorkspaceDir(absPath);
        setActiveProjectName(entry.name);
        setPage("home");
        setHomeIndex(0);
        setSelectedAgent(null);
        setSelectedRunId(null);
        setRunDetail(null);
        pushBlock(`Switched to project: ${entry.name}`, "green");
      } catch (e) {
        pushBlock(`Switch failed: ${(e as Error).message}`, "red");
      } finally {
        setSwitching(false);
      }
    },
    [services, registry, pushBlock],
  );

  /** Navigate to a page, refreshing any page-specific state. */
  const navigateTo = useCallback(
    (target: Page) => {
      setPage(target);
      if (target === "agents") setAgentsIndex(0);
      if (target === "runs") setRunsIndex(0);
      if (target === "memory") {
        // Default the memory page to listing shared memory files.
        const files = services.sharedMemoryStore.listFiles();
        setMemoryLabel("shared memory files");
        setMemoryContent(files.length > 0 ? files.map((f) => `- ${f}`).join("\n") : "(no shared memory files)");
      }
    },
    [services.sharedMemoryStore],
  );

  /** Open the agent detail page for a named agent (drill-down). */
  const openAgent = useCallback((name: string) => {
    setSelectedAgent(name);
    setPage("agentDetail");
  }, []);

  /** Open the run detail page for a runId (drill-down) — loads the event log. */
  const openRun = useCallback(
    (runId: string) => {
      setSelectedRunId(runId);
      setRunDetail(readRunDetail(workspaceDir, runId));
      setPage("runDetail");
    },
    [workspaceDir],
  );

  /** Handle a submitted slash command / free-text task. */
  const handleCommand = useCallback(
    (raw: string) => {
      const cmd = parseSlashCommand(raw);
      switch (cmd.kind) {
        case "help":
          navigateTo("help");
          break;
        case "projects":
          setSwitcherIndex(0);
          setShowSwitcher(true);
          break;
        case "agents":
          navigateTo("agents");
          break;
        case "runs":
          navigateTo("runs");
          break;
        case "checkpoint":
          navigateTo("checkpoint");
          break;
        case "cost":
          navigateTo("cost");
          break;
        case "memory": {
          if (cmd.agent) {
            const mem = services.agentMemoryStore.readForInjection(cmd.agent);
            setMemoryLabel(`agent memory: ${cmd.agent}`);
            setMemoryContent(mem || `(no memory for agent '${cmd.agent}')`);
          } else {
            const files = services.sharedMemoryStore.listFiles();
            setMemoryLabel("shared memory files");
            setMemoryContent(files.length > 0 ? files.map((f) => `- ${f}`).join("\n") : "(no shared memory files)");
          }
          navigateTo("memory");
          break;
        }
        case "advance": {
          const mgr = new CheckpointManager(services.sharedMemoryStore);
          const res = mgr.advance();
          pushBlock(
            res.advanced ? `Advanced to: ${res.current?.title}` : `Not advanced: ${res.reason ?? "?"}`,
            res.advanced ? "green" : "yellow",
          );
          navigateTo("checkpoint");
          break;
        }
        case "run":
          pushBlock(`(run queued: ${cmd.agent} — "${cmd.task.slice(0, 60)}")`, "yellow");
          pushBlock("Run execution from the TUI needs the async runner (Phase 5.5). Use `sophron run` for now.", "gray");
          break;
        case "approve": {
          const res = approvals.resolve(cmd.id, cmd.decision === "yes" ? "allow" : "deny");
          pushBlock(
            res ? `Approved ${res.item.shortId}: ${res.decision}` : `No pending approval '${cmd.id}'`,
            res ? "green" : "red",
          );
          break;
        }
        case "rewind":
          pushBlock(`(rewind to ${cmd.runId} — checkpointer restore is Phase 5.5)`, "gray");
          break;
        case "clear":
          setBlocks([]);
          break;
        case "quit":
          exit();
          break;
        case "task":
          pushBlock(`(task: "${cmd.text.slice(0, 60)}")`, "yellow");
          pushBlock("Run execution from the TUI needs the async runner (Phase 5.5). Use `sophron run`.", "gray");
          break;
        case "unknown":
          pushBlock(`Unknown: ${cmd.reason}`, "red");
          break;
      }
    },
    [approvals, services.sharedMemoryStore, services.agentMemoryStore, navigateTo, pushBlock, exit],
  );

  // ── Keyboard handling — dual mode ──────────────────────────────────────
  useInput((inputChar, key) => {
    // Ctrl+C always exits.
    if (key.ctrl && inputChar === "c") {
      exit();
      return;
    }

    // Disable input during a project switch (services are being rebuilt).
    if (switching) return;

    // ── Project switcher overlay (takes over input when visible) ──
    if (showSwitcher) {
      const projects = listProjects();
      if (key.return) {
        const sel = projects[switcherIndex];
        if (sel) {
          void switchProject(sel.path);
        } else {
          setShowSwitcher(false);
        }
        return;
      }
      if (key.escape) {
        setShowSwitcher(false);
        return;
      }
      if (key.upArrow || key.downArrow) {
        setSwitcherIndex((p) => clampIndex(p + (key.upArrow ? -1 : 1), Math.max(projects.length, 1)));
        return;
      }
      return; // swallow other keys while the overlay is up
    }

    // Ctrl+P toggles the project switcher.
    if (key.ctrl && inputChar === "p") {
      setSwitcherIndex(0);
      setShowSwitcher((v) => !v);
      return;
    }

    if (mode === "compose") {
      // ── Compose mode: building a command/task ──
      if (key.return) {
        const line = input;
        setInput("");
        setMode("navigate");
        if (line.trim()) {
          // On the agent-detail page, free text is a task for THAT agent.
          if (page === "agentDetail" && selectedAgent && !line.startsWith("/")) {
            pushBlock(`${selectedAgent}> ${line}`, "yellow");
            pushBlock("Run execution from the TUI needs the async runner (Phase 5.5). Use `sophron run`.", "gray");
          } else {
            pushBlock(`> ${line}`, "gray");
            handleCommand(line);
          }
        }
        return;
      }
      if (key.escape) {
        setInput("");
        setMode("navigate");
        return;
      }
      if (key.backspace || key.delete) {
        setInput((prev) => prev.slice(0, -1));
        return;
      }
      if (inputChar && !key.ctrl && !key.meta && !key.escape) {
        setInput((prev) => prev + inputChar);
      }
      return;
    }

    // ── Navigate mode ──
    if (key.return) {
      // Home: Enter activates the selected menu item.
      if (page === "home") {
        const item = HOME_MENU[homeIndex];
        if (item) {
          if (item.page === "quit") exit();
          else navigateTo(item.page);
        }
        return;
      }
      // Agents list: Enter drills into the selected agent.
      if (page === "agents") {
        const a = model.agents[agentsIndex];
        if (a) openAgent(a.name);
        return;
      }
      // Runs list: Enter drills into the selected run.
      if (page === "runs") {
        const r = model.recentRuns[runsIndex];
        if (r) openRun(r.runId);
        return;
      }
      return;
    }
    if (key.escape) {
      // Esc: from a detail page, go back to its parent list; from a top-level
      // page, go to home; from home, exit.
      if (page === "agentDetail") {
        navigateTo("agents");
        setSelectedAgent(null);
      } else if (page === "runDetail") {
        navigateTo("runs");
        setSelectedRunId(null);
        setRunDetail(null);
      } else if (page !== "home") {
        navigateTo("home");
      } else {
        exit();
      }
      return;
    }
    // Arrow navigation on the list-bearing pages.
    if (key.upArrow || key.downArrow) {
      const delta = key.upArrow ? -1 : 1;
      if (page === "home") setHomeIndex((p) => clampIndex(p + delta, HOME_MENU.length));
      else if (page === "agents") setAgentsIndex((p) => clampIndex(p + delta, model.agents.length));
      else if (page === "runs") setRunsIndex((p) => clampIndex(p + delta, model.recentRuns.length));
      return;
    }
    // Any printable char → start composing (slash command or free text).
    if (inputChar && !key.ctrl && !key.meta && !key.upArrow && !key.downArrow && !key.return && !key.escape) {
      if (inputChar.charCodeAt(0) >= 32) {
        setMode("compose");
        setInput(inputChar);
      }
    }
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* ── Breadcrumb (includes active project name) ── */}
      <Box marginBottom={1}>
        <Text dimColor>
          SophronSwarm V3 ›{" "}
          <Text bold color="magenta">
            {activeProjectName}
          </Text>
          <Text dimColor> › </Text>
          <Text bold color="cyan">
            {page === "agentDetail" && selectedAgent
              ? `Agents › ${selectedAgent}`
              : page === "runDetail" && selectedRunId
                ? `Runs › ${selectedRunId.slice(0, 8)}`
                : PAGE_TITLES[page]}
          </Text>
        </Text>
      </Box>

      {/* ── Active page ── */}
      <Box flexDirection="column">
        {page === "home" && <HomePage model={model} selectedIndex={homeIndex} />}
        {page === "projects" && <ProjectsPage model={model} />}
        {page === "agents" && <AgentsPage model={model} selectedIndex={agentsIndex} />}
        {page === "agentDetail" && selectedAgent && (
          <AgentDetailPage model={model} agentName={selectedAgent} input={input} mode={mode} />
        )}
        {page === "runs" && <RunsPage model={model} selectedIndex={runsIndex} />}
        {page === "runDetail" && <RunDetailPage detail={runDetail} />}
        {page === "checkpoint" && <CheckpointPage model={model} />}
        {page === "cost" && <CostPage model={model} />}
        {page === "memory" && (
          <MemoryPage model={model} memoryContent={memoryContent} memoryLabel={memoryLabel} />
        )}
        {page === "help" && <HelpPage />}
      </Box>

      {/* ── Project switcher overlay (Ctrl+P / /projects) ── */}
      {showSwitcher && (
        <ProjectSwitcher
          projects={listProjects()}
          activePath={workspaceDir}
          selectedIndex={switcherIndex}
        />
      )}
      {switching && (
        <Box marginTop={1}>
          <Text bold color="yellow">
            ⟳ Switching project…
          </Text>
        </Box>
      )}

      {/* ── Output log ── */}
      {blocks.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>── output ──</Text>
          {blocks.map((b) => (
            <Text key={b.id} color={b.color as never}>
              {b.text}
            </Text>
          ))}
        </Box>
      )}

      {/* ── Input line (hidden on agentDetail — it has its own inline input) ── */}
      {page !== "agentDetail" && (
        <Box marginTop={1}>
          <Text bold color={mode === "compose" ? "cyan" : "gray"}>
            {"> "}
          </Text>
          <Text>{input}</Text>
          <Text dimColor>{mode === "compose" ? "" : "▏"}</Text>
        </Box>
      )}

      {/* ── Footer hints ── */}
      <Text dimColor>
        {mode === "compose"
          ? " Enter submit · Esc cancel · Ctrl+C exit"
          : showSwitcher
            ? " ↑↓ select · Enter switch · Esc cancel"
            : page === "home"
              ? " ↑↓ navigate · Enter select · Ctrl+P switch project · Esc exit · type to command"
              : page === "agents" || page === "runs"
                ? " ↑↓ navigate · Enter open · Esc back · Ctrl+P switch · type to command"
                : page === "agentDetail" || page === "runDetail"
                  ? " Esc back · Ctrl+P switch project · type to command · Ctrl+C exit"
                  : " Esc back to menu · Ctrl+P switch project · type to command · Ctrl+C exit"}
      </Text>
    </Box>
  );
}

// Re-export HELP_TEXT for backward compat with any direct importers.
export { HELP_TEXT };
