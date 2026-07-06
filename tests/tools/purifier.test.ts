import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  stripAnsi,
  stripProgressBars,
  collapseConsecutiveDuplicates,
  collapseBlankLines,
  headTailTruncate,
  applyTier1,
  shouldPurify,
  Purifier,
  writeRaw,
  type PurifierMode,
} from "../../src/tools/purifier.js";

// ── Tier 1 rules ────────────────────────────────────────────────────────────

describe("purifier Tier 1 rules", () => {
  describe("stripAnsi", () => {
    it("removes color escape sequences", () => {
      expect(stripAnsi("\x1b[32mSUCCESS\x1b[0m")).toBe("SUCCESS");
    });
    it("removes private-mode (?…) sequences (cursor hide)", () => {
      expect(stripAnsi("\x1b[?25lLoading\x1b[?25h")).toBe("Loading");
    });
    it("leaves plain text untouched", () => {
      expect(stripAnsi("plain text")).toBe("plain text");
    });
    it("removes multi-attribute SGR sequences", () => {
      expect(stripAnsi("\x1b[1;31;47mERR\x1b[0m")).toBe("ERR");
    });
  });

  describe("stripProgressBars", () => {
    it("keeps only the final segment after the last \\r on a line", () => {
      // A progress bar that updates in place: " 10%", " 50%", " 99%", "done"
      const input = "progress: 10%\rprogress: 50%\rprogress: 99%\rdone";
      expect(stripProgressBars(input)).toBe("done");
    });
    it("preserves lines without \\r", () => {
      expect(stripProgressBars("line1\nline2\nline3")).toBe("line1\nline2\nline3");
    });
    it("handles \\r per logical line, not across \\n", () => {
      const input = "a\rb\nx\ry";
      expect(stripProgressBars(input)).toBe("b\ny");
    });
  });

  describe("collapseConsecutiveDuplicates", () => {
    it("collapses 3+ identical lines into one + count marker", () => {
      const input = "Compiling foo...\nCompiling foo...\nCompiling foo...\nCompiling foo...\nDone";
      const out = collapseConsecutiveDuplicates(input);
      expect(out).toContain("Compiling foo...");
      expect(out).toContain("[… 3 duplicate line(s) omitted …]");
      expect(out).toContain("Done");
      // Should only have one copy of the repeated line + marker + Done.
      const lines = out.split("\n");
      expect(lines.filter((l) => l === "Compiling foo...").length).toBe(1);
    });
    it("does NOT collapse runs of only 2 (keeps both)", () => {
      const input = "foo\nfoo";
      expect(collapseConsecutiveDuplicates(input)).toBe("foo\nfoo");
    });
    it("ignores trailing whitespace when comparing", () => {
      const input = "bar  \nbar\nbar";
      const out = collapseConsecutiveDuplicates(input);
      expect(out).toContain("[… 2 duplicate line(s) omitted …]");
    });
    it("leaves unique lines untouched", () => {
      expect(collapseConsecutiveDuplicates("a\nb\nc")).toBe("a\nb\nc");
    });
  });

  describe("collapseBlankLines", () => {
    it("collapses 2+ consecutive blanks to one", () => {
      expect(collapseBlankLines("foo\n\n\n\nbar")).toBe("foo\n\nbar");
    });
    it("preserves single blank lines", () => {
      expect(collapseBlankLines("foo\n\nbar")).toBe("foo\n\nbar");
    });
    it("handles whitespace-only lines as blank", () => {
      expect(collapseBlankLines("a\n   \n\t\nb")).toBe("a\n   \nb");
    });
  });

  describe("headTailTruncate", () => {
    it("truncates when line count > keep*2, keeping head + tail + marker", () => {
      const lines = Array.from({ length: 100 }, (_, i) => `L${i}`);
      const input = lines.join("\n");
      const res = headTailTruncate(input, 5);
      expect(res.truncated).toBe(true);
      expect(res.omitted).toBe(90);
      const out = res.text.split("\n");
      expect(out[0]).toBe("L0");
      expect(out[4]).toBe("L4");
      expect(out[5]).toContain("90 line(s) omitted");
      expect(out[6]).toBe("L95");
      expect(out[10]).toBe("L99");
    });
    it("is a no-op when line count <= keep*2", () => {
      expect(headTailTruncate("a\nb\nc", 5)).toEqual({ text: "a\nb\nc", truncated: false, omitted: 0 });
    });
  });

  describe("applyTier1 pipeline", () => {
    it("applies ANSI + dup + blank rules", () => {
      const input = "\x1b[32mok\x1b[0m\n\n\n\nx\nx\nx";
      const { text, changed } = applyTier1(input, { keepLines: 40, aggressive: false });
      expect(changed).toBe(true);
      expect(text).toContain("ok");
      expect(text).not.toContain("\x1b[");
      // 3 identical x lines → 1 + marker; 3 blanks → 1.
      expect(text).toContain("[… 2 duplicate line(s) omitted …]");
    });
    it("truncates when over threshold", () => {
      // Build a string well over the 1000-token default truncation threshold.
      const lines = Array.from({ length: 500 }, (_, i) => `line number ${i} here`);
      const input = lines.join("\n");
      const { text, changed } = applyTier1(input, { keepLines: 5, aggressive: false });
      expect(changed).toBe(true);
      expect(text.split("\n").length).toBeLessThan(lines.length);
      expect(text).toContain("line(s) omitted");
    });
    it("does not truncate short output", () => {
      const { text, changed } = applyTier1("short output\nhere", { keepLines: 40, aggressive: false });
      expect(changed).toBe(false);
      expect(text).toBe("short output\nhere");
    });
  });
});

