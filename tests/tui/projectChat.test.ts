/**
 * Tests for per-project chat persistence (src/tui/projectChat.ts).
 */
import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listProjectThreads,
  loadProjectThread,
  saveProjectThread,
  createProjectThread,
  deleteProjectThread,
} from "../../src/tui/projectChat.js";
import type { ChatMessage } from "../../src/tui/chat.js";

describe("projectChat persistence", () => {
  let projectPath: string;
  beforeEach(() => {
    projectPath = mkdtempSync(join(tmpdir(), "sophron-project-chat-"));
  });

  it("lists, loads, and saves project threads", () => {
    expect(listProjectThreads(projectPath)).toEqual([]);

    const messages: ChatMessage[] = [
      { id: 1, role: "user", text: "hello" },
      { id: 2, role: "orchestrator", text: "hi" },
    ];
    const thread = createProjectThread(projectPath, messages);
    expect(thread.title).toBe("hello");

    const threads = listProjectThreads(projectPath);
    expect(threads).toHaveLength(1);
    expect(threads[0]!.id).toBe(thread.id);

    expect(loadProjectThread(projectPath, thread.id)).toEqual(messages);

    saveProjectThread(projectPath, thread.id, [...messages, { id: 3, role: "system", text: "feedback", color: "gray" }]);
    const reloaded = loadProjectThread(projectPath, thread.id);
    expect(reloaded).toHaveLength(2);
    expect(reloaded.some((m) => m.role === "system")).toBe(false);
  });

  it("deletes a thread", () => {
    const thread = createProjectThread(projectPath, [{ id: 1, role: "user", text: "x" }]);
    expect(listProjectThreads(projectPath)).toHaveLength(1);
    deleteProjectThread(projectPath, thread.id);
    expect(listProjectThreads(projectPath)).toEqual([]);
  });
});
