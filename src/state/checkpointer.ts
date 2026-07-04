/**
 * Checkpointer — immutable, append-only SQLite state log.
 *
 * Ported from V2's sophron_swarm/checkpointer.py. One row per state transition.
 * WAL mode for concurrent read during writes. All failures degrade to no-ops
 * (logged, never crash the loop) — matches V2's `_safe_checkpoint`.
 *
 * See docs/PHASE_0_DESIGN.md §8.
 */
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { log } from "../util/log.js";
import type { AgentRunState } from "../types.js";

export class Checkpointer {
  private db: Database.Database;

  constructor(dbPath = ".sophron/checkpoint.db") {
    try {
      mkdirSync(dirname(dbPath), { recursive: true });
    } catch {
      // dirname may be "." for a bare filename — ignore
    }
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS checkpoints (
        seq        INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id  TEXT    NOT NULL,
        run_id     TEXT    NOT NULL,
        state      TEXT    NOT NULL,
        ts         INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_checkpoints_thread
        ON checkpoints(thread_id, seq);
    `);
  }

  /** Append a state snapshot. Mutates `state.seq` and returns it. */
  save(state: AgentRunState): number {
    try {
      const info = this.db
        .prepare(
          "INSERT INTO checkpoints (thread_id, run_id, state, ts) VALUES (?, ?, ?, ?)",
        )
        .run(state.threadId, state.runId, JSON.stringify(state), Date.now());
      const seq = Number(info.lastInsertRowid);
      state.seq = seq;
      return seq;
    } catch (e) {
      log.warn({ err: e }, "checkpoint save failed — degrading to no-op");
      return -1;
    }
  }

  /** Latest checkpoint for a thread, or null. */
  loadLatest(threadId: string): AgentRunState | null {
    try {
      const row = this.db
        .prepare(
          "SELECT state FROM checkpoints WHERE thread_id = ? ORDER BY seq DESC LIMIT 1",
        )
        .get(threadId) as { state: string } | undefined;
      return row ? (JSON.parse(row.state) as AgentRunState) : null;
    } catch (e) {
      log.warn({ err: e }, "checkpoint loadLatest failed");
      return null;
    }
  }

  /** Exact snapshot at a sequence number (for rewind). */
  loadAt(seq: number): AgentRunState | null {
    try {
      const row = this.db
        .prepare("SELECT state FROM checkpoints WHERE seq = ?")
        .get(seq) as { state: string } | undefined;
      return row ? (JSON.parse(row.state) as AgentRunState) : null;
    } catch (e) {
      log.warn({ err: e }, "checkpoint loadAt failed");
      return null;
    }
  }

  /** All checkpoints for a thread, ascending (for replay/rewind menus). */
  loadThread(threadId: string): AgentRunState[] {
    try {
      const rows = this.db
        .prepare(
          "SELECT state FROM checkpoints WHERE thread_id = ? ORDER BY seq ASC",
        )
        .all(threadId) as { state: string }[];
      return rows.map((r) => JSON.parse(r.state) as AgentRunState);
    } catch (e) {
      log.warn({ err: e }, "checkpoint loadThread failed");
      return [];
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }
}
