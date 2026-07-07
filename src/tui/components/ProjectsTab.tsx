/**
 * ProjectsTab — the Home surface's project list.
 *
 * Lists all registered projects (from the registry). ↑/↓ navigates; Enter
 * enters the selected project's Project View (the App tears down + rebuilds
 * services for it). This replaces the old overlay project switcher.
 *
 * Pure presentational component — the App owns the selection index + the
 * keyboard handling + the actual services switch.
 */
import React from "react";
import { Box, Text } from "ink";
import { SelectList } from "./SelectList.js";
import type { ProjectEntry } from "../../project/registry.js";

export interface ProjectsTabProps {
  projects: ProjectEntry[];
  selectedIndex: number;
  /** Path of the currently active project (highlighted). */
  activePath: string;
}

export function ProjectsTab({ projects, selectedIndex, activePath }: ProjectsTabProps) {
  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="cyan">
          📁 Projects ({projects.length})
        </Text>
      </Box>
      {projects.length === 0 ? (
        <Text dimColor>{"  (no projects registered — use the Orchestrator tab to propose one)"}</Text>
      ) : (
        <SelectList
          items={projects.map((p) => ({
            id: p.path,
            label: `${p.pinned ? "📌 " : ""}${p.name}${p.path === activePath ? " (active)" : ""}`,
            hint: p.path,
            icon: "📁",
          }))}
          selectedIndex={selectedIndex}
        />
      )}
      <Box marginTop={1}>
        <Text dimColor>{"  (↑↓ select · Enter to open · Esc back)"}</Text>
      </Box>
    </Box>
  );
}
