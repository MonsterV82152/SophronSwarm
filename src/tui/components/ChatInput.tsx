/**
 * ChatInput — interactive input for orchestrator channels.
 *
 * Owns @file attachments, / command autocomplete, and keyboard handling.
 * Renders at the bottom of an interactive channel (bare chrome).
 */
import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { useInput } from "ink";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { safeResolve } from "../../tools/builtin/paths.js";
import type { FileAttachment } from "../../types.js";

export interface ChatSubmit {
  text: string;
  attachments: FileAttachment[];
}

export interface ChatInputProps {
  onSubmit: (submit: ChatSubmit) => void;
  onCancel: () => void;
  onStop?: () => void;
  workspaceDir: string;
}

const MAX_ATTACHMENT_LINES = 1000;

export function ChatInput({ onSubmit, onCancel, onStop, workspaceDir }: ChatInputProps) {
  const [text, setText] = useState("");
  const [cursor, setCursor] = useState(0);
  const [menu, setMenu] = useState<{ items: string[]; trigger: "@" | "/"; index: number } | null>(null);

  // Keep cursor within bounds whenever text changes.
  useEffect(() => {
    setCursor((c) => Math.min(c, text.length));
  }, [text]);

  useInput((inputChar, key) => {
    if (key.ctrl && inputChar === "c") {
      // Ctrl+C is handled by the parent App (stop active run or exit).
      return;
    }

    if (menu) {
      if (key.upArrow) {
        setMenu({ ...menu, index: Math.max(0, menu.index - 1) });
        return;
      }
      if (key.downArrow) {
        setMenu({ ...menu, index: Math.min(menu.items.length - 1, menu.index + 1) });
        return;
      }
      if (key.return || key.tab) {
        confirmMenu();
        return;
      }
      if (key.escape) {
        setMenu(null);
        return;
      }
    }

    if (key.escape) {
      onCancel();
      return;
    }

    if (key.return) {
      submit();
      return;
    }

    if (key.backspace || key.delete) {
      if (cursor > 0) {
        setText((t) => t.slice(0, cursor - 1) + t.slice(cursor));
        setCursor((c) => c - 1);
      }
      return;
    }

    if (key.leftArrow) {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }

    if (key.rightArrow) {
      setCursor((c) => Math.min(text.length, c + 1));
      return;
    }

    if (inputChar && !key.ctrl && !key.meta && !key.escape) {
      const next = text.slice(0, cursor) + inputChar + text.slice(cursor);
      setText(next);
      const nextCursor = cursor + inputChar.length;
      setCursor(nextCursor);
      refreshMenu(next, nextCursor, workspaceDir);
    }
  });

  function confirmMenu() {
    if (!menu) return;
    const selected = menu.items[menu.index];
    if (selected === undefined) {
      setMenu(null);
      return;
    }
    const { start } = wordAt(text, cursor);
    const replacement = menu.trigger === "/" ? selected : `${menu.trigger}${selected}`;
    const next = text.slice(0, start) + replacement + " " + text.slice(cursor);
    setText(next);
    setCursor(start + replacement.length + 1);
    setMenu(null);
  }

  function submit() {
    const trimmed = text.trim();
    if (!trimmed) return;
    const attachments = resolveAttachments(trimmed, workspaceDir);
    onSubmit({ text: trimmed, attachments });
    setText("");
    setCursor(0);
    setMenu(null);
  }

  const prompt = "> ";

  return (
    <Box flexDirection="column">
      {menu ? (
        <Box flexDirection="column" marginBottom={1}>
          {menu.items.length === 0 ? (
            <Text dimColor>{`  ${menu.trigger}(no matches)`}</Text>
          ) : (
            menu.items.slice(0, 6).map((item, i) => (
              <Text key={item} color={i === menu.index ? "cyan" : "gray"}>
                {`  ${i === menu.index ? "› " : "  "}${menu.trigger}${item}`}
              </Text>
            ))
          )}
        </Box>
      ) : null}
      <Box>
        <Text bold color="cyan">{prompt}</Text>
        <Text>{text.slice(0, cursor)}</Text>
        <Text color="cyan">{cursor < text.length ? text[cursor] : "▏"}</Text>
        <Text>{text.slice(cursor + 1)}</Text>
      </Box>
    </Box>
  );
}

/** Find the word at the cursor and whether it triggers a menu. */
export function wordAt(
  text: string,
  cursor: number,
): { word: string; start: number; end: number; trigger: "@" | "/" | null } {
  const pos = Math.min(cursor, text.length);
  let start = pos;
  while (start > 0 && !/\s/.test(text[start - 1]!)) start--;
  let end = pos;
  while (end < text.length && !/\s/.test(text[end]!)) end++;
  const word = text.slice(start, end);
  const trigger = word.startsWith("@") ? "@" : word.startsWith("/") ? "/" : null;
  return { word, start, end, trigger };
}

/** Refresh the autocomplete menu based on the word at the cursor. */
export function refreshMenu(text: string, cursor: number, workspaceDir: string): { items: string[]; trigger: "@" | "/" | null } {
  const { word, trigger } = wordAt(text, cursor);
  if (!trigger) return { items: [], trigger: null };
  const prefix = word.slice(1);
  const items = trigger === "@" ? listFiles(workspaceDir, prefix) : listSlashCommands(prefix);
  return { items, trigger };
}

function listSlashCommands(prefix: string): string[] {
  const commands = ["stop", "model", "clear", "help", "quit"];
  return commands.filter((c) => c.startsWith(prefix));
}

function listFiles(root: string, prefix: string): string[] {
  const files: string[] = [];
  function walk(dir: string) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const full = join(dir, entry);
      let rel: string;
      try {
        rel = relative(root, full);
      } catch {
        continue;
      }
      if (rel.startsWith("..")) continue;
      try {
        const st = statSync(full);
        if (st.isDirectory()) {
          walk(full);
        } else {
          files.push(rel);
        }
      } catch {
        /* ignore */
      }
    }
  }
  walk(root);
  const normalized = prefix.replace(/^\/+/, "");
  return files.filter((f) => f.startsWith(normalized)).slice(0, 20);
}

/** Extract @file mentions and read their contents (capped at 1000 lines). */
export function resolveAttachments(text: string, workspaceDir: string): FileAttachment[] {
  const seen = new Set<string>();
  const attachments: FileAttachment[] = [];
  const mentionRe = /@(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = mentionRe.exec(text)) !== null) {
    const raw = match[1]!;
    if (!raw) continue;
    try {
      const absPath = safeResolve(workspaceDir, raw);
      if (seen.has(absPath)) continue;
      seen.add(absPath);
      const content = readFileSync(absPath, "utf8");
      const lines = content.split("\n");
      const truncated = lines.length > MAX_ATTACHMENT_LINES
        ? lines.slice(0, MAX_ATTACHMENT_LINES).join("\n") + "\n[…file truncated at 1000 lines…]"
        : content;
      attachments.push({ path: raw, content: truncated });
    } catch {
      // Skip unresolvable or unreadable attachments.
    }
  }
  return attachments;
}

export const MAX_ATTACHMENT_LINES_EXPORT = MAX_ATTACHMENT_LINES;
