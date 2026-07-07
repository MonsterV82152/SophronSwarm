/**
 * Project-surface tabs — the content for each tab on the Project View.
 *
 * The Project surface has six tabs: Status · Agents · Runs · Checkpoint ·
 * Memory · Cost. Each is a presentational component taking the dashboard model
 * (+ optional selection index for navigable tabs). The App owns navigation.
 *
 * See docs/ROADMAP.md (M3).
 */
import React from "react";
import { Box, Text } from "ink";
import { SelectList, type SelectListItem } from "./SelectList.js";
import { formatTokens, type DashboardModel, type RunDetail } from "../dashboard.js";

export interface ProjectTabProps {
  model: DashboardModel;
}

// ── Status: at-a-glance project health ──────────────────────────────────────

export function StatusTab({ model }: ProjectTabProps) {
  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="cyan">
          📊 Status — {model.workspaceDir.split("/").pop()}
        </Text>
      </Box>
      <Box marginBottom={1}>
        <Text>
          {"  "}
          <Text dimColor>workspace: </Text>
          {model.workspaceDir}
        </Text>
      </Box>
      <Box marginBottom={1}>
        <Text>
          {"  "}
          <Text dimColor>agents: </Text>
          <Text bold>{model.agents.length}</Text>
          <Text dimColor> · runs: </Text>
          <Text bold>{model.recentRuns.length}</Text>
          <Text dimColor> · checkpoint: </Text>
          <Text color="green">{model.checkpoint.current}</Text>
        </Text>
      </Box>
      <Box marginBottom={1}>
        <Text>
          {"  "}
          <Text dimColor>tokens (promoted): </Text>
          <Text bold>{formatTokens(model.mcpCost.total)}</Text>
          <Text dimColor> · mcp servers: </Text>
          <Text bold>{model.mcpCost.configuredServers.length}</Text>
        </Text>
      </Box>
      {model.approvalsPending > 0 ? (
        <Box marginBottom={1}>
          <Text color="yellow">{"  ⚠ "}{model.approvalsPending} pending approval(s) — use /approve</Text>
        </Box>
      ) : (
        <Box marginBottom={1}>
          <Text color="green">{"  ✓ no pending approvals"}</Text>
        </Box>
      )}
    </Box>
  );
}

// ── Agents: navigable list of loaded agents ─────────────────────────────────

export function AgentsTab({ model, selectedIndex }: ProjectTabProps & { selectedIndex: number }) {
  const items: SelectListItem[] = model.agents.map((a) => ({
    id: a.name,
    label: a.name,
    hint: `${a.description} [${a.source}] ${a.model}`,
    icon: "🤖",
  }));
  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="cyan">
          🤖 Agents ({model.agents.length})
        </Text>
      </Box>
      {model.agents.length === 0 ? (
        <Text dimColor>{"  (no agents loaded)"}</Text>
      ) : (
        <SelectList items={items} selectedIndex={selectedIndex} />
      )}
      <Box marginTop={1}>
        <Text dimColor>{"  (↑↓ select · Enter to open + live stream · Esc back)"}</Text>
      </Box>
    </Box>
  );
}

// ── Runs: navigable list of recent runs ─────────────────────────────────────

export function RunsTab({ model, selectedIndex }: ProjectTabProps & { selectedIndex: number }) {
  const items: SelectListItem[] = model.recentRuns.map((r) => ({
    id: r.runId,
    label: `${r.agent} [${r.status}]`,
    hint: `${r.turns} turns · ${formatTokens(r.tokens)} tokens · ${r.runId.slice(0, 8)} · ${r.startedAt}`,
    icon: "📊",
  }));
  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="cyan">
          📊 Recent Runs ({model.recentRuns.length})
        </Text>
      </Box>
      {model.recentRuns.length === 0 ? (
        <Text dimColor>{"  (no runs yet — use `sophron run` or the Agents tab)"}</Text>
      ) : (
        <SelectList items={items} selectedIndex={selectedIndex} />
      )}
      <Box marginTop={1}>
        <Text dimColor>{"  (↑↓ select · Enter to expand · Esc back)"}</Text>
      </Box>
    </Box>
  );
}

// ── Run detail (drill-down from Runs) ───────────────────────────────────────

