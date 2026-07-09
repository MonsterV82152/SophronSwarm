/**
 * AgentChat — a reusable streaming chat pane for any agent.
 *
 * Originally built for the global orchestrator (M8 + M19), now generalized so
 * the same chat UI can be used for the per-project orchestrator and any other
 * agent conversation. A thin `OrchestratorChat` wrapper at the bottom keeps the
 * global-orchestrator defaults and preserves existing callers/tests.
 *
 * Supports:
 *   - Thread list mode ("list") and chat mode ("chat").
 *   - Bottom-anchored, wrapping-aware message viewport.
 *   - "thinking…" indicator while `running` is true.
 *   - Install / empty / hint states.
 */
import React, { useMemo } from "react";
import { Box, Text } from "ink";
import wrapAnsi from "wrap-ansi";
import { type ChatMessage, type ChatThread } from "../chat.js";
import { SelectList } from "./SelectList.js";

export type { ChatMessage } from "../chat.js";

export interface AgentChatProps {
  /** "list" shows saved threads; "chat" shows the active conversation. */
  mode?: "list" | "chat";
  /** Human-readable agent name shown in the header. */
  title: string;
  /** Optional icon shown before the title. */
  icon?: string;
  /** Default subtitle when no `currentTitle` is provided. */
  subtitle?: string;
  /** Prompt shown when the chat viewport is empty. */
  emptyPrompt?: string;
  /** Text shown while `running` is true. */
  thinkingText?: string;
  /** Footer hint text. */
  hint?: string;
  /** Hint shown when installed is false. */
  notInstalledHint?: string;
  /** Subtitle/body shown when installed is false. */
  notInstalledSubtitle?: string;
  /** Title for the SelectList in list mode. */
  listTitle?: string;
  /** Active conversation messages (chat mode). */
  messages?: ChatMessage[];
  running?: boolean;
  installed?: boolean;
  /** Maximum number of text lines to render in the message thread viewport. */
  maxLines?: number;
  /** Available terminal width so wrapping can be counted accurately. */
  width?: number;
  /** Saved threads for list mode. */
  threads?: ChatThread[];
  /** Selected index in the thread list. */
  selectedThreadIndex?: number;
  /** Title of the active thread (chat mode header). */
  currentTitle?: string;
  /** Called when the user selects a thread from the list. */
  onSelectThread?: (id: string) => void;
  /** Called to create a new thread. */
  onNewThread?: () => void;
  /** @deprecated Kept for backward compatibility; the TUI now owns submission. */
  onSubmit?: (text: string) => void;
}

/** Width reserved for the message prefix + root padding. */
const WIDTH_RESERVE = 12;

export function AgentChat({
  mode = "chat",
  title,
  icon,
  subtitle = "",
  emptyPrompt = "No messages yet. Type below to start.",
  thinkingText = `⟳ ${title} is thinking…`,
  hint = "Type below to chat · Esc back",
  notInstalledHint = "Install the agent, then chat below",
  notInstalledSubtitle = `Install the agent definition to chat with it.`,
  listTitle = "Saved threads",
  messages = [],
  running = false,
  installed = true,
  maxLines = 10,
  width = 80,
  threads = [],
  selectedThreadIndex = 0,
  currentTitle,
}: AgentChatProps) {
  const header = icon ? `${icon} ${title}` : title;

  if (mode === "list") {
    return (
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text bold color="cyan">
            {header}
          </Text>
          <Text dimColor> — select a chat thread</Text>
        </Box>
        <SelectList
          title={listTitle}
          items={threads.map((t) => ({
            id: t.id,
            label: t.title,
            hint: formatDate(t.updatedAt),
          }))}
          selectedIndex={selectedThreadIndex}
        />
        <Box marginTop={1}>
          <Text dimColor>{"  ↑/↓ select · Enter open · /new start fresh"}</Text>
        </Box>
      </Box>
    );
  }

  const contentWidth = Math.max(20, width - WIDTH_RESERVE);
  const { visible, visibleLines, hasOverflow } = useViewport(messages, Math.max(1, maxLines), contentWidth);

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          {header}
        </Text>
        {currentTitle ? <Text dimColor> — {currentTitle}</Text> : subtitle ? <Text dimColor> — {subtitle}</Text> : null}
      </Box>

      {!installed ? (
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text color="yellow">⚠ {title} is not installed.</Text>
          </Box>
          <Box marginBottom={1}>
            <Text dimColor>{`  ${notInstalledSubtitle}`}</Text>
          </Box>
        </Box>
      ) : null}

      {/* ── Message thread viewport ── */}
      {(() => {
        const indicatorLines = hasOverflow ? 1 : 0;
        const placeholderLines = visible.length === 0 && installed ? 1 : 0;
        const contentLines = visible.length === 0 && installed ? placeholderLines : visibleLines;
        const padLines = Math.max(0, maxLines - contentLines - indicatorLines);
        return (
          <Box flexDirection="column" height={Math.max(1, maxLines)} overflowY="hidden" marginBottom={1}>
            {padLines > 0 ? <Box height={padLines} /> : null}
            {hasOverflow ? <Text dimColor>{"  ↑ older messages above"}</Text> : null}
            {visible.length === 0 && installed ? <Text dimColor>{`  ${emptyPrompt}`}</Text> : null}
            {visible.map((m) => (
              <MessageRow key={m.id} message={m} width={contentWidth} />
            ))}
          </Box>
        );
      })()}

      {/* ── Thinking indicator ── */}
      {running ? (
        <Box marginBottom={1}>
          <Text color="cyan" italic>
            {"  "}
            {thinkingText}
          </Text>
        </Box>
      ) : null}

      {/* ── Hint ── */}
      <Box>
        <Text dimColor>{"  "}{installed ? hint : notInstalledHint}</Text>
      </Box>
    </Box>
  );
}

