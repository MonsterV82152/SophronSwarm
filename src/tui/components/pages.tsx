/**
 * TUI pages — the content rendered for each navigable page.
 *
 * Each page is a pure presentational component: it takes the dashboard model
 * (+ optional callbacks) and renders. The App owns navigation state and
 * keyboard handling; pages just display data.
 *
 * Page model:
 *   - Home     : the main navigable menu
 *   - Projects : current project summary + overview
 *   - Agents   : loaded agent definitions
 *   - Runs     : recent runs
 *   - Checkpoint : current milestone + list
 *   - Cost     : MCP token-cost meter
 *   - Memory   : shared + per-agent memory browser
 *   - Help     : command reference
 *
 * See docs/PHASE_5_DESIGN.md.
 */
import React from "react";
import { Box, Text } from "ink";
import { SelectList, type SelectListItem } from "./SelectList.js";
import { formatTokens, type DashboardModel, type RunDetail } from "../dashboard.js";
import { HELP_TEXT } from "../slashCommands.js";

/** All navigable pages. */
export type Page =
  | "home"
  | "projects"
  | "agents"
  | "runs"
  | "checkpoint"
  | "cost"
  | "memory"
  | "help"
  | "agentDetail"
  | "runDetail";

/** The home-page menu items (id = the page to navigate to). */
export const HOME_MENU: (SelectListItem & { page: Page | "quit" })[] = [
  { id: "projects", label: "Projects", hint: "Current project summary + overview", icon: "📁", page: "projects" },
  { id: "agents", label: "Agents", hint: "Loaded agent definitions", icon: "🤖", page: "agents" },
  { id: "runs", label: "Runs", hint: "Recent agent runs", icon: "📊", page: "runs" },
  { id: "checkpoint", label: "Checkpoint", hint: "Current project milestone", icon: "🎯", page: "checkpoint" },
  { id: "cost", label: "MCP Cost", hint: "Token-cost meter", icon: "💰", page: "cost" },
  { id: "memory", label: "Memory", hint: "Shared + per-agent memory", icon: "🧠", page: "memory" },
  { id: "help", label: "Help", hint: "Commands reference", icon: "❓", page: "help" },
  { id: "quit", label: "Quit", hint: "Exit SophronSwarm", icon: "🚪", page: "quit" },
];

export interface PageProps {
  model: DashboardModel;
}

/** The home page — a navigable menu of pages. */
export function HomePage({
  model,
  selectedIndex,
}: PageProps & { selectedIndex: number }) {
  const items = HOME_MENU.map(({ id, label, hint, icon }) => ({ id, label, hint, icon }));
  return (
    <Box flexDirection="column">
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color="cyan">
          SophronSwarm V3
        </Text>
        <Text dimColor>
          workspace: {model.workspaceDir}
          {model.approvalsPending > 0 ? `  ⚠ ${model.approvalsPending} pending` : ""}
        </Text>
      </Box>
      <SelectList items={items} selectedIndex={selectedIndex} />
    </Box>
  );
}

/** Projects page — current project summary + overview. */
export function ProjectsPage({ model }: PageProps) {
  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="cyan">
          📁 Project
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
          {model.agents.length}
          <Text dimColor> · runs: </Text>
          {model.recentRuns.length}
          <Text dimColor> · mcp servers: </Text>
          {model.mcpCost.configuredServers.length}
        </Text>
      </Box>
      <Box marginBottom={1}>
        <Text>
          {"  "}
          <Text dimColor>checkpoint: </Text>
          <Text color="green">{model.checkpoint.current}</Text>
        </Text>
      </Box>
    </Box>
  );
}

/** Agents page — a navigable list of loaded agent definitions. */
export function AgentsPage({
  model,
  selectedIndex,
}: PageProps & { selectedIndex: number }) {
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
        <Text dimColor>  (no agents loaded)</Text>
      ) : (
        <SelectList items={items} selectedIndex={selectedIndex} />
      )}
      <Box marginTop={1}>
        <Text dimColor>{"  "}(Enter to open an agent · Esc back)</Text>
      </Box>
    </Box>
  );
}

