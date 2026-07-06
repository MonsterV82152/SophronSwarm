/**
 * DashboardView — renders the DashboardModel as an Ink panel.
 *
 * Presentational component: takes a model, renders text. No business logic.
 * Tested via ink-testing-library.
 */
import { Text } from "ink";
import type { DashboardModel } from "../dashboard.js";
import { formatTokens } from "../dashboard.js";

export function DashboardView({ model }: { model: DashboardModel }) {
  return (
    <>
      <Text bold color="cyan">
        SophronSwarm V3 — Dashboard
      </Text>
      <Text dimColor> workspace: {model.workspaceDir}</Text>

      <Text>
        {"\n"}
        <Text bold>Agents</Text>
        <Text dimColor> ({model.agents.length})</Text>
        {model.approvalsPending > 0 ? (
          <Text color="yellow"> ⚠ {model.approvalsPending} pending approval(s)</Text>
        ) : (
          ""
        )}
      </Text>
      {model.agents.length === 0 ? (
        <Text dimColor>  (no agents loaded)</Text>
      ) : (
        model.agents.map((a) => (
          <Text key={a.name}>
            {"\n  "}
            <Text bold>{a.name}</Text>
            <Text dimColor> [{a.source}] {a.model}</Text>
            {"\n  "}
            <Text dimColor>{a.description}</Text>
          </Text>
        ))
      )}

      <Text>
        {"\n"}
        <Text bold>Checkpoint</Text>
      </Text>
      <Text>
        {"  "}
        <Text dimColor>current: </Text>
        <Text color="green">{model.checkpoint.current}</Text>
      </Text>
      {model.checkpoint.milestones.length > 0 ? (
        model.checkpoint.milestones.map((m) => (
          <Text key={m.index}>
            {"\n  "}
            <Text dimColor>
              {m.done ? "[x]" : "[ ]"} {m.index}. {m.title}
            </Text>
          </Text>
        ))
      ) : (
        <Text dimColor>  (no milestones defined)</Text>
      )}

      <Text>
        {"\n"}
        <Text bold>MCP Cost</Text>
        {model.mcpCost.configuredServers.length === 0 ? (
          <Text dimColor> (no servers configured)</Text>
        ) : (
          ""
        )}
      </Text>
      {model.mcpCost.total > 0 ? (
        <Text>
          {"  "}
          <Text dimColor>promoted tools: </Text>
          <Text color={model.mcpCost.total > 4000 ? "red" : "green"}>{formatTokens(model.mcpCost.total)} tokens/turn</Text>
        </Text>
      ) : (
        <Text dimColor>  (no tools promoted — lazy)</Text>
      )}
      {model.mcpCost.perServer.map((s) => (
        <Text key={s.server}>
          {"\n  "}
          <Text dimColor>
            {s.server}: {formatTokens(s.tokens)} tokens/turn
          </Text>
        </Text>
      ))}

      <Text>
        {"\n"}
        <Text bold>Recent Runs</Text>
        <Text dimColor> (last {model.recentRuns.length})</Text>
      </Text>
      {model.recentRuns.length === 0 ? (
        <Text dimColor>  (no runs yet)</Text>
      ) : (
        model.recentRuns.map((r) => (
          <Text key={r.runId}>
            {"\n  "}
            <Text bold>{r.agent}</Text>
            <Text dimColor> [{r.status}] {r.turns} turns, {formatTokens(r.tokens)} tokens</Text>
          </Text>
        ))
      )}
    </>
  );
}
