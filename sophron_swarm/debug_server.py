"""
Debug Server – serves recorded events and the replay UI over HTTP.

Uses Python's built-in ``http.server`` so no extra dependencies are required.
Start it in a background thread alongside the main SophronSwarm run, or run it
standalone to replay a previous session.

Usage (standalone)::

    python -m sophron_swarm.debug_server                        # latest run
    python -m sophron_swarm.debug_server ./debug_runs/events_20260627_123456.jsonl
    python -m sophron_swarm.debug_server --port 8080

From Python::

    from sophron_swarm.debug_server import start_debug_server
    start_debug_server(port=8877)          # background thread, returns immediately
"""
from __future__ import annotations

import json
import os
import sys
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse, parse_qs

# Resolve the UI directory relative to this file
_UI_DIR = Path(__file__).parent / "debug_ui"
_INDEX_HTML = _UI_DIR / "index.html"


# --------------------------------------------------------------------------- #
# Event loading
# --------------------------------------------------------------------------- #
def _load_events(log_path: Path) -> list[dict]:
    """Load all events from a JSONL log file."""
    events: list[dict] = []
    if not log_path.exists():
        return events
    try:
        with open(log_path, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line:
                    try:
                        events.append(json.loads(line))
                    except json.JSONDecodeError:
                        pass
    except OSError:
        pass
    return events


def _latest_log(log_dir: str = "./debug_runs") -> Optional[Path]:
    """Find the most recently modified events_*.jsonl file."""
    log_dir_path = Path(log_dir)
    if not log_dir_path.exists():
        return None
    logs = sorted(log_dir_path.glob("events_*.jsonl"), key=lambda p: p.stat().st_mtime)
    return logs[-1] if logs else None


# --------------------------------------------------------------------------- #
# HTTP handler
# --------------------------------------------------------------------------- #
class DebugHandler(BaseHTTPRequestHandler):
    """HTTP request handler serving the replay UI and event data."""

    # The active log file is set by the server factory below.
    _log_path: Optional[Path] = None

    def log_message(self, format: str, *args) -> None:  # noqa: A002, A003
        """Suppress default request logging to keep the console clean."""
        pass

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)

        if parsed.path == "/" or parsed.path == "/index.html":
            self._serve_html()
        elif parsed.path == "/api/events":
            self._serve_events(parsed)
        elif parsed.path == "/api/runs":
            self._serve_runs()
        elif parsed.path == "/api/load":
            self._serve_load_file(parse_qs(parsed.query))
        else:
            self.send_error(404, "Not Found")

    # ── Route handlers ───────────────────────────────────────────────────────

    def _serve_html(self) -> None:
        try:
            html = _INDEX_HTML.read_text(encoding="utf-8")
            self._respond(200, "text/html; charset=utf-8", html.encode("utf-8"))
        except FileNotFoundError:
            self.send_error(404, "UI file not found at " + str(_INDEX_HTML))

    def _serve_events(self, parsed) -> None:
        """Serve events from the active log file, optionally after a cursor."""
        params = parse_qs(parsed.query)
        since = int(params.get("since", ["-1"])[0])

        log_path = self._log_path or _latest_log()
        events = _load_events(log_path) if log_path else []

        # Filter to events after the cursor (for live polling)
        if since >= 0:
            events = [e for e in events if e.get("seq", -1) > since]

        log_name = log_path.name if log_path else None
        payload = json.dumps({
            "log_file": log_name,
            "total_events": len(events),
            "events": events,
        }, ensure_ascii=False)

        self._respond(200, "application/json", payload.encode("utf-8"))

    def _serve_runs(self) -> None:
        """List all available run logs for selection in the UI."""
        log_dir = Path("./debug_runs")
        runs = []
        if log_dir.exists():
            for log in sorted(log_dir.glob("events_*.jsonl"), reverse=True):
                runs.append({
                    "file": log.name,
                    "size": log.stat().st_size,
                    "modified": log.stat().st_mtime,
                })
        payload = json.dumps({"runs": runs}, ensure_ascii=False)
        self._respond(200, "application/json", payload.encode("utf-8"))

    def _serve_load_file(self, params: dict) -> None:
        """Switch the active log file."""
        file_name = params.get("file", [None])[0]
        if file_name:
            candidate = Path("./debug_runs") / file_name
            if candidate.exists() and candidate.suffix == ".jsonl":
                DebugHandler._log_path = candidate
                self._respond(200, "application/json",
                              b'{"status":"loaded"}')
                return
        self.send_error(404, "Run file not found")

    # ── Low-level response helper ────────────────────────────────────────────

    def _respond(self, code: int, content_type: str, body: bytes) -> None:
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.end_headers()
        self.wfile.write(body)


# --------------------------------------------------------------------------- #
# Server lifecycle
# --------------------------------------------------------------------------- #
_server_instance: Optional[ThreadingHTTPServer] = None
_server_thread: Optional[threading.Thread] = None


def start_debug_server(
    port: int = 8877,
    log_path: Optional[str] = None,
    open_browser: bool = True,
) -> ThreadingHTTPServer:
    """
    Start the debug server in a background daemon thread.

    Parameters
    ----------
    port:
        TCP port to listen on.
    log_path:
        Specific JSONL log file to serve.  If None, serves the latest run
        and auto-discovers new runs.
    open_browser:
        Open the default web browser to the UI after starting.

    Returns the ``ThreadingHTTPServer`` instance.
    """
    global _server_instance, _server_thread

    if log_path:
        DebugHandler._log_path = Path(log_path)

    _server_instance = ThreadingHTTPServer(("0.0.0.0", port), DebugHandler)
    _server_instance.daemon_threads = True

    _server_thread = threading.Thread(
        target=_server_instance.serve_forever, daemon=True
    )
    _server_thread.start()

    url = f"http://localhost:{port}"
    print(f"[debug-server] Replay UI running at  {url}")
    print(f"[debug-server] Serving log: {DebugHandler._log_path or '(latest run)'}")

    if open_browser:
        try:
            webbrowser.open(url)
        except Exception:  # noqa: BLE001
            pass

    return _server_instance


def stop_debug_server() -> None:
    """Shut down the debug server if it is running."""
    global _server_instance
    if _server_instance is not None:
        _server_instance.shutdown()
        _server_instance = None


# --------------------------------------------------------------------------- #
# CLI entry point
# --------------------------------------------------------------------------- #
if __name__ == "__main__":
    port = 8877
    log_file: Optional[str] = None

    args = sys.argv[1:]
    if "--port" in args:
        idx = args.index("--port")
        port = int(args[idx + 1])
        del args[idx:idx + 2]
    if "--no-browser" in args:
        _no_browser = True
        args.remove("--no-browser")
    else:
        _no_browser = False
    if args:
        log_file = args[0]

    start_debug_server(port=port, log_path=log_file, open_browser=not _no_browser)

    # Keep the main thread alive
    try:
        import time
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n[debug-server] Shutting down.")
        stop_debug_server()
