/**
 * TabBar — a horizontal, navigable tab bar.
 *
 * Renders the tab labels in a single row with the selected tab highlighted.
 * The parent owns the `selectedIndex` + keyboard handling; this is presentational.
 *
 * Navigation model (see nav.ts): ←/→ moves across tabs; Enter/↓ drills into
 * the selected tab's content; Esc/↑ exits back to the tab bar.
 */
import React from "react";
import { Box, Text } from "ink";

export interface TabBarProps {
  /** Tab labels, left-to-right. */
  labels: string[];
  /** Currently-selected tab index (0-based). */
  selectedIndex: number;
  /** Whether the tab bar is currently focused (controls the highlight style). */
  focused: boolean;
}

export function TabBar({ labels, selectedIndex, focused }: TabBarProps) {
  return (
    <Box>
      {labels.map((label, i) => {
        const selected = i === selectedIndex;
        const active = selected && focused;
        const color = active ? "black" : selected ? "cyan" : undefined;
        const bg = active ? "cyan" : undefined;
        return (
          <Box key={label}>
            <Text backgroundColor={bg} color={color} bold={selected}>
              {selected ? " " : " "}
              {label}
              {selected ? " " : "  "}
            </Text>
            {i < labels.length - 1 ? <Text> </Text> : null}
          </Box>
        );
      })}
    </Box>
  );
}
