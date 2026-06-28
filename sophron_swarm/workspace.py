"""
WorkspaceManager – lazy file-access layer implementing the On-Demand Workspace
State Pattern (spec §4.3).

Agents initially receive only the lightweight workspace_tree structure.
File contents are served ephemerally: loaded only when an agent explicitly
requests them, used for one turn, then discarded.

SHA-256 file hashing supports pre-patch integrity validation (spec §5.3).
"""
from __future__ import annotations

import hashlib
import logging
from pathlib import Path
from typing import Optional

log = logging.getLogger(__name__)

# Directories and file patterns excluded from the workspace tree scan
_EXCLUDED_DIRS  = frozenset({"__pycache__", ".git", ".svn", "node_modules", ".venv", "venv", "target", ".mypy_cache"})
_EXCLUDED_NAMES = frozenset({".DS_Store", "Thumbs.db"})

# Maximum nesting depth for scan_tree (prevents runaway recursion on huge trees)
_MAX_SCAN_DEPTH = 8


class WorkspaceManager:
    """
    Manages the workspace tree structural view and provides controlled,
    lazy access to file contents.

    Parameters
    ----------
    root : str | Path
        Absolute path to the local workspace directory.
    """

    def __init__(self, root: str | Path) -> None:
        self.root = Path(root).resolve()

    def _safe_resolve(self, rel_path: str) -> Path:
        """
        Resolve a relative path inside the workspace, rejecting path traversal.

        Strips leading slashes and ensures the resolved path stays within
        ``self.root`` (prevents ``../../etc/passwd`` escapes).
        Returns the resolved absolute path.  Raises ValueError if the path
        escapes the workspace root.
        """
        clean = rel_path.lstrip("/")
        candidate = (self.root / clean).resolve()
        # Ensure the candidate is within the workspace root
        if not str(candidate).startswith(str(self.root)):
            raise ValueError(
                f"Path '{rel_path}' escapes workspace root {self.root}"
            )
        return candidate

    # ── Workspace tree (structural, no content) ───────────────────────────────

    def scan_tree(self) -> dict[str, str]:
        """
        Return a lightweight structural map of the workspace.

        Values are ``"file"`` or ``"directory"``.  File contents are never
        included here (spec §3.1 workspace_tree constraint).

        Hidden directories, caches, and build artefacts are excluded to keep
        the structural map concise and token-efficient.  A maximum scan depth
        prevents runaway recursion on very large directory trees.
        """
        tree: dict[str, str] = {}
        if not self.root.exists():
            return tree

        try:
            for item in sorted(self.root.rglob("*")):
                parts = item.relative_to(self.root).parts
                # Skip excluded directories at any depth
                if any(p.startswith(".") or p in _EXCLUDED_DIRS for p in parts):
                    continue
                # Skip excluded filenames
                if item.name in _EXCLUDED_NAMES:
                    continue
                # Depth guard: prevent runaway traversal
                if len(parts) > _MAX_SCAN_DEPTH:
                    continue
                # Symlink safety: skip symlinks that escape the workspace root
                if item.is_symlink():
                    try:
                        resolved = item.resolve()
                        if not str(resolved).startswith(str(self.root)):
                            continue
                    except OSError:
                        continue
                rel = str(item.relative_to(self.root))
                tree[rel] = "directory" if item.is_dir() else "file"
        except OSError as exc:
            log.warning("scan_tree failed for %s: %s", self.root, exc)

        return tree

    # ── Lazy ephemeral file fetching (spec §4.3) ──────────────────────────────

    def fetch_files(self, paths: list[str]) -> dict[str, str]:
        """
        Load and return content for the requested file paths.

        This call produces a single-turn ephemeral payload.  The caller is
        responsible for discarding the content immediately after the node
        function returns its state transition data (spec §4.3).

        Missing files are NOT silently skipped — instead, an explicit marker
        ``"(file does not exist on disk)"`` is returned so the agent knows the
        file needs to be created rather than re-requested forever.

        Leading slashes in paths are stripped (e.g. ``/index.html`` → ``index.html``)
        to avoid Python's ``Path(root) / "/abs"`` resolving to the filesystem root.
        """
        contents: dict[str, str] = {}
        for rel_path in paths:
            # Normalize: strip leading slashes + prevent path traversal
            try:
                abs_path = self._safe_resolve(rel_path)
                clean = rel_path.lstrip("/")
            except ValueError:
                contents[rel_path.lstrip("/")] = "(error: path escapes workspace)"
                continue
            if abs_path.is_file():
                try:
                    contents[clean] = abs_path.read_text(
                        encoding="utf-8", errors="replace"
                    )
                except OSError as exc:
                    contents[clean] = f"(error: could not read file: {exc})"
            else:
                # Explicit marker so the agent knows the file doesn't exist yet
                contents[clean] = "(file does not exist on disk)"
        return contents

    # ── SHA-256 integrity helpers (spec §5.3) ─────────────────────────────────

    def sha256(self, rel_path: str) -> Optional[str]:
        """Return the SHA-256 hex-digest of a workspace file, or None if not found."""
        try:
            abs_path = self._safe_resolve(rel_path)
        except ValueError:
            return None
        if not abs_path.is_file():
            return None
        return hashlib.sha256(abs_path.read_bytes()).hexdigest()

    def verify_sha256(self, rel_path: str, expected: str) -> bool:
        """
        Validate a file's SHA-256 digest before applying a patch.

        Returns True only if the file exists and its digest matches expected.
        """
        actual = self.sha256(rel_path)
        if actual is None:
            return False
        return actual == expected

    # ── Filesystem write helpers ──────────────────────────────────────────────

    def write_file(self, rel_path: str, content: str) -> None:
        """Write (or overwrite) a file in the workspace, creating parents as needed."""
        target = self._safe_resolve(rel_path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")

    def ensure_dir(self, rel_dir: str) -> None:
        """Create a directory (and all parents) inside the workspace."""
        path = self._safe_resolve(rel_dir)
        path.mkdir(parents=True, exist_ok=True)
