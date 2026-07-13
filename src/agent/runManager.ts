/**
 * Run manager — tracks active agent runs for the TUI.
 *
 * Wraps `runAgent` with an `AbortController` so the operator can stop a run
 * from a channel. Also tracks parent→child relationships so stopping an
 * orchestrator cascades to its delegated sub-agents.
 *
 * See docs/V3.1.0_PLAN.md §6.3.
 */
import { randomUUID } from "node:crypto";
import { runAgent, type RunOptions } from "./loop.js";
import type { AgentDefinition, AgentRunState } from "../types.js";

export interface ActiveRun {
  runId: string;
  agentName: string;
  status: "running" | "stopped" | "complete" | "error";
  abortController: AbortController;
  startedAt: number;
  /** Parent run id when this run was spawned by `delegate`. */
  parentId?: string;
}

interface StartOptions extends Omit<RunOptions, "abortSignal"> {
  agent: AgentDefinition;
  parentId?: string;
}

class RunManager {
  private active = new Map<string, ActiveRun>();

  start(opts: StartOptions): { runId: string; promise: Promise<AgentRunState> } {
    const runId = randomUUID();
    const abortController = new AbortController();
    const startedAt = Date.now();

    this.active.set(runId, {
      runId,
      agentName: opts.agent.name,
      status: "running",
      abortController,
      startedAt,
      parentId: opts.parentId,
    });

    const runPromise = runAgent({
      ...opts,
      runId,
      abortSignal: abortController.signal,
    });

    const completionPromise = runPromise
      .then(({ state }) => {
        const run = this.active.get(state.runId);
        if (run && run.status === "running") {
          run.status = state.status === "error" ? "error" : state.status === "stopped" ? "stopped" : "complete";
        }
        return state;
      })
      .finally(() => {
        // Keep the entry briefly so the TUI can observe the final status, then
        // clean it up. The event bus already emitted the terminal event.
        setTimeout(() => this.active.delete(runId), 5000);
      });

    return { runId, promise: completionPromise };
  }

  stop(runId: string): void {
    const run = this.active.get(runId);
    if (!run) return;
    run.abortController.abort();
    run.status = "stopped";
    // Cascade to children.
    for (const child of this.active.values()) {
      if (child.parentId === runId) {
        this.stop(child.runId);
      }
    }
  }

  listActive(): ActiveRun[] {
    return [...this.active.values()];
  }

  isRunning(agentName: string): ActiveRun | undefined {
    for (const run of this.active.values()) {
      if (run.agentName === agentName && run.status === "running") {
        return run;
      }
    }
    return undefined;
  }

  get(runId: string): ActiveRun | undefined {
    return this.active.get(runId);
  }
}

/** Module-level singleton. */
export const runManager = new RunManager();