/** Global-orchestrator-specific wrapper (backward compatible). */
export function OrchestratorChat(props: Omit<AgentChatProps, "title">) {
  return (
    <AgentChat
      {...props}
      title="Global Orchestrator"
      icon="🧭"
      subtitle='your project-lifecycle "CEO" (no project memory, keeps chat history)'
      emptyPrompt="No messages yet. Describe a project you want to build, or ask what exists."
      thinkingText="orchestrator is thinking…"
      hint="Type below to chat · /chats to list · /new to start fresh · /clear to reset"
      notInstalledHint="Install the orchestrator, then chat below"
      notInstalledSubtitle="Install it with:  sophron init --install-orchestrator (also installs the global architect for roster drafting)"
      listTitle="Saved threads"
    />
  );
}

/** Count how many screen rows a message will occupy, accounting for wrapping. */
function wrappedLineCount(text: string, width: number): number {
  if (width <= 0) return text.split("\n").length || 1;
  return text
    .split("\n")
    .map((line) => {
      const wrapped = wrapAnsi(line, width, { hard: true, trim: false });
      return wrapped.length === 0 ? 1 : wrapped.split("\n").length;
    })
    .reduce((a, b) => a + b, 0);
}

/** Hard-wrap a block of text and keep only the last `maxLines` screen rows. */
function truncateToLastLines(text: string, width: number, maxLines: number): string {
  if (maxLines <= 0) return "";
  const allLines = text.split("\n").flatMap((line) => {
    const wrapped = wrapAnsi(line, Math.max(1, width), { hard: true, trim: false });
    return wrapped.length === 0 ? [""] : wrapped.split("\n");
  });
  return allLines.slice(-maxLines).join("\n");
}

function computeVisibleMessages(messages: ChatMessage[], maxLines: number, contentWidth: number): ChatMessage[] {
  const visible: ChatMessage[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    const lines = wrappedLineCount(m.text, contentWidth);
    if (used + lines <= maxLines) {
      visible.unshift(m);
      used += lines;
      continue;
    }
    // The newest messages still fit, but this older message is partially cut off.
    const remaining = maxLines - used;
    if (remaining > 0) {
      visible.unshift({ ...m, text: truncateToLastLines(m.text, contentWidth, remaining) });
    }
    break;
  }
  return visible;
}

function useViewport(
  messages: ChatMessage[],
  maxLines: number,
  contentWidth: number,
): { visible: ChatMessage[]; visibleLines: number; hasOverflow: boolean } {
  return useMemo(() => {
    const full = computeVisibleMessages(messages, maxLines, contentWidth);
    const fullLines = full.reduce((sum, m) => sum + wrappedLineCount(m.text, contentWidth), 0);
    const hasOverflow = full.length < messages.length;
    if (!hasOverflow || fullLines < maxLines) {
      return { visible: full, visibleLines: fullLines, hasOverflow };
    }
    // Make room for the "older messages above" indicator.
    const clipped = computeVisibleMessages(messages, Math.max(1, maxLines - 1), contentWidth);
    const clippedLines = clipped.reduce((sum, m) => sum + wrappedLineCount(m.text, contentWidth), 0);
    return { visible: clipped, visibleLines: clippedLines, hasOverflow };
  }, [messages, maxLines, contentWidth]);
}

function MessageRow({ message, width }: { message: ChatMessage; width: number }) {
  const isUser = message.role === "user";
  const isSystem = message.role === "system";
  const prefix = isUser ? "  you › " : isSystem ? "  › " : "  🧭 › ";
  const color: "green" | "cyan" | string | undefined = isUser ? "green" : isSystem ? (message.color ?? "gray") : "cyan";
  // Hard-wrap each logical line to the viewport so Ink never wraps unpredictably.
  const lines = message.text.split("\n").flatMap((line) => {
    const wrapped = wrapAnsi(line, Math.max(1, width), { hard: true, trim: false });
    return wrapped.length === 0 ? [""] : wrapped.split("\n");
  });
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

function formatDate(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