// ── shouldPurify gating ──────────────────────────────────────────────────────

describe("shouldPurify", () => {
  it("returns false for off mode regardless of tool", () => {
    expect(shouldPurify("run_command", "off")).toBe(false);
    expect(shouldPurify("echo", "off")).toBe(false);
  });
  it("default mode: only run_command and mcp__ tools", () => {
    expect(shouldPurify("run_command", "default")).toBe(true);
    expect(shouldPurify("mcp__server__tool", "default")).toBe(true);
    expect(shouldPurify("echo", "default")).toBe(false);
    expect(shouldPurify("read_file", "default")).toBe(false);
    expect(shouldPurify("apply_patch", "default")).toBe(false);
  });
  it("aggressive mode: everything", () => {
    expect(shouldPurify("echo", "aggressive")).toBe(true);
    expect(shouldPurify("read_file", "aggressive")).toBe(true);
    expect(shouldPurify("anything", "aggressive")).toBe(true);
  });
});

// ── Raw output store + pruner ────────────────────────────────────────────────

describe("writeRaw + pruner", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sophron-purify-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes raw output and returns a workspace-relative path", () => {
    const rel = writeRaw("hello raw world", { workingDir: dir, runId: "r1", toolCallId: "call_1", capBytes: 50 * 1024 * 1024 });
    expect(rel).toContain(".sophron/raw/r1/");
    expect(rel).toContain("call_1");
    expect(existsSync(join(dir, rel))).toBe(true);
    expect(readFileSync(join(dir, rel), "utf8")).toBe("hello raw world");
  });

  it("prunes oldest files when over the size cap", () => {
    const cap = 200; // tiny cap to force pruning
    // Write 3 files; each ~100 bytes; oldest should be pruned once total > cap.
    const p1 = writeRaw("a".repeat(100), { workingDir: dir, runId: "r1", toolCallId: "c1", capBytes: cap });
    // mtime must be strictly older; touch with a past time by re-writing then sleeping is flaky,
    // so instead rely on ordering: write sequentially, the first is oldest.
    const p2 = writeRaw("b".repeat(100), { workingDir: dir, runId: "r1", toolCallId: "c2", capBytes: cap });
    const p3 = writeRaw("c".repeat(100), { workingDir: dir, runId: "r1", toolCallId: "c3", capBytes: cap });
    // p1 is oldest and should have been pruned by the time p3 was written (total 300 > cap 200).
    expect(existsSync(join(dir, p1))).toBe(false);
    // The newest two survive.
    expect(existsSync(join(dir, p2))).toBe(true);
    expect(existsSync(join(dir, p3))).toBe(true);
  });
});

