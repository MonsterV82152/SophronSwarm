/**
 * Agent draft store — the one-time agent-creation approval ledger.
 *
 * When the Architect proposes new agents (via the `propose_agent` tool), the
 * drafts land in `<workspace>/.sophron/agents.draft/<name>.md` (a staging dir
 * the registry does NOT scan) and are recorded in `.sophron/agents.json`.
 *
 * Drafts CANNOT execute (the registry only scans `agents/`). Promotion
 * (`.draft/` → `agents/`) is operator-initiated — there is NO auto-approval path.
 * Once all drafts are approved/rejected, bootstrap creation CLOSES for the project.
 *
 * See docs/PROJECT_OVERVIEW.md §5.1 / §7.1 and PHASE_6_DESIGN.md §3.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { log } from "../util/log.js";

export const DRAFT_DIR_NAME = ".sophron/agents.draft";
export const LEDGER_FILENAME = "agents.json";

export type DraftStatus = "draft" | "approved" | "rejected";

export interface DraftEntry {
  name: string;
  status: DraftStatus;
  /** ISO timestamp of when the draft was created. */
  createdAt: string;
  /** ISO timestamp of when it was resolved (approved/rejected), if any. */
  resolvedAt?: string;
}

export interface DraftLedger {
  entries: DraftEntry[];
  /** True once every draft has been resolved (approved/rejected) → creation closes. */
  bootstrapClosed: boolean;
}

/** A single agent draft within a batch roster proposal (M6). */
export interface RosterDraft {
  name: string;
  /** Full serialized `.md` content (frontmatter + body). */
  content: string;
}

