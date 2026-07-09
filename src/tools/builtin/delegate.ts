/**
 * delegate tool — spawn a specialized sub-agent for a task.
 *
 * The sub-agent runs in its own isolated context window. Its full tool output
 * (file reads, build logs, search results) never pollutes the parent's context.
 * Only a concise HandoffPacket summary is returned here.
 *
 * See docs/PROJECT_OVERVIEW.md §4.3 (delegation).
 */
import { resolve, isAbsolute } from "node:path";
import { log } from "../../util/log.js";
import { runAgent } from "../../agent/loop.js";
import { workspaceRoot, sophronRoot } from "./global.js";
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

function safeResolveWorkspace(path: string, allowedRoots: string[]): string {
  const candidate = isAbsolute(path) ? resolve(path) : resolve(allowedRoots[0]!, path);
  const roots = allowedRoots.map((r) => resolve(r));
  for (const root of roots) {
    if (candidate === root || candidate.startsWith(root + "/")) return candidate;
  }
  throw new Error(`Path '${path}' is outside allowed workspaces`);
}

export const delegate: ToolSpec = {
  name: "delegate",
  description:
    "Delegate a self-contained task to a specialized sub-agent. " +
    "The sub-agent runs in its own isolated context — its verbose tool output " +
    "(file reads, build logs) never appears here. Only a concise summary returns. " +
    "Use when a task is better handled by a specialist (security review, UI design, " +
    "test writing, dependency management, etc.). " +
    "The sub-agent inherits the current workspace unless you pass an explicit 'dir'.",
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
      dir: {
        type: "string",
        description:
          "Optional absolute working directory for the sub-agent. Use when the " +
          "sub-agent needs to read/write files in a specific project (e.g. the " +
          "architect drafting a project's roster). Must be under ~/sophron_workspace " +
          "or ~/.sophron.",
      },
    },
    required: ["agent", "task"],
  },
  handler: async ({ args, agent: callerAgent, state, services }) => {
    const targetName = requireString(args, "agent");
    const task = requireString(args, "task");
    const dirArg = typeof args["dir"] === "string" ? (args["dir"] as string).trim() : "";
    const workingDir = dirArg
      ? safeResolveWorkspace(dirArg, [state.workingDir, workspaceRoot(), sophronRoot()])
      : state.workingDir;

    // ── 1. Policy check (depth, cycle, allowlist) ─────────────────────────
    const policy = checkPolicy(targetName, callerAgent, state.delegationCtx);
    if (!policy.allowed) {
      return `Delegation denied: ${policy.reason}`;
    }

    // ── 2. Find target agent in the registry ──────────────────────────────
    const targetDef = services.agentRegistry.get(targetName);
    if (!targetDef) {
      const available = services.agentRegistry.listProjectAgents().map((a) => a.name).join(", ");
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
      workingDir,
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

    // ── 6. Persist a concise record to shared memory (Phase 3) ─────────────
    // So the next agent/session picks up what was done without replaying the
    // full sub-agent transcript.
    persistHandoffToShared(services.sharedMemoryStore, packet);
    return formatHandoffPacket(packet);
  },
};

/**
 * Append a concise handoff record to `.sophron/shared/HANDOFFS.md` under a
 * "Recent Delegations" section. Capped at the most recent entries (oldest are
 * trimmed) so the file doesn't grow unbounded.
 */
const HANDOFFS_FILE = "HANDOFFS.md";
const HANDOFFS_SECTION = "Recent Delegations";
const MAX_HANDOFF_ENTRIES = 20;

function persistHandoffToShared(
  store: import("../../memory/sharedStore.js").SharedMemoryStore,
  packet: import("../../types.js").HandoffPacket,
): void {
  const date = new Date().toISOString().slice(0, 19).replace("T", " ");
  const files = packet.filesChanged.length > 0 ? packet.filesChanged.join(", ") : "(none)";
  const line = `- [${date}] ${packet.agentName} → ${packet.outcome} (${packet.turns} turns): ${packet.summary.slice(0, 200)} | Files: ${files}`;

  let body = store.appendToSection(HANDOFFS_FILE, HANDOFFS_SECTION, line);
  // Trim to the most recent MAX_HANDOFF_ENTRIES entries.
  const entries = body.split("\n").filter((l) => l.trim().startsWith("- "));
  if (entries.length > MAX_HANDOFF_ENTRIES) {
    body = entries.slice(entries.length - MAX_HANDOFF_ENTRIES).join("\n");
    store.writeSection(HANDOFFS_FILE, HANDOFFS_SECTION, body);
  }
}
