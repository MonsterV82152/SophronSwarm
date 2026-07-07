/**
 * App — the SophronSwarm TUI shell (M3 rewrite).
 *
 * Box-chrome shell with two surfaces, each with a horizontal tab bar:
 *   - **home**    — Overview · Orchestrator(stub) · Projects
 *   - **project** — Status · Agents · Runs · Checkpoint · Memory · Cost
 *
 * Navigation is owned by the pure reducer in `nav.ts` (the fix for the first
 * M3 attempt's "broken and confusing" UX). This component is a thin shell:
 *   1. holds services/workspace/registry in state (for project switching),
 *   2. reduces keyboard input into nav actions,
 *   3. renders the box chrome + the active surface's tabs + content + input bar.
 *
 * See docs/ROADMAP.md (M3).
 */
import React, { useState, useCallback, useEffect, useMemo } from "react";
import { Box, Text, useInput, useApp, useStdout } from "ink";
import { resolve } from "node:path";
import { parseSlashCommand } from "./slashCommands.js";
import { helpForView, helpViewFor } from "./help.js";
import { buildDashboard, buildOverview, readRunDetail, type OverviewModel, type RunDetail } from "./dashboard.js";
import { CheckpointManager } from "../memory/checkpoints.js";
import {
  initialNavState,
  navReducer,
  HOME_TABS,
  PROJECT_TABS,
  HOME_TAB_LABELS,
  PROJECT_TAB_LABELS,
  activeHomeTab,
  activeProjectTab,
  type NavState,
  type NavAction,
} from "./nav.js";
import { Banner } from "./components/Banner.js";
import { TabBar } from "./components/TabBar.js";
import { InputBar } from "./components/InputBar.js";
import { OverviewTab } from "./components/OverviewTab.js";
import { OrchestratorTab } from "./components/OrchestratorTab.js";
import { ProjectsTab } from "./components/ProjectsTab.js";
import {
  StatusTab,
  AgentsTab,
  RunsTab,
  RunDetailView,
  CheckpointTab,
  MemoryTab,
  CostTab,
} from "./components/ProjectTabs.js";
import { AgentDetail } from "./components/AgentDetail.js";
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

interface OutputBlock {
  id: number;
  text: string;
  color?: string;
}