export class AgentDraftStore {
  /** Workspace root. */
  readonly workspaceDir: string;
  readonly draftDir: string;
  readonly ledgerPath: string;

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
    this.draftDir = join(workspaceDir, DRAFT_DIR_NAME);
    this.ledgerPath = join(workspaceDir, ".sophron", LEDGER_FILENAME);
  }

  // ── Ledger ──────────────────────────────────────────────────────────────

  /** Read the ledger (or an empty one if absent). */
  readLedger(): DraftLedger {
    if (!existsSync(this.ledgerPath)) return { entries: [], bootstrapClosed: false };
    try {
      const raw = readFileSync(this.ledgerPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<DraftLedger>;
      return {
        entries: Array.isArray(parsed.entries) ? parsed.entries : [],
        bootstrapClosed: parsed.bootstrapClosed === true,
      };
    } catch (e) {
      log.warn({ err: (e as Error).message }, "could not read agent draft ledger");
      return { entries: [], bootstrapClosed: false };
    }
  }

  private writeLedger(ledger: DraftLedger): void {
    mkdirSync(join(this.workspaceDir, ".sophron"), { recursive: true });
    writeFileSync(this.ledgerPath, JSON.stringify(ledger, null, 2), "utf8");
  }

  /** Has the one-time bootstrap creation been closed? */
  isBootstrapClosed(): boolean {
    return this.readLedger().bootstrapClosed;
  }

  // ── Draft lifecycle ─────────────────────────────────────────────────────

  /**
   * Write a draft agent definition + record it in the ledger.
   * Refuses if bootstrap creation is closed.
   * Returns the draft's status ("draft") or throws.
   */
  writeDraft(name: string, content: string): DraftEntry {
    const ledger = this.readLedger();
    // Check the existing-entry status BEFORE the closed check — re-drafting a
    // resolved agent is always an error, regardless of bootstrap state.
    const existing = ledger.entries.find((e) => e.name === name);
    if (existing && existing.status !== "draft") {
      throw new Error(`Agent '${name}' was already ${existing.status}. Cannot re-draft.`);
    }
    if (ledger.bootstrapClosed) {
      throw new Error("Agent creation is closed for this project (bootstrap complete). Re-open approval to add new agent types.");
    }

    mkdirSync(this.draftDir, { recursive: true });
    writeFileSync(join(this.draftDir, `${name}.md`), content, "utf8");

    const entry: DraftEntry = { name, status: "draft", createdAt: new Date().toISOString() };
    if (!existing) {
      ledger.entries.push(entry);
    } else {
      existing.createdAt = entry.createdAt;
    }
    this.writeLedger(ledger);
    log.info({ name }, "agent draft written");
    return entry;
  }

  /**
   * Promote a draft to live: move `.draft/<name>.md` → `agents/<name>.md`.
   * The registry hot-reloads it. Returns the new status ("approved") or throws.
   */
  approve(name: string): DraftEntry {
    return this.resolve(name, "approved", () => {
      const draftFile = join(this.draftDir, `${name}.md`);
      if (!existsSync(draftFile)) throw new Error(`No draft file for '${name}'`);
      const liveDir = join(this.workspaceDir, "agents");
      mkdirSync(liveDir, { recursive: true });
      renameSync(draftFile, join(liveDir, `${name}.md`));
    });
  }

  /** Reject a draft: delete the draft file (never promoted). */
  reject(name: string): DraftEntry {
    return this.resolve(name, "rejected", () => {
      const draftFile = join(this.draftDir, `${name}.md`);
      if (existsSync(draftFile)) rmSync(draftFile, { force: true });
    });
  }

  // ── Batched roster (M6) ─────────────────────────────────────────────────
  //
  // `propose_roster` drafts N agents in ONE pass; one operator approval gate
  // covers the whole batch. `writeRoster` is transactional — it validates every
  // entry BEFORE writing anything, so a roster either lands in full or not at
  // all (no half-applied batches).

  /**
   * Write a batch of draft agents + record them in the ledger in ONE pass.
   * Transactional: validates every entry first; if any fails, writes NOTHING.
   * Returns the names drafted. Throws on validation failure.
   */
  writeRoster(drafts: RosterDraft[]): DraftEntry[] {
    if (drafts.length === 0) throw new Error("writeRoster requires at least one draft");

    const ledger = this.readLedger();

    // Validate ALL entries before touching the filesystem (all-or-nothing).
    // Check each entry's resolved status BEFORE the closed check — re-drafting
    // a resolved agent is always an error, regardless of bootstrap state
    // (matches writeDraft's ordering + comment above).
    const seen = new Set<string>();
    for (const d of drafts) {
      if (typeof d.name !== "string" || !d.name.trim()) throw new Error(`Roster entry has a missing or empty name`);
      const name = d.name.trim();
      if (seen.has(name)) throw new Error(`Duplicate name in roster: '${name}'`);
      seen.add(name);
      const existing = ledger.entries.find((e) => e.name === name);
      if (existing && existing.status !== "draft") {
        throw new Error(`Agent '${name}' was already ${existing.status}. Cannot re-draft.`);
      }
    }
    if (ledger.bootstrapClosed) {
      throw new Error("Agent creation is closed for this project (bootstrap complete). Re-open approval to add new agent types.");
    }

    // All validated — now write the files + update the ledger.
    mkdirSync(this.draftDir, { recursive: true });
    const now = new Date().toISOString();
    for (const d of drafts) {
      const name = d.name.trim();
      writeFileSync(join(this.draftDir, `${name}.md`), d.content, "utf8");
    }
    for (const d of drafts) {
      const name = d.name.trim();
      const existing = ledger.entries.find((e) => e.name === name);
      if (!existing) {
        ledger.entries.push({ name, status: "draft", createdAt: now });
      } else {
        existing.createdAt = now;
      }
    }
    this.writeLedger(ledger);
    log.info({ count: drafts.length, names: drafts.map((d) => d.name.trim()) }, "agent roster drafted");
    return drafts.map((d) => ledger.entries.find((e) => e.name === d.name.trim())!);
  }

  /**
   * Approve a batch of drafts by name in ONE ledger write. The draft files are
   * promoted to `agents/` (hot-reload picks them up). Unknown or already-resolved
   * names throw. Returns the resolved entries.
   */
  approveMany(names: string[]): DraftEntry[] {
    return this.resolveMany(names, "approved", (name) => {
      const draftFile = join(this.draftDir, `${name}.md`);
      if (!existsSync(draftFile)) throw new Error(`No draft file for '${name}'`);
      const liveDir = join(this.workspaceDir, "agents");
      mkdirSync(liveDir, { recursive: true });
      renameSync(draftFile, join(liveDir, `${name}.md`));
    });
  }

  /** Reject a batch of drafts by name (delete their draft files). */
  rejectMany(names: string[]): DraftEntry[] {
    return this.resolveMany(names, "rejected", (name) => {
      const draftFile = join(this.draftDir, `${name}.md`);
      if (existsSync(draftFile)) rmSync(draftFile, { force: true });
    });
  }

  /** Approve ALL currently-pending drafts. No-op (returns []) if there are none. */
  approveAll(): DraftEntry[] {
    const pending = this.pendingDrafts().map((e) => e.name);
    if (pending.length === 0) return [];
    return this.approveMany(pending);
  }

  /** Reject ALL currently-pending drafts. No-op (returns []) if there are none. */
  rejectAll(): DraftEntry[] {
    const pending = this.pendingDrafts().map((e) => e.name);
    if (pending.length === 0) return [];
    return this.rejectMany(pending);
  }

  /** Common single resolve logic: update the ledger, close bootstrap if all resolved. */
  private resolve(name: string, status: "approved" | "rejected", mutate: () => void): DraftEntry {
    const ledger = this.readLedger();
    const entry = ledger.entries.find((e) => e.name === name);
    if (!entry) throw new Error(`No draft named '${name}'`);
    if (entry.status !== "draft") throw new Error(`'${name}' is already ${entry.status}`);

    mutate();
    entry.status = status;
    entry.resolvedAt = new Date().toISOString();

    // Close bootstrap if every entry is now resolved.
    if (ledger.entries.every((e) => e.status !== "draft")) {
      ledger.bootstrapClosed = true;
    }
    this.writeLedger(ledger);
    log.info({ name, status, bootstrapClosed: ledger.bootstrapClosed }, "agent draft resolved");
    return entry;
  }

  /**
   * Common batch resolve logic: validate ALL names first (so a partially-bad
   * batch fails atomically — no partial promotions), then mutate + update the
   * ledger in ONE write. `mutate(name)` performs the per-name filesystem change
   * (rename for approve, rm for reject) and may throw.
   */
  private resolveMany(names: string[], status: "approved" | "rejected", mutate: (name: string) => void): DraftEntry[] {
    if (names.length === 0) return [];
    const ledger = this.readLedger();

    // Validate ALL names before any mutation (atomicity).
    const entries: DraftEntry[] = [];
    for (const name of names) {
      const entry = ledger.entries.find((e) => e.name === name);
      if (!entry) throw new Error(`No draft named '${name}'`);
      if (entry.status !== "draft") throw new Error(`'${name}' is already ${entry.status}`);
      entries.push(entry);
    }

    // All valid — perform the filesystem mutations.
    for (const name of names) mutate(name);

    // Update ledger in one pass.
    const now = new Date().toISOString();
    for (const entry of entries) {
      entry.status = status;
      entry.resolvedAt = now;
    }
    if (ledger.entries.every((e) => e.status !== "draft")) {
      ledger.bootstrapClosed = true;
    }
    this.writeLedger(ledger);
    log.info({ names, status, bootstrapClosed: ledger.bootstrapClosed }, "agent roster batch resolved");
    return entries;
  }

  // ── Inspection ──────────────────────────────────────────────────────────

  /** All drafts currently awaiting approval. */
  pendingDrafts(): DraftEntry[] {
    return this.readLedger().entries.filter((e) => e.status === "draft");
  }

  /** Draft files on disk (names without extension). */
  draftFiles(): string[] {
    if (!existsSync(this.draftDir)) return [];
    return readdirSync(this.draftDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, ""));
  }

  /**
   * Re-open bootstrap creation (operator action). Allows adding new agent types
   * after the roster was closed. Existing approved agents are unaffected.
   */
  reopenBootstrap(): void {
    const ledger = this.readLedger();
    ledger.bootstrapClosed = false;
    this.writeLedger(ledger);
    log.info("bootstrap creation re-opened");
  }
}
