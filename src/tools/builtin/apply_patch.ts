/**
 * apply_patch tool — apply a unified diff to the workspace.
 *
 * Delegates to the patch-applier chain (TS applier → patch -p1 → patch -p0).
 * See docs/PHASE_1_DESIGN.md §3.2.
 */
import { applyPatchChain } from "../../sandbox/patchApplier.js";
import type { ToolSpec } from "../schema.js";

function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string") throw new Error(`Missing or non-string argument '${key}'`);
  return v;
}

export const apply_patch: ToolSpec = {
  name: "apply_patch",
  description:
    "Apply a unified diff to the workspace. Use to modify existing files or create new ones. " +
    "The `diff` argument must be a valid unified diff with '--- ' / '+++ ' / '@@ ' headers.",
  parameters: {
    type: "object",
    properties: {
      diff: { type: "string", description: "The full unified diff to apply." },
    },
    required: ["diff"],
  },
  handler: async ({ args, agent, state }) => {
    // plan mode: read-only, deny mutations
    if (agent.permissionMode === "plan") {
      return `Blocked: apply_patch is not allowed in plan mode (read-only).`;
    }

    const diff = requireString(args, "diff");
    const result = await applyPatchChain(diff, state.workingDir);
    if (result.ok) {
      return `Patch applied via ${result.method}: ${result.filesChanged} file(s) changed. ${result.output}`.trim();
    }
    return `Patch failed (${result.method}): ${result.error ?? result.output}`;
  },
};
