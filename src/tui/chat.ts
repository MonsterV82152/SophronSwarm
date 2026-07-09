/**
 * Global-orchestrator chat types + persistence.
 *
 * Chat threads are stored as JSON files under `~/.sophron/chats/` so operators
 * can maintain multiple project-planning conversations across TUI sessions.
 * Threads are **not** injected as agent memory — they're purely operator
 * convenience.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ChatMessage {
  id: number;
  role: "user" | "orchestrator" | "system";
  text: string;
  /** Optional Ink color for system-feedback messages. */
  color?: string;
}

export interface ChatThread {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

interface ThreadFile extends ChatThread {
  messages: ChatMessage[];
}

export function chatsDir(): string {
  return join(homedir(), ".sophron", "chats");
}

function threadPath(id: string): string {
  return join(chatsDir(), `${id}.json`);
}

function ensureDir(): void {
  mkdirSync(chatsDir(), { recursive: true });
}

/** Derive a human-readable title from the first user message. */
export function generateTitle(messages: ChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser) return "New chat";
  const line = firstUser.text.split("\n")[0] ?? "";
  const trimmed = line.trim().slice(0, 60);
  return trimmed || "New chat";
}

/** List saved threads, newest first. */
export function listThreads(): ChatThread[] {
  ensureDir();
  const dir = chatsDir();
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  const threads = files
    .map((f) => {
      try {
        const raw = readFileSync(join(dir, f), "utf8");
        const parsed = JSON.parse(raw) as ThreadFile;
        return {
          id: parsed.id,
          title: parsed.title,
          createdAt: parsed.createdAt,
          updatedAt: parsed.updatedAt,
        };
      } catch {
        return null;
      }
    })
    .filter((t): t is ChatThread => t != null);
  threads.sort((a, b) => b.updatedAt - a.updatedAt);
  return threads;
}

/** Load one thread's messages. */
export function loadThread(id: string): ChatMessage[] {
  try {
    const raw = readFileSync(threadPath(id), "utf8");
    const parsed = JSON.parse(raw) as ThreadFile;
    return parsed.messages ?? [];
  } catch {
    return [];
  }
}

/**
 * Persist a thread's messages (title and updatedAt are recomputed).
 * System-feedback messages are stripped before saving so threads only contain
 * operator + orchestrator turns.
 */
export function saveThread(id: string, messages: ChatMessage[]): ChatThread {
  ensureDir();
  let existing: ThreadFile | null = null;
  try {
    existing = JSON.parse(readFileSync(threadPath(id), "utf8")) as ThreadFile;
  } catch {
    existing = null;
  }
  const persisted = messages.filter((m) => m.role !== "system");
  const now = Date.now();
  const data: ThreadFile = {
    id,
    title: generateTitle(persisted),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    messages: persisted,
  };
  writeFileSync(threadPath(id), JSON.stringify(data, null, 2), "utf8");
  return { id: data.id, title: data.title, createdAt: data.createdAt, updatedAt: data.updatedAt };
}

/** Create a new thread on disk and return its metadata. */
export function createThread(initialMessages: ChatMessage[] = []): ChatThread {
  ensureDir();
  const id = randomUUID();
  const title = generateTitle(initialMessages);
  const now = Date.now();
  const data: ThreadFile = {
    id,
    title,
    createdAt: now,
    updatedAt: now,
    messages: initialMessages,
  };
  writeFileSync(threadPath(id), JSON.stringify(data, null, 2), "utf8");
  return { id, title, createdAt: now, updatedAt: now };
}

/** Delete a thread file. */
export function deleteThread(id: string): void {
  try {
    rmSync(threadPath(id));
  } catch {
    // ignore missing file
  }
}
