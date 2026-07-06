/**
 * Approvals queue — the operator-facing side of the permission gate.
 *
 * When a tool invocation returns a "prompt" decision from the PermissionGate,
 * it's enqueued here for the operator to approve or deny. The TUI renders the
 * pending items; `/approve <id> yes|no` resolves them.
 *
 * For non-interactive (batch) runs, the queue stays empty and the gate falls
 * back to its existing allow+log behavior.
 *
 * Pure — no React, no I/O. Unit-testable.
 *
 * See docs/PHASE_5_DESIGN.md §3.4.
 */
import { randomUUID } from "node:crypto";
import { log } from "../util/log.js";

export interface PendingApproval {
  /** Unique id the operator references in /approve. */
  id: string;
  /** Short display id (first 8 chars) for the TUI. */
  shortId: string;
  agent: string;
  tool: string;
  args: Record<string, unknown>;
  /** The run that originated the request. */
  runId: string;
  createdAt: number;
}

export type ApprovalDecision = "allow" | "deny";

export interface ResolveResult {
  decision: ApprovalDecision;
  item: PendingApproval;
}

export class ApprovalsQueue {
  private items = new Map<string, PendingApproval>();

  /** Add a pending approval request; returns its id. */
  enqueue(req: Omit<PendingApproval, "id" | "shortId" | "createdAt">): string {
    const id = randomUUID();
    const shortId = id.slice(0, 8);
    const item: PendingApproval = { ...req, id, shortId, createdAt: Date.now() };
    this.items.set(id, item);
    log.info({ id: shortId, agent: req.agent, tool: req.tool }, "approval enqueued");
    return id;
  }

  /** Resolve an approval by id (or short id prefix). Returns the decision + item, or null if not found. */
  resolve(idOrPrefix: string, decision: ApprovalDecision): ResolveResult | null {
    const item = this.findById(idOrPrefix);
    if (!item) return null;
    this.items.delete(item.id);
    log.info({ id: item.shortId, agent: item.agent, tool: item.tool, decision }, "approval resolved");
    return { decision, item };
  }

  /** All currently-pending approvals, oldest first. */
  pending(): PendingApproval[] {
    return [...this.items.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Count of pending approvals. */
  get size(): number {
    return this.items.size;
  }

  /** Find an approval by full id or short id prefix (case-insensitive). */
  private findById(idOrPrefix: string): PendingApproval | undefined {
    const lower = idOrPrefix.toLowerCase();
    // exact full id
    let hit = [...this.items.values()].find((i) => i.id.toLowerCase() === lower);
    if (hit) return hit;
    // short id prefix
    const matches = [...this.items.values()].filter((i) => i.shortId.toLowerCase() === lower || i.id.toLowerCase().startsWith(lower));
    return matches[0];
  }
}

/**
 * A PermissionGate that routes "prompt" decisions to an ApprovalsQueue.
 *
 * Read-only tools → allow. Plan mode mutating tools → deny. Other mutating
 * tools in `default` mode → enqueue + block until resolved (the TUI resolves).
 * In `accept-edits`/`auto`/`full-auto` modes → allow (consistent with the
 * existing DefaultPermissionGate semantics).
 *
 * Because enqueue blocks (returns "deny" until resolved), this gate is only
 * safe to use behind the interactive TUI. Batch runs use DefaultPermissionGate.
 */
export function gateDecisionFor(
  toolName: string,
  agent: { name: string; permissionMode: string },
  approvals: ApprovalsQueue,
  state: { runId: string },
  args: Record<string, unknown>,
): "allow" | "deny" | "prompt" {
  const READONLY = new Set(["echo", "read_file", "list_dir"]);
  const MUTATING = new Set(["write_file", "apply_patch", "run_command"]);
  if (READONLY.has(toolName)) return "allow";
  if (MUTATING.has(toolName)) {
    if (agent.permissionMode === "plan") return "deny";
    if (agent.permissionMode === "default") {
      approvals.enqueue({ agent: agent.name, tool: toolName, args, runId: state.runId });
      return "prompt";
    }
    return "allow"; // accept-edits / auto / full-auto
  }
  return "allow";
}
