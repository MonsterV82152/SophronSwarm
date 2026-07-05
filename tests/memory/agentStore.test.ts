import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentMemoryStore,
  AGENT_MEMORY_SECTIONS,
  DEFAULT_INJECTION_LINES,
  MIN_NOTE_LENGTH,
} from "../../src/memory/agentStore.js";

describe("AgentMemoryStore", () => {
  let dir: string;
  let store: AgentMemoryStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sophron-agentmem-"));
    store = new AgentMemoryStore(join(dir, ".sophron", "memory"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("read returns empty string for a missing agent", () => {
    expect(store.read("missing")).toBe("");
  });

  it("append creates the file with a timestamped bullet", () => {
    const res = store.append("builder", AGENT_MEMORY_SECTIONS.FAILURES, "bwrap masks /tmp", {
      date: "2026-07-05",
    });
    expect(res.appended).toBe(true);
    const onDisk = readFileSync(store.path("builder"), "utf8");
    expect(onDisk).toContain("## Past Points of Failure");
    expect(onDisk).toContain("- [2026-07-05] bwrap masks /tmp");
  });

  it("append adds to an existing section", () => {
    store.append("builder", AGENT_MEMORY_SECTIONS.KEY_POINTS, "first key point here", { date: "2026-07-05" });
    store.append("builder", AGENT_MEMORY_SECTIONS.KEY_POINTS, "second key point here", { date: "2026-07-05" });
    const body = store.readSection("builder", AGENT_MEMORY_SECTIONS.KEY_POINTS);
    expect(body).toContain("first key point here");
    expect(body).toContain("second key point here");
  });

  it("append rejects a note that is too short", () => {
    const res = store.append("builder", AGENT_MEMORY_SECTIONS.ISSUES, "tiny", { date: "2026-07-05" });
    expect(res.appended).toBe(false);
    expect(res.reason).toMatch(/too short/i);
    expect(store.read("builder")).toBe("");
  });

  it("append rejects a duplicate note (dedup on)", () => {
    store.append("builder", AGENT_MEMORY_SECTIONS.ISSUES, "node lives at ~/.local/bin/node", { date: "2026-07-05" });
    const res = store.append("builder", AGENT_MEMORY_SECTIONS.ISSUES, "node lives at ~/.local/bin/node", {
      date: "2026-07-05",
    });
    expect(res.appended).toBe(false);
    expect(res.reason).toMatch(/duplicate/i);
    // Only one entry on disk.
    const body = store.readSection("builder", AGENT_MEMORY_SECTIONS.ISSUES);
    expect(body.split("\n")).toHaveLength(1);
  });

  it("append allows a duplicate when dedup is off", () => {
    store.append("builder", AGENT_MEMORY_SECTIONS.ISSUES, "node lives at ~/.local/bin/node", { date: "2026-07-05" });
    const res = store.append("builder", AGENT_MEMORY_SECTIONS.ISSUES, "node lives at ~/.local/bin/node", {
      date: "2026-07-05",
      dedup: false,
    });
    expect(res.appended).toBe(true);
  });

  it("append detects near-duplicate restatements", () => {
    store.append("builder", AGENT_MEMORY_SECTIONS.FAILURES, "The patch applier falls back to patch -p1", {
      date: "2026-07-05",
    });
    const res = store.append("builder", AGENT_MEMORY_SECTIONS.FAILURES, "patch applier falls back", {
      date: "2026-07-05",
    });
    expect(res.appended).toBe(false);
    expect(res.reason).toMatch(/duplicate/i);
  });

  it("write + read round-trips full content", () => {
    store.write("builder", "# Memory\n\n## Key Points\n- something\n");
    expect(store.read("builder")).toBe("# Memory\n\n## Key Points\n- something\n");
  });

  describe("readForInjection", () => {
    it("returns empty for a missing agent", () => {
      expect(store.readForInjection("missing")).toBe("");
    });

    it("returns the full content when under the line cap", () => {
      store.write("builder", "# Memory\n\n## Key Points\n- note\n");
      expect(store.readForInjection("builder")).toBe("# Memory\n\n## Key Points\n- note\n");
    });

    it("truncates to the line cap", () => {
      const long = Array.from({ length: DEFAULT_INJECTION_LINES + 50 }, (_, i) => `line ${i}`).join("\n") + "\n";
      store.write("builder", long);
      const injected = store.readForInjection("builder");
      expect(injected.split("\n")).toHaveLength(DEFAULT_INJECTION_LINES);
    });

    it("respects a custom line cap", () => {
      store.write("builder", "a\nb\nc\nd\n");
      expect(store.readForInjection("builder", 2)).toBe("a\nb");
    });
  });

  it("exposes MIN_NOTE_LENGTH and DEFAULT_INJECTION_LINES constants", () => {
    expect(MIN_NOTE_LENGTH).toBeGreaterThan(0);
    expect(DEFAULT_INJECTION_LINES).toBe(200);
  });

  it("path and dir helpers resolve under the root", () => {
    expect(store.path("builder")).toBe(join(store.root, "builder", "MEMORY.md"));
    expect(store.dir("builder")).toBe(join(store.root, "builder"));
  });
});
