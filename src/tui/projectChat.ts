/**
 * Per-project agent chat persistence.
 *
 * Each project can have one or more chat threads with its per-project
 * orchestrator (and potentially other agents). Threads live under
 * `<project>/.sophron/chats/` so they stay with the project while remaining
 * separate from agent/project memory stores.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ChatMessage, type ChatThread, generateTitle } from "./chat.js";

interface ThreadFile extends ChatThread {
  messages: ChatMessage[];
}

export function projectChatsDir(projectPath: string): string {
  return join(projectPath, ".sophron", "chats");
}

function threadPath(projectPath: string, id: string): string {
  return join(projectChatsDir(projectPath), `${id}.json`);
}

function ensureDir(projectPath: string): void {
  mkdirSync(projectChatsDir(projectPath), { recursive: true });
}

/** List saved threads for a project, newest first. */
export function listProjectThreads(projectPath: string): ChatThread[] {
  ensureDir(projectPath);
  const dir = projectChatsDir(projectPath);
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

/** Load one project thread's messages. */
export function loadProjectThread(projectPath: string, id: string): ChatMessage[] {
  try {
    const raw = readFileSync(threadPath(projectPath, id), "utf8");
    const parsed = JSON.parse(raw) as ThreadFile;
    return parsed.messages ?? [];
  } catch {
    return [];
  }
}

/**
 * Persist a project thread's messages.
 * System-feedback messages are stripped before saving.
 */
export function saveProjectThread(projectPath: string, id: string, messages: ChatMessage[]): ChatThread {
  ensureDir(projectPath);
  let existing: ThreadFile | null = null;
  try {
    existing = JSON.parse(readFileSync(threadPath(projectPath, id), "utf8")) as ThreadFile;
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
  writeFileSync(threadPath(projectPath, id), JSON.stringify(data, null, 2), "utf8");
  return { id: data.id, title: data.title, createdAt: data.createdAt, updatedAt: data.updatedAt };
}

/** Create a new project thread on disk and return its metadata. */
export function createProjectThread(projectPath: string, initialMessages: ChatMessage[] = []): ChatThread {
  ensureDir(projectPath);
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
  writeFileSync(threadPath(projectPath, id), JSON.stringify(data, null, 2), "utf8");
  return { id, title, createdAt: now, updatedAt: now };
}

/** Delete a project thread file. */
export function deleteProjectThread(projectPath: string, id: string): void {
  try {
    rmSync(threadPath(projectPath, id));
  } catch {
    // ignore missing file
  }
}
