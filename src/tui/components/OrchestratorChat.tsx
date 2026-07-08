/**
 * OrchestratorChat — the Home surface's global-orchestrator chat (M8).
 *
 * Replaces the M3 stub. This is where the operator talks to the **global
 * orchestrator** — the operator's "CEO" that manages the project lifecycle
 * (propose / create / list projects). The orchestrator runs via `runAgent`
 * (M7 global-orchestrator.md, `noMemory: true`, scoped tools).
 *
 * Layout:
 *   - Message thread (user + orchestrator), newest at the bottom.
 *   - "thinking…" indicator while the orchestrator is running.
 *   - Install hint if the global orchestrator isn't installed yet.
 *
 * Input: the bottom input bar (shared across tabs). When the operator is on
 * this tab and submits non-slash-command text, app.tsx routes it to
 * `onSubmit` which runs the orchestrator's agent loop.
 *
 * Nav model: the Orchestrator tab supports drill-in (Enter → content focus),
 * but content is non-navigable (no ↑/↓ list) — it's a chat, not a list.
 */
import React from "react";
import { Box, Text } from "ink";

export interface ChatMessage {
  id: number;
  role: "user" | "orchestrator";
  text: string;
}

export interface OrchestratorChatProps {
  messages: ChatMessage[];
  running: boolean;
  installed: boolean;
  onSubmit: (text: string) => void;
}

export function OrchestratorChat({ messages, running, installed }: OrchestratorChatProps) {
  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="cyan">
          🧭 Global Orchestrator
        </Text>
        <Text dimColor> — your project-lifecycle "CEO" (no memory, no codebase)</Text>
      </Box>

      {!installed ? (
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text color="yellow">⚠ The global orchestrator is not installed.</Text>
          </Box>
          <Box marginBottom={1}>
            <Text dimColor>{"  Install it with:  sophron init --install-orchestrator"}</Text>
          </Box>
          <Box marginBottom={1}>
            <Text dimColor>{"  (also installs the global architect for roster drafting)"}</Text>
          </Box>
        </Box>
      ) : null}

      {/* ── Message thread ── */}
      <Box flexDirection="column" marginBottom={1}>
        {messages.length === 0 && installed ? (
          <Box marginBottom={1}>
            <Text dimColor>
              {"  No messages yet. Describe a project you want to build, or ask what exists."}
            </Text>
          </Box>
        ) : null}
        {messages.map((m) => (
          <MessageRow key={m.id} message={m} />
        ))}
      </Box>

      {/* ── Thinking indicator ── */}
      {running ? (
        <Box marginBottom={1}>
          <Text color="cyan" italic>
            {"  ⟳ orchestrator is thinking…"}
          </Text>
        </Box>
      ) : null}

      {/* ── Hint ── */}
      <Box>
        <Text dimColor>
          {"  "}
          {installed
            ? "Type below to chat · /projects to jump · /clear to reset"
            : "Install the orchestrator, then chat below"}
        </Text>
      </Box>
    </Box>
  );
}

function MessageRow({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  const prefix = isUser ? "  you › " : "  🧭 › ";
  const color: "green" | "cyan" = isUser ? "green" : "cyan";
  // Render multi-line text as separate lines, each prefixed.
  const lines = message.text.split("\n");
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <Text key={i} color={i === 0 ? color : undefined}>
          {i === 0 ? `${prefix}${line}` : `      ${line}`}
        </Text>
      ))}
    </Box>
  );
}
