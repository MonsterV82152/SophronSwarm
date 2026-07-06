/**
 * The agentic loop — the heart of SophronSwarm V3.
 *
 * Claude Code / SwarmClaw pattern: the model decides the next action, tools
 * execute synchronously in-turn, the agent terminates when it emits a
 * non-tool final answer.
 *
 * Invariants (from V2 + repo memory):
 *   - maxTurns cap = infinite-loop protection.
 *   - Retry wraps ONLY the LLM call (transient → backoff, fatal → throw).
 *   - Tool errors are returned to the model as isError results (never retried,
 *     never fatal) — this is what lets the loop self-correct.
 *   - Checkpoint after every turn → enables rewind (Phase 5).
 *
 * See docs/PHASE_0_DESIGN.md §4.
 */
import { randomUUID } from "node:crypto";
import { log } from "../util/log.js";
import { LLMClient } from "../llm/client.js";
import { PromptBuilder } from "../llm/promptBuilder.js";
import { ToolDispatcher } from "../tools/dispatcher.js";
import { ToolRegistry } from "../tools/registry.js";
import { Checkpointer } from "../state/checkpointer.js";
import { recorder } from "../state/recorder.js";
import type { SharedServices } from "../tools/schema.js";
import { promoteTool, recordPromotionCosts } from "../mcp/promotion.js";
import {
  addUsage, EMPTY_USAGE,
  type AgentDefinition, type AgentRunState, type DelegationContext, type LLMMessage,
} from "../types.js";

export const DEFAULT_MAX_TURNS = 32;

export interface RunOptions {
  agent: AgentDefinition;
  task: string;
  workingDir: string;
  llm: LLMClient;
  dispatcher: ToolDispatcher;
  checkpointer: Checkpointer;
  /** Shared services threaded into every tool call (required for delegation). */
  services: SharedServices;
  /** Delegation context set when this run is a sub-agent. */
  delegationCtx?: DelegationContext;
  /** Override the default max-turns cap. */
  maxTurns?: number;
}

function initRunState(
  agent: AgentDefinition,
  task: string,
  workingDir: string,
  delegationCtx?: DelegationContext,
): AgentRunState {
  const runId = randomUUID();
  const threadId = randomUUID();
  return {
    runId,
    threadId,
    agentName: agent.name,
    task,
    messages: [],
    turn: 0,
    status: "running",
    workingDir,
    tokenUsage: { ...EMPTY_USAGE },
    startedAt: Date.now(),
    delegationCtx,
  };
}

export interface RunResult {
  state: AgentRunState;
}

/**
 * Run an agent's loop to completion.
 *
 * Returns the final AgentRunState. Throws only on fatal LLM errors
 * (transient ones are retried inside the client).
 */
