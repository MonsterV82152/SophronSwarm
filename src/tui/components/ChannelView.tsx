/**
 * ChannelView — real-time stream + controls for a single agent.
 *
 * This is the M4 replacement for the JSONL-polling AgentDetail when the operator
 * enters an agent's live channel. It subscribes to the in-process AgentEventBus
 * and renders the activity thread as events arrive.
 *
 * Interactive channels (orchestrators) show a chat input; observation channels
 * (workers) are read-only.
 */
import React, { useEffect, useLayoutEffect, useState } from "react";
import { Box, Text } from "ink";
import { agentEvents, type AgentEvent } from "../../agent/events.js";
import { runManager } from "../../agent/runManager.js";
import type { AgentDefinition } from "../../types.js";
import { MessageThread, type ActivityItem } from "./MessageThread.js";

export interface ChannelViewProps {
  agentName: string;
  agent: AgentDefinition;
  workspaceDir: string;
  interactive: boolean;
}

export function ChannelView({ agentName, agent, interactive }: ChannelViewProps) {
  const activeRun = runManager.isRunning(agentName);
  const [runId, setRunId] = useState<string | null>(activeRun?.runId ?? null);
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [status, setStatus] = useState<string>(activeRun ? "running" : "idle");
  const [turn, setTurn] = useState<number>(-1);

  // Re-evaluate active run when the operator enters the channel.
  useEffect(() => {
    const active = runManager.isRunning(agentName);
    if (active) {
      setRunId(active.runId);
      setStatus("running");
    }
  }, [agentName]);

  // Subscribe to all agent events and keep the ones for this agent.
  // useLayoutEffect is used so tests (and the TUI) see updates synchronously
  // right after the component mounts.
  useLayoutEffect(() => {
    const off = agentEvents.onAll((event) => {
      if (event.agentName !== agentName) return;
      if (event.type === "run_start" && event.runId) {
        setRunId(event.runId);
      }
      setItems((prev) => [...prev, eventToItem(event, prev.length)]);
      if (event.type === "run_start") {
        setStatus("running");
      } else if (event.type === "turn_start") {
        setTurn(event.turn ?? -1);
      } else if (event.type === "run_end" || event.type === "run_error") {
        setStatus(event.type === "run_error" ? "error" : (event.status ?? "complete"));
      }
    });
    return off;
  }, [agentName]);

  const statusColor = status === "running" ? "green" : status === "error" ? "red" : status === "stopped" ? "yellow" : "gray";

  return (
    <Box flexDirection="column" flexGrow={1}>
      {/* Status line */}
      <Box marginBottom={1}>
        <Text bold color="cyan">
          {interactive ? "🧭" : "🤖"} {agentName}
        </Text>
        <Text dimColor> · </Text>
        <Text>{agent.model}</Text>
        <Text dimColor> · </Text>
        <Text color={statusColor}>{status}</Text>
        {turn >= 0 ? <Text dimColor> · turn {turn}</Text> : null}
      </Box>

      {/* Activity thread */}
      <Box flexDirection="column" flexGrow={1}>
        <MessageThread
          items={items}
          emptyHint={
            interactive
              ? "No activity yet. Type a task below to start this agent."
              : "No activity yet. This agent runs when delegated to by an orchestrator."
          }
        />
      </Box>

      {/* Controls */}
      <Box marginTop={1}>
        <Text dimColor>
          {interactive
            ? "[/stop] stop · [/model] change model · [Esc] back · @file to attach"
            : "[/stop] stop · [/model] change model · [Esc] back · observation only"}
        </Text>
      </Box>
    </Box>
  );
}

function eventToItem(event: AgentEvent, seq: number): ActivityItem {
  switch (event.type) {
    case "run_start":
      return { id: seq, kind: "event", text: `Run started: ${event.task ?? "(no task)"}`, color: "cyan" };
    case "turn_start":
      return { id: seq, kind: "event", text: "Turn started", turn: event.turn };
    case "llm_response":
      return {
        id: seq,
        kind: "event",
        text: `LLM response · ${event.finishReason ?? ""} · ${event.toolCallCount ?? 0} tool call(s)`,
        turn: event.turn,
        color: "cyan",
      };
    case "tool_call_start":
      return {
        id: seq,
        kind: "event",
        text: `${event.tool ?? "?"} · ${JSON.stringify(event.args ?? {})}`,
        turn: event.turn,
        color: "yellow",
      };
    case "tool_call_result":
      return {
        id: seq,
        kind: "event",
        text: `${event.isError ? "✗" : "✓"} ${event.resultPreview?.slice(0, 80) ?? ""}`,
        turn: event.turn,
        color: event.isError ? "red" : "green",
      };
    case "turn_end":
      return {
        id: seq,
        kind: "event",
        text: `Turn end · ${event.cumulativeUsage?.totalTokens ?? 0} tokens`,
        turn: event.turn,
        color: "gray",
      };
    case "run_end":
      return { id: seq, kind: "event", text: `Run ended · ${event.status ?? ""}`, color: "gray" };
    case "run_error":
      return { id: seq, kind: "event", text: `Run error: ${event.error ?? ""}`, color: "red" };
    default:
      return { id: seq, kind: "event", text: String(event.type), color: "gray" };
  }
}