export function RunDetailView({ detail }: { detail: RunDetail | null }) {
  return (
    <Box flexDirection="column">
      {detail ? (
        <>
          <Box marginBottom={1}>
            <Text bold color="cyan">
              📊 {detail.agent} [{detail.status}]
            </Text>
          </Box>
          {detail.task ? (
            <Box marginBottom={1}>
              <Text>
                <Text dimColor>task: </Text>
                {detail.task}
              </Text>
            </Box>
          ) : null}
          <Box marginBottom={1}>
            <Text>
              <Text dimColor>summary: </Text>
              {detail.turns} turns · {formatTokens(detail.tokens)} tokens · {detail.runId.slice(0, 8)}
            </Text>
          </Box>
          <Box marginBottom={1}>
            <Text dimColor>── event log ({detail.events.length}) ──</Text>
          </Box>
          {detail.events.slice(-30).map((e, i) => (
            <Box key={i} flexDirection="column">
              <Text color={e.isError ? "red" : undefined}>
                {e.turn !== undefined ? `t${e.turn} ` : "   "}
                {e.label}
              </Text>
              {e.detail ? <Text dimColor>      {e.detail}</Text> : null}
            </Box>
          ))}
        </>
      ) : (
        <Text dimColor>(run not found)</Text>
      )}
      <Box marginTop={1}>
        <Text dimColor>{"  (Esc back to Runs)"}</Text>
      </Box>
    </Box>
  );
}

// ── Checkpoint ──────────────────────────────────────────────────────────────

export function CheckpointTab({ model }: ProjectTabProps) {
  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="cyan">
          🎯 Checkpoint
        </Text>
      </Box>
      <Box marginBottom={1}>
        <Text>
          {"  "}
          <Text dimColor>current: </Text>
          <Text color="green">{model.checkpoint.current}</Text>
        </Text>
      </Box>
      {model.checkpoint.milestones.length === 0 ? (
        <Box marginBottom={1}>
          <Text dimColor>{"  (no milestones defined)"}</Text>
        </Box>
      ) : (
        model.checkpoint.milestones.map((m) => (
          <Box key={m.index} marginBottom={1}>
            <Text>
              {"  "}
              <Text dimColor>
                {m.done ? "[x]" : "[ ]"} {m.index}. {m.title}
              </Text>
            </Text>
          </Box>
        ))
      )}
      <Box marginTop={1}>
        <Text dimColor>{"  (use /advance to mark current complete + advance)"}</Text>
      </Box>
    </Box>
  );
}

// ── Memory ──────────────────────────────────────────────────────────────────

export function MemoryTab({ content, label }: { content: string; label: string }) {
  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="cyan">
          🧠 Memory — {label}
        </Text>
      </Box>
      {content ? (
        content.split("\n").map((line, i) => (
          <Text key={i}>{"  "}{line}</Text>
        ))
      ) : (
        <Text dimColor>{"  (empty)"}</Text>
      )}
      <Box marginTop={1}>
        <Text dimColor>{"  (/memory for shared · /memory <agent> for per-agent · /clear to reset view)"}</Text>
      </Box>
    </Box>
  );
}

// ── Cost ────────────────────────────────────────────────────────────────────

export function CostTab({ model }: ProjectTabProps) {
  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="cyan">
          💰 MCP Token Cost
        </Text>
      </Box>
      <Box marginBottom={1}>
        <Text>
          {"  "}
          <Text dimColor>configured servers: </Text>
          {model.mcpCost.configuredServers.length > 0
            ? model.mcpCost.configuredServers.join(", ")
            : "(none)"}
        </Text>
      </Box>
      <Box marginBottom={1}>
        <Text>
          {"  "}
          <Text dimColor>promoted total: </Text>
          <Text bold>{formatTokens(model.mcpCost.total)}</Text>
        </Text>
      </Box>
      {model.mcpCost.perServer.length > 0 ? (
        <>
          <Box marginBottom={1}>
            <Text dimColor>{"  ── per-server ──"}</Text>
          </Box>
          {model.mcpCost.perServer.map((p) => (
            <Box key={p.server} marginBottom={1}>
              <Text>
                {"  "}
                <Text bold>{p.server}</Text>
                <Text dimColor> — {formatTokens(p.tokens)} tokens</Text>
              </Text>
            </Box>
          ))}
        </>
      ) : (
        <Box marginBottom={1}>
          <Text dimColor>{"  (lazy by default — promote tools via mcp_tool_search)"}</Text>
        </Box>
      )}
    </Box>
  );
}
