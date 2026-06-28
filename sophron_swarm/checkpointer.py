"""
SQLite-backed append-only transaction log checkpointer (spec §2).

Each state transition is persisted as an immutable row, enabling granular
rollback to any prior SwarmState snapshot for thread recovery or debugging.

The log is strictly append-only: rows are never modified or deleted, providing
a complete immutable audit trail of every agent-driven state transition.
"""
from __future__ import annotations

import sqlite3
import threading
from datetime import datetime, timezone
from typing import Optional

from sophron_swarm.state import SwarmState


_DDL = """
CREATE TABLE IF NOT EXISTS checkpoints (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id  TEXT    NOT NULL,
    timestamp  TEXT    NOT NULL,
    bitmask    INTEGER NOT NULL,
    state_json TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_thread_seq ON checkpoints (thread_id, seq);
"""


class Checkpointer:
    """
    Lightweight, thread-safe SQLite checkpointer.

    Uses one connection per thread via threading.local() to avoid contention.
    WAL journal mode is enabled for concurrent read performance.

    Parameters
    ----------
    db_path:
        SQLite database file path.  Use ":memory:" (default) for an in-process
        store, or provide an absolute path for persistence across restarts.
    """

    def __init__(self, db_path: str = ":memory:") -> None:
        self._db_path = db_path
        self._local = threading.local()
        self._init_error: str | None = None
        try:
            self._init_schema()
        except sqlite3.Error as exc:
            # Don't crash the entire application if the DB is unavailable;
            # save/load will gracefully degrade to no-ops.
            import logging
            logging.getLogger(__name__).warning(
                "Checkpointer init failed (%s) – running without persistence.", exc
            )
            self._init_error = str(exc)

    # ── Connection pool (one connection per thread) ───────────────────────────

    @property
    def _conn(self) -> sqlite3.Connection:
        if not getattr(self._local, "conn", None):
            conn = sqlite3.connect(self._db_path, check_same_thread=False)
            conn.execute("PRAGMA journal_mode=WAL;")
            conn.execute("PRAGMA synchronous=NORMAL;")
            self._local.conn = conn
        return self._local.conn

    def _init_schema(self) -> None:
        self._conn.executescript(_DDL)
        self._conn.commit()

    # ── Public API ────────────────────────────────────────────────────────────

    def save(self, thread_id: str, state: SwarmState) -> Optional[int]:
        """
        Append a new checkpoint row.

        Returns the auto-assigned sequence number, or None if the save failed
        (errors are logged but never raised, so checkpoint failures cannot
        crash the graph loop).
        """
        if self._init_error:
            return None
        try:
            cur = self._conn.execute(
                "INSERT INTO checkpoints(thread_id, timestamp, bitmask, state_json) "
                "VALUES (?, ?, ?, ?)",
                (
                    thread_id,
                    datetime.now(timezone.utc).isoformat(),
                    state.bitmask,
                    state.model_dump_json(),
                ),
            )
            self._conn.commit()
            return cur.lastrowid  # type: ignore[return-value]
        except sqlite3.Error as exc:
            import logging
            logging.getLogger(__name__).warning(
                "Checkpoint save failed: %s", exc
            )
            return None

    def load_latest(self, thread_id: str) -> Optional[SwarmState]:
        """Return the most recent SwarmState for this thread, or None."""
        if self._init_error:
            return None
        try:
            row = self._conn.execute(
                "SELECT state_json FROM checkpoints "
                "WHERE thread_id = ? ORDER BY seq DESC LIMIT 1",
                (thread_id,),
            ).fetchone()
            return SwarmState.model_validate_json(row[0]) if row else None
        except (sqlite3.Error, Exception) as exc:
            import logging
            logging.getLogger(__name__).warning(
                "load_latest failed: %s", exc
            )
            return None

    def load_at(self, thread_id: str, seq: int) -> Optional[SwarmState]:
        """Return the SwarmState at a specific sequence number (rollback)."""
        if self._init_error:
            return None
        try:
            row = self._conn.execute(
                "SELECT state_json FROM checkpoints WHERE thread_id = ? AND seq = ?",
                (thread_id, seq),
            ).fetchone()
            return SwarmState.model_validate_json(row[0]) if row else None
        except (sqlite3.Error, Exception) as exc:
            import logging
            logging.getLogger(__name__).warning(
                "load_at failed: %s", exc
            )
            return None

    def list_checkpoints(self, thread_id: str) -> list[dict]:
        """Return metadata for all checkpoints in a thread (no state JSON)."""
        rows = self._conn.execute(
            "SELECT seq, timestamp, bitmask FROM checkpoints "
            "WHERE thread_id = ? ORDER BY seq",
            (thread_id,),
        ).fetchall()
        return [
            {"seq": r[0], "timestamp": r[1], "bitmask": f"0x{r[2]:04X}"}
            for r in rows
        ]
