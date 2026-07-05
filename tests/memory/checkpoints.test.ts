import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckpointManager, parseCheckpoints, serializeCheckpoints } from "../../src/memory/checkpoints.js";
import { SharedMemoryStore, SHARED_FILES } from "../../src/memory/sharedStore.js";

describe("parseCheckpoints", () => {
  it("parses numbered checkbox items", () => {
    const ms = parseCheckpoints("1. [ ] First\n2. [ ] Second\n3. [x] Third\n");
    expect(ms).toHaveLength(3);
    expect(ms[0]).toEqual({ index: 1, title: "First", done: false });
    expect(ms[2]).toEqual({ index: 3, title: "Third", done: true });
  });

  it("parses bullet checkbox items", () => {
    const ms = parseCheckpoints("- [ ] A\n- [x] B\n");
    expect(ms.map((m) => m.title)).toEqual(["A", "B"]);
    expect(ms[1]!.done).toBe(true);
  });

  it("ignores non-list lines", () => {
    const ms = parseCheckpoints("# Checkpoints\n\n1. [ ] A\nsome prose\n");
    expect(ms).toHaveLength(1);
    expect(ms[0]!.title).toBe("A");
  });

  it("returns empty for a doc with no list items", () => {
    expect(parseCheckpoints("# Checkpoints\n\nNo items yet.\n")).toHaveLength(0);
  });
});

describe("serializeCheckpoints", () => {
  it("round-trips milestones + preamble", () => {
    const ms = [
      { index: 1, title: "A", done: false },
      { index: 2, title: "B", done: true },
    ];
    const out = serializeCheckpoints(ms, "# Checkpoints");
    const reparsed = parseCheckpoints(out);
    expect(reparsed[0]).toEqual({ index: 1, title: "A", done: false });
    expect(reparsed[1]).toEqual({ index: 2, title: "B", done: true });
    expect(out).toContain("# Checkpoints");
  });
});

describe("CheckpointManager", () => {
  let dir: string;
  let store: SharedMemoryStore;
  let mgr: CheckpointManager;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sophron-ckpt-"));
    store = new SharedMemoryStore(join(dir, ".sophron", "shared"));
    mgr = new CheckpointManager(store);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("list returns [] when no checkpoints defined", () => {
    expect(mgr.list()).toHaveLength(0);
  });

  it("current returns null when no current checkpoint file exists", () => {
    store.write(SHARED_FILES.CHECKPOINTS, "1. [ ] A\n2. [ ] B\n");
    expect(mgr.current()).toBeNull();
  });

  it("advance returns advanced=false with no milestones", () => {
    const res = mgr.advance();
    expect(res.advanced).toBe(false);
    expect(res.reason).toMatch(/no milestones/i);
  });

  describe("with milestones + a current checkpoint", () => {
    beforeEach(() => {
      store.write(SHARED_FILES.CHECKPOINTS, "# Checkpoints\n\n1. [ ] Phase 0\n2. [ ] Phase 1\n3. [ ] Phase 2\n");
      store.write(SHARED_FILES.CURRENT_CHECKPOINT, "# Current Checkpoint\n\nPhase 0\n");
    });

    it("current resolves the matching milestone", () => {
      const cur = mgr.current();
      expect(cur?.title).toBe("Phase 0");
      expect(cur?.done).toBe(false);
    });

    it("advance marks current complete and moves to next", () => {
      const res = mgr.advance();
      expect(res.advanced).toBe(true);
      expect(res.completed?.title).toBe("Phase 0");
      expect(res.current?.title).toBe("Phase 1");
      // CURRENT_CHECKPOINT updated.
      const curFile = store.read(SHARED_FILES.CURRENT_CHECKPOINT);
      expect(curFile).toContain("Phase 1");
      // CHECKPOINTS marks Phase 0 done.
      const ms = mgr.list();
      expect(ms[0]!.done).toBe(true);
      expect(ms[1]!.done).toBe(false);
    });

    it("advance twice moves two steps", () => {
      mgr.advance();
      const res2 = mgr.advance();
      expect(res2.advanced).toBe(true);
      expect(res2.current?.title).toBe("Phase 2");
    });

    it("advance at the last milestone does not advance", () => {
      mgr.advance(); // → Phase 1
      mgr.advance(); // → Phase 2
      const res = mgr.advance(); // at last
      expect(res.advanced).toBe(false);
      expect(res.reason).toMatch(/last milestone/i);
    });

    it("counts remaining milestones after advancing", () => {
      const res = mgr.advance();
      expect(res.advanced).toBe(true);
      // Phase 0 done, Phase 1 current, Phase 2 remaining
      const remaining = res.milestones.filter((m) => !m.done && m.title !== res.current!.title).length;
      expect(remaining).toBe(1);
    });
  });

  it("advance with no current set starts at the first milestone", () => {
    store.write(SHARED_FILES.CHECKPOINTS, "1. [ ] A\n2. [ ] B\n");
    const res = mgr.advance();
    expect(res.advanced).toBe(true);
    expect(res.current?.title).toBe("A");
    expect(res.completed).toBeNull();
  });
});
