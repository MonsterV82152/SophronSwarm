/**
 * delegate tool — spawn a specialized sub-agent for a task.
 *
 * The sub-agent runs in its own isolated context window. Its full tool output
 * (file reads, build logs, search results) never pollutes the parent's context.
 * Only a concise HandoffPacket summary is returned here.
 *
 * See docs/PROJECT_OVERVIEW.md §4.3 (delegation).
 */
import { log } from "../../util/log.js";
import { runAgent } from "../../agent/loop.js";
import {
  buildChildCtx,
  buildHandoffPacket,
  checkPolicy,
  formatHandoffPacket,
} from "../../agent/delegation.js";
import type { ToolSpec } from "../schema.js";

function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || !v.trim())
    throw new Error(`Missing or empty argument '${key}'`);
  return v.trim();
}

export const delegate: ToolSpec = {
  name: "delegate",
  description:
    "Delegate a self-contained task to a specialized sub-agent. " +
    "The sub-agent runs in its own isolated context — its verbose tool output " +
    "(file reads, build logs) never appears here. Only a concise summary returns. " +
    "Use when a task is better handled by a specialist (security review, UI design, " +
    "test writing, dependency management, etc.). " +
    "The sub-agent inherits the current workspace.",
  parameters: {
    type: "object",
    properties: {
      agent: {
        type: "string",
        description: "Name of the agent to delegate to (must be loaded in the registry).",
      },
      task: {
        type: "string",
        description:
          "Specific, self-contained task description for the sub-agent. " +
          "Be explicit — the sub-agent starts with a fresh context and has no " +
          "memory of this conversation.",
      },
    },
    required: ["agent", "task"],
  },
  handler: async ({ args, agent: callerAgent, state, services }) => {
    const targetName = requireString(args, "agent");
    const task = requireString(args, "task");

    // ── 1. Policy check (depth, cycle, allowlist) ─────────────────────────
    const policy = checkPolicy(targetName, callerAgent, state.delegationCtx);
    if (!policy.allowed) {
      return `Delegation denied: ${policy.reason}`;
    }

    // ── 2. Find target agent in the registry ──────────────────────────────
    const targetDef = services.agentRegistry.get(targetName);
    if (!targetDef) {
      const available = services.agentRegistry.list().map((a) => a.name).join(", ");
      return `Delegation failed: agent '${targetName}' not found. Available: ${available || "(none)"}`;
    }

    // ── 3. Build child delegation context ─────────────────────────────────
    const childCtx = buildChildCtx(callerAgent, state);
    log.info(
      {
        target: targetName,
        depth: childCtx.depth,
        ancestry: childCtx.ancestry,
        task: task.slice(0, 100),
      },
      "delegating",
    );

    // ── 4. Run sub-agent in isolation ─────────────────────────────────────
    // Fresh AgentRunState (empty messages = full context isolation).
    // Shares workspace, LLM, tools, and checkpointer (SQLite WAL handles
    // concurrent writes safely).
    const { state: subState } = await runAgent({
      agent: targetDef,
      task,
      workingDir: state.workingDir,
      llm: services.llm,
      dispatcher: services.dispatcher,
      checkpointer: services.checkpointer,
      services,
      delegationCtx: childCtx,
    });

    // ── 5. Build handoff packet — the ONLY thing entering parent context ──
    const packet = buildHandoffPacket(subState, task);
    log.info(
      {
        target: targetName,
        outcome: packet.outcome,
        turns: packet.turns,
        tokens: packet.tokenUsage.totalTokens,
        filesChanged: packet.filesChanged.length,
      },
      "delegation complete",
    );
    return formatHandoffPacket(packet);
  },
};
