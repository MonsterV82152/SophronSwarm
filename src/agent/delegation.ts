/**
 * Delegation policy — guards `delegate` tool calls with depth limit, cycle
 * detection, and per-agent allowlist enforcement.
 *
 * Also provides `buildHandoffPacket()` which distills a sub-agent's run into
 * the concise packet returned to the parent's context.
 *
 * See docs/PROJECT_OVERVIEW.md §4.3 and PHASE_1_DESIGN.md for delegation design.
 */
import type {
  AgentDefinition,
  AgentRunState,
  DelegationContext,
  HandoffPacket,
} from "../types.js";

// ── Limits ────────────────────────────────────────────────────────────────────

/** Hard maximum delegation depth (Claude Code uses 5). */
export const MAX_DEPTH = 5;

export interface PolicyResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Check whether `callerAgent` is permitted to delegate to `targetAgentName`
 * from the given delegation context.
 *
 * Three guards in priority order:
 *   1. Depth limit (MAX_DEPTH) — prevents runaway nesting.
 *   2. Cycle detection (ancestry list) — prevents A→B→A loops.
 *   3. Allowlist (agent.delegateAllowlist) — only relevant when configured.
 */
export function checkPolicy(
  targetAgentName: string,
  callerAgent: AgentDefinition,
  ctx: DelegationContext | undefined,
): PolicyResult {
  const depth = ctx?.depth ?? 0;

  // Guard 1: depth
  if (depth >= MAX_DEPTH) {
    return {
      allowed: false,
      reason: `Max delegation depth (${MAX_DEPTH}) reached. Cannot delegate further.`,
    };
  }

  // Guard 2: cycle detection
  const ancestry = ctx?.ancestry ?? [];
  if (ancestry.includes(targetAgentName)) {
    return {
      allowed: false,
      reason: `Delegation cycle detected: '${targetAgentName}' is already in the call chain [${ancestry.join(" → ")} → ${targetAgentName}].`,
    };
  }

  // Guard 3: allowlist (only enforced when the caller declares one)
  if (callerAgent.delegateAllowlist && callerAgent.delegateAllowlist.length > 0) {
    if (!callerAgent.delegateAllowlist.includes(targetAgentName)) {
      return {
        allowed: false,
        reason: `Agent '${targetAgentName}' is not in ${callerAgent.name}'s delegate allowlist. Allowed: [${callerAgent.delegateAllowlist.join(", ")}].`,
      };
    }
  }

  return { allowed: true };
}

/**
 * Build the child delegation context for a sub-agent about to be spawned.
 * Appends the caller to the ancestry chain and increments depth.
 */
export function buildChildCtx(
  callerAgent: AgentDefinition,
  parentState: AgentRunState,
): DelegationContext {
  const parentCtx = parentState.delegationCtx;
  return {
    parentRunId: parentState.runId,
    parentThreadId: parentState.threadId,
    depth: (parentCtx?.depth ?? 0) + 1,
    ancestry: [...(parentCtx?.ancestry ?? []), callerAgent.name],
  };
}

// ── Handoff packet ────────────────────────────────────────────────────────────

/**
 * Distill a completed sub-agent run into the concise HandoffPacket that is
 * returned to the parent agent's context.
 *
 * The parent receives ONLY this packet — the sub-agent's full tool output
 * (file reads, build logs, search results) stays isolated in its own context.
 */
export function buildHandoffPacket(state: AgentRunState, task: string): HandoffPacket {
  // Last non-empty assistant text message (the summary)
  const lastAssistant = [...state.messages]
    .reverse()
    .find((m) => m.role === "assistant" && typeof m.content === "string" && !m.tool_calls);
  const summary = (lastAssistant?.content as string | null | undefined)?.trim() || "(no final response)";

  // Files written: scan tool calls for successful write_file / apply_patch
  const filesChanged = new Set<string>();
  for (let i = 0; i < state.messages.length; i++) {
    const msg = state.messages[i]!;
    if (msg.role !== "assistant" || !msg.tool_calls) continue;
    for (const call of msg.tool_calls) {
      const toolName = call.function.name;
      if (toolName !== "write_file" && toolName !== "apply_patch") continue;
      // Find the corresponding tool result in the subsequent messages
      const toolResult = state.messages
        .slice(i + 1)
        .find((m) => m.role === "tool" && m.tool_call_id === call.id);
      if (!toolResult || toolResult.content?.startsWith("Blocked")) continue;
      if (toolName === "write_file") {
        try {
          const args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
          if (typeof args["path"] === "string") filesChanged.add(args["path"]);
        } catch {
          /* ignore unparseable args */
        }
      } else {
        // apply_patch: extract paths from the result message (format: "Patch applied: X file(s)")
        const pathMatch = toolResult.content?.match(/Created \d+: ([^\n;]+)/g);
        if (pathMatch) {
          for (const m of pathMatch) {
            const paths = m.replace(/Created \d+: /, "").split(", ");
            for (const p of paths) filesChanged.add(p.trim());
          }
        }
      }
    }
  }

  const outcome: HandoffPacket["outcome"] =
    state.status === "complete" ? "success"
    : state.status === "error" ? "failure"
    : "halted";

  return {
    agentName: state.agentName,
    task,
    status: state.status,
    outcome,
    summary,
    filesChanged: [...filesChanged],
    turns: state.turn + 1,
    tokenUsage: state.tokenUsage,
    error: state.error,
  };
}

/** Format a HandoffPacket as the concise string returned into the parent's context. */
export function formatHandoffPacket(packet: HandoffPacket): string {
  const lines: string[] = [
    `[delegated: ${packet.agentName} | ${packet.outcome} | ${packet.turns} turn(s) | ${packet.tokenUsage.totalTokens} tokens]`,
    ``,
    `Summary:`,
    packet.summary,
  ];
  if (packet.filesChanged.length > 0) {
    lines.push(``, `Files changed: ${packet.filesChanged.join(", ")}`);
  }
  if (packet.error) {
    lines.push(``, `Error: ${packet.error}`);
  }
  return lines.join("\n");
}
