/**
 * AgentDetail — the drill-down view for a single agent.
 *
 * Shows:
 *   1. The agent's config (frontmatter: model, source, permission mode, tools).
 *   2. A **live stream** of what the agent is currently doing — re-reads the
 *      agent's most recent run's JSONL event log on a short interval and
 *      renders the latest events. This is "live-ish" (JSONL tail), not a true
 *      in-process EventEmitter stream (that needs run-from-TUI / Phase 5.5 and
 *      is deferred to M8). For CLI-started runs (`sophron run`), the JSONL is
 *      flushed after every event, so the tail tracks the live run closely.
 *
 * Nav (see nav.ts): Esc returns to the Agents tab.
 */
import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { formatTokens, readRunDetail, type RunDetail, type DashboardModel } from "../dashboard.js";

export interface AgentDetailProps {
  model: DashboardModel;
  agentName: string;
  /** Effective model override for this agent, if any. */
  effectiveModel?: string;
  /** Live streaming assistant content from a TUI-triggered run. */
  agentStream?: { agentName: string; text: string } | null;
}

const REFRESH_MS = 500;

export function AgentDetail({ model, agentName, effectiveModel, agentStream }: AgentDetailProps) {
  const agent = model.agents.find((a) => a.name === agentName);

  // ── Live stream: re-read the agent's most recent run on an interval ──
  // Find the latest run for THIS agent, then tail its JSONL.
  const latestRunId = model.recentRuns.find((r) => r.agent === agentName)?.runId ?? null;
  const [detail, setDetail] = useState<RunDetail | null>(
    latestRunId ? readRunDetail(model.workspaceDir, latestRunId) : null,
  );

  useEffect(() => {
    if (!latestRunId) {
      setDetail(null);
      return;
    }
    // Prime immediately.
    setDetail(readRunDetail(model.workspaceDir, latestRunId));
    const timer = setInterval(() => {
      setDetail(readRunDetail(model.workspaceDir, latestRunId));
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [model.workspaceDir, latestRunId]);

  const isRunning = detail?.status === "running";

  return (
    <Box flexDirection="column">
      {/* ── Config ── */}
      <Box marginBottom={1}>
        <Text bold color="cyan">
          🤖 {agentName}
        </Text>
        {isRunning ? <Text color="green"> ● running</Text> : null}
      </Box>
      {agent ? (
        <>
          <Box marginBottom={1}>
            <Text>
              {"  "}
              <Text dimColor>description: </Text>
              {agent.description}
            </Text>
          </Box>
          <Box marginBottom={1}>
            <Text>
              {"  "}
              <Text dimColor>model: </Text>
              {effectiveModel ?? agent.model}
              {effectiveModel && effectiveModel !== agent.model ? (
                <Text color="yellow"> (override)</Text>
              ) : null}
            </Text>
          </Box>
          <Box marginBottom={1}>
            <Text>
              {"  "}
              <Text dimColor>source: </Text>
              {agent.source}
            </Text>
          </Box>
        </>
      ) : (
        <Box marginBottom={1}>
          <Text dimColor>{"  (agent not found)"}</Text>
        </Box>
      )}

      {/* ── Live stream (in-process TUI run) ── */}
      {agentStream && agentStream.agentName === agentName && agentStream.text ? (
        <>
          <Box marginTop={1} marginBottom={1}>
            <Text dimColor>{"  ── streaming ──"}</Text>
          </Box>
          <Box marginBottom={1}>
            <Text color="cyan">{"  "}{agentStream.text}</Text>
          </Box>
        </>
      ) : null}

      {/* ── Live stream (JSONL tail) ── */}
      <Box marginTop={1} marginBottom={1}>
        <Text dimColor>
          {"  ── live stream "}
          {latestRunId ? `(run ${latestRunId.slice(0, 8)}, refresh ${REFRESH_MS}ms)` : "(no runs yet)"}
          {" ──"}
        </Text>
      </Box>
      {detail ? (
        <>
          {detail.task ? (
            <Box marginBottom={1}>
              <Text dimColor>{"  task: "}</Text>
              <Text>{detail.task}</Text>
            </Box>
          ) : null}
          {detail.events.slice(-15).map((e, i) => (
            <Box key={i} flexDirection="column">
              <Text color={e.isError ? "red" : undefined}>
                {"  "}
                {e.turn !== undefined ? `t${e.turn} ` : "   "}
                {e.label}
              </Text>
              {e.detail ? <Text dimColor>      {e.detail}</Text> : null}
            </Box>
          ))}
          <Box marginTop={1}>
            <Text dimColor>
              {"  "}
              {detail.turns} turns · {formatTokens(detail.tokens)} tokens · [{detail.status}]
            </Text>
          </Box>
        </>
      ) : (
        <Text dimColor>{"  (no run activity — start one via `sophron run " + agentName + ' "<task>"`)'}</Text>
      )}

      <Box marginTop={1}>
        <Text dimColor>{"  (Esc back to Agents · type a task below to queue it for this agent)"}</Text>
      </Box>
    </Box>
  );
}