export function App({ services: initialServices, workspaceDir: initialDir, approvals: initialApprovals, registry: initialRegistry }: AppProps) {
  // ── Services + workspace in STATE so they rebuild on project switch ──
  const [services, setServices] = useState<SharedServices>(initialServices);
  const [registry, setRegistry] = useState<AgentRegistry>(initialRegistry);
  const [workspaceDir, setWorkspaceDir] = useState(initialDir);
  const [approvals, setApprovals] = useState<ApprovalsQueue>(initialApprovals);
  const [activeProjectName, setActiveProjectName] = useState(() => {
    const entry = listProjects().find((p) => p.path === resolve(initialDir));
    return entry?.name ?? (initialDir.split("/").pop() || "project");
  });
  const [switching, setSwitching] = useState(false);
  const { exit } = useApp();
  const { stdout } = useStdout();

  // ── Navigation state (the reducer owns all nav logic) ──
  const [nav, setNav] = useState<NavState>(initialNavState());

  // ── Output log (for slash-command feedback) ──
  const [blocks, setBlocks] = useState<OutputBlock[]>([]);
  // ── Memory viewer content ──
  const [memoryContent, setMemoryContent] = useState("");
  const [memoryLabel, setMemoryLabel] = useState("shared memory files");
  // ── Run detail (drill-down from Runs) ──
  const [runDetail, setRunDetail] = useState<RunDetail | null>(null);

  // ── Dashboard model (recomputed when services/workspace change) ──
  const model = useMemo(
    () => buildDashboard(services, { workspaceDir, approvalsPending: approvals.size }),
    [services, workspaceDir, approvals.size],
  );

  // ── Overview model (recomputed periodically for live-ish health) ──
  const [overviewTick, setOverviewTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setOverviewTick((n) => n + 1), 2000);
    return () => clearInterval(t);
  }, []);

  const pushBlock = useCallback((text: string, color?: string) => {
    setBlocks((prev) => [...prev.slice(-6), { id: prev.length, text, color }]);
  }, []);

  // Dispatch a nav action (clamps list selections against current data sizes).
  const dispatch = useCallback(
    (action: NavAction) => {
      const projects = listProjects();
      setNav((prev) =>
        navReducer(prev, action, {
          projects: projects.length,
          agents: model.agents.length,
          runs: model.recentRuns.length,
        }),
      );
    },
    [model.agents.length, model.recentRuns.length],
  );

  // ── Project switching (teardown + rebuild services) ──
  const switchProject = useCallback(
    async (projectPath: string) => {
      const absPath = resolve(projectPath);
      setSwitching(true);
      pushBlock(`Switching to ${absPath}…`, "yellow");
      try {
        const entry = registerProject(absPath);
        const { services: newServices, registry: newRegistry } = await switchServices(services, registry, absPath);
        setServices(newServices);
        setRegistry(newRegistry);
        setApprovals(newServices.approvals);
        setWorkspaceDir(absPath);
        setActiveProjectName(entry.name);
        setNav((prev) => ({ ...prev, surface: "project", focus: "tabs", agentDetail: null, runDetail: null, agentsIndex: 0, runsIndex: 0 }));
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

  // ── Open the selected list item (Enter in content focus) ──
  const handleOpenSelected = useCallback(() => {
    // Projects tab → enter the selected project.
    if (nav.surface === "home" && activeHomeTab(nav) === "projects") {
      const sel = listProjects()[nav.projectsIndex];
      if (sel) void switchProject(sel.path);
      return;
    }
    // Agents tab → open agent detail.
    if (nav.surface === "project" && activeProjectTab(nav) === "agents") {
      const sel = model.agents[nav.agentsIndex];
      if (sel) dispatch({ kind: "openAgentDetail", name: sel.name });
      return;
    }
    // Runs tab → open run detail.
    if (nav.surface === "project" && activeProjectTab(nav) === "runs") {
      const sel = model.recentRuns[nav.runsIndex];
      if (sel) {
        setRunDetail(readRunDetail(workspaceDir, sel.runId));
        dispatch({ kind: "openRunDetail", runId: sel.runId });
      }
      return;
    }
  }, [nav, model, workspaceDir, switchProject, dispatch]);

  // ── Command handling (slash commands + free-text tasks) ──
  const handleCommand = useCallback(
    (raw: string) => {
      // On Agent detail, free text is a task for THAT agent.
      if (nav.agentDetail && !raw.startsWith("/")) {
        pushBlock(`${nav.agentDetail}> ${raw}`, "yellow");
        pushBlock(`(task queued — run via: sophron run ${nav.agentDetail} "${raw.slice(0, 60)}")`, "gray");
        return;
      }
      const cmd = parseSlashCommand(raw);
      switch (cmd.kind) {
        case "help": {
          const detail = nav.agentDetail ? "agent" : nav.runDetail ? "run" : null;
          const view = helpViewFor(
            nav.surface,
            activeHomeTab(nav),
            activeProjectTab(nav),
            detail,
          );
          for (const line of helpForView(view).split("\n")) pushBlock(line, "cyan");
          break;
        }
        case "projects":
          setNav((p) => ({ ...p, surface: "home", homeTabIndex: HOME_TABS.indexOf("projects"), focus: "content", agentDetail: null, runDetail: null }));
          break;
        case "agents":
          if (nav.surface === "project") setNav((p) => ({ ...p, projectTabIndex: PROJECT_TABS.indexOf("agents"), focus: "content" }));
          else pushBlock("Enter a project first (Home › Projects tab).", "yellow");
          break;
        case "runs":
          if (nav.surface === "project") setNav((p) => ({ ...p, projectTabIndex: PROJECT_TABS.indexOf("runs"), focus: "content" }));
          else pushBlock("Enter a project first.", "yellow");
          break;
        case "checkpoint":
          if (nav.surface === "project") setNav((p) => ({ ...p, projectTabIndex: PROJECT_TABS.indexOf("checkpoint"), focus: "tabs" }));
          else pushBlock("Enter a project first.", "yellow");
          break;
        case "advance": {
          const mgr = new CheckpointManager(services.sharedMemoryStore);
          const res = mgr.advance();
          pushBlock(res.advanced ? `Advanced to: ${res.current?.title}` : `Not advanced: ${res.reason ?? "?"}`, res.advanced ? "green" : "yellow");
          break;
        }
        case "cost":
          if (nav.surface === "project") setNav((p) => ({ ...p, projectTabIndex: PROJECT_TABS.indexOf("cost"), focus: "tabs" }));
          break;
        case "memory": {
          if (cmd.agent) {
            const mem = services.agentMemoryStore.readForInjection(cmd.agent);
            setMemoryLabel(`agent: ${cmd.agent}`);
            setMemoryContent(mem || `(no memory for agent '${cmd.agent}')`);
          } else {
            const files = services.sharedMemoryStore.listFiles();
            setMemoryLabel("shared memory files");
            setMemoryContent(files.length > 0 ? files.map((f) => `- ${f}`).join("\n") : "(no shared memory files)");
          }
          if (nav.surface === "project") setNav((p) => ({ ...p, projectTabIndex: PROJECT_TABS.indexOf("memory"), focus: "tabs" }));
          break;
        }
        case "approve": {
          const res = approvals.resolve(cmd.id, cmd.decision === "yes" ? "allow" : "deny");
          pushBlock(res ? `Approved ${res.item.shortId}: ${res.decision}` : `No pending approval '${cmd.id}'`, res ? "green" : "red");
          break;
        }
        case "rewind":
          pushBlock(`(rewind to ${cmd.runId} — checkpointer restore pending)`, "gray");
          break;
        case "clear":
          setBlocks([]);
          break;
        case "quit":
          exit();
          break;
        case "run":
          pushBlock(`(run queued: ${cmd.agent} — "${cmd.task.slice(0, 60)}")`, "yellow");
          pushBlock(`Run via: sophron run ${cmd.agent} "${cmd.task.slice(0, 60)}"`, "gray");
          break;
        case "task":
          pushBlock(`(task: "${cmd.text.slice(0, 60)}")`, "yellow");
          pushBlock("Run execution from the TUI needs the async runner. Use `sophron run`.", "gray");
          break;
        case "unknown":
          pushBlock(`Unknown: ${cmd.reason}`, "red");
          break;
      }
    },
    [nav.surface, nav.agentDetail, services, approvals, pushBlock, exit],
  );

  // ── Keyboard input → nav actions ──
  useInput((inputChar, key) => {
    if (key.ctrl && inputChar === "c") {
      exit();
      return;
    }
    if (switching) return;

    // ── Input bar focus ──
    if (nav.focus === "input") {
      if (key.return) {
        const line = nav.input;
        dispatch({ kind: "inputSubmit" });
        if (line.trim()) {
          pushBlock(`> ${line}`, "gray");
          handleCommand(line);
        }
        return;
      }
      if (key.escape) {
        dispatch({ kind: "inputCancel" });
        return;
      }
      if (key.backspace || key.delete) {
        dispatch({ kind: "inputBackspace" });
        return;
      }
      if (inputChar && !key.ctrl && !key.meta && !key.escape) {
        dispatch({ kind: "inputType", char: inputChar });
      }
      return;
    }

    // ── Tab bar / content navigation ──
    if (key.leftArrow) {
      dispatch({ kind: "tabLeft" });
      return;
    }
    if (key.rightArrow) {
      dispatch({ kind: "tabRight" });
      return;
    }
    if (key.upArrow) {
      // ↑ on tabs → exit up a level (project → home). ↑ in content → move the
      // list up; if already at the top (index 0) or not on a list, exit back
      // to tabs. This lets ↑ both navigate lists and exit, matching the spec's
      // "escape/up arrow to exit" while keeping lists usable.
      if (nav.focus === "tabs") {
        dispatch({ kind: "exitUp" });
      } else if (nav.focus === "content") {
        const atTop =
          (nav.surface === "home" && activeHomeTab(nav) === "projects" && nav.projectsIndex <= 0) ||
          (nav.surface === "project" && activeProjectTab(nav) === "agents" && nav.agentsIndex <= 0) ||
          (nav.surface === "project" && activeProjectTab(nav) === "runs" && nav.runsIndex <= 0);
        if (atTop) dispatch({ kind: "exitUp" });
        else dispatch({ kind: "listUp" });
      }
      return;
    }
    if (key.downArrow) {
      if (nav.focus === "tabs") dispatch({ kind: "enterTab" });
      else dispatch({ kind: "listDown" });
      return;
    }
    if (key.return) {
      if (nav.focus === "tabs") {
        dispatch({ kind: "enterTab" });
      } else if (nav.focus === "content" && !nav.agentDetail && !nav.runDetail) {
        handleOpenSelected();
      }
      return;
    }
    if (key.escape) {
      if (nav.agentDetail || nav.runDetail) {
        setRunDetail(null);
        dispatch({ kind: "closeDetail" });
      } else {
        dispatch({ kind: "exitUp" });
      }
      return;
    }
    // Any printable char → focus the input bar (seeded with the char).
    if (inputChar && !key.ctrl && !key.meta && inputChar.charCodeAt(0) >= 32) {
      dispatch({ kind: "focusInput", char: inputChar });
    }
  });

  // ── Overview model (for the Home Overview tab) ──
  const overview = useMemo(
    () => buildOverview(approvals.size),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [approvals.size, overviewTick],
  );

  const projects = useMemo(() => listProjects(), [overviewTick]);

  // ── Render: which tab labels + which content ──
  const isHome = nav.surface === "home";
  const tabLabels = isHome
    ? HOME_TABS.map((t) => HOME_TAB_LABELS[t])
    : PROJECT_TABS.map((t) => PROJECT_TAB_LABELS[t]);
  const tabIndex = isHome ? nav.homeTabIndex : nav.projectTabIndex;
  const tabsFocused = nav.focus === "tabs";
  const cols = stdout?.columns ?? 80;
  const activeProjectPath = projects.find((p) => p.name === activeProjectName)?.path ?? "";

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      {/* ── Header: ASCII banner ── */}
      <Banner version="SophronSwarm V3" />

      {/* ── Divider ── */}
      <Text color="cyan">{"─".repeat(Math.max(cols - 4, 20))}</Text>

      {/* ── Breadcrumb ── */}
      <Box>
        <Text dimColor>
          {isHome ? (
            "Home"
          ) : (
            <>
              {"Home › "}
              <Text color="magenta">{activeProjectName}</Text>
              {nav.agentDetail ? ` › Agents › ${nav.agentDetail}` : ""}
              {nav.runDetail ? ` › Runs › ${(nav.runDetail ?? "").slice(0, 8)}` : ""}
            </>
          )}
        </Text>
      </Box>

      {/* ── Tab bar ── */}
      <Box marginBottom={1}>
        <TabBar labels={tabLabels} selectedIndex={tabIndex} focused={tabsFocused} />
      </Box>

      {/* ── Content area ── */}
      <Box flexDirection="column" flexGrow={1}>
        {isHome ? (
          <HomeContent nav={nav} overview={overview} activeProjectName={activeProjectName} projects={projects} activeProjectPath={activeProjectPath} />
        ) : (
          <ProjectContent
            nav={nav}
            model={model}
            runDetail={runDetail}
            memoryContent={memoryContent}
            memoryLabel={memoryLabel}
          />
        )}
      </Box>

      {/* ── Output log (command feedback) ── */}
      {blocks.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>── output ──</Text>
          {blocks.map((b) => (
            <Text key={b.id} color={b.color as "red" | "green" | "yellow" | "cyan" | "gray" | undefined}>
              {b.text}
            </Text>
          ))}
        </Box>
      ) : null}

      {/* ── Footer: input bar ── */}
      <Box marginTop={1}>
        <InputBar value={nav.input} focused={nav.focus === "input"} disabled={switching} prompt={nav.agentDetail ? `${nav.agentDetail}>` : ">"} />
      </Box>

      {/* ── Hint line ── */}
      <Text dimColor>{"  "}←/→ tabs · ↑/↓ list · Enter open · Esc back · type for input · Ctrl+C quit</Text>
    </Box>
  );
}

