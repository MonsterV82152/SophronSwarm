/**
 * InputBar — the persistent text-input bar at the bottom of the shell.
 *
 * Any printable char focuses it (the App seeds the first char); Enter submits;
 * Esc cancels. When not focused, it renders as a dimmed prompt so the operator
 * knows it's available. When focused, it shows the composed text + a cursor.
 *
 * Context sensitivity is the App's job: on the Agent-detail view, free text is
 * a task for that agent; elsewhere it's a slash command or free-text task.
 */
import React from "react";
import { Box, Text } from "ink";

export interface InputBarProps {
  /** Current composed text. */
  value: string;
  /** Whether the input bar is currently focused. */
  focused: boolean;
  /** Prompt prefix shown before the text (e.g. ">" or "orchestrator>"). */
  prompt?: string;
  /** Whether the input is disabled (e.g. during a project switch). */
  disabled?: boolean;
}

export function InputBar({ value, focused, prompt = ">", disabled }: InputBarProps) {
  if (disabled) {
    return (
      <Box>
        <Text dimColor>{"  (input disabled — switching project…)"}</Text>
      </Box>
    );
  }
  return (
    <Box>
      <Text bold color={focused ? "cyan" : "gray"}>
        {prompt}{" "}
      </Text>
      <Text color={focused ? undefined : "gray"}>{value}</Text>
      {focused ? <Text color="cyan">{"▏"}</Text> : null}
      {!focused ? <Text dimColor>{"  (type to enter a command or task · Enter submit · Esc back)"}</Text> : null}
    </Box>
  );
}