/** Agent detail page — full config + a dedicated input (tasks go to this agent). */
export function AgentDetailPage({
  model,
  agentName,
  input,
  mode,
}: PageProps & { agentName: string; input: string; mode: "navigate" | "compose" }) {
  const agent = model.agents.find((a) => a.name === agentName);
  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="cyan">
          🤖 {agentName}
        </Text>
      </Box>
      {agent ? (
        <>
          <Box marginBottom={1}>
            <Text>
              <Text dimColor>description: </Text>
              {agent.description}
            </Text>
          </Box>
          <Box marginBottom={1}>
            <Text>
              <Text dimColor>model: </Text>
              {agent.model}
            </Text>
          </Box>
          <Box marginBottom={1}>
            <Text>
              <Text dimColor>source: </Text>
              {agent.source}
            </Text>
          </Box>
        </>
      ) : (
        <Box marginBottom={1}>
          <Text dimColor>(agent not found)</Text>
        </Box>
      )}
      <Box marginTop={1} marginBottom={1}>
        <Text dimColor>── send a task to {agentName} ──</Text>
      </Box>
      <Box>
        <Text bold color={mode === "compose" ? "cyan" : "gray"}>
          {agentName}{"> "}
        </Text>
        <Text>{input}</Text>
        <Text dimColor>{mode === "compose" ? "" : "▏"}</Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>{"  "}(type a task + Enter to run · Esc back · execution needs async runner)</Text>
      </Box>
    </Box>
  );
}

/** Runs page — a navigable list of recent agent runs. */
export function RunsPage({
  model,
  selectedIndex,
}: PageProps & { selectedIndex: number }) {
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
          📊 Recent Runs
        </Text>
      </Box>
      {model.recentRuns.length === 0 ? (
        <Text dimColor>  (no runs yet)</Text>
      ) : (
        <SelectList items={items} selectedIndex={selectedIndex} />
      )}
      <Box marginTop={1}>
        <Text dimColor>{"  "}(Enter to expand a run · Esc back)</Text>
      </Box>
    </Box>
  );
}

/** Run detail page — full event log for a single run. */
export function RunDetailPage({ detail }: { detail: RunDetail | null }) {
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
          {detail.events.map((e, i) => (
            <Box key={i} flexDirection="column" marginBottom={1}>
              <Text color={e.isError ? "red" : undefined}>
                {e.turn !== undefined ? `t${e.turn} ` : "   "}
                {e.label}
              </Text>
              {e.detail ? (
                <Text dimColor>      {e.detail}</Text>
              ) : null}
            </Box>
          ))}
        </>
      ) : (
        <Text dimColor>(run not found)</Text>
      )}
    </Box>
  );
}

/** Checkpoint page — current milestone + ordered list. */
export function CheckpointPage({ model }: PageProps) {
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
          <Text dimColor>  (no milestones defined)</Text>
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
        <Text dimColor>{"  "}(use /advance to mark current complete + advance)</Text>
      </Box>
    </Box>
  );
}

/** Cost page — MCP token-cost meter. */
export function CostPage({ model }: PageProps) {
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
          <Text color={model.mcpCost.total > 4000 ? "red" : "green"}>
            {formatTokens(model.mcpCost.total)} tokens/turn
          </Text>
        </Text>
      </Box>
      {model.mcpCost.total === 0 ? (
        <Box marginBottom={1}>
          <Text dimColor>  (no tools promoted — lazy by default)</Text>
        </Box>
      ) : (
        model.mcpCost.perServer.map((s) => (
          <Box key={s.server} marginBottom={1}>
            <Text dimColor>
              {"  "}
              {s.server}: {formatTokens(s.tokens)} tokens/turn
            </Text>
          </Box>
        ))
      )}
    </Box>
  );
}

/** Memory page — shared + per-agent memory summary. */
export function MemoryPage({
  model,
  memoryContent,
  memoryLabel,
}: PageProps & { memoryContent: string; memoryLabel: string }) {
  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="cyan">
          🧠 Memory
        </Text>
      </Box>
      <Box marginBottom={1}>
        <Text dimColor>
          {"  "}
          {memoryLabel}
        </Text>
      </Box>
      <Box marginTop={1} marginBottom={1}>
        <Text dimColor>── {memoryLabel} ──</Text>
      </Box>
      <Box flexDirection="column" marginBottom={1}>
        {memoryContent.trim() ? (
          memoryContent.split("\n").map((line, i) => (
            <Box key={i} marginBottom={1}>
              <Text>{line}</Text>
            </Box>
          ))
        ) : (
          <Text dimColor>(empty)</Text>
        )}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>{"  "}(use /memory [agent] to view a specific agent's memory)</Text>
      </Box>
    </Box>
  );
}

/** Help page — command reference. */
export function HelpPage() {
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        ❓ Help — Commands
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {HELP_TEXT.split("\n").map((line, i) => (
          <Text key={i} dimColor={line.trim() === ""}>
            {line}
          </Text>
        ))}
      </Box>
    </Box>
  );
}
