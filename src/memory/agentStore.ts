/**
 * Per-agent memory store — `<memory_root>/<agent_id>/MEMORY.md`.
 *
 * Structured sections (decided in PROJECT_OVERVIEW.md §5.2):
 *   - Past Points of Failure — what broke and the fix.
 *   - Past Encountered Issues — gotchas, env quirks, non-obvious behavior.
 *   - Key Points — architecture decisions, library locations, conventions.
 *
 * The first ~200 lines are auto-injected into the agent's system prompt.
 * Writes happen via the `remember` tool (agent calls deliberately — never
 * auto-dumped). Quality-gated (minimum length + exact-duplicate dedup).
 *
 * Embedding-based dedup is deferred (Phase 3.5) — only when volume justifies.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { log } from "../util/log.js";
import {
  appendToSection,
  findSection,
  normalizeForDedup,
  parseMarkdown,
  sectionHasNote,
  serializeMarkdown,
} from "./sections.js";

export const AGENT_MEMORY_DIR_NAME = ".sophron/memory";

/** Canonical section names for per-agent MEMORY.md. */
export const AGENT_MEMORY_SECTIONS = {
  FAILURES: "Past Points of Failure",
  ISSUES: "Past Encountered Issues",
  KEY_POINTS: "Key Points",
} as const;

export type AgentMemorySection = (typeof AGENT_MEMORY_SECTIONS)[keyof typeof AGENT_MEMORY_SECTIONS];

/** Default number of lines auto-injected into the system prompt. */
export const DEFAULT_INJECTION_LINES = 200;

/** Minimum note length (normalized) to pass the quality gate. */
export const MIN_NOTE_LENGTH = 10;

export interface AppendResult {
  /** True if the note was appended; false if rejected by the quality gate. */
  appended: boolean;
  /** Why the note was rejected (only set when appended === false). */
  reason?: string;
  /** The section the note targeted. */
  section: string;
  /** The full body of the section after the append attempt. */
  body: string;
}

export class AgentMemoryStore {
  /** Absolute path to the `<workspace>/.sophron/memory/` directory. */
  readonly root: string;

  constructor(memoryRoot: string) {
    this.root = memoryRoot;
  }

  // ── Path helpers ──────────────────────────────────────────────────────────

  /** Absolute path to an agent's MEMORY.md. */
  path(agentId: string): string {
    return join(this.root, agentId, "MEMORY.md");
  }

  /** Directory holding an agent's MEMORY.md (and future per-agent artifacts). */
  dir(agentId: string): string {
    return join(this.root, agentId);
  }

  // ── Full-file operations ──────────────────────────────────────────────────

  /** Read an agent's full MEMORY.md. Returns "" if it does not exist. */
  read(agentId: string): string {
    const abs = this.path(agentId);
    if (!existsSync(abs)) return "";
    return readFileSync(abs, "utf8");
  }

  /** Overwrite an agent's MEMORY.md (creating the directory). */
  write(agentId: string, content: string): void {
    mkdirSync(this.dir(agentId), { recursive: true });
    writeFileSync(this.path(agentId), content, "utf8");
    log.debug({ agent: agentId, chars: content.length }, "agent memory written");
  }

  /**
   * Read the first `maxLines` lines of an agent's MEMORY.md for prompt injection.
   * Returns "" if the file is absent or empty. `maxLines` defaults to 200.
   */
  readForInjection(agentId: string, maxLines: number = DEFAULT_INJECTION_LINES): string {
    const raw = this.read(agentId);
    if (!raw.trim()) return "";
    return raw.split("\n").slice(0, maxLines).join("\n");
  }

  // ── Section-level operations ──────────────────────────────────────────────

  /** Read a single section's body. "" if the file or section is absent. */
  readSection(agentId: string, sectionTitle: string): string {
    const doc = parseMarkdown(this.read(agentId));
    return findSection(doc, sectionTitle)?.body ?? "";
  }

  /**
   * Append a note to a section, with quality gating + dedup.
   *
   * Quality gate: the normalized note must be at least MIN_NOTE_LENGTH chars.
   * Dedup: if `dedup` is true (default), a note whose normalized form already
   * appears in the section is rejected rather than re-added.
   *
   * Entries are stored as timestamped bullets: `- [YYYY-MM-DD] note`.
   */
  append(
    agentId: string,
    sectionTitle: string,
    note: string,
    opts: { dedup?: boolean; date?: string } = {},
  ): AppendResult {
    const dedup = opts.dedup ?? true;
    const norm = normalizeForDedup(note);

    // Quality gate: reject empty / trivially short notes.
    if (norm.length < MIN_NOTE_LENGTH) {
      return {
        appended: false,
        reason: `Note too short (min ${MIN_NOTE_LENGTH} meaningful chars after normalization).`,
        section: sectionTitle,
        body: this.readSection(agentId, sectionTitle),
      };
    }

    const doc = parseMarkdown(this.read(agentId));
    const existing = findSection(doc, sectionTitle);

    // Dedup gate.
    if (dedup && existing && sectionHasNote(existing, note)) {
      return {
        appended: false,
        reason: "Note already exists in this section (duplicate).",
        section: sectionTitle,
        body: existing.body,
      };
    }

    const date = opts.date ?? new Date().toISOString().slice(0, 10);
    const line = `- [${date}] ${note.trim()}`;
    appendToSection(doc, sectionTitle, line);
    this.write(agentId, serializeMarkdown(doc));

    const body = findSection(doc, sectionTitle)?.body ?? "";
    return { appended: true, section: sectionTitle, body };
  }
}
