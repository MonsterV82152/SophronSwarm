import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentEvents, type AgentEvent } from "../../src/agent/events.js";

describe("agentEvents", () => {
  const events: AgentEvent[] = [];
  let unsubscribes: Array<() => void> = [];

  beforeEach(() => {
    events.length = 0;
    unsubscribes = [];
  });

  afterEach(() => {
    for (const off of unsubscribes) off();
    events.length = 0;
  });

  it("delivers events by runId", () => {
    const off = agentEvents.onRun("r1", (e) => events.push(e));
    unsubscribes.push(off);

    agentEvents.publish({
      runId: "r1",
      agentName: "a",
      type: "turn_start",
      turn: 0,
      ts: 1,
    });
    agentEvents.publish({
      runId: "r2",
      agentName: "b",
      type: "turn_start",
      turn: 0,
      ts: 2,
    });

    expect(events).toHaveLength(1);
    expect(events[0]!.runId).toBe("r1");
  });

  it("delivers all events to the wildcard channel", () => {
    const off = agentEvents.onAll((e) => events.push(e));
    unsubscribes.push(off);

    agentEvents.publish({ runId: "r1", agentName: "a", type: "run_start", ts: 1 });
    agentEvents.publish({ runId: "r2", agentName: "b", type: "run_end", status: "complete", totalUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, ts: 2 });

    expect(events).toHaveLength(2);
  });

  it("unsubscribe removes the listener", () => {
    const off = agentEvents.onRun("r1", (e) => events.push(e));
    off();

    agentEvents.publish({ runId: "r1", agentName: "a", type: "run_start", ts: 1 });
    expect(events).toHaveLength(0);
  });
});
