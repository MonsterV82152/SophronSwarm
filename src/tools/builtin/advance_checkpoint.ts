/**
 * advance_checkpoint tool — mark the current milestone complete and move to the
 * next one in shared memory.
 *
 * The orchestrator calls this when it judges the current checkpoint finished.
 * It reads CHECKPOINTS.md + CURRENT_CHECKPOINT.md, marks the current done, and
 * writes the next milestone as the new current. This keeps the project's
 * progress durable and human-readable across sessions.
 *
 * See docs/PROJECT_OVERVIEW.md §5.3.
 */
import { CheckpointManager } from "../../memory/checkpoints.js";
import type { ToolSpec } from "../schema.js";

export const advance_checkpoint: ToolSpec = {
  name: "advance_checkpoint",
  description:
    "Mark the current project milestone complete and advance to the next one. " +
    "Reads CHECKPOINTS.md and CURRENT_CHECKPOINT.md from shared memory, marks the " +
    "current checkpoint done, and updates CURRENT_CHECKPOINT.md to the next milestone. " +
    "Use only when the current checkpoint is genuinely finished.",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
  handler: ({ services }) => {
    const mgr = new CheckpointManager(services.sharedMemoryStore);
    const result = mgr.advance();
    if (!result.advanced) {
      return `Checkpoint not advanced: ${result.reason ?? "unknown reason"}`;
    }
    const cur = result.current!;
    const lines = [
      `Checkpoint advanced.`,
      `Completed: ${result.completed?.title ?? "(none — was starting)"}`,
      `Now current: ${cur.title}`,
    ];
    const remaining = result.milestones.filter((m) => !m.done && m.index !== cur.index).length;
    lines.push(`Remaining milestones: ${remaining}`);
    return lines.join("\n");
  },
};
