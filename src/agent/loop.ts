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
import { addUsage, EMPTY_USAGE, type AgentDefinition, type AgentRunState, type LLMMessage } from "../types.js";

export const DEFAULT_MAX_TURNS = 32;

export interface RunOptions {
  agent: AgentDefinition;
  task: string;
  workingDir: string;
  llm: LLMClient;
  dispatcher: ToolDispatcher;
  checkpointer: Checkpointer;
  /** Shared-memory blocks (Phase 3). Keys = section titles. */
  sharedMemory?: Map<string, string>;
  /** Override the default max-turns cap. */
  maxTurns?: number;
}

function initRunState(agent: AgentDefinition, task: string, workingDir: string): AgentRunState {
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
  const { agent, task, workingDir, llm, dispatcher, checkpointer, sharedMemory } = opts;
  const maxTurns = opts.maxTurns ?? agent.maxTurns ?? DEFAULT_MAX_TURNS;

  const promptBuilder = new PromptBuilder();
  const state = initRunState(agent, task, workingDir);
  const messages: LLMMessage[] = promptBuilder.build(agent, task, { workingDir, sharedMemory });
  state.messages = messages;

  recorder.openForRun(state.runId);
  recorder.recordRunStart(state);
  checkpointer.save(state);
  log.info({ agent: agent.name, runId: state.runId, model: agent.model, maxTurns }, "run start");

  try {
    for (state.turn = 0; state.turn < maxTurns; state.turn++) {
      recorder.recordTurnStart(state);

      // ── 1. Call the model (transient errors retried inside the client) ────
      const tools = toolDefsFor(dispatcher.registry, agent);
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
        const result = await dispatcher.dispatch(call, agent, state);
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
    log.info(
      { agent: agent.name, runId: state.runId, status: state.status, turns: state.turn + 1, usage: state.tokenUsage },
      "run end",
    );
  }

  return { state };
}

/** Filter the registry's tools to this agent's allow/deny lists. */
function toolDefsFor(registry: ToolRegistry, agent: AgentDefinition) {
  return registry.definitionsFor({ allow: agent.tools, deny: agent.disallowedTools });
}
