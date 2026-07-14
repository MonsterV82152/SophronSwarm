/**
 * Real-time agent event bus.
 *
 * The JSONL recorder persists every event to disk, but the TUI needs live,
 * in-process streaming. AgentEventBus mirrors the same event shapes in memory
 * and emits them keyed by runId so channels can subscribe to exactly one run.
 *
 * See docs/V3.1.0_PLAN.md §6.3.
 */
import { EventEmitter } from "node:events";
import type { Usage } from "../types.js";

export interface AgentEvent {
  runId: string;
  agentName: string;
  type:
    | "run_start"
    | "turn_start"
    | "llm_response"
    | "tool_call_start"
    | "tool_call_result"
    | "turn_end"
    | "run_end"
    | "run_error";
  turn?: number;
  // type-specific fields
  task?: string;
  model?: string;
  usage?: Usage;
  finishReason?: string;
  contentPreview?: string;
  toolCallCount?: number;
  toolCallId?: string;
  tool?: string;
  args?: unknown;
  isError?: boolean;
  resultPreview?: string;
  cumulativeUsage?: Usage;
  totalUsage?: Usage;
  status?: string;
  error?: string;
  ts: number;
}

/** Global event bus. The loop emits; the TUI subscribes. */
class AgentEventBus extends EventEmitter {
  /** Ring buffer of recent events for catch-up on late subscription. */
  private recent: AgentEvent[] = [];
  private readonly maxRecent = 500;

  /** Publish an event to the run-specific channel and the wildcard channel. */
  publish(event: AgentEvent): void {
    // Store in ring buffer for late subscribers.
    this.recent.push(event);
    if (this.recent.length > this.maxRecent) {
      this.recent.splice(0, this.recent.length - this.maxRecent);
    }
    super.emit(event.runId, event);
    super.emit("*", event);
  }

  /** Subscribe to events for a specific run. Returns an unsubscribe function. */
  onRun(runId: string, handler: (e: AgentEvent) => void): () => void {
    super.on(runId, handler);
    return () => super.off(runId, handler);
  }

  /** Subscribe to all runs. Returns an unsubscribe function. */
  onAll(handler: (e: AgentEvent) => void): () => void {
    super.on("*", handler);
    return () => super.off("*", handler);
  }

  /** Return recent buffered events for a specific agent (for catch-up). */
  recentForAgent(agentName: string, limit = 100): AgentEvent[] {
    return this.recent.filter((e) => e.agentName === agentName).slice(-limit);
  }

  /** Clear the ring buffer (for tests). */
  clearRecent(): void {
    this.recent = [];
  }
}

/** Module-level singleton. */
export const agentEvents = new AgentEventBus();
