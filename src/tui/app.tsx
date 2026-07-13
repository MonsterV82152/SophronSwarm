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
import { helpForView, helpViewFor } from "./help.js";
import { reresolveModel } from "../llm/providers.js";
import { updateAgentFrontmatter } from "../agent/loader.js";
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
import { ChatInput } from "./components/ChatInput.js";
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
import { ChannelView } from "./components/ChannelView.js";
import { OrchestratorChat, type ChatMessage } from "./components/OrchestratorChat.js";
import { runManager } from "../agent/runManager.js";
import { switchServices } from "../services/lifecycle.js";
import { runAgent } from "../agent/loop.js";
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

/** Determine which chrome layer a given nav state should render. */
export function chromeForView(nav: NavState): "boxed" | "bare" {
  // Chat views are bare.
  if (nav.surface === "home" && activeHomeTab(nav) === "orchestrator") return "bare";
  if (nav.detail === "agentChannel" && nav.agentDetail) return "bare";
  // Everything else (dashboards, lists, read-only details) stays boxed.
  return "boxed";
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
    [services, registry, pushBlock],
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
    [registry, services, nextMsgId],
  );

  // ── Open the selected list item (Enter in content focus) ──
  const handleOpenSelected = useCallback(() => {
    // Projects tab → enter the selected project.
    if (nav.surface === "home" && activeHomeTab(nav) === "projects") {
      const sel = listProjects()[nav.projectsIndex];
      if (sel) void switchProject(sel.path);
      return;
    }
    // Agents tab → open agent channel.
    if (nav.surface === "project" && activeProjectTab(nav) === "agents") {
      const sel = model.agents[nav.agentsIndex];
      if (sel) dispatch({ kind: "openAgentChannel", name: sel.name });
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
      // On Agent detail or channel, free text is a task for THAT agent.
      if (nav.agentDetail && !raw.startsWith("/")) {
        const agent = registry.get(nav.agentDetail);
        if (!agent) {
          pushBlock(`Unknown agent '${nav.agentDetail}'.`, "red");
          return;
        }
        if (nav.detail === "agentChannel" && agent.tools?.includes("delegate")) {
          // Interactive orchestrator channel: start a run directly.
          const { runId } = runManager.start({
            agent,
            task: raw,
            workingDir: workspaceDir,
            llm: services.llm,
            dispatcher: services.dispatcher,
            checkpointer: services.checkpointer,
            services,
          });
          pushBlock(`Started run ${runId.slice(0, 8)} for ${agent.name}`, "green");
        } else {
          pushBlock(`${nav.agentDetail}> ${raw}`, "yellow");
          pushBlock(`(task queued — run via: sophron run ${nav.agentDetail} "${raw.slice(0, 60)}")`, "gray");
        }
        return;
      }
      const cmd = parseSlashCommand(raw);
      switch (cmd.kind) {
        case "help": {
          let detail: "agent" | "agentChannel" | "run" | null = null;
          if (nav.agentDetail) {
            detail = nav.detail === "agentChannel" ? "agentChannel" : "agent";
          } else if (nav.runDetail) {
            detail = "run";
          }
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
          setNav((p) => ({ ...p, surface: "home", homeTabIndex: HOME_TABS.indexOf("projects"), focus: "content", agentDetail: null, runDetail: null, detail: null }));
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
        case "stop": {
          const active = nav.agentDetail ? runManager.isRunning(nav.agentDetail) : undefined;
          if (active) {
            runManager.stop(active.runId);
            pushBlock(`Stopped run ${active.runId.slice(0, 8)} for ${active.agentName}`, "yellow");
          } else {
            pushBlock("No active run to stop.", "gray");
          }
          break;
        }
        case "clear":
          setBlocks([]);
          // On the Orchestrator tab, /clear also resets the chat thread.
          if (nav.surface === "home" && activeHomeTab(nav) === "orchestrator") {
            setOrchestratorMessages([]);
            pushBlock("Cleared chat thread + output log.", "gray");
          }
          break;
        case "model": {
          const agentName = cmd.agent ?? nav.agentDetail;
          if (!agentName) {
            pushBlock("Specify an agent: /model <agent> <model-id>, or open an agent detail/channel.", "yellow");
            break;
          }
          const agent = registry.get(agentName);
          if (!agent) {
            pushBlock(`Unknown agent '${agentName}'.`, "red");
            break;
          }
          if (!cmd.model) {
            pushBlock(`${agentName}: model=${agent.model} provider=${agent.provider ?? "(none)"}`, "cyan");
            break;
          }
          try {
            const resolved = reresolveModel(agent, cmd.model);
            agent.model = resolved.model;
            agent.provider = resolved.provider;
            updateAgentFrontmatter(agent.filePath, { model: resolved.model, provider: resolved.provider });
            pushBlock(`Updated ${agentName}: model=${resolved.model} provider=${resolved.provider}`, "green");
          } catch (e) {
            pushBlock(`Model update failed: ${(e as Error).message}`, "red");
          }
          break;
        }
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
    [nav.surface, nav.agentDetail, nav.detail, nav.runDetail, nav.homeTabIndex, nav.projectTabIndex, registry, services, approvals, pushBlock, exit, handleOrchestratorMessage, orchestratorRunning],
  );

  // ── Keyboard input → nav actions ──
  const interactiveChannel =
    nav.detail === "agentChannel" &&
    nav.agentDetail != null &&
    registry.get(nav.agentDetail)?.tools?.includes("delegate") === true;

  useInput((inputChar, key) => {
    if (key.ctrl && inputChar === "c") {
      // In an agent channel, Ctrl+C stops the active run first.
      if (nav.detail === "agentChannel" && nav.agentDetail) {
        const active = runManager.isRunning(nav.agentDetail);
        if (active) {
          runManager.stop(active.runId);
          pushBlock(`Stopped run ${active.runId.slice(0, 8)} for ${active.agentName}`, "yellow");
          return;
        }
      }
      exit();
      return;
    }

    // In an interactive channel, ChatInput owns all keys except Ctrl+C.
    if (interactiveChannel) return;

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

  const chrome = chromeForView(nav);
  const content = (
    <Box key={`${nav.surface}:${activeProjectName}`} flexDirection="column" flexGrow={1}>
      {isHome ? (
        <HomeContent nav={nav} overview={overview} activeProjectName={activeProjectName} projects={projects} activeProjectPath={activeProjectPath} onOrchestratorMessage={handleOrchestratorMessage} orchestratorMessages={orchestratorMessages} orchestratorRunning={orchestratorRunning} orchestratorInstalled={orchestratorInstalled} />
      ) : (
        <ProjectContent
          nav={nav}
          model={model}
          runDetail={runDetail}
          memoryContent={memoryContent}
          memoryLabel={memoryLabel}
          workspaceDir={workspaceDir}
          registry={registry}
        />
      )}
    </Box>
  );

  if (chrome === "bare") {
    // Bare chat chrome: no box border, no tab bar, single-line status.
    const context = nav.detail === "agentChannel" && nav.agentDetail
      ? `Agents › ${nav.agentDetail}`
      : "Global Orchestrator";
    return (
      <Box flexDirection="column" flexGrow={1}>
        <Banner version="V3" compact={context} />
        {content}
        <Box marginTop={1}>
          {interactiveChannel && nav.agentDetail ? (
            <ChatInput
              workspaceDir={workspaceDir}
              onSubmit={({ text, attachments }) => {
                const agent = registry.get(nav.agentDetail!);
                if (!agent) return;
                const { runId } = runManager.start({
                  agent,
                  task: text,
                  workingDir: workspaceDir,
                  llm: services.llm,
                  dispatcher: services.dispatcher,
                  checkpointer: services.checkpointer,
                  services,
                  attachments,
                });
                pushBlock(`Started run ${runId.slice(0, 8)} for ${agent.name}`, "green");
              }}
              onCancel={() => {
                setNav((p) => ({ ...p, focus: "content" }));
                dispatch({ kind: "exitUp" });
              }}
              onStop={() => {
                if (!nav.agentDetail) return;
                const active = runManager.isRunning(nav.agentDetail);
                if (active) {
                  runManager.stop(active.runId);
                  pushBlock(`Stopped run ${active.runId.slice(0, 8)} for ${active.agentName}`, "yellow");
                }
              }}
            />
          ) : (
            <InputBar value={nav.input} focused={nav.focus === "input"} disabled={switching} prompt={nav.agentDetail ? `${nav.agentDetail}>` : ">"} />
          )}
        </Box>
      </Box>
    );
  }

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
      {/* key forces a full remount on surface/project change so Ink clears the
          previous content's lines completely (avoids ghost lines bleeding from
          one surface/project into the next). */}
      {content}

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
  workspaceDir,
  registry,
}: {
  nav: NavState;
  model: ReturnType<typeof buildDashboard>;
  runDetail: RunDetail | null;
  memoryContent: string;
  memoryLabel: string;
  workspaceDir: string;
  registry: AgentRegistry;
}) {
  if (nav.agentDetail) {
    const agent = registry.get(nav.agentDetail);
    if (nav.detail === "agentChannel" && agent) {
      const interactive = agent.tools?.includes("delegate") ?? false;
      return <ChannelView agentName={agent.name} agent={agent} workspaceDir={workspaceDir} interactive={interactive} />;
    }
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
