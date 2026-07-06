/**
 * SelectList — a reusable navigable menu list for the TUI.
 *
 * Renders a vertical list of items with a highlight on the selected one. The
 * parent owns the `selectedIndex` state and the keyboard handling (so this is a
 * pure presentational component — easy to test with ink-testing-library).
 *
 * Ollama/claude-code-style: the selected row is prefixed with a `❯` marker and
 * colored; unselected rows are indented with spaces.
 */
import React from "react";
import { Box, Text } from "ink";

export interface SelectListItem {
  /** Stable key for React. */
  id: string;
  /** Label shown to the user. */
  label: string;
  /** Optional secondary line (description / detail). */
  hint?: string;
  /** Optional icon/emoji prefix. */
  icon?: string;
}

export interface SelectListProps {
  items: SelectListItem[];
  /** Currently-highlighted index (0-based). */
  selectedIndex: number;
  /** Optional title rendered above the list. */
  title?: string;
  /** Vertical padding between rows. Default 1 (one blank line between items). */
  rowGap?: number;
}

export function SelectList({ items, selectedIndex, title, rowGap = 1 }: SelectListProps) {
  return (
    <Box flexDirection="column">
      {title ? (
        <Box marginBottom={1}>
          <Text bold color="cyan">
            {title}
          </Text>
        </Box>
      ) : null}
      {items.length === 0 ? (
        <Text dimColor>(empty)</Text>
      ) : (
        items.map((item, i) => {
          const selected = i === selectedIndex;
          const icon = item.icon ? `${item.icon} ` : "";
          return (
            <Box key={item.id} flexDirection="column" marginBottom={i < items.length - 1 ? rowGap : 0}>
              <Text color={selected ? "cyan" : undefined} bold={selected}>
                {selected ? "❯ " : "  "}
                {icon}
                {item.label}
              </Text>
              {item.hint ? (
                <Text dimColor color={selected ? "cyan" : undefined}>
                  {"  "}
                  {item.hint}
                </Text>
              ) : null}
            </Box>
          );
        })
      )}
    </Box>
  );
}

/**
 * Clamp a list index into the valid range [0, len-1]. Returns 0 for empty.
 */
export function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  if (index < 0) return 0;
  if (index >= length) return length - 1;
  return index;
}
