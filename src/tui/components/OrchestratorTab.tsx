/**
 * OrchestratorTab — the Home surface's global-orchestrator chat (STUB).
 *
 * This tab is reserved for the global orchestrator (ROADMAP M7/M8). Until that
 * lands, it renders a placeholder explaining the stub. When M8 ships, this
 * becomes a two-pane view: conversation list (left) + chat (right), Claude-Code/
 * Codex-style.
 *
 * Nav model (see nav.ts): the Orchestrator tab supports drill-in (Enter →
 * content focus), but content is non-navigable (no ↑/↓ list) until the real
 * chat lands.
 */
import React from "react";
import { Box, Text } from "ink";

export function OrchestratorTab() {
  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="cyan">
          🧭 Orchestrator
        </Text>
      </Box>
      <Box marginBottom={1}>
        <Text dimColor>{"  ┌─────────────────────────────────────────────────────────┐"}</Text>
      </Box>
      <Box marginBottom={1}>
        <Text dimColor>{"  │  The global orchestrator is not yet built.            │"}</Text>
      </Box>
      <Box marginBottom={1}>
        <Text dimColor>{"  │                                                         │"}</Text>
      </Box>
      <Box marginBottom={1}>
        <Text dimColor>{"  │  Once M7 lands, this tab is where you propose and      │"}</Text>
      </Box>
      <Box marginBottom={1}>
        <Text dimColor>{"  │  create projects by chatting with the global           │"}</Text>
      </Box>
      <Box marginBottom={1}>
        <Text dimColor>{"  │  orchestrator (the operator's \"CEO\").                  │"}</Text>
      </Box>
      <Box marginBottom={1}>
        <Text dimColor>{"  └─────────────────────────────────────────────────────────┘"}</Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>{"  (Esc/← back to tabs · see docs/ROADMAP.md M7–M8)"}</Text>
      </Box>
    </Box>
  );
}