// ── Purifier class ──────────────────────────────────────────────────────────

describe("Purifier class", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sophron-purifier-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function opts(overrides: Partial<Parameters<Purifier["purify"]>[1]> = {}) {
    return {
      mode: "default" as PurifierMode,
      threshold: 1500,
      workingDir: dir,
      runId: "run-test",
      toolCallId: "call-1",
      toolName: "run_command",
      ...overrides,
    };
  }

  it("off mode: returns content unchanged, no raw path", async () => {
    const p = new Purifier(); // no llm → deterministic only
    const r = await p.purify("some output", opts({ mode: "off" }));
    expect(r.content).toBe("some output");
    expect(r.rawPath).toBeUndefined();
    expect(r.tier1Applied).toBe(false);
    expect(r.tier2Applied).toBe(false);
  });

  it("default mode: non-noisy tools pass through untouched", async () => {
    const p = new Purifier();
    const r = await p.purify("file contents", opts({ toolName: "read_file" }));
    expect(r.content).toBe("file contents");
    expect(r.rawPath).toBeUndefined();
    expect(r.tier1Applied).toBe(false);
  });

  it("default mode: run_command with ANSI/noise is purified and raw is saved", async () => {
    const p = new Purifier();
    const noisy = "\x1b[32mBUILD SUCCESS\x1b[0m\n\n\n\nDone";
    const r = await p.purify(noisy, opts({ toolName: "run_command" }));
    expect(r.tier1Applied).toBe(true);
    expect(r.content).not.toContain("\x1b[");
    expect(r.rawPath).toBeDefined();
    expect(r.content).toContain(r.rawPath!);
    // Raw file on disk has the original.
    expect(readFileSync(join(dir, r.rawPath!), "utf8")).toBe(noisy);
  });

  it("short clean output is not truncated (no raw written)", async () => {
    const p = new Purifier();
    const clean = "all good\nno noise";
    const r = await p.purify(clean, opts({ toolName: "run_command" }));
    // clean (no ANSI, no dupes, no blanks) → unchanged → no raw path.
    expect(r.tier1Applied).toBe(false);
    expect(r.rawPath).toBeUndefined();
    expect(r.content).toBe(clean);
  });

  it("Tier 2 never fires when no llm is configured (deterministic-only)", async () => {
    const p = new Purifier(); // no llm
    // Large output exceeding threshold but Tier 2 should stay disabled.
    const big = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    const r = await p.purify(big, opts({ toolName: "run_command", threshold: 100 }));
    expect(r.tier2Applied).toBe(false);
    expect(r.tier1Applied).toBe(true); // truncation still applied
    expect(r.content).toContain("line(s) omitted");
  });

  it("never throws — on internal error returns original content", async () => {
    const p = new Purifier();
    // Force an error by pointing workingDir at a non-existent nested path that
    // mkdirSync can't create (parent is a file). writeRaw will throw, but the
    // purifier must catch it and return the original.
    const fileAsDir = join(dir, "iamfile");
    writeFileSync(fileAsDir, "x");
    const r = await p.purify("\x1b[32mclean\x1b[0m", opts({
      workingDir: join(fileAsDir, "sub"), // parent is a file → mkdirSync throws
    }));
    expect(r.content).toBe("\x1b[32mclean\x1b[0m");
    expect(r.tier1Applied).toBe(false);
  });

  it("aggressive mode purifies tools default would skip (e.g. echo)", async () => {
    const p = new Purifier();
    const r = await p.purify("\x1b[31mred\x1b[0m", opts({ toolName: "echo", mode: "aggressive" }));
    expect(r.tier1Applied).toBe(true);
    expect(r.content).toContain("red");
    expect(r.content).not.toContain("\x1b[");
  });
});
