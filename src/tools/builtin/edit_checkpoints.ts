/**
 * edit_checkpoints — replace the project's milestone list.
 *
 * Unlike `advance_checkpoint` (which only marks the current milestone done and
 * moves forward), this tool lets the orchestrator rewrite CHECKPOINTS.md to
 * match a freshly compiled plan. It is the fix for templates that ship with
 * hard-coded milestones that would otherwise be unremovable.
 */
import { CheckpointManager } from "../../memory/checkpoints.js";
import { SHARED_FILES } from "../../memory/sharedStore.js";
import type { ToolSpec } from "../schema.js";

export const edit_checkpoints: ToolSpec = {
  name: "edit_checkpoints",
  description:
    "Replace the project's milestone list in CHECKPOINTS.md. Pass an ordered list of " +
    "milestone titles; all new milestones start unchecked and the first one becomes the " +
    "current checkpoint. Use this to align checkpoints with a new plan. " +
    "Pass an empty list to clear all milestones.",
  parameters: {
    type: "object",
    properties: {
      milestones: {
        type: "array",
        items: { type: "string" },
        description: "Ordered list of milestone titles. Empty list clears all checkpoints.",
      },
    },
    required: ["milestones"],
  },
  handler: ({ args, services }) => {
    const raw = args["milestones"];
    if (!Array.isArray(raw)) {
      return "Refused: 'milestones' must be an array of strings.";
    }
    const titles = raw.filter((t): t is string => typeof t === "string");
    const mgr = new CheckpointManager(services.sharedMemoryStore);
    const result = mgr.replaceCheckpoints(titles);
    if (titles.length === 0) {
      return "Cleared all checkpoints. Use edit_checkpoints again to add milestones.";
    }
    const lines = [
      `Replaced checkpoints. Current: ${result.current?.title ?? "(none)"}`,
      "",
      "Milestones:",
      ...result.milestones.map((m) => `${m.index}. ${m.title}`),
    ];
    return lines.join("\n");
  },
};
