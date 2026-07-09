/**
 * OrchestratorChat — the Home surface's global-orchestrator chat (M8).
 *
 * Replaces the M3 stub. This is where the operator talks to the **global
 * orchestrator** — the operator's "CEO" that manages the project lifecycle
 * (propose / create / list projects). The orchestrator runs via `runAgent`
 * (M7 global-orchestrator.md, `noMemory: true`, scoped tools).
 *
 * Layout:
 *   - Message thread (user + orchestrator + inline system feedback), newest at
 *     the bottom.
 *   - "thinking…" indicator while the orchestrator is running.
 *   - Install hint if the global orchestrator isn't installed yet.
 *
 * The message thread is capped to `maxLines` so it never overflows the
 * terminal; older messages scroll off the top as the conversation grows.
 *
 * Input: the bottom input bar (shared across tabs). When the operator is on
 * this tab and submits non-slash-command text, app.tsx routes it to
 * `onSubmit` which runs the orchestrator's agent loop.
 *
 * Nav model: the Orchestrator tab supports drill-in (Enter → content focus),
 * but content is non-navigable (no ↑/↓ list) — it's a chat, not a list.
 */
import React, { useMemo } from "react";
import { Box, Text } from "ink";

export interface ChatMessage {
  id: number;
  role: "user" | "orchestrator" | "system";
  text: string;
  /** Optional Ink color for system-feedback messages. */
  color?: string;
}

export interface OrchestratorChatProps {
  messages: ChatMessage[];
  running: boolean;
  installed: boolean;
  onSubmit: (text: string) => void;
  /** Maximum number of text lines to render in the message thread. */
  maxLines?: number;
}

export function OrchestratorChat({ messages, running, installed, maxLines = 10 }: OrchestratorChatProps) {
  const visible = useVisibleMessages(messages, Math.max(1, maxLines));

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="cyan">
          🧭 Global Orchestrator
        </Text>
        <Text dimColor> — your project-lifecycle "CEO" (no project memory, keeps chat history)</Text>
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
        {visible.length === 0 && installed ? (
          <Box marginBottom={1}>
            <Text dimColor>
              {"  No messages yet. Describe a project you want to build, or ask what exists."}
            </Text>
          </Box>
        ) : null}
        {visible.map((m) => (
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

function useVisibleMessages(messages: ChatMessage[], maxLines: number): ChatMessage[] {
  return useMemo(() => {
    const visible: ChatMessage[] = [];
    let used = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      const lines = m.text.split("\n").length;
      if (used + lines > maxLines && visible.length > 0) break;
      if (visible.length === 0 && lines > maxLines) {
        const truncated = m.text.split("\n").slice(-maxLines).join("\n");
        visible.unshift({ ...m, text: truncated });
        break;
      }
      visible.unshift(m);
      used += lines;
    }
    return visible;
  }, [messages, maxLines]);
}

function MessageRow({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  const isSystem = message.role === "system";
  const prefix = isUser ? "  you › " : isSystem ? "  › " : "  🧭 › ";
  const color: "green" | "cyan" | string | undefined = isUser ? "green" : isSystem ? (message.color ?? "gray") : "cyan";
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
