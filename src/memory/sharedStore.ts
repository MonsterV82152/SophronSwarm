/**
 * Shared memory store — plain markdown files under `<workspace>/.sophron/shared/`.
 *
 * Three named files (decided in PROJECT_OVERVIEW.md §5.3):
 *   - OVERVIEW.md          — high-level goal, stack, constraints
 *   - CHECKPOINTS.md       — ordered list of milestones
 *   - CURRENT_CHECKPOINT.md — the single active milestone (drives orchestrator)
 *
 * No DB, no vector store. Files diff cleanly in git and are operator-editable.
 * Section-level reads/writes use the ## -section utilities.
 *
 * Auto-injected into every agent's system prompt via the prompt builder
 * (see loop.ts → PromptBuilder.build with a sharedMemory map).
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { log } from "../util/log.js";
import {
  appendToSection,
  findSection,
  parseMarkdown,
  serializeMarkdown,
  setSection,
} from "./sections.js";

export const SHARED_DIR_NAME = ".sophron/shared";

/** Canonical shared-memory file names. */
export const SHARED_FILES = {
  OVERVIEW: "OVERVIEW.md",
  CHECKPOINTS: "CHECKPOINTS.md",
  CURRENT_CHECKPOINT: "CURRENT_CHECKPOINT.md",
} as const;

export type SharedFileName = (typeof SHARED_FILES)[keyof typeof SHARED_FILES];

export class SharedMemoryStore {
  /** Absolute path to the `<workspace>/.sophron/shared/` directory. */
  readonly dir: string;

  constructor(sharedDir: string) {
    this.dir = sharedDir;
  }

  // ── File-level operations ────────────────────────────────────────────────

  /** Read a file's full contents. Returns "" if the file does not exist. */
  read(fileName: string): string {
    const abs = this.path(fileName);
    if (!existsSync(abs)) return "";
    return readFileSync(abs, "utf8");
  }

  /** Overwrite a file's contents (creating it and the directory). */
  write(fileName: string, content: string): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.path(fileName), content, "utf8");
    log.debug({ file: fileName, chars: content.length }, "shared memory written");
  }

  exists(fileName: string): boolean {
    return existsSync(this.path(fileName));
  }

  /** Absolute path for a file within the shared dir. */
  path(fileName: string): string {
    return join(this.dir, fileName);
  }

  /** List the `.md` files currently present in the shared dir. */
  listFiles(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir).filter((f) => f.endsWith(".md"));
  }

  // ── Section-level operations ─────────────────────────────────────────────

  /** Read a single section's body by title. "" if the file or section is absent. */
  readSection(fileName: string, sectionTitle: string): string {
    const doc = parseMarkdown(this.read(fileName));
    return findSection(doc, sectionTitle)?.body ?? "";
  }

  /** Replace a section's body (or create it). Preserves the rest of the file. */
  writeSection(fileName: string, sectionTitle: string, body: string): void {
    const doc = parseMarkdown(this.read(fileName));
    setSection(doc, sectionTitle, body);
    this.write(fileName, serializeMarkdown(doc));
  }

  /**
   * Append a line to a section's body (creates the section if missing).
   * Returns the new full body of the section.
   */
  appendToSection(fileName: string, sectionTitle: string, line: string): string {
    const doc = parseMarkdown(this.read(fileName));
    appendToSection(doc, sectionTitle, line);
    this.write(fileName, serializeMarkdown(doc));
    return findSection(doc, sectionTitle)?.body ?? "";
  }

  // ── Prompt injection ─────────────────────────────────────────────────────

  /**
   * Build a Map<title, body> of all non-empty shared files for prompt injection.
   * Keys are human-friendly titles derived from the file name; values are the
   * raw file contents. Only files that exist AND have non-whitespace content
   * are included (so an empty shared dir injects nothing).
   */
  toInjectionMap(): Map<string, string> {
    const map = new Map<string, string>();
    for (const file of this.listFiles()) {
      const body = this.read(file);
      if (!body.trim()) continue;
      const title = fileToTitle(file);
      map.set(title, body);
    }
    return map;
  }
}

/** Convert a shared-file name to a human-friendly injection title. */
export function fileToTitle(fileName: string): string {
  return basename(fileName, ".md")
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
