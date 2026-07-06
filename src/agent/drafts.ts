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

  /** Common resolve logic: update the ledger, close bootstrap if all resolved. */
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
