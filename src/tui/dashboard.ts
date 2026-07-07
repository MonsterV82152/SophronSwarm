/**
 * Dashboard model — pure aggregation of service state into renderable shapes.
 *
 * No React, no Ink — just data the TUI components render. This separation keeps
 * the aggregation logic unit-testable without a terminal.
 *
 * See docs/PHASE_5_DESIGN.md §3.1.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SharedServices } from "../tools/schema.js";
import { CheckpointManager, type Milestone } from "../memory/checkpoints.js";

export interface AgentSummary {
  name: string;
  model: string;
  description: string;
  source: string;
}

export interface CheckpointSummary {
  current: string;
  milestones: { index: number; title: string; done: boolean }[];
}

export interface McpCostSummary {
  perServer: { server: string; tokens: number }[];
  total: number;
  configuredServers: string[];
}

export interface RunSummary {
  runId: string;
  agent: string;
  status: string;
  turns: number;
  tokens: number;
  /** ISO timestamp of run start (best-effort from JSONL). */
  startedAt: string;
}

export interface DashboardModel {
  workspaceDir: string;
  agents: AgentSummary[];
  checkpoint: CheckpointSummary;
  mcpCost: McpCostSummary;
  recentRuns: RunSummary[];
  approvalsPending: number;
}

export interface DashboardOptions {
  workspaceDir: string;
  /** Max number of recent runs to include. Default 5. */
  runLimit?: number;
  approvalsPending?: number;
}

/**
 * Build a dashboard model by aggregating state from SharedServices + on-disk
 * run logs. Pure (no side effects beyond reads). Never throws — missing data
 * degrades gracefully to empty fields.
 */
export function buildDashboard(services: SharedServices, opts: DashboardOptions): DashboardModel {
  const runLimit = opts.runLimit ?? 5;

  const agents: AgentSummary[] = services.agentRegistry.list().map((a) => ({
    name: a.name,
    model: a.model,
    description: a.description,
    source: a.source,
  }));

  const checkpoint = buildCheckpointSummary(services);

  const report = services.mcpCostMeter.report();
  const mcpCost: McpCostSummary = {
    perServer: [...report.perServer.entries()].map(([server, tokens]) => ({ server, tokens })),
    total: report.total,
    configuredServers: services.mcpPool.configuredServers().map((s) => s.name),
  };

  const recentRuns = readRecentRuns(opts.workspaceDir, runLimit);

  return {
    workspaceDir: opts.workspaceDir,
    agents,
    checkpoint,
    mcpCost,
    recentRuns,
    approvalsPending: opts.approvalsPending ?? 0,
  };
}

function buildCheckpointSummary(services: SharedServices): CheckpointSummary {
  try {
    const mgr = new CheckpointManager(services.sharedMemoryStore);
    const milestones: Milestone[] = mgr.list();
    const current = mgr.current()?.title ?? "(none set)";
    return {
      current,
      milestones: milestones.map((m) => ({ index: m.index, title: m.title, done: m.done })),
    };
  } catch {
    return { current: "(none set)", milestones: [] };
  }
}

/**
 * Scan `<workspace>/runs/*.jsonl` for run_start/run_end events and build a
 * summary per run. Returns the most recent `limit` runs.
 *
 * The recorder writes one JSONL file per run. We read the first line (run_start)
 * and last run_end line of each to build the summary.
 */
export function readRecentRuns(workspaceDir: string, limit: number): RunSummary[] {
  const runsDir = join(workspaceDir, "runs");
  if (!existsSync(runsDir)) return [];

  let files: string[];
  try {
    files = readdirSync(runsDir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }

  const summaries: RunSummary[] = [];
  for (const file of files) {
    const s = summarizeRunFile(join(runsDir, file));
    if (s) summaries.push(s);
  }

  // Most recent first (by startedAt, falling back to filename which has a timestamp).
  summaries.sort((a, b) => (b.startedAt > a.startedAt ? 1 : b.startedAt < a.startedAt ? -1 : 0));
  return summaries.slice(0, limit);
}

function summarizeRunFile(filePath: string): RunSummary | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  const lines = raw.split("\n").filter(Boolean);
  if (lines.length === 0) return null;

  let runId = "";
  let agent = "";
  let status = "?";
  let turns = 0;
  let tokens = 0;
  let startedAt = "";

  for (const line of lines) {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    const type = String(ev["type"] ?? "");
    if (type === "run_start") {
      runId = String(ev["runId"] ?? "");
      agent = String(ev["agent"] ?? "");
      startedAt = String(ev["ts"] ?? "");
      if (startedAt && /^\d+$/.test(startedAt)) startedAt = new Date(Number(startedAt)).toISOString();
    } else if (type === "run_end") {
      status = String(ev["status"] ?? status);
      turns = Number(ev["turns"] ?? turns);
      const usage = ev["totalUsage"] as { totalTokens?: number } | undefined;
      tokens = usage?.totalTokens ?? tokens;
    }
  }

  if (!agent && !runId) return null;
  return { runId, agent, status, turns, tokens, startedAt };
}

/** Format a token count compactly (e.g. 1234 → "1.2k"). */
export function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** A single event from a run's JSONL log (for the run-detail page). */
export interface RunEvent {
  type: string;
  turn?: number;
  /** Short human-readable summary of the event. */
  label: string;
  /** Detail line (e.g. tool name + args, or token count). */
  detail?: string;
  isError?: boolean;
}

export interface RunDetail {
  runId: string;
  agent: string;
  status: string;
  task: string;
  turns: number;
  tokens: number;
  events: RunEvent[];
}

/**
 * Read a single run's full event log (its JSONL file) into a structured detail.
 * Returns null if the run file can't be found or parsed. The runId may be a
 * prefix; the first matching file under <workspace>/runs/ is used.
 */
