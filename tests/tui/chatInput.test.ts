import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wordAt, resolveAttachments } from "../../src/tui/components/ChatInput.js";

describe("ChatInput — wordAt", () => {
  it("finds the word at the cursor", () => {
    const r = wordAt("hello world", 5);
    expect(r.word).toBe("hello");
    expect(r.start).toBe(0);
    expect(r.end).toBe(5);
  });

  it("detects @ trigger", () => {
    const r = wordAt("impl @src/app.ts", 10);
    expect(r.word).toBe("@src/app.ts");
    expect(r.trigger).toBe("@");
  });

  it("detects / trigger", () => {
    const r = wordAt("/sto", 4);
    expect(r.word).toBe("/sto");
    expect(r.trigger).toBe("/");
  });

  it("returns null trigger for plain words", () => {
    const r = wordAt("hello", 3);
    expect(r.trigger).toBeNull();
  });
});

describe("ChatInput — resolveAttachments", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sophron-chatinput-"));
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src/app.ts"), "export const x = 1;");
    writeFileSync(join(dir, "readme.md"), "# README");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads attached files", () => {
    const attachments = resolveAttachments("check @readme.md", dir);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]!.path).toBe("readme.md");
    expect(attachments[0]!.content).toContain("# README");
  });

  it("reads multiple attachments", () => {
    const attachments = resolveAttachments("look at @readme.md and @src/app.ts", dir);
    expect(attachments).toHaveLength(2);
    expect(attachments.map((a) => a.path)).toContain("readme.md");
    expect(attachments.map((a) => a.path)).toContain("src/app.ts");
  });

  it("ignores duplicate mentions", () => {
    const attachments = resolveAttachments("@readme.md @readme.md", dir);
    expect(attachments).toHaveLength(1);
  });

  it("ignores path-traversal mentions", () => {
    const attachments = resolveAttachments("@../../../etc/passwd", dir);
    expect(attachments).toHaveLength(0);
  });

  it("truncates files over 1000 lines", () => {
    const longContent = Array.from({ length: 1200 }, (_, i) => `line ${i}`).join("\n");
    writeFileSync(join(dir, "long.txt"), longContent);
    const attachments = resolveAttachments("@long.txt", dir);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]!.content).toContain("[…file truncated at 1000 lines…]");
  });
});
