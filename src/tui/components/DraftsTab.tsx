/**
 * DraftsTab — the Home surface's pending agent-draft queue.
 *
 * Lists every agent draft awaiting approval across all registered projects.
 * ↑/↓ navigates; Enter approves the selected draft; R rejects it. This is the
 * dedicated, keyboard-driven UI for the draft approval flow that used to be
 * reachable only via slash commands.
 */
import React from "react";
import { Box, Text } from "ink";
import { SelectList } from "./SelectList.js";
import type { PendingDraftRef } from "../draftApprovals.js";

export interface DraftsTabProps {
  drafts: PendingDraftRef[];
  selectedIndex: number;
}

export function DraftsTab({ drafts, selectedIndex }: DraftsTabProps) {
  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="yellow">
          📝 Pending Agent Drafts ({drafts.length})
        </Text>
      </Box>
      {drafts.length === 0 ? (
        <Text dimColor>{"  (no pending agent drafts — new proposals will appear here)"}</Text>
      ) : (
        <SelectList
          items={drafts.map((d) => ({
            id: `${d.projectPath}:${d.name}`,
            label: `${d.projectName}/${d.name}`,
            hint: `created ${d.createdAt}`,
            icon: "📝",
          }))}
          selectedIndex={selectedIndex}
        />
      )}
      <Box marginTop={1}>
        <Text dimColor>
          {"  (↑↓ select · Enter approve · R reject · Esc back · /approve-all-drafts <project> to bulk approve)"}
        </Text>
      </Box>
    </Box>
  );
}
