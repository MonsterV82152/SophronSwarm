/**
 * Event recorder — module-level singleton writing JSONL to disk.
 *
 * Ported from V2's sophron_swarm/recorder.py. One file per run under runs/.
 * Flushed after every event for live inspection / replay UI (Phase 5).
 *
 * See docs/PHASE_0_DESIGN.md §9.
 */
import { mkdirSync, appendFileSync } from "node:fs";
import { log } from "../util/log.js";
import type { AgentRunState, ToolCall, Usage } from "../types.js";

export type RecorderEvent =
  | { type: "run_start"; runId: string; agent: string; task: string; ts: number }
  | { type: "turn_start"; runId: string; turn: number; ts: number }
  | {
      type: "llm_response";
      runId: string;
      turn: number;
      model: string;
      usage: Usage;
      finishReason: string;
      contentPreview: string;
      toolCallCount: number;
      ts: number;
    }
  | {
      type: "tool_call_start";
      runId: string;
      turn: number;
      toolCallId: string;
      tool: string;
      args: unknown;
      ts: number;
    }
  | {
      type: "tool_call_result";
      runId: string;
      turn: number;
      toolCallId: string;
      isError: boolean;
      resultPreview: string;
      ts: number;
    }
  | {
      type: "turn_end";
      runId: string;
      turn: number;
      cumulativeUsage: Usage;
      ts: number;
    }
  | { type: "run_end"; runId: string; status: string; totalUsage: Usage; ts: number }
  | { type: "run_error"; runId: string; error: string; ts: number };

const MAX_PREVIEW = 500;

class Recorder {
  private filePath: string | null = null;
  private initialized = false;
  /** Stack for nested (delegated) runs — saves/restores parent file path. */
  private fileStack: Array<{ filePath: string | null; initialized: boolean }> = [];

  /**
   * Open a fresh JSONL file for a run.
   * When called inside an already-open run (delegation), the current context
   * is pushed onto a stack and restored when `closeRun()` is called.
   */
  openForRun(runId: string): string {
    // Save current context before overwriting (supports nested sub-agent runs).
    this.fileStack.push({ filePath: this.filePath, initialized: this.initialized });
    const dir = "runs";
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      /* ignore */
    }
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    this.filePath = `${dir}/events_${ts}_${runId.slice(0, 8)}.jsonl`;
    this.initialized = true;
    return this.filePath;
  }

  /**
   * Close the current run's JSONL context and restore the parent's context
   * (if we were inside a delegated sub-agent run).
   */
  closeRun(): void {
    const prev = this.fileStack.pop();
    if (prev !== undefined) {
      this.filePath = prev.filePath;
      this.initialized = prev.initialized;
    }
  }

  /** Append one event. Silently drops if no file is open. */
  record(event: RecorderEvent): void {
    if (!this.initialized || !this.filePath) {
      log.debug({ eventType: event.type }, "recorder not opened; dropping event");
      return;
    }
    try {
      appendFileSync(this.filePath, JSON.stringify(event) + "\n", "utf8");
    } catch (e) {
      log.warn({ err: e }, "recorder write failed");
    }
  }

  // ── Convenience helpers ──────────────────────────────────────────────────

  recordRunStart(state: AgentRunState): void {
    this.record({
      type: "run_start",
      runId: state.runId,
      agent: state.agentName,
      task: state.task,
      ts: Date.now(),
    });
  }

  recordTurnStart(state: AgentRunState): void {
    this.record({ type: "turn_start", runId: state.runId, turn: state.turn, ts: Date.now() });
  }

  recordTurnEnd(state: AgentRunState): void {
    this.record({
      type: "turn_end",
      runId: state.runId,
      turn: state.turn,
      cumulativeUsage: state.tokenUsage,
      ts: Date.now(),
    });
  }

  recordRunEnd(state: AgentRunState): void {
    this.record({
      type: "run_end",
      runId: state.runId,
      status: state.status,
      totalUsage: state.tokenUsage,
      ts: Date.now(),
    });
  }

  recordToolCallStart(call: ToolCall, runId: string, turn: number): void {
    let parsedArgs: unknown = call.function.arguments;
    try {
      parsedArgs = JSON.parse(call.function.arguments || "{}");
    } catch {
      /* keep raw string */
    }
    this.record({
      type: "tool_call_start",
      runId,
      turn,
      toolCallId: call.id,
      tool: call.function.name,
      args: parsedArgs,
      ts: Date.now(),
    });
  }

  recordToolCallResult(
    call: ToolCall,
    runId: string,
    turn: number,
    result: string,
    isError: boolean,
  ): void {
    this.record({
      type: "tool_call_result",
      runId,
      turn,
      toolCallId: call.id,
      isError,
      resultPreview: result.slice(0, MAX_PREVIEW),
      ts: Date.now(),
    });
  }
}

/** Module-level singleton. */
export const recorder = new Recorder();

/** Serialize a run state for diffing in replay (Phase 5). */
export function serializeState(state: AgentRunState): string {
  return JSON.stringify({
    turn: state.turn,
    status: state.status,
    messages: state.messages.length,
    tokenUsage: state.tokenUsage,
  });
}
