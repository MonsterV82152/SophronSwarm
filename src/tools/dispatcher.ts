/**
 * Tool dispatcher — maps a tool_call to its handler and executes it.
 *
 * Enforces the agent's allow/deny lists and the permission gate. Tool errors
 * are NEVER retried and NEVER fatal — they are returned to the model as
 * `isError` results so the model can adapt (this is the contract that lets
 * the agentic loop self-correct).
 *
 * Ported from V2's tool-execution pattern. See docs/PHASE_0_DESIGN.md §5.
 */
import { log } from "../util/log.js";
import type { AgentDefinition, AgentRunState, ToolCall, ToolResult } from "../types.js";
import { ToolRegistry } from "./registry.js";
import type { SharedServices, ToolSpec } from "./schema.js";
import { isMcpTool } from "../mcp/promotion.js";

/** A permission decision for a tool invocation. */
export type PermissionDecision = "allow" | "deny" | "prompt";

/**
 * Permission gate. Decides allow/deny/prompt per (tool, agent.permissionMode).
 *
 * The dangerous-command blocker runs INSIDE run_command (not here) so it always
 * applies regardless of mode. This gate only handles mode-based routing.
 *
 * Phase 6 replaces the "prompt" return with the auto-mode classifier + an
 * interactive prompt UI. For now (Phase 1) prompts degrade to allow+log since
 * there's no UI to surface them.
 *
 * See docs/PHASE_1_DESIGN.md §4.
 */
export interface PermissionGate {
  check(toolName: string, args: unknown, agent: AgentDefinition, state?: AgentRunState): Promise<PermissionDecision>;
}

/** Tools that mutate the filesystem or execute shell. */
const MUTATING_TOOLS = new Set(["write_file", "apply_patch", "run_command"]);

/** Read-only tools — always allowed in every mode (including plan). */
const READONLY_TOOLS = new Set(["echo", "read_file", "list_dir"]);

/**
 * Phase-1 default gate. Tool- and mode-aware:
 *   - read-only tools: always allow.
 *   - mutating tools in `plan` mode: deny.
 *   - mutating tools in other modes: allow (the dangerous-command blocker
 *     inside run_command handles the actual safety work).
 *   - unknown tools: allow (the registry/allowlist filtering already gates these).
 */
export class DefaultPermissionGate implements PermissionGate {
  async check(toolName: string, args: unknown, agent: AgentDefinition, _state?: AgentRunState): Promise<PermissionDecision> {
    if (READONLY_TOOLS.has(toolName)) return "allow";
    if (MUTATING_TOOLS.has(toolName)) {
      if (agent.permissionMode === "plan") {
        log.info({ tool: toolName, agent: agent.name }, "denied: plan mode is read-only");
        return "deny";
      }
      return "allow";
    }
    return "allow";
  }
}

export class ToolDispatcher {
  /** Exposed so the loop can read filtered tool definitions per-agent. */
  readonly registry: ToolRegistry;

  constructor(
    registry: ToolRegistry,
    private gate: PermissionGate = new DefaultPermissionGate(),
  ) {
    this.registry = registry;
  }

  async dispatch(
    call: ToolCall,
    agent: AgentDefinition,
    state: AgentRunState,
    services?: SharedServices,
  ): Promise<ToolResult> {
    const name = call.function.name;

    // ── Parse arguments ────────────────────────────────────────────────────
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(call.function.arguments || "{}");
      if (args === null || typeof args !== "object" || Array.isArray(args)) {
        return errorResult(call.id, `Tool arguments must be a JSON object, got ${typeof args}`);
      }
    } catch {
      return errorResult(call.id, `Invalid JSON arguments: ${call.function.arguments}`);
    }

    // ── Allow / deny enforcement ───────────────────────────────────────────
    if (agent.disallowedTools?.includes(name)) {
      return errorResult(call.id, `Tool '${name}' is disallowed for this agent`);
    }
    // Promoted MCP tools are gated by mcp_tool_search (which the agent must call
    // to enable them), NOT by the agent's static allowlist. Exempt them here.
    if (!isMcpTool(name) && agent.tools && !agent.tools.includes(name)) {
      return errorResult(call.id, `Tool '${name}' is not in this agent's allowlist`);
    }

    // ── Resolve handler ────────────────────────────────────────────────────
    // Promoted MCP tools live on state.mcpTools (per-run); builtins in the registry.
    let spec: ToolSpec | undefined;
    if (isMcpTool(name)) {
      spec = state.mcpTools?.find((t) => t.name === name);
    } else {
      spec = this.registry.get(name);
    }
    if (!spec) return errorResult(call.id, `Unknown tool '${name}'`);

    // ── Permission gate ────────────────────────────────────────────────────
    const decision = await this.gate.check(name, args, agent, state);
    if (decision === "deny") {
      return errorResult(call.id, `Denied by permission gate (mode=${agent.permissionMode})`);
    }
    // "prompt" means the gate enqueued an approval request. In batch (no TUI to
    // resolve it) we block the call rather than silently allow — safer default.
    if (decision === "prompt") {
      return errorResult(call.id, `Awaiting operator approval (mode=${agent.permissionMode}). Use the TUI /approve or run in accept-edits/auto mode.`);
    }

    // ── Execute (tool errors are surfaced to the model, never thrown) ──────
    try {
      const out = await spec.handler({ args, agent, state, services: services! });
      const content = typeof out === "string" ? out : JSON.stringify(out);
      log.debug({ tool: name, chars: content.length }, "tool ok");
      return { tool_call_id: call.id, content };
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      log.warn({ tool: name, err: msg }, "tool error (surfaced to model)");
      return errorResult(call.id, `${name}: ${msg}`);
    }
  }
}

function errorResult(toolCallId: string, message: string): ToolResult {
  return { tool_call_id: toolCallId, content: message, isError: true };
}
