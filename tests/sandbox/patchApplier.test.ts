import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPatchChain, looksLikeUnifiedDiff } from "../../src/sandbox/patchApplier.js";

describe("patchApplier — looksLikeUnifiedDiff", () => {
  it("accepts a real unified diff", () => {
    expect(
      looksLikeUnifiedDiff(`--- a/foo\n+++ b/foo\n@@ -1 +1 @@\n-old\n+new\n`),
    ).toBe(true);
  });
  it("rejects prose", () => {
    expect(looksLikeUnifiedDiff("This is just an explanation, not a diff.")).toBe(false);
  });
  it("rejects empty", () => {
    expect(looksLikeUnifiedDiff("")).toBe(false);
  });
});

describe("patchApplier — applyPatchChain", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sophron-patch-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("creates a new file from /dev/null", async () => {
    const diff = [
      "--- /dev/null",
      "+++ b/hello.txt",
      "@@ -0,0 +1,3 @@",
      "+first line",
      "+second line",
      "+third line",
      "",
    ].join("\n");
    const res = await applyPatchChain(diff, dir);
    expect(res.ok).toBe(true);
    expect(res.method).toBe("typescript");
    expect(existsSync(join(dir, "hello.txt"))).toBe(true);
    expect(readFileSync(join(dir, "hello.txt"), "utf8").trim()).toBe("first line\nsecond line\nthird line");
  });

  it("creates multiple new files from one diff", async () => {
    const diff = [
      "--- /dev/null",
      "+++ b/a.txt",
      "@@ -0,0 +1,1 @@",
      "+A",
      "--- /dev/null",
      "+++ b/sub/b.txt",
      "@@ -0,0 +1,1 @@",
      "+B",
    ].join("\n");
    const res = await applyPatchChain(diff, dir);
    expect(res.ok).toBe(true);
    expect(res.filesChanged).toBe(2);
    expect(existsSync(join(dir, "a.txt"))).toBe(true);
    expect(existsSync(join(dir, "sub", "b.txt"))).toBe(true);
  });

  it("modifies an existing file (single hunk)", async () => {
    writeFileSync(join(dir, "code.ts"), "export const X = 1;\nexport const Y = 2;\nexport const Z = 3;\n");
    const diff = [
      "--- a/code.ts",
      "+++ b/code.ts",
      "@@ -1,3 +1,3 @@",
      " export const X = 1;",
      "-export const Y = 2;",
      "+export const Y = 22;",
      " export const Z = 3;",
      "",
    ].join("\n");
    const res = await applyPatchChain(diff, dir);
    expect(res.ok).toBe(true);
    expect(readFileSync(join(dir, "code.ts"), "utf8")).toContain("Y = 22");
    expect(readFileSync(join(dir, "code.ts"), "utf8")).toContain("X = 1");
  });

  it("falls back to the patch utility for diffs the TS applier rejects", async () => {
    // A hunk whose context doesn't match → TS applier fails → patch utility runs.
    writeFileSync(join(dir, "f.txt"), "line1\nline2\nline3\n");
    const diff = [
      "--- a/f.txt",
      "+++ b/f.txt",
      "@@ -1,3 +1,3 @@",
      " line1",
      "-lineX",
      "+line2-edited",
      " line3",
      "",
    ].join("\n");
    // The TS applier can't find the pre-image ("line1","lineX","line3"), so it
    // falls through to `patch`. patch with mismatched context fails too, so we
    // expect ok=false but method indicating it tried the utility.
    const res = await applyPatchChain(diff, dir);
    expect(res.ok).toBe(false);
    expect(res.method === "patch-p1" || res.method === "none").toBe(true);
  });

  it("rejects a non-diff payload with a clear error", async () => {
    const res = await applyPatchChain("I think we should add a new file called foo.", dir);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not a valid unified diff/);
  });

  it("rejects empty payload", async () => {
    const res = await applyPatchChain("   ", dir);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Empty diff/);
  });

  it("refuses path traversal in target", async () => {
    const diff = "--- /dev/null\n+++ b/../../../etc/evil\n@@ -0,0 +1 @@\n+bad\n";
    const res = await applyPatchChain(diff, dir);
    // The TS applier should catch the traversal; if it somehow doesn't, the
    // patch utility runs in workspace cwd and can't escape anyway.
    expect(res.ok).toBe(false);
    expect(existsSync("/etc/evil")).toBe(false);
  });
});
