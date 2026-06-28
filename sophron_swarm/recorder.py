"""
Event Recorder – structured telemetry capture for the SophronSwarm debugger.

Records every LLM request/response, node transition, bitmask change, and
sandbox action as timestamped events.  Events are written to a JSONL file
in real-time so they can be replayed in the debug UI or inspected manually.

The recorder is a module-level singleton (``recorder``) so that any component
(LLM clients, graph, nodes) can record without explicit wiring.  All recording
is wrapped in try/except so telemetry never crashes the main pipeline.

Usage::

    from sophron_swarm.recorder import recorder

    recorder.start(thread_id="default", log_dir="./debug_runs")
    recorder.set_context(iteration=3, node="coder")
    recorder.record("llm_request", messages=[...])
    recorder.record("llm_response", raw="...")
    recorder.finish()
"""
from __future__ import annotations

import json
import os
import threading
from datetime import datetime
from pathlib import Path
from typing import Any, Optional


class _Recorder:
    """
    Thread-safe, singleton event recorder.

    Events accumulate in an in-memory list and are flushed to a JSONL file
    after every ``record()`` call so the debug server can read partial runs.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._events: list[dict[str, Any]] = []
        self._context: dict[str, Any] = {}
        self._log_path: Path | None = None
        self._started = False
        self.run_id: str | None = None
        self.thread_id: str | None = None

    # ── Lifecycle ────────────────────────────────────────────────────────────

    def start(
        self,
        thread_id: str = "default",
        log_dir: str = "./debug_runs",
    ) -> Path:
        """
        Begin a fresh recording session.

        Clears any previous events, creates a timestamped JSONL file, and
        writes a ``session_start`` event.  Returns the path to the log file.
        """
        with self._lock:
            self.run_id = datetime.now().strftime("%Y%m%d_%H%M%S")
            self.thread_id = thread_id
            self._events = []
            self._context = {}
            self._started = True

            log_path = Path(log_dir) / f"events_{self.run_id}.jsonl"
            log_path.parent.mkdir(parents=True, exist_ok=True)
            self._log_path = log_path

        self.record("session_start", thread_id=thread_id, run_id=self.run_id)
        return log_path

    def finish(self, final_state: dict[str, Any] | None = None) -> None:
        """Write a ``session_end`` event and close the session."""
        self.record("session_end", final_state=final_state or {})
        with self._lock:
            self._started = False

    @property
    def log_path(self) -> Path | None:
        return self._log_path

    @property
    def events(self) -> list[dict[str, Any]]:
        with self._lock:
            return list(self._events)

    # ── Context management ───────────────────────────────────────────────────

    def set_context(self, **kwargs: Any) -> None:
        """Update the context merged into every subsequent event."""
        with self._lock:
            self._context.update(kwargs)

    def clear_context_keys(self, *keys: str) -> None:
        """Remove specific keys from the active context."""
        with self._lock:
            for key in keys:
                self._context.pop(key, None)

    # ── Core recording ───────────────────────────────────────────────────────

    def record(self, event_type: str, **data: Any) -> None:
        """
        Record a single timestamped event.

        Never raises – if serialisation or file I/O fails the error is
        silently swallowed so telemetry can never break the pipeline.
        """
        try:
            with self._lock:
                event: dict[str, Any] = {
                    "timestamp": datetime.now().isoformat(timespec="microseconds"),
                    "seq": len(self._events),
                    "type": event_type,
                }
                # merge context (thread_id, iteration, node, etc.)
                event.update({k: v for k, v in self._context.items() if v is not None})
                event["data"] = data

                self._events.append(event)
                self._flush(event)
        except Exception:  # noqa: BLE001
            pass

    def _flush(self, event: dict[str, Any]) -> None:
        """Append a single event to the JSONL log file (called under lock)."""
        if self._log_path is None:
            return
        try:
            with open(self._log_path, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(event, default=str, ensure_ascii=False) + "\n")
        except Exception:  # noqa: BLE001
            pass

    # ── Helpers for common event shapes ──────────────────────────────────────

    def record_iteration(
        self,
        iteration: int,
        bitmask: int,
        node: str,
    ) -> None:
        """Convenience: record a graph-iteration-start event."""
        self.record(
            "iteration",
            iteration=iteration,
            bitmask=bitmask,
            bitmask_hex=f"0x{bitmask:04X}",
            node=node,
        )

    def record_llm_request(
        self,
        node: str,
        model: str,
        messages: list[dict[str, Any]],
    ) -> None:
        """Record the full message list sent to an LLM."""
        self.record(
            "llm_request",
            node=node,
            model=model,
            messages=messages,
            message_count=len(messages),
        )

    def record_llm_response(
        self,
        node: str,
        model: str,
        raw: str,
        parsed: dict[str, Any] | None = None,
    ) -> None:
        """Record the raw LLM response text and (optionally) the parsed dict."""
        self.record(
            "llm_response",
            node=node,
            model=model,
            raw=raw,
            raw_length=len(raw),
            parsed=parsed,
        )

    def record_node_enter(
        self,
        node: str,
        state_snapshot: dict[str, Any],
    ) -> None:
        """Record the state snapshot before a node executes."""
        self.record(
            "node_enter",
            node=node,
            state=state_snapshot,
        )

    def record_node_exit(
        self,
        node: str,
        state_before: dict[str, Any],
        state_after: dict[str, Any],
    ) -> None:
        """Record state before and after a node runs, plus a diff of key fields."""
        diff = self._state_diff(state_before, state_after)
        self.record(
            "node_exit",
            node=node,
            state_before=state_before,
            state_after=state_after,
            diff=diff,
        )

    def record_sandbox(
        self,
        action: int,
        lang: str,
        result: dict[str, Any],
    ) -> None:
        """Record a sandbox execution result."""
        self.record(
            "sandbox_dispatch",
            action=action,
            action_hex=f"0x{action:X}",
            lang=lang,
            result=result,
        )

    # ── Internals ────────────────────────────────────────────────────────────

    @staticmethod
    def _state_diff(before: dict[str, Any], after: dict[str, Any]) -> dict[str, Any]:
        """Compute changed/added/removed keys between two state snapshots."""
        diff: dict[str, Any] = {"changed": {}, "added": {}, "removed": {}}
        all_keys = set(before) | set(after)
        for key in sorted(all_keys):
            old_val = before.get(key)
            new_val = after.get(key)
            if key not in before:
                diff["added"][key] = new_val
            elif key not in after:
                diff["removed"][key] = old_val
            elif old_val != new_val:
                diff["changed"][key] = {"before": old_val, "after": new_val}
        return diff


# Module-level singleton
recorder = _Recorder()


def serialize_state(state: Any) -> dict[str, Any]:
    """
    Serialise a SwarmState (pydantic model) into a JSON-friendly dict suitable
    for the recorder and debug UI.  Returns ``{}`` if serialisation fails.
    """
    try:
        if hasattr(state, "model_dump"):
            return state.model_dump()
        if isinstance(state, dict):
            return dict(state)
        return {"repr": repr(state)}
    except Exception:  # noqa: BLE001
        return {}
