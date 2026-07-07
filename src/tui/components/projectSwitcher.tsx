/**
 * Project switcher — transient overlay for switching the active project.
 *
 * Triggered by Ctrl+P or /projects. Renders a list of known projects (from the
 * registry) with the active one highlighted. Enter switches; Esc cancels.
 *
 * The App owns the keyboard handling + selectedIndex; this is a pure
 * presentational component.
 *
 * See docs/IDEAS.md (#2) + docs/ROADMAP.md (M3).
 */
import React from "react";
import { Box, Text } from "ink";
import type { ProjectEntry } from "../../project/registry.js";

export interface ProjectSwitcherProps {
  projects: ProjectEntry[];
  activePath: string;
  selectedIndex: number;
}

export function ProjectSwitcher({ projects, activePath, selectedIndex }: ProjectSwitcherProps) {
  return (
    <Box
      flexDirection="column"
      marginTop={1}
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
    >
      <Box marginBottom={1}>
        <Text bold color="cyan">
          🔄 Switch Project
        </Text>
      </Box>
      {projects.length === 0 ? (
        <Text dimColor>  (no projects registered yet — run `sophron` in a directory to add one)</Text>
      ) : (
        projects.map((p, i) => {
          const isActive = p.path === activePath;
          const isSelected = i === selectedIndex;
          const pin = p.pinned ? "📌 " : "   ";
          const marker = isSelected ? "▸ " : "  ";
          return (
            <Box key={p.path}>
              <Text>
                {marker}
                {pin}
                <Text bold={isSelected} color={isActive ? "green" : isSelected ? "cyan" : undefined}>
                  {p.name}
                </Text>
                {isActive ? <Text dimColor> (active)</Text> : <Text></Text>}
                <Text dimColor> — {p.path}</Text>
              </Text>
            </Box>
          );
        })
      )}
      <Box marginTop={1}>
        <Text dimColor>  ↑↓ select · Enter switch · Esc cancel</Text>
      </Box>
    </Box>
  );
}