export function readRunDetail(workspaceDir: string, runIdOrPrefix: string): RunDetail | null {
  const runsDir = join(workspaceDir, "runs");
  if (!existsSync(runsDir)) return null;

  let files: string[];
  try {
    files = readdirSync(runsDir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return null;
  }

  // Match by runId prefix embedded in the filename OR the runId field inside.
  // Filenames look like events_<iso>_<runId>.jsonl.
  const target = runIdOrPrefix.toLowerCase();
  const file =
    files.find((f) => f.toLowerCase().includes(target)) ??
    files.find((f) => f.toLowerCase() === `events_${target}.jsonl`);
  if (!file) return null;

  let raw: string;
  try {
    raw = readFileSync(join(runsDir, file), "utf8");
  } catch {
    return null;
  }

  const events: RunEvent[] = [];
  let runId = runIdOrPrefix;
  let agent = "";
  let status = "?";
  let task = "";
  let turns = 0;
  let tokens = 0;

  for (const line of raw.split("\n").filter(Boolean)) {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    const type = String(ev["type"] ?? "");
    if (type === "run_start") {
      runId = String(ev["runId"] ?? runId);
      agent = String(ev["agent"] ?? agent);
      task = String(ev["task"] ?? "");
      events.push({ type, label: "run start", detail: agent });
    } else if (type === "run_end") {
      status = String(ev["status"] ?? status);
      turns = Number(ev["turns"] ?? turns);
      const usage = ev["totalUsage"] as { totalTokens?: number } | undefined;
      tokens = usage?.totalTokens ?? tokens;
      events.push({ type, label: "run end", detail: `${status} · ${turns} turns · ${formatTokens(tokens)} tokens` });
    } else if (type === "turn_start") {
      events.push({ type, turn: Number(ev["turn"]), label: "turn start", detail: `turn ${ev["turn"]}` });
    } else if (type === "llm_response") {
      events.push({
        type,
        turn: Number(ev["turn"]),
        label: "llm response",
        detail: `${ev["finishReason"] ?? "?"} · ${ev["toolCallCount"] ?? 0} tool call(s)`,
      });
    } else if (type === "tool_call_start") {
      events.push({
        type,
        turn: Number(ev["turn"]),
        label: `→ ${ev["tool"]}`,
        detail: JSON.stringify(ev["args"] ?? {}),
      });
    } else if (type === "tool_call_result") {
      events.push({
        type,
        turn: Number(ev["turn"]),
        label: `← ${ev["tool"]}`,
        detail: String(ev["resultPreview"] ?? "").slice(0, 120),
        isError: ev["isError"] === true,
      });
    }
  }

  if (!agent && events.length === 0) return null;
  return { runId, agent, status, task, turns, tokens, events };
}

// ── Overview (cross-project health, for the Home Overview tab) ──────────────

import { listProjects, type ProjectEntry } from "../project/registry.js";

/** Per-project health summary, used in the Home Overview aggregate. */
export interface ProjectHealth {
  name: string;
  path: string;
  pinned: boolean;
  /** Number of run JSONL files found under <path>/runs/. */
  runCount: number;
  /** Tokens from the most recent run's run_end totalUsage (0 if none). */
  lastRunTokens: number;
  /** Status of the most recent run ("complete" / "error" / "running" / "?"). */
  lastRunStatus: string;
  /** Whether the most recent run ended in error. */
  lastRunFailed: boolean;
}

/**
 * The aggregate overview shown on the Home surface's Overview tab.
 *
 * Pure (no side effects beyond reads). Never throws — missing data degrades to
 * zeros. Reads each project's `runs/` directory for run summaries.
 */
export interface OverviewModel {
  projects: ProjectHealth[];
  totalProjects: number;
  totalRuns: number;
  totalTokens: number;
  failedRuns: number;
  /** Projects whose most recent run failed (the "needs attention" set). */
  needingAttention: string[];
  /** Approvals pending in the *currently active* project (cross-project
   *  approval aggregation needs a global approvals store; for now we surface
   *  the active project's count). */
  activeApprovalsPending: number;
}

/**
 * Build the cross-project overview model by scanning every registered
 * project's `runs/` directory. `activeApprovalsPending` is passed in by the
 * caller (from the active project's ApprovalsQueue).
 *
 * Pure (reads only). Never throws.
 */
export function buildOverview(activeApprovalsPending: number): OverviewModel {
  const projects = listProjects();
  const health: ProjectHealth[] = projects.map((p) => projectHealth(p));

  const totalRuns = health.reduce((sum, h) => sum + h.runCount, 0);
  const totalTokens = health.reduce((sum, h) => sum + h.lastRunTokens, 0);
  const failedRuns = health.filter((h) => h.lastRunFailed).length;
  const needingAttention = health.filter((h) => h.lastRunFailed).map((h) => h.name);

  return {
    projects: health,
    totalProjects: projects.length,
    totalRuns,
    totalTokens,
    failedRuns,
    needingAttention,
    activeApprovalsPending,
  };
}

/** Compute health for a single project from its on-disk run logs. Pure. */
function projectHealth(entry: ProjectEntry): ProjectHealth {
  const runs = readRecentRuns(entry.path, 1);
  const allRuns = readRecentRuns(entry.path, 1000);
  const last = runs[0];
  const lastRunTokens = last?.tokens ?? 0;
  const lastRunStatus = last?.status ?? "(no runs)";
  const lastRunFailed = last?.status === "error" || last?.status === "halt";
  return {
    name: entry.name,
    path: entry.path,
    pinned: entry.pinned ?? false,
    runCount: allRuns.length,
    lastRunTokens,
    lastRunStatus,
    lastRunFailed,
  };
}
