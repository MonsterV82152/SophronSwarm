/**
 * App — the SophronSwarm TUI shell (M3 rewrite).
 *
 * Box-chrome shell with two surfaces, each with a horizontal tab bar:
 *   - **home**    — Overview · Orchestrator (global chat, M8) · Projects
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
import React, { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { Box, Text, useInput, useApp, useStdout } from "ink";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { parseSlashCommand } from "./slashCommands.js";
import { clearTerminal } from "./clearTerminal.js";
import { resolveModelTarget } from "./modelTarget.js";
import { resolveModelSpec } from "../llm/providers.js";
import { updateAgentModelFile } from "../agent/updateModel.js";
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
import { OrchestratorChat, type ChatMessage } from "./components/OrchestratorChat.js";
import { switchServices } from "../services/lifecycle.js";
import { runAgent } from "../agent/loop.js";
import { listProjects, registerProject, type ProjectEntry } from "../project/registry.js";
import type { SharedServices } from "../tools/schema.js";
import type { ApprovalsQueue } from "./approvals.js";
import type { AgentRegistry } from "../agent/registry.js";
import type { ModelOverride } from "../types.js";

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

  // ── Global orchestrator chat (M8) ──
  const [orchestratorMessages, setOrchestratorMessages] = useState<ChatMessage[]>([]);
  const [orchestratorRunning, setOrchestratorRunning] = useState(false);
  // Monotonic message ID counter (avoids Date.now() collisions if two messages
  // land in the same millisecond).
  const msgIdRef = useRef(0);
  const nextMsgId = useCallback(() => ++msgIdRef.current, []);
  // Whether the global-orchestrator agent is installed (checked lazily).
  const orchestratorInstalled = useMemo(() => registry.get("global-orchestrator") != null, [registry]);

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

  // Use a ref to maintain a monotonically increasing ID counter for output blocks.
  // This prevents duplicate keys when the array is sliced to keep only the last 6 items.
  const blockIdRef = useRef(0);
  const pushBlock = useCallback((text: string, color?: string) => {
    const id = blockIdRef.current++;
    setBlocks((prev) => [...prev.slice(-6), { id, text, color }]);
  }, []);

  // ── Surface/project switch state cleanup ──
  // Reset surface-specific state when the operator switches surfaces or
  // projects so stale detail/memory/run data cannot bleed into the new view.
  const prevSurfaceRef = useRef(nav.surface);
  const prevProjectRef = useRef(activeProjectName);
  useEffect(() => {
    const surfaceChanged = prevSurfaceRef.current !== nav.surface;
    const projectChanged = prevProjectRef.current !== activeProjectName;
    prevSurfaceRef.current = nav.surface;
    prevProjectRef.current = activeProjectName;
    if (surfaceChanged || projectChanged) {
      setRunDetail(null);
      setMemoryContent("");
      setMemoryLabel("shared memory files");
    }
  }, [nav.surface, activeProjectName]);

  // ── Runtime model overrides (M11) ──
  // Keyed by agent name. Used by `/model` and surfaced in Agent detail.
  const [modelOverrides, setModelOverrides] = useState<Record<string, ModelOverride>>({});

  const effectiveModelFor = useCallback(
    (agentName: string): string | undefined => {
      const override = modelOverrides[agentName];
      if (override) return override.model;
      const agent = registry.get(agentName);
      return agent?.model;
    },
    [modelOverrides, registry],
  );

  const applyModelOverride = useCallback(
    (agentName: string, spec: string): boolean => {
      try {
        const resolved = resolveModelSpec(spec);
        // Persist the change to the agent's .md file so it survives the session.
        const agent = registry.get(agentName);
        if (agent?.filePath) {
          updateAgentModelFile(agent.filePath, resolved);
          pushBlock(`Updated ${agentName} model file: ${resolved.model} [${resolved.provider}]`, "green");
        } else {
          pushBlock(`Model override set for ${agentName}: ${resolved.model} [${resolved.provider}] (file not available)`, "yellow");
        }
        // Also keep the runtime override so the very next run uses it immediately,
        // even before the file watcher rescans.
        setModelOverrides((prev) => ({ ...prev, [agentName]: resolved }));
        return true;
      } catch (e) {
        pushBlock(`Could not set model for ${agentName}: ${(e as Error).message}`, "red");
        return false;
      }
    },
    [pushBlock, registry],
  );

  // Dispatch a nav action (clamps list selections against current data sizes).
  // Surface-changing actions clear the terminal synchronously first so Ink
  // paints the new frame onto a blank screen instead of stacking it.
  const dispatch = useCallback(
    (action: NavAction) => {
      const changesSurface =
        action.kind === "goHome" ||
        action.kind === "enterProject" ||
        (action.kind === "exitUp" && nav.surface === "project" && nav.focus === "tabs");
      if (changesSurface) clearTerminal(stdout);
      const projects = listProjects();
      setNav((prev) =>
        navReducer(prev, action, {
          projects: projects.length,
          agents: model.agents.length,
          runs: model.recentRuns.length,
        }),
      );
    },
    [model.agents.length, model.recentRuns.length, nav.surface, nav.focus, stdout],
  );

  // ── Project switching (teardown + rebuild services) ──
  const switchProject = useCallback(
    async (projectPath: string) => {
      // Clear the terminal (including scrollback) before rebuilding so the new
      // project frame replaces the previous one instead of stacking below it.
      clearTerminal(stdout);
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
        // Full nav reset — don't spread prev (stale tab indices + input leak
        // across projects). Start fresh on the Status tab of the new project.
        setNav({ ...initialNavState(), surface: "project", focus: "tabs" });
        setRunDetail(null);
        // Clear stale output-log entries from the previous project context.
        setBlocks([]);
        setMemoryContent("");
        pushBlock(`Switched to project: ${entry.name}`, "green");
      } catch (e) {
        pushBlock(`Switch failed: ${(e as Error).message}`, "red");
      } finally {
        setSwitching(false);
      }
    },
    [services, registry, pushBlock, stdout],
  );

  // ── Global orchestrator chat (M8) ──
  // Runs the global-orchestrator agent loop with the operator's message as the
  // task. The global orchestrator lives at ~/.sophron/agents/global-orchestrator.md
  // and has NO memory + NO codebase workspace — it only manages the project
  // lifecycle (propose / create / list). Its working dir is ~/.sophron/.
  const handleOrchestratorMessage = useCallback(
    async (text: string) => {
      const agent = registry.get("global-orchestrator");
      if (!agent) {
        setOrchestratorMessages((prev) => [
          ...prev,
          {
            id: nextMsgId(),
            role: "orchestrator",
            text: "The global orchestrator is not installed. Run:\n  sophron init --install-orchestrator",
          },
        ]);
        return;
      }

      // Append the user's message + a "thinking" marker.
      setOrchestratorMessages((prev) => [...prev, { id: nextMsgId(), role: "user", text }]);
      setOrchestratorRunning(true);
      try {
        const result = await runAgent({
          agent,
          task: text,
          workingDir: resolve(homedir(), ".sophron"),
          llm: services.llm,
          dispatcher: services.dispatcher,
          checkpointer: services.checkpointer,
          services,
          modelOverride: modelOverrides[agent.name],
        });
        const reply = result.state.messages
          .filter((m) => m.role === "assistant" && m.content)
          .map((m) => m.content as string)
          .join("\n")
          .trim() || "(no response)";
        setOrchestratorMessages((prev) => [...prev, { id: nextMsgId(), role: "orchestrator", text: reply }]);
      } catch (e) {
        setOrchestratorMessages((prev) => [
          ...prev,
          { id: nextMsgId(), role: "orchestrator", text: `Error: ${(e as Error).message}` },
        ]);
      } finally {
        setOrchestratorRunning(false);
      }
    },
    [registry, services, nextMsgId, modelOverrides],
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
      // On the Orchestrator tab, free text is a message to the global orchestrator.
      if (
        !raw.startsWith("/") &&
        nav.surface === "home" &&
        activeHomeTab(nav) === "orchestrator" &&
        !orchestratorRunning
      ) {
        void handleOrchestratorMessage(raw);
        return;
      }
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
          clearTerminal(stdout);
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
        case "model": {
          // Resolve the target agent from context when no explicit agent is given.
          const targetAgent = resolveModelTarget(nav, model, cmd.agent);
          if (!targetAgent) {
            pushBlock("Use /model <spec> from an agent view, or /model <agent> <spec>.", "yellow");
            break;
          }
          applyModelOverride(targetAgent, cmd.spec);
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
          // On the Orchestrator tab, /clear also resets the chat thread.
          if (nav.surface === "home" && activeHomeTab(nav) === "orchestrator") {
            setOrchestratorMessages([]);
            pushBlock("Cleared chat thread + output log.", "gray");
          }
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
    [nav.surface, nav.agentDetail, nav.homeTabIndex, nav.projectTabIndex, nav.agentsIndex, services, approvals, pushBlock, exit, handleOrchestratorMessage, orchestratorRunning, applyModelOverride, model],
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
  const rows = stdout?.rows ?? 24;
  const activeProjectPath = projects.find((p) => p.name === activeProjectName)?.path ?? "";

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} height={rows - 1}>
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
      {/* No remount key: React reconciles the content pane in place. Surface /
          project switches clear the terminal synchronously before the new
          frame is painted, and the root Box is fixed to the terminal height. */}
      <Box flexDirection="column" flexGrow={1}>
        {isHome ? (
          <HomeContent nav={nav} overview={overview} activeProjectName={activeProjectName} projects={projects} activeProjectPath={activeProjectPath} onOrchestratorMessage={handleOrchestratorMessage} orchestratorMessages={orchestratorMessages} orchestratorRunning={orchestratorRunning} orchestratorInstalled={orchestratorInstalled} />
        ) : (
          <ProjectContent
            nav={nav}
            model={model}
            runDetail={runDetail}
            memoryContent={memoryContent}
            memoryLabel={memoryLabel}
            effectiveModelFor={effectiveModelFor}
          />
        )}
      </Box>

      {/* ── Output log (command feedback) ── */}
      {blocks.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>── output ──</Text>
          {blocks.slice(-4).map((b) => (
            <Text key={b.id} color={b.color as "red" | "green" | "yellow" | "cyan" | "gray" | undefined}>
              {b.text.length > cols - 8 ? `${b.text.slice(0, cols - 11)}...` : b.text}
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
  onOrchestratorMessage,
  orchestratorMessages,
  orchestratorRunning,
  orchestratorInstalled,
}: {
  nav: NavState;
  overview: OverviewModel;
  activeProjectName: string;
  projects: ProjectEntry[];
  activeProjectPath: string;
  onOrchestratorMessage: (text: string) => void;
  orchestratorMessages: ChatMessage[];
  orchestratorRunning: boolean;
  orchestratorInstalled: boolean;
}) {
  const tab = activeHomeTab(nav);
  if (tab === "overview") {
    return <OverviewTab overview={overview} activeProjectName={activeProjectName} />;
  }
  if (tab === "orchestrator") {
    return (
      <OrchestratorChat
        messages={orchestratorMessages}
        running={orchestratorRunning}
        installed={orchestratorInstalled}
        onSubmit={onOrchestratorMessage}
      />
    );
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
  effectiveModelFor,
}: {
  nav: NavState;
  model: ReturnType<typeof buildDashboard>;
  runDetail: RunDetail | null;
  memoryContent: string;
  memoryLabel: string;
  effectiveModelFor?: (agentName: string) => string | undefined;
}) {
  if (nav.agentDetail) {
    return <AgentDetail model={model} agentName={nav.agentDetail} effectiveModel={effectiveModelFor?.(nav.agentDetail)} />;
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