export async function runAgent(opts: RunOptions): Promise<RunResult> {
  const { agent, task, workingDir, llm, dispatcher, checkpointer, services } = opts;
  const maxTurns = opts.maxTurns ?? agent.maxTurns ?? DEFAULT_MAX_TURNS;

  // ── Phase 3: pull memory into context (auto-injection) ──────────────────
  // Shared memory: always injected (project context). Per-agent memory: the
  // agent's own recorded lessons (first ~200 lines), injected unless the agent
  // explicitly opts out of per-agent scope.
  const sharedMemory = services.sharedMemoryStore.toInjectionMap();
  const allowPerAgent =
    !agent.memoryScopes || agent.memoryScopes.length === 0 || agent.memoryScopes.includes("per-agent");
  const agentMemory = allowPerAgent ? services.agentMemoryStore.readForInjection(agent.name) : "";

  const promptBuilder = new PromptBuilder();
  const state = initRunState(agent, task, workingDir, opts.delegationCtx);
  const messages: LLMMessage[] = promptBuilder.build(agent, task, {
    workingDir,
    sharedMemory: sharedMemory.size > 0 ? sharedMemory : undefined,
    agentMemory: agentMemory || undefined,
  });
  state.messages = messages;

  // ── Phase 4: pre-promote tools from alwaysExpose servers ────────────────
  // Eager servers opt into having all their tools bound from turn 0 (rare; the
  // default is lazy search). Per-run isolated on state.mcpTools.
  await prePromoteAlwaysExpose(agent, state, services);

  recorder.openForRun(state.runId);
  recorder.recordRunStart(state);
  checkpointer.save(state);
  log.info({ agent: agent.name, runId: state.runId, model: agent.model, maxTurns }, "run start");

  try {
    for (state.turn = 0; state.turn < maxTurns; state.turn++) {
      recorder.recordTurnStart(state);

      // ── 1. Call the model (transient errors retried inside the client) ────
      const tools = toolDefsFor(dispatcher.registry, agent, state);
      const response = await llm.complete({ model: agent.model, provider: agent.provider, messages, tools });
      state.tokenUsage = addUsage(state.tokenUsage, response.usage);
      recorder.record({
        type: "llm_response",
        runId: state.runId,
        turn: state.turn,
        model: response.model,
        usage: response.usage,
        finishReason: response.finishReason,
        contentPreview: (response.content ?? "").slice(0, 500),
        toolCallCount: response.toolCalls.length,
        ts: Date.now(),
      });
      log.info(
        { turn: state.turn, finish: response.finishReason, calls: response.toolCalls.length, usage: response.usage },
        "llm turn",
      );

      // ── 2. Terminal? (final answer, length cap, or content filter) ────────
      const wantsTools = response.finishReason === "tool_calls" && response.toolCalls.length > 0;
      if (!wantsTools) {
        messages.push({ role: "assistant", content: response.content });
        state.messages = messages;
        state.status = "complete";
        recorder.recordTurnEnd(state);
        checkpointer.save(state);
        break;
      }

      // ── 3. Dispatch tool calls synchronously, in-turn ─────────────────────
      messages.push({
        role: "assistant",
        content: response.content,
        tool_calls: response.toolCalls,
      });

      for (const call of response.toolCalls) {
        recorder.recordToolCallStart(call, state.runId, state.turn);
        const result = await dispatcher.dispatch(call, agent, state, services);
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: result.content,
          name: call.function.name,
        });
        recorder.recordToolCallResult(call, state.runId, state.turn, result.content, result.isError === true);
      }

      state.messages = messages;
      recorder.recordTurnEnd(state);
      checkpointer.save(state);
    }

    if (state.status === "running") {
      state.status = "halted";
      log.warn({ agent: agent.name, runId: state.runId, maxTurns }, "agent halted at maxTurns cap");
    }
  } catch (e) {
    state.status = "error";
    state.error = (e as Error)?.message ?? String(e);
    recorder.record({ type: "run_error", runId: state.runId, error: state.error, ts: Date.now() });
    log.error({ err: e, runId: state.runId }, "run ended in error");
  } finally {
    state.endedAt = Date.now();
    recorder.recordRunEnd(state);
    checkpointer.save(state);
    // Restore the parent run's recorder context (no-op when this is the top-level run).
    recorder.closeRun();
    log.info(
      { agent: agent.name, runId: state.runId, status: state.status, turns: state.turn + 1, usage: state.tokenUsage },
      "run end",
    );
  }

  return { state };
}

/** Filter the registry's tools to this agent's allow/deny lists + merge promoted MCP tools. */
function toolDefsFor(registry: ToolRegistry, agent: AgentDefinition, state: AgentRunState) {
  const builtin = registry.definitionsFor({ allow: agent.tools, deny: agent.disallowedTools });
  // Merge promoted MCP tools (Phase 4) — per-run isolated on state.mcpTools.
  // The agent never needs to declare MCP tools in its allowlist; the mcp_tool_search
  // meta-tool is the gate (it's a builtin, subject to normal allow/deny).
  const mcp = (state.mcpTools ?? []).map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
  return [...builtin, ...mcp];
}

/**
 * Pre-promote tools from servers declared `alwaysExpose: true` for this agent.
 * Eager exposure is the rare opt-in; the default is lazy `mcp_tool_search`.
 * Errors here are non-fatal (logged) — a failing server shouldn't abort the run.
 */
async function prePromoteAlwaysExpose(
  agent: AgentDefinition,
  state: AgentRunState,
  services: SharedServices,
): Promise<void> {
  const declared = agent.mcpServers ?? [];
  if (declared.length === 0) return;
  const eager = services.mcpPool
    .configuredServers()
    .filter((s) => s.alwaysExpose === true)
    .filter((s) => declared.some((d) => (typeof d === "string" ? d === s.name : d["name"] === s.name)));
  if (eager.length === 0) return;

  try {
    await services.mcpCatalog.refresh(eager.map((s) => s.name));
  } catch (e) {
    log.warn({ err: (e as Error).message }, "alwaysExpose catalog refresh failed");
    return;
  }

  const promoted = state.mcpTools ?? [];
  for (const server of eager) {
    const cap = server.maxTools ?? 20;
    const tools = services.mcpCatalog.forServer(server.name).slice(0, cap);
    for (const t of tools) {
      promoted.push(promoteTool(t, services.mcpPool, services.mcpCostMeter));
    }
    recordPromotionCosts(tools, services.mcpCostMeter);
  }
  state.mcpTools = promoted;
  log.info({ agent: agent.name, servers: eager.map((s) => s.name), tools: promoted.length }, "alwaysExpose pre-promoted");
}
