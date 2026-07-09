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
import { expandTaskWithAttachments } from "../prompt/attachments.js";
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
import { DraftsTab } from "./components/DraftsTab.js";
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
import { OrchestratorChat, AgentChat } from "./components/OrchestratorChat.js";
import { createThread, listThreads, loadThread, saveThread, type ChatMessage, type ChatThread } from "./chat.js";
import {
  listProjectThreads,
  loadProjectThread,
  saveProjectThread,
  createProjectThread,
  deleteProjectThread,
} from "./projectChat.js";
import { switchServices } from "../services/lifecycle.js";
import { runAgent } from "../agent/loop.js";
import { AgentRegistry } from "../agent/registry.js";
import { listProjects, registerProject, type ProjectEntry } from "../project/registry.js";
import { buildServices, closeServices } from "../services/lifecycle.js";
import type { SharedServices } from "../tools/schema.js";
import type { ApprovalsQueue } from "./approvals.js";
import type { LLMMessage, ModelOverride } from "../types.js";
import {
  listPendingDrafts,
  pendingDraftCountByProject,
  approveAgentDraft,
  rejectAgentDraft,
  approveAllAgentDrafts,
  rejectAllAgentDrafts,
  findProjectByNameOrPath,
} from "./draftApprovals.js";
import { workspaceRoot, sophronRoot } from "../tools/builtin/global.js";

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

  // ── Global orchestrator chat (M8 + M19) ──
  const [orchestratorMessages, setOrchestratorMessages] = useState<ChatMessage[]>([]);
  const [orchestratorRunning, setOrchestratorRunning] = useState(false);
  // M19: persisted thread list + active thread
  const [orchestratorThreads, setOrchestratorThreads] = useState<ChatThread[]>([]);
  const [currentThreadId, setCurrentThreadId] = useState<string | null>(null);
  const [threadListIndex, setThreadListIndex] = useState(0);
  // Ref to avoid persisting unchanged messages (e.g. on thread load).
  const lastPersistedRef = useRef<{ id: string | null; messages: ChatMessage[] }>({ id: null, messages: [] });
  // Monotonic message ID counter (avoids Date.now() collisions if two messages
  // land in the same millisecond).
  const msgIdRef = useRef(0);
  const nextMsgId = useCallback(() => ++msgIdRef.current, []);
  // Ref mirror so the async handler can read the latest chat history without
  // recreating the callback on every new message.
  const orchestratorMessagesRef = useRef(orchestratorMessages);
  orchestratorMessagesRef.current = orchestratorMessages;
  // Whether the global-orchestrator agent is installed (checked lazily).
  const orchestratorInstalled = useMemo(() => registry.get("global-orchestrator") != null, [registry]);

  // ── Per-project agent chat ──
  const [projectChatThreadId, setProjectChatThreadId] = useState<string | null>(null);
  const [projectChatMessages, setProjectChatMessages] = useState<ChatMessage[]>([]);
  const [projectChatThreads, setProjectChatThreads] = useState<ChatThread[]>([]);
  const [projectChatRunning, setProjectChatRunning] = useState(false);
  const [agentStream, setAgentStream] = useState<{ agentName: string; text: string } | null>(null);
  // Cache of built services per project so switching back is instant.
  const servicesCacheRef = useRef<Map<string, { services: SharedServices; registry: AgentRegistry }>>(new Map());

  // M19: load saved threads once on mount. Start in list mode if any exist;
  // otherwise create a first empty thread so the user can begin immediately.
  useEffect(() => {
    const threads = listThreads();
    setOrchestratorThreads(threads);
    if (threads.length > 0) {
      setCurrentThreadId(null);
      setThreadListIndex(0);
      lastPersistedRef.current = { id: null, messages: [] };
    } else {
      const thread = createThread();
      setOrchestratorThreads([thread]);
      setCurrentThreadId(thread.id);
      setOrchestratorMessages([]);
      lastPersistedRef.current = { id: thread.id, messages: [] };
    }
  }, []);

  const openThread = useCallback((id: string) => {
    const messages = loadThread(id);
    setCurrentThreadId(id);
    setOrchestratorMessages(messages);
    lastPersistedRef.current = { id, messages: messages.slice() };
    const idx = orchestratorThreads.findIndex((t) => t.id === id);
    setThreadListIndex(idx >= 0 ? idx : 0);
  }, [orchestratorThreads]);

  const startNewThread = useCallback(() => {
    const thread = createThread();
    setOrchestratorThreads((prev) => [thread, ...prev]);
    setCurrentThreadId(thread.id);
    setOrchestratorMessages([]);
    lastPersistedRef.current = { id: thread.id, messages: [] };
  }, []);

  // Persist the active thread whenever its messages change, but skip writes
  // while a streaming response is in flight to avoid saving partial deltas.
  useEffect(() => {
    if (!currentThreadId || orchestratorRunning) return;
    if (
      lastPersistedRef.current.id === currentThreadId &&
      messagesEqual(lastPersistedRef.current.messages, orchestratorMessages)
    ) {
      return;
    }
    const meta = saveThread(currentThreadId, orchestratorMessages);
    lastPersistedRef.current = { id: currentThreadId, messages: orchestratorMessages.slice() };
    setOrchestratorThreads((prev) => [meta, ...prev.filter((t) => t.id !== meta.id)]);
  }, [currentThreadId, orchestratorMessages, orchestratorRunning]);

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
  const pushBlock = useCallback(
    (text: string, color?: string) => {
      const onGlobalChat = nav.surface === "home" && activeHomeTab(nav) === "orchestrator";
      const onProjectChat = nav.surface === "project" && activeProjectTab(nav) === "chat";
      if (onGlobalChat) {
        // Inline command feedback into the global orchestrator chat.
        setOrchestratorMessages((prev) => [...prev, { id: nextMsgId(), role: "system" as const, text, color }]);
      } else if (onProjectChat) {
        // Inline command feedback into the project chat thread.
        setProjectChatMessages((prev) => [...prev, { id: nextMsgId(), role: "system" as const, text, color }]);
      } else {
        const id = blockIdRef.current++;
        setBlocks((prev) => [...prev.slice(-6), { id, text, color }]);
      }
    },
    [nav.surface, nav.homeTabIndex, nav.projectTabIndex, nextMsgId],
  );

  // ── Attachment expansion (@path references) ──
  const expandTask = useCallback(
    (text: string, isGlobal: boolean): { task: string; error?: string } => {
      try {
        const baseDir = isGlobal ? sophronRoot() : workspaceDir;
        const allowedRoots = isGlobal ? [sophronRoot(), workspaceRoot()] : [workspaceDir];
        const { task } = expandTaskWithAttachments(text, baseDir, allowedRoots);
        return { task };
      } catch (e) {
        return { task: text, error: (e as Error).message };
      }
    },
    [workspaceDir],
  );

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

  // Cross-project agent draft state (refreshed with the overview tick).
  const draftCounts = useMemo(() => pendingDraftCountByProject(), [overviewTick]);
  const pendingDrafts = useMemo(() => listPendingDrafts(), [overviewTick]);

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
          drafts: pendingDrafts.length,
          chatThreads: projectChatThreads.length,
        }),
      );
    },
    [model.agents.length, model.recentRuns.length, pendingDrafts.length, projectChatThreads.length, nav.surface, nav.focus, stdout],
  );

  // ── Project switching (cached rebuild so the TUI feels global) ──
  const loadProjectChatState = useCallback((projectPath: string) => {
    const threads = listProjectThreads(projectPath);
    setProjectChatThreads(threads);
    if (threads.length > 0) {
      const newest = threads[0]!;
      setProjectChatThreadId(newest.id);
      const messages = loadProjectThread(projectPath, newest.id);
      setProjectChatMessages(messages);
      projectChatMessagesRef.current = messages;
    } else {
      setProjectChatThreadId(null);
      setProjectChatMessages([]);
      projectChatMessagesRef.current = [];
    }
  }, []);

  const switchProject = useCallback(
    async (projectPath: string, opts?: { tab?: "status" | "chat" | "agents" | "runs" | "checkpoint" | "memory" | "cost" }) => {
      // Clear the terminal (including scrollback) before rebuilding so the new
      // project frame replaces the previous one instead of stacking below it.
      clearTerminal(stdout);
      const absPath = resolve(projectPath);
      setSwitching(true);
      pushBlock(`Switching to ${absPath}…`, "yellow");
      try {
        const entry = registerProject(absPath);
        // Preserve the current services in the cache before we leave.
        servicesCacheRef.current.set(workspaceDir, { services, registry });

        let next: { services: SharedServices; registry: AgentRegistry };
        const cached = servicesCacheRef.current.get(absPath);
        if (cached) {
          next = cached;
          pushBlock(`Restored cached services for ${entry.name}`, "green");
        } else {
          const newRegistry = new AgentRegistry(absPath);
          newRegistry.scan();
          newRegistry.startWatch();
          next = { services: buildServices(absPath, newRegistry, approvals), registry: newRegistry };
          servicesCacheRef.current.set(absPath, next);
        }

        setServices(next.services);
        setRegistry(next.registry);
        setApprovals(next.services.approvals);
        setWorkspaceDir(absPath);
        setActiveProjectName(entry.name);
        const tabIndex = opts?.tab ? PROJECT_TABS.indexOf(opts.tab) : 0;
        // Full nav reset — don't spread prev (stale tab indices + input leak
        // across projects). Start fresh on the requested/default tab.
        setNav({ ...initialNavState(), surface: "project", focus: "tabs", projectTabIndex: tabIndex >= 0 ? tabIndex : 0 });
        setRunDetail(null);
        setBlocks([]);
        setMemoryContent("");
        setAgentStream(null);
        loadProjectChatState(absPath);
        pushBlock(`Switched to project: ${entry.name}`, "green");
      } catch (e) {
        pushBlock(`Switch failed: ${(e as Error).message}`, "red");
      } finally {
        setSwitching(false);
      }
    },
    [services, registry, approvals, workspaceDir, pushBlock, stdout, loadProjectChatState],
  );

  // Cache the initial services and prime the first project's chat state.
  useEffect(() => {
    servicesCacheRef.current.set(initialDir, { services: initialServices, registry: initialRegistry });
    loadProjectChatState(initialDir);
  }, []);

  // Close every cached services instance when the TUI exits.
  useEffect(() => {
    return () => {
      for (const { services: cachedServices, registry: cachedRegistry } of servicesCacheRef.current.values()) {
        void closeServices(cachedServices, cachedRegistry);
      }
      servicesCacheRef.current.clear();
    };
  }, []);

  // ── Run a project agent from inside the TUI ──
  // This is the single-place control path: the operator can prompt any project's
  // agent without leaving the TUI or changing the shell directory. Current-project
  // runs reuse the active services; cross-project runs build a temporary services
  // instance bound to the target project and share the active approvals queue.
  const executeAgentRun = useCallback(
    async (
      projectPath: string,
      agentName: string,
      task: string,
      targetServices: SharedServices,
      targetRegistry: AgentRegistry,
      onStream?: (text: string) => void,
    ) => {
      const agent = targetRegistry.get(agentName);
      if (!agent) {
        pushBlock(`Agent '${agentName}' not found in ${projectPath}`, "red");
        return;
      }
      let expandedTask = task;
      try {
        const { task: t } = expandTaskWithAttachments(task, projectPath, [projectPath]);
        expandedTask = t;
      } catch (e) {
        pushBlock(`Attachment error: ${(e as Error).message}`, "red");
        return;
      }
      if (!onStream) pushBlock(`Running ${agentName} in ${projectPath}…`, "yellow");
      try {
        const result = await runAgent({
          agent,
          task: expandedTask,
          workingDir: projectPath,
          llm: targetServices.llm,
          dispatcher: targetServices.dispatcher,
          checkpointer: targetServices.checkpointer,
          services: targetServices,
          modelOverride: modelOverrides[agentName],
          onStream,
        });
        const finalContent = result.state.messages
          .filter((m) => m.role === "assistant" && m.content)
          .map((m) => m.content as string)
          .join("\n")
          .trim();
        const statusColor =
          result.state.status === "complete" ? "green" : result.state.status === "error" ? "red" : "yellow";
        pushBlock(`${agentName} ${result.state.status} · ${result.state.turn + 1} turns`, statusColor);
        if (finalContent) pushBlock(finalContent.slice(0, 500), "gray");
      } catch (e) {
        pushBlock(`${agentName} failed: ${(e as Error).message}`, "red");
      }
    },
    [pushBlock, modelOverrides],
  );

  // ── Global orchestrator chat (M8 + M19) ──
  // Runs the global-orchestrator agent loop with the operator's message as the
  // task. The global orchestrator lives at ~/.sophron/agents/global-orchestrator.md
  // and has NO injected project memory + NO codebase workspace — it only manages
  // the project lifecycle (propose / create / list). It DOES retain chat
  // history within the current persisted thread. Its working dir is ~/.sophron/.
  const handleOrchestratorMessage = useCallback(
    async (text: string) => {
      const agent = registry.get("global-orchestrator");
      if (!agent) {
        const msg: ChatMessage = {
          id: nextMsgId(),
          role: "orchestrator",
          text: "The global orchestrator is not installed. Run:\n  sophron init --install-orchestrator",
        };
        setOrchestratorMessages((prev) => [...prev, msg]);
        return;
      }

      // Expand @path references to embedded file attachments.
      const { task: expandedTask, error } = expandTask(text, true);
      if (error) {
        pushBlock(`Attachment error: ${error}`, "red");
        return;
      }

      // Ensure there is an active thread. If the operator typed free text while
      // viewing the thread list, create a new thread on the fly.
      let threadId = currentThreadId;
      let baseMessages: ChatMessage[];
      const userMsg: ChatMessage = { id: nextMsgId(), role: "user", text };
      if (!threadId) {
        const thread = createThread([userMsg]);
        threadId = thread.id;
        baseMessages = [userMsg];
        setOrchestratorThreads((prev) => [thread, ...prev]);
        setCurrentThreadId(threadId);
        setOrchestratorMessages(baseMessages);
      } else {
        baseMessages = [...orchestratorMessages, userMsg];
        setOrchestratorMessages(baseMessages);
      }
      // Keep the ref in sync so follow-up logic reads the latest thread.
      orchestratorMessagesRef.current = baseMessages;

      setOrchestratorRunning(true);
      const placeholderMsg: ChatMessage = { id: nextMsgId(), role: "orchestrator", text: "" };
      setOrchestratorMessages((prev) => [...prev, placeholderMsg]);
      orchestratorMessagesRef.current = [...baseMessages, placeholderMsg];
      try {
        // Feed the prior chat turns as history so the orchestrator remembers the
        // current conversation without touching project memory stores.
        const history: LLMMessage[] = baseMessages
          .filter((m) => m.role !== "system")
          .map((m) => ({
            role: m.role === "user" ? "user" : "assistant",
            content: m.text,
          }));
        let streamed = "";
        const updatePlaceholder = (text: string) => {
          setOrchestratorMessages((prev) =>
            prev.map((m) => (m.id === placeholderMsg.id ? { ...m, text } : m))
          );
          orchestratorMessagesRef.current = orchestratorMessagesRef.current.map((m) =>
            m.id === placeholderMsg.id ? { ...m, text } : m
          );
        };
        const result = await runAgent({
          agent,
          task: expandedTask,
          workingDir: resolve(homedir(), ".sophron"),
          llm: services.llm,
          dispatcher: services.dispatcher,
          checkpointer: services.checkpointer,
          services,
          modelOverride: modelOverrides[agent.name],
          history,
          onStream: (delta) => {
            streamed += delta;
            updatePlaceholder(streamed);
          },
        });
        const finalContent = result.state.messages
          .filter((m) => m.role === "assistant" && m.content)
          .map((m) => m.content as string)
          .join("\n")
          .trim();
        const reply = streamed.trim() || finalContent || "(no response)";
        updatePlaceholder(reply);
      } catch (e) {
        const errText = `Error: ${(e as Error).message}`;
        setOrchestratorMessages((prev) =>
          prev.map((m) => (m.id === placeholderMsg.id ? { ...m, text: errText } : m))
        );
        orchestratorMessagesRef.current = orchestratorMessagesRef.current.map((m) =>
          m.id === placeholderMsg.id ? { ...m, text: errText } : m
        );
      } finally {
        setOrchestratorRunning(false);
      }
    },
    [registry, services, nextMsgId, modelOverrides, currentThreadId, orchestratorMessages, expandTask, pushBlock],
  );

  // ── Per-project orchestrator chat ──
  const projectChatMessagesRef = useRef(projectChatMessages);
  projectChatMessagesRef.current = projectChatMessages;

  const setProjectMessages = useCallback((updater: (prev: ChatMessage[]) => ChatMessage[]) => {
    setProjectChatMessages((prev) => {
      const next = updater(prev);
      projectChatMessagesRef.current = next;
      return next;
    });
  }, []);

  const handleProjectChatMessage = useCallback(
    async (text: string) => {
      const agent = registry.get("orchestrator");
      if (!agent) {
        pushBlock("No per-project orchestrator agent found in this project.", "red");
        return;
      }

      const { task: expandedTask, error } = expandTask(text, false);
      if (error) {
        pushBlock(`Attachment error: ${error}`, "red");
        return;
      }

      let threadId = projectChatThreadId;
      const userMsg: ChatMessage = { id: nextMsgId(), role: "user", text };

      if (!threadId) {
        const thread = createProjectThread(workspaceDir, [userMsg]);
        threadId = thread.id;
        setProjectChatThreads((prev) => [thread, ...prev]);
        setProjectChatThreadId(threadId);
        setProjectMessages(() => [userMsg]);
      } else {
        setProjectMessages((prev) => [...prev, userMsg]);
      }

      setProjectChatRunning(true);
      const placeholderMsg: ChatMessage = { id: nextMsgId(), role: "orchestrator", text: "" };
      setProjectMessages((prev) => [...prev, placeholderMsg]);

      try {
        const history: LLMMessage[] = projectChatMessagesRef.current
          .filter((m) => m.role !== "system" && m.text.trim() !== "")
          .map((m) => ({
            role: m.role === "user" ? "user" : "assistant",
            content: m.text,
          }));
        let streamed = "";
        const updatePlaceholder = (txt: string) => {
          setProjectMessages((prev) => prev.map((m) => (m.id === placeholderMsg.id ? { ...m, text: txt } : m)));
        };
        const result = await runAgent({
          agent,
          task: expandedTask,
          workingDir: workspaceDir,
          llm: services.llm,
          dispatcher: services.dispatcher,
          checkpointer: services.checkpointer,
          services,
          modelOverride: modelOverrides[agent.name],
          history,
          onStream: (delta) => {
            streamed += delta;
            updatePlaceholder(streamed);
          },
        });
        const finalContent = result.state.messages
          .filter((m) => m.role === "assistant" && m.content)
          .map((m) => m.content as string)
          .join("\n")
          .trim();
        const reply = streamed.trim() || finalContent || "(no response)";
        updatePlaceholder(reply);
      } catch (e) {
        const errText = `Error: ${(e as Error).message}`;
        setProjectMessages((prev) => prev.map((m) => (m.id === placeholderMsg.id ? { ...m, text: errText } : m)));
      } finally {
        setProjectChatRunning(false);
        // Persist the thread (system messages stripped by saveProjectThread).
        if (threadId) {
          const thread = saveProjectThread(workspaceDir, threadId, projectChatMessagesRef.current);
          setProjectChatThreads((prev) =>
            [thread, ...prev.filter((t) => t.id !== thread.id)].sort((a, b) => b.updatedAt - a.updatedAt),
          );
        }
      }
    },
    [registry, services, workspaceDir, nextMsgId, modelOverrides, projectChatThreadId, setProjectMessages, expandTask, pushBlock],
  );

  const openProjectChatThread = useCallback((id: string) => {
    const messages = loadProjectThread(workspaceDir, id);
    setProjectChatThreadId(id);
    setProjectMessages(() => messages);
  }, [workspaceDir, setProjectMessages]);

  const startNewProjectThread = useCallback(() => {
    const thread = createProjectThread(workspaceDir);
    setProjectChatThreads((prev) => [thread, ...prev]);
    setProjectChatThreadId(thread.id);
    setProjectMessages(() => []);
  }, [workspaceDir, setProjectMessages]);

  // ── Open the selected list item (Enter in content focus) ──
  const handleOpenSelected = useCallback(() => {
    // Orchestrator thread list → resume selected thread.
    if (nav.surface === "home" && activeHomeTab(nav) === "orchestrator" && !currentThreadId) {
      const sel = orchestratorThreads[threadListIndex];
      if (sel) openThread(sel.id);
      return;
    }
    // Projects tab → enter the selected project.
    if (nav.surface === "home" && activeHomeTab(nav) === "projects") {
      const sel = listProjects()[nav.projectsIndex];
      if (sel) void switchProject(sel.path);
      return;
    }
    // Drafts tab → approve the selected draft.
    if (nav.surface === "home" && activeHomeTab(nav) === "drafts") {
      const sel = pendingDrafts[nav.draftsIndex];
      if (sel) {
        try {
          const entry = approveAgentDraft(sel.projectPath, sel.name);
          pushBlock(`Approved draft ${sel.projectName}/${entry.name} → ${entry.status}`, "green");
        } catch (e) {
          pushBlock(`Could not approve draft ${sel.projectName}/${sel.name}: ${(e as Error).message}`, "red");
        }
        setOverviewTick((n) => n + 1);
      }
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
    // Project Chat thread list → open selected thread.
    if (nav.surface === "project" && activeProjectTab(nav) === "chat" && !projectChatThreadId) {
      const sel = projectChatThreads[nav.chatThreadsIndex];
      if (sel) openProjectChatThread(sel.id);
      return;
    }
  }, [nav, model, workspaceDir, switchProject, dispatch, currentThreadId, orchestratorThreads, threadListIndex, openThread, pendingDrafts, pushBlock, projectChatThreads, projectChatThreadId, openProjectChatThread]);

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
      // On Agent detail, free text is a task for THAT agent — stream its
      // reasoning into the Agent detail view so the operator can see it.
      if (nav.agentDetail && !raw.startsWith("/")) {
        const agentName = nav.agentDetail;
        setAgentStream({ agentName, text: "" });
        void executeAgentRun(workspaceDir, agentName, raw, services, registry, (text) => {
          setAgentStream({ agentName, text });
        }).then(() => {
          setAgentStream(null);
        });
        return;
      }
      // In a project, free text starts/continues a chat with the per-project
      // orchestrator so the conversation (and thinking) is always visible.
      if (nav.surface === "project" && !raw.startsWith("/")) {
        void handleProjectChatMessage(raw);
        if (activeProjectTab(nav) !== "chat") {
          dispatch({ kind: "enterProject", tabIndex: PROJECT_TABS.indexOf("chat") });
        }
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
        case "checkpoints": {
          if (nav.surface !== "project") {
            pushBlock("Enter a project first.", "yellow");
            break;
          }
          const mgr = new CheckpointManager(services.sharedMemoryStore);
          if (cmd.milestones && cmd.milestones.length > 0) {
            const res = mgr.replaceCheckpoints(cmd.milestones);
            pushBlock(
              res.advanced
                ? `Checkpoints replaced. Current: ${res.current?.title ?? "(none)"}`
                : `Checkpoints cleared.`,
              "green",
            );
          } else {
            const list = mgr.list();
            if (list.length === 0) {
              pushBlock("No checkpoints set. Use /checkpoints \"Milestone 1\" \"Milestone 2\" to add some.", "yellow");
            } else {
              pushBlock(
                ["Checkpoints:", ...list.map((m) => `${m.index}. [${m.done ? "x" : " "}] ${m.title}`)].join("\n"),
                "cyan",
              );
            }
          }
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
            lastPersistedRef.current = { id: currentThreadId, messages: [] };
            pushBlock("Cleared chat thread + output log.", "gray");
          }
          if (nav.surface === "project" && activeProjectTab(nav) === "chat") {
            setProjectChatMessages([]);
            pushBlock("Cleared project chat thread.", "gray");
          }
          break;
        case "new":
          if (nav.surface === "home" && activeHomeTab(nav) === "orchestrator") {
            startNewThread();
            pushBlock("Started a new chat thread.", "gray");
          } else if (nav.surface === "project") {
            startNewProjectThread();
            dispatch({ kind: "enterProject", tabIndex: PROJECT_TABS.indexOf("chat") });
            pushBlock("Started a new project chat thread.", "gray");
          } else {
            pushBlock("Use /new on the Orchestrator or Chat tab.", "yellow");
          }
          break;
        case "chats":
          if (nav.surface === "home" && activeHomeTab(nav) === "orchestrator") {
            setCurrentThreadId(null);
            dispatch({ kind: "enterTab" });
          } else if (nav.surface === "project") {
            setProjectChatThreadId(null);
            dispatch({ kind: "enterProject", tabIndex: PROJECT_TABS.indexOf("chat") });
          } else {
            pushBlock("Use /chats on the Orchestrator or Chat tab.", "yellow");
          }
          break;
        case "switch": {
          const project = findProjectByNameOrPath(cmd.project);
          if (!project) {
            pushBlock(`Project '${cmd.project}' not found.`, "red");
            break;
          }
          void switchProject(project.path);
          break;
        }
        case "chat": {
          const project = cmd.project ? findProjectByNameOrPath(cmd.project) : listProjects().find((p) => p.path === workspaceDir);
          if (!project) {
            pushBlock(cmd.project ? `Project '${cmd.project}' not found.` : "No current project.", "red");
            break;
          }
          void switchProject(project.path, { tab: "chat" });
          break;
        }
        case "quit":
          exit();
          break;
        case "run": {
          if (cmd.project) {
            const project = findProjectByNameOrPath(cmd.project);
            if (!project) {
              pushBlock(`Project '${cmd.project}' not found.`, "red");
              break;
            }
            void (async () => {
              const targetRegistry = new AgentRegistry(project.path);
              targetRegistry.scan();
              const targetServices = buildServices(project.path, targetRegistry, approvals);
              try {
                await executeAgentRun(project.path, cmd.agent, cmd.task, targetServices, targetRegistry);
              } finally {
                await closeServices(targetServices, targetRegistry);
              }
            })();
          } else if (nav.surface === "project") {
            void executeAgentRun(workspaceDir, cmd.agent, cmd.task, services, registry);
          } else {
            pushBlock("Use /run <project>/<agent> from the Home surface, or enter a project first.", "yellow");
          }
          break;
        }
        case "task": {
          if (nav.surface === "project") {
            const agent = registry.get("orchestrator");
            if (agent) {
              void executeAgentRun(workspaceDir, agent.name, cmd.text, services, registry);
            } else {
              pushBlock("No orchestrator agent in this project. Use /run <agent> \"<task>\".", "yellow");
            }
          } else {
            pushBlock(
              "Free-text tasks run the current project's orchestrator. Enter a project first, or use /run <project>/<agent>.",
              "yellow",
            );
          }
          break;
        }
        case "drafts": {
          if (pendingDrafts.length === 0) {
            pushBlock("No pending agent drafts across all registered projects.", "green");
          } else {
            pushBlock(`${pendingDrafts.length} pending agent draft(s):`, "yellow");
            for (const d of pendingDrafts) {
              pushBlock(`  ${d.projectName}/${d.name}  (${d.createdAt})`, "gray");
            }
          }
          break;
        }
        case "approveDraft": {
          const project = findProjectByNameOrPath(cmd.project);
          if (!project) {
            pushBlock(`Project '${cmd.project}' not found.`, "red");
            break;
          }
          try {
            const entry = approveAgentDraft(project.path, cmd.name);
            pushBlock(`Approved draft ${project.name}/${entry.name} → ${entry.status}`, "green");
          } catch (e) {
            pushBlock(`Could not approve ${cmd.project}/${cmd.name}: ${(e as Error).message}`, "red");
          }
          break;
        }
        case "rejectDraft": {
          const project = findProjectByNameOrPath(cmd.project);
          if (!project) {
            pushBlock(`Project '${cmd.project}' not found.`, "red");
            break;
          }
          try {
            const entry = rejectAgentDraft(project.path, cmd.name);
            pushBlock(`Rejected draft ${project.name}/${entry.name} → ${entry.status}`, "yellow");
          } catch (e) {
            pushBlock(`Could not reject ${cmd.project}/${cmd.name}: ${(e as Error).message}`, "red");
          }
          break;
        }
        case "approveAllDrafts": {
          const batches = approveAllAgentDrafts(cmd.project);
          if (batches.length === 0) {
            pushBlock(cmd.project ? `No pending drafts in '${cmd.project}'.` : "No pending drafts to approve.", "gray");
          } else {
            for (const batch of batches) {
              pushBlock(
                `Approved ${batch.entries.length} draft(s) in ${batch.projectName}: ${batch.entries.map((e) => e.name).join(", ")}`,
                "green",
              );
            }
          }
          break;
        }
        case "rejectAllDrafts": {
          const batches = rejectAllAgentDrafts(cmd.project);
          if (batches.length === 0) {
            pushBlock(cmd.project ? `No pending drafts in '${cmd.project}'.` : "No pending drafts to reject.", "gray");
          } else {
            for (const batch of batches) {
              pushBlock(
                `Rejected ${batch.entries.length} draft(s) in ${batch.projectName}: ${batch.entries.map((e) => e.name).join(", ")}`,
                "yellow",
              );
            }
          }
          break;
        }
        case "unknown":
          pushBlock(`Unknown: ${cmd.reason}`, "red");
          break;
      }
    },
    [nav.surface, nav.agentDetail, nav.homeTabIndex, nav.projectTabIndex, nav.agentsIndex, services, approvals, pushBlock, exit, handleOrchestratorMessage, orchestratorRunning, applyModelOverride, model, startNewThread, currentThreadId, executeAgentRun, workspaceDir, registry, pendingDrafts, handleProjectChatMessage, startNewProjectThread, switchProject],
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

    const onOrchestratorList =
      nav.surface === "home" && activeHomeTab(nav) === "orchestrator" && currentThreadId === null;

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
      // M19: ↑/↓ navigate the orchestrator thread list.
      if (onOrchestratorList) {
        setThreadListIndex((i) => Math.max(0, i - 1));
        if (nav.focus === "tabs") dispatch({ kind: "enterTab" });
        return;
      }
      // ↑ on tabs → exit up a level (project → home). ↑ in content → move the
      // list up; if already at the top (index 0) or not on a list, exit back
      // to tabs. This lets ↑ both navigate lists and exit, matching the spec's
      // "escape/up arrow to exit" while keeping lists usable.
      if (nav.focus === "tabs") {
        dispatch({ kind: "exitUp" });
      } else if (nav.focus === "content") {
        const atTop =
          (nav.surface === "home" && activeHomeTab(nav) === "projects" && nav.projectsIndex <= 0) ||
          (nav.surface === "home" && activeHomeTab(nav) === "drafts" && nav.draftsIndex <= 0) ||
          (nav.surface === "project" && activeProjectTab(nav) === "chat" && nav.chatThreadsIndex <= 0) ||
          (nav.surface === "project" && activeProjectTab(nav) === "agents" && nav.agentsIndex <= 0) ||
          (nav.surface === "project" && activeProjectTab(nav) === "runs" && nav.runsIndex <= 0);
        if (atTop) dispatch({ kind: "exitUp" });
        else dispatch({ kind: "listUp" });
      }
      return;
    }
    if (key.downArrow) {
      if (onOrchestratorList) {
        setThreadListIndex((i) => Math.max(0, Math.min(orchestratorThreads.length - 1, i + 1)));
        if (nav.focus === "tabs") dispatch({ kind: "enterTab" });
        return;
      }
      if (nav.focus === "tabs") dispatch({ kind: "enterTab" });
      else dispatch({ kind: "listDown" });
      return;
    }
    if (key.return) {
      if (onOrchestratorList) {
        const sel = orchestratorThreads[threadListIndex];
        if (sel) openThread(sel.id);
        return;
      }
      if (nav.focus === "tabs") {
        dispatch({ kind: "enterTab" });
      } else if (nav.focus === "content" && !nav.agentDetail && !nav.runDetail) {
        handleOpenSelected();
      }
      return;
    }
    if (inputChar === "r" && nav.focus === "content" && nav.surface === "home" && activeHomeTab(nav) === "drafts") {
      const sel = pendingDrafts[nav.draftsIndex];
      if (sel) {
        try {
          const entry = rejectAgentDraft(sel.projectPath, sel.name);
          pushBlock(`Rejected draft ${sel.projectName}/${entry.name} → ${entry.status}`, "yellow");
        } catch (e) {
          pushBlock(`Could not reject draft ${sel.projectName}/${sel.name}: ${(e as Error).message}`, "red");
        }
        setOverviewTick((n) => n + 1);
      }
      return;
    }
    if (key.escape) {
      if (nav.agentDetail || nav.runDetail) {
        setRunDetail(null);
        dispatch({ kind: "closeDetail" });
      } else if (nav.surface === "home" && activeHomeTab(nav) === "orchestrator" && currentThreadId !== null) {
        // M19: Esc from chat mode returns to the thread list.
        setCurrentThreadId(null);
        dispatch({ kind: "enterTab" });
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
  const onOrchestrator = nav.surface === "home" && activeHomeTab(nav) === "orchestrator";
  const onProjectChat = nav.surface === "project" && activeProjectTab(nav) === "chat";
  // Leave room for banner (6), divider, breadcrumb, tab bar, input bar, hint,
  // borders/padding (~12) plus the chat chrome (~2). The cap grows/shrinks with
  // the terminal so long conversations never overlap the chrome.
  const chatMaxLines = Math.max(4, rows - 14);

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
          <HomeContent
            nav={nav}
            overview={overview}
            activeProjectName={activeProjectName}
            projects={projects}
            activeProjectPath={activeProjectPath}
            draftCounts={draftCounts}
            pendingDrafts={pendingDrafts}
            onOrchestratorMessage={handleOrchestratorMessage}
            orchestratorMessages={orchestratorMessages}
            orchestratorRunning={orchestratorRunning}
            orchestratorInstalled={orchestratorInstalled}
            chatMaxLines={chatMaxLines}
            chatWidth={cols}
            orchestratorThreads={orchestratorThreads}
            currentThreadId={currentThreadId}
            threadListIndex={threadListIndex}
            openThread={openThread}
            startNewThread={startNewThread}
          />
        ) : (
          <ProjectContent
            nav={nav}
            model={model}
            projectName={activeProjectName}
            runDetail={runDetail}
            memoryContent={memoryContent}
            memoryLabel={memoryLabel}
            effectiveModelFor={effectiveModelFor}
            projectChatMessages={projectChatMessages}
            projectChatRunning={projectChatRunning}
            projectChatThreads={projectChatThreads}
            projectChatThreadId={projectChatThreadId}
            onSelectProjectThread={openProjectChatThread}
            onNewProjectThread={startNewProjectThread}
            agentStream={agentStream}
            chatMaxLines={chatMaxLines}
            chatWidth={cols}
          />
        )}
      </Box>

      {/* ── Output log (command feedback) ── */}
      {/* Hidden on chat tabs: feedback is rendered inline in the chat. */}
      {!onOrchestrator && !onProjectChat && blocks.length > 0 ? (
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

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Shallow equality of message arrays by value (used for M19 persistence). */
function messagesEqual(a: ChatMessage[], b: ChatMessage[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const am = a[i]!;
    const bm = b[i]!;
    if (am.id !== bm.id || am.role !== bm.role || am.text !== bm.text || am.color !== bm.color) return false;
  }
  return true;
}

// ── Home surface content ────────────────────────────────────────────────────

function HomeContent({
  nav,
  overview,
  activeProjectName,
  projects,
  activeProjectPath,
  draftCounts,
  pendingDrafts,
  onOrchestratorMessage,
  orchestratorMessages,
  orchestratorRunning,
  orchestratorInstalled,
  chatMaxLines,
  chatWidth,
  orchestratorThreads,
  currentThreadId,
  threadListIndex,
  openThread,
  startNewThread,
}: {
  nav: NavState;
  overview: OverviewModel;
  activeProjectName: string;
  projects: ProjectEntry[];
  activeProjectPath: string;
  draftCounts: Map<string, number>;
  pendingDrafts: import("./draftApprovals.js").PendingDraftRef[];
  onOrchestratorMessage: (text: string) => void;
  orchestratorMessages: ChatMessage[];
  orchestratorRunning: boolean;
  orchestratorInstalled: boolean;
  chatMaxLines: number;
  chatWidth: number;
  orchestratorThreads: ChatThread[];
  currentThreadId: string | null;
  threadListIndex: number;
  openThread: (id: string) => void;
  startNewThread: () => void;
}) {
  const tab = activeHomeTab(nav);
  if (tab === "overview") {
    return <OverviewTab overview={overview} activeProjectName={activeProjectName} />;
  }
  if (tab === "orchestrator") {
    const mode = currentThreadId ? "chat" : "list";
    const currentTitle = orchestratorThreads.find((t) => t.id === currentThreadId)?.title;
    return (
      <OrchestratorChat
        mode={mode}
        messages={orchestratorMessages}
        running={orchestratorRunning}
        installed={orchestratorInstalled}
        onSubmit={onOrchestratorMessage}
        maxLines={chatMaxLines}
        width={chatWidth}
        threads={orchestratorThreads}
        selectedThreadIndex={threadListIndex}
        currentTitle={currentTitle}
        onSelectThread={openThread}
        onNewThread={startNewThread}
      />
    );
  }
  if (tab === "drafts") {
    return <DraftsTab drafts={pendingDrafts} selectedIndex={nav.draftsIndex} />;
  }
  return <ProjectsTab projects={projects} selectedIndex={nav.projectsIndex} activePath={activeProjectPath} draftCounts={draftCounts} />;
}

// ── Project surface content ─────────────────────────────────────────────────

function ProjectContent({
  nav,
  model,
  projectName,
  runDetail,
  memoryContent,
  memoryLabel,
  effectiveModelFor,
  projectChatMessages,
  projectChatRunning,
  projectChatThreads,
  projectChatThreadId,
  onSelectProjectThread,
  onNewProjectThread,
  agentStream,
  chatMaxLines,
  chatWidth,
}: {
  nav: NavState;
  model: ReturnType<typeof buildDashboard>;
  projectName: string;
  runDetail: RunDetail | null;
  memoryContent: string;
  memoryLabel: string;
  effectiveModelFor?: (agentName: string) => string | undefined;
  projectChatMessages: ChatMessage[];
  projectChatRunning: boolean;
  projectChatThreads: ChatThread[];
  projectChatThreadId: string | null;
  onSelectProjectThread: (id: string) => void;
  onNewProjectThread: () => void;
  agentStream: { agentName: string; text: string } | null;
  chatMaxLines: number;
  chatWidth: number;
}) {
  if (nav.agentDetail) {
    return (
      <AgentDetail
        model={model}
        agentName={nav.agentDetail}
        effectiveModel={effectiveModelFor?.(nav.agentDetail)}
        agentStream={agentStream}
      />
    );
  }
  if (nav.runDetail) {
    return <RunDetailView detail={runDetail} />;
  }
  const tab = activeProjectTab(nav);
  switch (tab) {
    case "status":
      return <StatusTab model={model} />;
    case "chat": {
      const mode = projectChatThreadId ? "chat" : "list";
      const currentTitle = projectChatThreads.find((t) => t.id === projectChatThreadId)?.title;
      return (
        <AgentChat
          title="Project Orchestrator"
          icon="🤖"
          subtitle={`chat with ${projectName}`}
          mode={mode}
          messages={projectChatMessages}
          running={projectChatRunning}
          installed={true}
          maxLines={chatMaxLines}
          width={chatWidth}
          threads={projectChatThreads}
          selectedThreadIndex={nav.chatThreadsIndex}
          currentTitle={currentTitle}
          onSelectThread={onSelectProjectThread}
          onNewThread={onNewProjectThread}
          emptyPrompt="No messages yet. Type below to chat with the project orchestrator."
          thinkingText="orchestrator is thinking…"
          hint="Type below to chat · /new for fresh thread · /chats to list · Esc back"
          listTitle="Project chat threads"
        />
      );
    }
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
