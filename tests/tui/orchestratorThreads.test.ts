/**
 * Tests for M19 orchestrator chat-thread persistence.
 *
 * Each test uses a fresh $HOME so real `~/.sophron/chats/` is never touched.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chatsDir,
  createThread,
  deleteThread,
  generateTitle,
  listThreads,
  loadThread,
  saveThread,
  type ChatMessage,
} from "../../src/tui/chat.js";

let originalHome: string | undefined;
let tempHome: string;

beforeEach(() => {
  originalHome = process.env["HOME"];
  tempHome = mkdtempSync(join(tmpdir(), "sophron-chat-"));
  process.env["HOME"] = tempHome;
});

afterEach(() => {
  process.env["HOME"] = originalHome;
  rmSync(tempHome, { recursive: true, force: true });
});

function makeMsg(overrides: Partial<ChatMessage> & { text: string; role: ChatMessage["role"] }): ChatMessage {
  return { id: 1, role: overrides.role, text: overrides.text, ...overrides };
}

describe("chatsDir", () => {
  it("resolves to ~/.sophron/chats under the current $HOME", () => {
    expect(chatsDir()).toBe(join(tempHome, ".sophron", "chats"));
  });
});

describe("generateTitle", () => {
  it("uses the first user message", () => {
    const messages: ChatMessage[] = [
      makeMsg({ id: 1, role: "system", text: "feedback" }),
      makeMsg({ id: 2, role: "user", text: "Plan the API for my new project" }),
    ];
    expect(generateTitle(messages)).toBe("Plan the API for my new project");
  });

  it("truncates long first lines", () => {
    const long = "a".repeat(100);
    expect(generateTitle([makeMsg({ id: 1, role: "user", text: long })])).toHaveLength(60);
  });

  it("falls back to New chat when there are no user messages", () => {
    expect(generateTitle([makeMsg({ id: 1, role: "orchestrator", text: "hello" })])).toBe("New chat");
    expect(generateTitle([])).toBe("New chat");
  });
});

describe("createThread", () => {
  it("creates an empty thread on disk", () => {
    const thread = createThread();
    expect(thread.title).toBe("New chat");
    expect(listThreads()).toHaveLength(1);
    expect(loadThread(thread.id)).toEqual([]);
  });

  it("can be created with initial messages", () => {
    const messages = [makeMsg({ id: 1, role: "user", text: "Seed message" })];
    const thread = createThread(messages);
    expect(thread.title).toBe("Seed message");
    expect(loadThread(thread.id)).toEqual(messages);
  });
});

describe("saveThread / loadThread", () => {
  it("persists user and orchestrator turns", () => {
    const thread = createThread();
    const messages: ChatMessage[] = [
      makeMsg({ id: 1, role: "user", text: "Hello" }),
      makeMsg({ id: 2, role: "orchestrator", text: "Hi" }),
    ];
    saveThread(thread.id, messages);
    expect(loadThread(thread.id)).toEqual(messages);
  });

  it("strips system messages before saving", () => {
    const thread = createThread();
    const messages: ChatMessage[] = [
      makeMsg({ id: 1, role: "user", text: "Hello" }),
      makeMsg({ id: 2, role: "system", text: "feedback", color: "gray" }),
    ];
    saveThread(thread.id, messages);
    expect(loadThread(thread.id)).toEqual([messages[0]]);
  });

  it("updates title and updatedAt", () => {
    const thread = createThread();
    const before = thread.updatedAt;
    const meta = saveThread(thread.id, [makeMsg({ id: 1, role: "user", text: "New topic" })]);
    expect(meta.title).toBe("New topic");
    expect(meta.updatedAt).toBeGreaterThanOrEqual(before);
  });

  it("returns threads newest first from listThreads", async () => {
    const t1 = createThread();
    await new Promise((r) => setTimeout(r, 10));
    const t2 = createThread();
    const list = listThreads();
    expect(list.map((t) => t.id)).toEqual([t2.id, t1.id]);
  });
});

describe("deleteThread", () => {
  it("removes the thread file", () => {
    const thread = createThread();
    expect(listThreads()).toHaveLength(1);
    deleteThread(thread.id);
    expect(listThreads()).toHaveLength(0);
    expect(loadThread(thread.id)).toEqual([]);
  });

  it("is a no-op for missing files", () => {
    expect(() => deleteThread("does-not-exist")).not.toThrow();
  });
});
