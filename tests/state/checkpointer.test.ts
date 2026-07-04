import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Checkpointer } from "../../src/state/checkpointer.js";
import type { AgentRunState } from "../../src/types.js";

function makeState(overrides: Partial<AgentRunState> = {}): AgentRunState {
  return {
    runId: "run-1",
    threadId: "thread-1",
    agentName: "echo-bot",
    task: "say hello",
    messages: [],
    turn: 0,
    status: "running",
    workingDir: "/tmp",
    tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    startedAt: Date.now(),
    ...overrides,
  };
}

describe("Checkpointer", () => {
  let dir: string;
  let dbPath: string;
  let cp: Checkpointer;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sophron-cp-"));
    dbPath = join(dir, "checkpoints.db");
    cp = new Checkpointer(dbPath);
  });

  afterEach(() => {
    cp.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates the db file and parent dir", () => {
    expect(existsSync(dbPath)).toBe(true);
  });

  it("saves and assigns a sequence number", () => {
    const state = makeState();
    const seq = cp.save(state);
    expect(seq).toBe(1);
    expect(state.seq).toBe(1);
  });

  it("loads the latest state for a thread", () => {
    const s1 = makeState({ turn: 0 });
    cp.save(s1);
    const s2 = makeState({ turn: 5, status: "complete" });
    cp.save(s2);

    const latest = cp.loadLatest("thread-1");
    expect(latest).not.toBeNull();
    expect(latest!.turn).toBe(5);
    expect(latest!.status).toBe("complete");
  });

  it("loads a specific snapshot by seq (for rewind)", () => {
    cp.save(makeState({ turn: 0 }));
    cp.save(makeState({ turn: 3 }));
    cp.save(makeState({ turn: 7 }));

    const rewindTarget = cp.loadAt(2);
    expect(rewindTarget).not.toBeNull();
    expect(rewindTarget!.turn).toBe(3);
  });

  it("returns null for unknown thread / seq", () => {
    expect(cp.loadLatest("nope")).toBeNull();
    expect(cp.loadAt(999)).toBeNull();
  });

  it("loads a full thread ascending", () => {
    cp.save(makeState({ turn: 0 }));
    cp.save(makeState({ turn: 1 }));
    cp.save(makeState({ turn: 2 }));
    const thread = cp.loadThread("thread-1");
    expect(thread).toHaveLength(3);
    expect(thread.map((s) => s.turn)).toEqual([0, 1, 2]);
  });

  it("isolates threads", () => {
    cp.save(makeState({ threadId: "a", turn: 1 }));
    cp.save(makeState({ threadId: "b", turn: 99 }));
    expect(cp.loadLatest("a")!.turn).toBe(1);
    expect(cp.loadLatest("b")!.turn).toBe(99);
  });
});