// ── Home surface content ────────────────────────────────────────────────────

function HomeContent({
  nav,
  overview,
  activeProjectName,
  projects,
  activeProjectPath,
}: {
  nav: NavState;
  overview: OverviewModel;
  activeProjectName: string;
  projects: ProjectEntry[];
  activeProjectPath: string;
}) {
  const tab = activeHomeTab(nav);
  if (tab === "overview") {
    return <OverviewTab overview={overview} activeProjectName={activeProjectName} />;
  }
  if (tab === "orchestrator") {
    return <OrchestratorTab />;
  }
  return <ProjectsTab projects={projects} selectedIndex={nav.projectsIndex} activePath={activeProjectPath} />;
}

// ── Project surface content ─────────────────────────────────────────────────

function ProjectContent({
  nav,
  model,
  runDetail,
  memoryContent,
  memoryLabel,
}: {
  nav: NavState;
  model: ReturnType<typeof buildDashboard>;
  runDetail: RunDetail | null;
  memoryContent: string;
  memoryLabel: string;
}) {
  if (nav.agentDetail) {
    return <AgentDetail model={model} agentName={nav.agentDetail} />;
  }
  if (nav.runDetail) {
    return <RunDetailView detail={runDetail} />;
  }
  const tab = activeProjectTab(nav);
  switch (tab) {
    case "status":
      return <StatusTab model={model} />;
    case "agents":
      return <AgentsTab model={model} selectedIndex={nav.agentsIndex} />;
    case "runs":
      return <RunsTab model={model} selectedIndex={nav.runsIndex} />;
    case "checkpoint":
      return <CheckpointTab model={model} />;
    case "memory":
      return <MemoryTab content={memoryContent} label={memoryLabel} />;
    case "cost":
      return <CostTab model={model} />;
  }
}
