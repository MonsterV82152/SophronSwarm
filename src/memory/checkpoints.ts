/**
 * Checkpoint manager — advances the current project milestone in shared memory.
 *
 * The current checkpoint lives in shared memory as a file (CURRENT_CHECKPOINT.md),
 * NOT in checkpointer state — so it survives across sessions, is human-readable,
 * and version-controls naturally. The orchestrator advances it on completion
 * (an approvable action).
 *
 * Model:
 *   CHECKPOINTS.md         — ordered list of milestones (source of truth for order)
 *   CURRENT_CHECKPOINT.md  — the single active milestone
 *
 * Milestones in CHECKPOINTS.md are parsed from numbered list items:
 *   1. [ ] First milestone
 *   2. [ ] Second milestone
 *   - [x] Completed milestone
 *
 * See docs/PROJECT_OVERVIEW.md §5.3 and PHASE_3_DESIGN.md.
 */
import { log } from "../util/log.js";
import { SHARED_FILES, type SharedMemoryStore } from "./sharedStore.js";

export interface Milestone {
  /** 1-based index in the ordered list. */
  index: number;
  /** Raw milestone title text (without the checkbox marker). */
  title: string;
  /** Completion state parsed from the checkbox marker. */
  done: boolean;
}

export interface AdvanceResult {
  /** True if the checkpoint was advanced. */
  advanced: boolean;
  /** The milestone that is now current (or unchanged if not advanced). */
  current: Milestone | null;
  /** The milestone that was just completed (if advanced). */
  completed: Milestone | null;
  /** Reason when not advanced (e.g., already at last milestone). */
  reason?: string;
  /** All parsed milestones (for display). */
  milestones: Milestone[];
}

/** Parse numbered/bulleted list items with optional checkbox markers. */
const MILESTONE_RE = /^\s*(?:\d+\.|[-*])\s*\[( |x|X)\]\s*(.+?)\s*$/;

/** Parse CHECKPOINTS.md into an ordered list of milestones. */
export function parseCheckpoints(raw: string): Milestone[] {
  const out: Milestone[] = [];
  let i = 0;
  for (const line of raw.split("\n")) {
    const m = line.match(MILESTONE_RE);
    if (!m) continue;
    i++;
    out.push({
      index: i,
      title: m[2]!.trim(),
      done: m[1]!.toLowerCase() === "x",
    });
  }
  return out;
}

/** Serialize milestones back to a CHECKPOINTS.md body (preserving preamble). */
export function serializeCheckpoints(milestones: Milestone[], preamble: string): string {
  const parts: string[] = [];
  if (preamble.trim()) parts.push(preamble.trim());
  if (milestones.length > 0) {
    const lines = milestones.map((m) => `${m.index}. [${m.done ? "x" : " "}] ${m.title}`);
    parts.push(lines.join("\n"));
  }
  return parts.join("\n\n") + "\n";
}

/** Read the current checkpoint title from CURRENT_CHECKPOINT.md. "" if absent. */
export function readCurrentCheckpointTitle(store: SharedMemoryStore): string {
  const raw = store.read(SHARED_FILES.CURRENT_CHECKPOINT);
  // The body may be just the title text, or include a `# Current Checkpoint` header.
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    return t;
  }
  return raw.trim();
}

export class CheckpointManager {
  constructor(private store: SharedMemoryStore) {}

  /** Parse the current CHECKPOINTS.md into milestones. */
  list(): Milestone[] {
    return parseCheckpoints(this.store.read(SHARED_FILES.CHECKPOINTS));
  }

  /** Find the milestone whose title matches the current checkpoint. */
  current(): Milestone | null {
    const title = readCurrentCheckpointTitle(this.store);
    if (!title) return null;
    const lower = title.toLowerCase();
    return this.list().find((m) => m.title.toLowerCase() === lower) ?? null;
  }

  /**
   * Advance to the next milestone: mark the current complete and write the next
   * one into CURRENT_CHECKPOINT.md. No-op (returns advanced=false) if already
   * at the last milestone.
   */
  advance(): AdvanceResult {
    const milestones = this.list();
    if (milestones.length === 0) {
      return { advanced: false, current: null, completed: null, reason: "No milestones defined in CHECKPOINTS.md.", milestones };
    }

    // Resolve the current milestone WITHIN the same milestones array so mutation
    // (marking done) persists when we serialize back to disk.
    const curTitle = readCurrentCheckpointTitle(this.store);
    const curIdx = curTitle
      ? milestones.findIndex((m) => m.title.toLowerCase() === curTitle.toLowerCase())
      : -1;
    const cur = curIdx >= 0 ? milestones[curIdx]! : null;
    const searchFrom = cur ? cur.index : 0;
    const next = milestones.find((m) => m.index > searchFrom && !m.done) ?? null;

    if (!next) {
      const at = cur ? `"${cur.title}"` : "(none)";
      return {
        advanced: false,
        current: cur,
        completed: null,
        reason: `Already at or past the last milestone (current: ${at}). Nothing to advance to.`,
        milestones,
      };
    }

    // Mark the current (if any) complete and write the next as current.
    let completed: Milestone | null = null;
    if (cur) {
      cur.done = true;
      completed = cur;
    }
    // Rewrite CHECKPOINTS.md with the updated completion state.
    const docRaw = this.store.read(SHARED_FILES.CHECKPOINTS);
    const preamble = docRaw.split(/\n(?=\s*(?:\d+\.|[-*])\s*\[)/)[0] ?? "";
    this.store.write(SHARED_FILES.CHECKPOINTS, serializeCheckpoints(milestones, preamble));

    // Write the new current checkpoint.
    this.store.write(SHARED_FILES.CURRENT_CHECKPOINT, `# Current Checkpoint\n\n${next.title}\n`);

    log.info({ from: completed?.title ?? "(start)", to: next.title }, "checkpoint advanced");
    return { advanced: true, current: next, completed, milestones };
  }
}
