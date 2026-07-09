/**
 * OverviewTab — the Home surface's display-only aggregate health view.
 *
 * Shows cross-project health: total projects, total runs, total tokens, failed
 * runs (needing attention), and a per-project table. No drill-in (display-only).
 *
 * Data comes from buildOverview() (dashboard.ts).
 */
import React from "react";
import { Box, Text } from "ink";
import { formatTokens, type OverviewModel } from "../dashboard.js";

export interface OverviewTabProps {
  overview: OverviewModel;
  /** Name of the currently active project (for highlighting). */
  activeProjectName: string;
}

export function OverviewTab({ overview, activeProjectName }: OverviewTabProps) {
  return (
    <Box flexDirection="column">
      {/* ── Aggregate stats ── */}
      <Box marginBottom={1}>
        <Text bold color="cyan">
          🌐 Overview — all projects
        </Text>
      </Box>
      <Box marginBottom={1}>
        <Text>
          {"  "}
          <Text dimColor>projects: </Text>
          <Text bold>{overview.totalProjects}</Text>
          <Text dimColor> · runs: </Text>
          <Text bold>{overview.totalRuns}</Text>
          <Text dimColor> · tokens: </Text>
          <Text bold>{formatTokens(overview.totalTokens)}</Text>
          {overview.activeApprovalsPending > 0 ? (
            <Text color="yellow"> · ⚠ {overview.activeApprovalsPending} pending approval(s)</Text>
          ) : null}
          {overview.totalDraftsPending > 0 ? (
            <Text color="yellow"> · 📝 {overview.totalDraftsPending} draft(s) pending</Text>
          ) : null}
        </Text>
      </Box>

      {/* ── Needs attention ── */}
      {overview.totalDraftsPending > 0 ? (
        <Box marginBottom={1}>
          <Text bold color="yellow">
            {"  "}→ {overview.totalDraftsPending} agent draft(s) pending approval — switch to the Drafts tab to review
          </Text>
        </Box>
      ) : null}

      {overview.needingAttention.length > 0 ? (
        <Box marginBottom={1}>
          <Text color="red">
            {"  "}⚠ Needs attention: {overview.needingAttention.join(", ")}
          </Text>
        </Box>
      ) : (
        <Box marginBottom={1}>
          <Text color="green">{"  "}✓ All projects healthy</Text>
        </Box>
      )}

      {/* ── Per-project table ── */}
      <Box marginBottom={1}>
        <Text dimColor>{"  ── projects ──"}</Text>
      </Box>
      {overview.projects.length === 0 ? (
        <Text dimColor>{"  (no projects registered — use the Orchestrator tab to propose one)"}</Text>
      ) : (
        overview.projects.map((p) => {
          const isActive = p.name === activeProjectName;
          const statusColor = p.lastRunFailed ? "red" : p.runCount > 0 ? "green" : "gray";
          return (
            <Box key={`${p.name}:${p.path}`} marginBottom={1}>
              <Text>
                {"  "}
                {p.pinned ? "📌 " : "   "}
                <Text bold={isActive} color={isActive ? "magenta" : undefined}>
                  {p.name}
                </Text>
                {isActive ? <Text dimColor> (active)</Text> : null}
                <Text dimColor> — runs: {p.runCount}</Text>
                <Text dimColor> · last: </Text>
                <Text color={statusColor as "red" | "green" | "gray"}>{p.lastRunStatus}</Text>
                <Text dimColor> · {formatTokens(p.lastRunTokens)} tokens</Text>
                {p.draftsPending > 0 ? (
                  <Text color="yellow"> · 📝 {p.draftsPending} draft(s)</Text>
                ) : null}
              </Text>
            </Box>
          );
        })
      )}
    </Box>
  );
}
