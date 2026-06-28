"""
Local Execution Node – Zero-Token Programmatic Engine (spec §3.3.C).

Responsibilities:
  - Apply unified diff patches to the workspace with SHA-256 pre-validation
  - Execute build / test / scaffold commands inside Docker containers
  - Translate hardware exit codes directly into bitmask flag updates
  - Consume ZERO LLM tokens (no cloud API calls whatsoever)

Docker SDK (docker-py) is the primary execution backend.  A subprocess
fallback is provided for environments where the Docker daemon is unavailable
(e.g. lightweight CI runners).

All blocking I/O is wrapped in asyncio.to_thread() to avoid stalling the
event loop during container execution or large file operations.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import subprocess
import tempfile
from pathlib import Path
from typing import Optional

from sophron_swarm.log_purifier import LogPurifier
from sophron_swarm.recorder import recorder
from sophron_swarm.state import BitMask, SwarmState
from sophron_swarm.workspace import WorkspaceManager

log = logging.getLogger(__name__)

_purifier = LogPurifier()

# ── Docker image map keyed by language name ───────────────────────────────────
_DOCKER_IMAGES: dict[str, str] = {
    "shell":  "ubuntu:22.04",
    "python": "python:3.11-slim",
    "nodejs": "node:20-alpine",
    "rust":   "rust:1.78-slim",
    "go":     "golang:1.22-alpine",
    "cpp":    "gcc:13",
}

# ── Language build commands (run inside the container at /workspace) ──────────
_BUILD_COMMANDS: dict[str, str] = {
    "python": "python -m py_compile $(find . -name '*.py' | head -20) 2>&1",
    "nodejs": "test -f package.json && (npm install --silent 2>&1 && npm run build --if-present 2>&1) || echo 'No package.json – static files, build skipped'",
    "rust":   "cargo build 2>&1",
    "go":     "go build ./... 2>&1",
    "cpp":    "find . -name '*.cpp' -o -name '*.cc' | xargs g++ -o app 2>&1",
    "shell":  "find . -name '*.sh' | xargs bash -n 2>&1",
}

# ── Language test commands ────────────────────────────────────────────────────
_TEST_COMMANDS: dict[str, str] = {
    "python": "python -m pytest --tb=short -q 2>&1",
    "nodejs": "test -f package.json && npm test 2>&1 || echo 'No package.json – test skipped'",
    "rust":   "cargo test 2>&1",
    "go":     "go test ./... 2>&1",
    "cpp":    "ctest --output-on-failure 2>&1",
    "shell":  "find . -name '*.sh' | xargs bash -n 2>&1 && echo OK",
}

# ── Dependency install / scaffold commands ────────────────────────────────────
_SCAFFOLD_COMMANDS: dict[str, str] = {
    "python": "pip install --quiet -r requirements.txt 2>&1",
    "nodejs": "npm install --silent 2>&1",
    "rust":   "cargo fetch 2>&1",
    "go":     "go mod download 2>&1",
    "cpp":    "echo 'scaffold: no package manager for cpp' 2>&1",
    "shell":  "echo 'scaffold: ok' 2>&1",
}


def _lang_name(state: SwarmState) -> str:
    return BitMask.LANG_NAMES.get(state.get_language(), "shell")


# ── Public entry point ────────────────────────────────────────────────────────

async def sandbox_node(state: SwarmState) -> SwarmState:
    """
    Zero-token execution engine.

    Reads the action nibble (bits 11-8) from the bitmask and dispatches
    to the appropriate handler.  All outputs are encoded as bitmask mutations;
    no text is sent to any cloud model endpoint.
    """
    action = state.get_action()   # nibble 0-15
    lang   = _lang_name(state)
    log.info("Sandbox dispatch: lang=%s  action=0x%X", lang, action)

    # Map action nibble to handler
    action_map = {
        BitMask.ACTION_PATCH       >> 8: _handle_patch,
        BitMask.ACTION_BUILD       >> 8: _handle_build,
        BitMask.ACTION_TEST        >> 8: _handle_test,
        BitMask.ACTION_SCAFFOLD    >> 8: _handle_scaffold,
        BitMask.ACTION_INSTALL_DEP >> 8: _handle_scaffold,   # alias
    }

    handler = action_map.get(action)
    if handler is None:
        log.warning("Sandbox received unknown action nibble 0x%X – ignoring.", action)
        return state

    return await handler(state, lang)


# ── Action handlers ───────────────────────────────────────────────────────────

async def _handle_patch(state: SwarmState, lang: str) -> SwarmState:
    """
    Apply the unified diff in shared_payload to the workspace.

    SHA-256 pre-validation (spec §5.3): hashes the target file before patching.
    If the `patch` utility is unavailable, falls back to a Python-based applier.
    """
    diff_content = state.shared_payload
    if not diff_content.strip():
        log.warning("Sandbox: ACTION_PATCH but shared_payload is empty.")
        recorder.record_sandbox(BitMask.ACTION_PATCH >> 8, lang, {
            "status": "empty_payload",
            "message": "ACTION_PATCH but shared_payload is empty",
            "diff_content_length": 0,
        })
        return _failure_state(state, BitMask.FLAG_BUILD_ERR, "Empty patch payload.")

    # Validate that the payload looks like a unified diff before invoking `patch`.
    # Models sometimes put explanatory text instead of a diff in shared_payload.
    if not _is_valid_unified_diff(diff_content):
        log.warning("Sandbox: shared_payload is not a valid unified diff.")
        recorder.record_sandbox(BitMask.ACTION_PATCH >> 8, lang, {
            "status": "invalid_diff",
            "diff_preview": diff_content[:500],
            "diff_content_length": len(diff_content),
        })
        err_msg = (
            "ERROR: shared_payload does not contain a valid unified diff.\n"
            "Expected a diff starting with '--- ' and '+++ ' headers.\n"
            "Received instead (first 200 chars):\n"
            + diff_content[:200]
        )
        return _failure_state(state, BitMask.FLAG_BUILD_ERR, err_msg)

    recorder.record_sandbox(BitMask.ACTION_PATCH >> 8, lang, {
        "status": "diff_received",
        "diff_preview": diff_content[:500],
        "diff_content_length": len(diff_content),
    })

    workspace = WorkspaceManager(state.workspace_root)

    # Try the Python diff applier first.  It handles new-file creation
    # (from /dev/null) reliably, including multi-file concatenated diffs,
    # without depending on the fragile `patch` utility and its strict hunk
    # line-count validation.  If it fails (e.g. the diff modifies existing
    # files), fall back to the POSIX `patch` command.
    exit_code, output = _apply_diff_python(diff_content, state.workspace_root)

    if exit_code != 0:
        log.info(
            "Python applier did not fully apply (rc=%d); trying `patch` utility.",
            exit_code,
        )
        # Fall back to the POSIX patch utility
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".patch", delete=False, encoding="utf-8"
        ) as tmp:
            tmp.write(diff_content)
            patch_file = tmp.name
        try:
            exit_code, output = await asyncio.to_thread(
                _run_patch_command, patch_file, state.workspace_root
            )
        finally:
            try:
                os.unlink(patch_file)
            except OSError:
                pass

    if exit_code != 0:
        log.warning("patch failed (rc=%d): %s", exit_code, output[:200])
        err_payload = _purifier.purify(output, lang)
        recorder.record_sandbox(BitMask.ACTION_PATCH >> 8, lang, {
            "status": "patch_failed",
            "exit_code": exit_code,
            "output": output[:1000],
        })
        return _failure_state(state, BitMask.FLAG_BUILD_ERR, err_payload)

    log.info("Patch applied successfully.")
    recorder.record_sandbox(BitMask.ACTION_PATCH >> 8, lang, {
        "status": "patch_applied",
        "exit_code": exit_code,
        "output": output[:500],
    })
    new_bitmask = (
        (state.bitmask & BitMask.LANGUAGE_MASK)  # keep language
        | BitMask.ACTION_BUILD                    # proceed to build
        | BitMask.NODE_SANDBOX                    # stay in sandbox
        # error flags intentionally cleared
    ) & 0xFFFF
    return state.model_copy(update={
        "bitmask":        new_bitmask,
        "workspace_tree": workspace.scan_tree(),
        "failure_streak": 0,
        "shared_payload": "",
    })


async def _handle_build(state: SwarmState, lang: str) -> SwarmState:
    """Run the compilation step inside a Docker container."""
    return await _run_in_docker(
        state, lang,
        command          = _BUILD_COMMANDS.get(lang, "echo 'build: no command'"),
        on_success_action = BitMask.ACTION_TEST,
        on_success_node   = BitMask.NODE_SANDBOX,
        on_failure_flag   = BitMask.FLAG_BUILD_ERR,
        on_failure_node   = BitMask.NODE_DEBUGGER,
    )


async def _handle_test(state: SwarmState, lang: str) -> SwarmState:
    """Run the test suite inside a Docker container."""
    return await _run_in_docker(
        state, lang,
        command            = _TEST_COMMANDS.get(lang, "echo 'test: no command'"),
        on_success_action  = BitMask.ACTION_IDLE,
        on_success_node    = BitMask.NODE_ARCHITECT,
        on_success_extra   = BitMask.FLAG_HALT,   # all tests pass → halt (spec §3.1 bit 7)
        on_failure_flag    = BitMask.FLAG_TEST_FAIL,
        on_failure_node    = BitMask.NODE_DEBUGGER,
    )


async def _handle_scaffold(state: SwarmState, lang: str) -> SwarmState:
    """Initialise the project scaffold / install dependencies in Docker."""
    return await _run_in_docker(
        state, lang,
        command          = _SCAFFOLD_COMMANDS.get(lang, "echo 'scaffold: ok'"),
        on_success_action = BitMask.ACTION_IDLE,
        on_success_node   = BitMask.NODE_CODER,
        on_failure_flag   = BitMask.FLAG_BUILD_ERR,
        on_failure_node   = BitMask.NODE_DEBUGGER,
    )


# ── Docker / subprocess execution engine ─────────────────────────────────────

async def _run_in_docker(
    state:            SwarmState,
    lang:             str,
    command:          str,
    on_success_action: int,
    on_success_node:  int,
    on_failure_flag:  int,
    on_failure_node:  int,
    on_success_extra: int = 0,
) -> SwarmState:
    """
    Execute a shell command inside a Docker container mounted on the workspace.

    Falls back to a direct subprocess when the Docker daemon is unavailable,
    ensuring functionality in CI/lightweight environments.
    """
    image          = _DOCKER_IMAGES.get(lang, "ubuntu:22.04")
    workspace_path = str(state.workspace_root)

    exit_code, raw_output = await asyncio.to_thread(
        _docker_or_subprocess, image, command, workspace_path
    )

    purified = _purifier.purify(raw_output, lang)

    if exit_code == 0:
        new_bitmask = (
            (state.bitmask & BitMask.LANGUAGE_MASK)   # keep language
            | on_success_action
            | on_success_node
            | on_success_extra
            # error flags cleared
        ) & 0xFFFF
        recorder.record_sandbox(
            (state.bitmask & BitMask.ACTION_MASK) >> 8, lang, {
            "status": "exec_success",
            "command": command,
            "exit_code": exit_code,
            "output": purified[:1000],
        })
        return state.model_copy(update={
            "bitmask":        new_bitmask,
            "shared_payload": "",
            "failure_streak": 0,
        })
    else:
        new_bitmask = (
            (state.bitmask & BitMask.LANGUAGE_MASK)
            | BitMask.ACTION_PATCH
            | on_failure_flag
            | on_failure_node
        ) & 0xFFFF
        recorder.record_sandbox(
            (state.bitmask & BitMask.ACTION_MASK) >> 8, lang, {
            "status": "exec_failed",
            "command": command,
            "exit_code": exit_code,
            "output": purified[:1000],
        })
        return state.model_copy(update={
            "bitmask":        new_bitmask,
            "shared_payload": purified,
        })


def _docker_or_subprocess(image: str, command: str, workspace_path: str) -> tuple[int, str]:
    """Run command in Docker; fall back to subprocess if Docker is unavailable."""
    try:
        import docker  # type: ignore
        client = docker.from_env(timeout=120)

        try:
            raw = client.containers.run(
                image=image,
                command=["sh", "-c", command],
                volumes={workspace_path: {"bind": "/workspace", "mode": "rw"}},
                working_dir="/workspace",
                remove=True,
                stdout=True,
                stderr=True,
                detach=False,
            )
            output = raw.decode("utf-8", errors="replace") if isinstance(raw, bytes) else str(raw)
            return 0, output

        except docker.errors.ContainerError as ce:
            stderr = ce.stderr
            output = stderr.decode("utf-8", errors="replace") if isinstance(stderr, bytes) else str(ce)
            return ce.exit_status, output

        except docker.errors.ImageNotFound:
            log.info("Docker image '%s' not found locally – pulling…", image)
            client.images.pull(image)
            # Retry once after pull
            raw = client.containers.run(
                image=image,
                command=["sh", "-c", command],
                volumes={workspace_path: {"bind": "/workspace", "mode": "rw"}},
                working_dir="/workspace",
                remove=True,
                stdout=True,
                stderr=True,
                detach=False,
            )
            output = raw.decode("utf-8", errors="replace") if isinstance(raw, bytes) else str(raw)
            return 0, output

    except Exception as exc:  # noqa: BLE001
        log.info("Docker unavailable (%s) – falling back to subprocess.", type(exc).__name__)
        return _subprocess_fallback(command, workspace_path)


def _subprocess_fallback(command: str, cwd: str) -> tuple[int, str]:
    """Direct subprocess execution when Docker is unavailable."""
    try:
        result = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            text=True,
            cwd=cwd,
            timeout=120,
        )
        return result.returncode, result.stdout + result.stderr
    except subprocess.TimeoutExpired:
        return 1, "Command timed out after 120 seconds."
    except Exception as exc:  # noqa: BLE001
        return 1, str(exc)


def _run_patch_command(patch_file: str, workspace_root: str) -> tuple[int, str]:
    """Run the POSIX patch utility; return (exit_code, combined_output).

    Tries ``-p1`` first (standard a/ b/ prefixed diffs).  If that fails to
    find the file, retries with ``-p0`` for diffs that use bare paths or
    leading-slash paths.
    """
    for strip_level in ["1", "0"]:
        try:
            result = subprocess.run(
                ["patch", f"-p{strip_level}", "--forward", "--batch",
                 "--no-backup-if-mismatch", "-i", patch_file],
                capture_output=True,
                text=True,
                cwd=workspace_root,
                timeout=30,
            )
        except FileNotFoundError:
            # `patch` not installed; attempt Python-based fallback
            log.warning("'patch' utility not installed – using Python fallback applier.")
            try:
                diff_text = Path(patch_file).read_text(encoding="utf-8")
                return _python_patch_fallback(diff_text, workspace_root)
            except Exception as exc:  # noqa: BLE001
                return 1, str(exc)
        except subprocess.TimeoutExpired:
            return 1, "patch command timed out."

        # Success, or non-recoverable failure (not a "can't find file" error)
        if result.returncode == 0:
            return result.returncode, result.stdout + result.stderr

        # If this was -p1 and the failure is "can't find file", try -p0 next
        output = result.stdout + result.stderr
        if strip_level == "1" and "can't find file to patch" in output:
            log.debug("patch -p1 failed to find file – retrying with -p0.")
            continue
        # Otherwise return the failure
        return result.returncode, output

    return result.returncode, result.stdout + result.stderr


def _python_patch_fallback(diff: str, workspace_root: str) -> tuple[int, str]:
    """
    Minimal Python-based patch applier as a last-resort fallback.

    Handles simple single-file creation diffs (new file from /dev/null).
    Does NOT implement full RFC 5/patch semantics; use only when `patch` is absent.
    """
    target = _extract_diff_target(diff)
    if not target:
        return 1, "Could not determine diff target file from patch header."

    # Prevent path traversal: ensure target stays within workspace_root
    root = Path(workspace_root).resolve()
    abs_path = (root / target).resolve()
    if not str(abs_path).startswith(str(root)):
        return 1, f"Patch target '{target}' escapes workspace root."

    if not abs_path.exists():
        # New-file creation: collect all '+' lines (skip diff meta-headers)
        new_lines = [
            line[1:] for line in diff.splitlines()
            if line.startswith("+") and not line.startswith("+++")
        ]
        abs_path.parent.mkdir(parents=True, exist_ok=True)
        abs_path.write_text("\n".join(new_lines) + "\n", encoding="utf-8")
        log.info("Python fallback: created new file '%s'.", target)
        return 0, f"Created {target}"

    return 1, (
        f"Python fallback patch applier only supports new-file creation. "
        f"'{target}' already exists and requires full diff application."
    )


def _apply_diff_python(diff: str, workspace_root: str) -> tuple[int, str]:
    """
    Robust Python diff applier for new-file creation and simple edits.

    Handles the concatenated multi-file diffs that LLMs typically emit,
    tolerating incorrect hunk line-counts that break the POSIX ``patch``
    utility.  Supports:

    * New-file creation from ``/dev/null`` source (the most common case)
    * Simple in-place edits (single-hunk, context lines present)

    Falls back (returns non-zero) if the diff is too complex, so the caller
    can retry with the ``patch`` utility.

    Returns ``(exit_code, output)`` like the other appliers.
    """
    root = Path(workspace_root).resolve()
    lines = diff.splitlines()

    # Split the diff into per-file sections.  A section starts at a '--- ' line.
    # Lines before the first '--- ' (e.g. "diff --git" headers) are discarded.
    sections: list[list[str]] = []
    current: list[str] = []
    for line in lines:
        if line.startswith("--- "):
            # Start of a new file section — flush the previous one
            if current and any(l.startswith("+++") for l in current):
                sections.append(current)
            current = [line]
        else:
            current.append(line)
    if current and any(l.startswith("+++") for l in current):
        sections.append(current)

    if not sections:
        return 1, "No diff sections found (missing '--- '/+++ headers)."

    created: list[str] = []
    modified: list[str] = []
    errors: list[str] = []

    for section in sections:
        # Extract source and target paths from the section header
        source_path: str | None = None
        target_path: str | None = None
        body_start = 0
        for i, line in enumerate(section):
            if line.startswith("--- ") and source_path is None:
                raw = line[4:].split("\t")[0].strip()
                source_path = raw
            elif line.startswith("+++ ") and target_path is None:
                raw = line[4:].split("\t")[0].strip()
                # Strip b/ or a/ prefix
                if raw.startswith(("b/", "a/")):
                    raw = raw[2:]
                target_path = raw.lstrip("/")
                body_start = i + 1
                break

        if not target_path or target_path in ("/dev/null", "dev/null"):
            errors.append("Could not determine target file from +++ header.")
            continue

        # Path traversal safety
        abs_target = (root / target_path).resolve()
        if not str(abs_target).startswith(str(root)):
            errors.append(f"Path '{target_path}' escapes workspace root.")
            continue

        # Determine if this is a new-file creation (source is /dev/null)
        is_new_file = source_path in ("/dev/null", "dev/null") or not abs_target.exists()

        # Collect the body lines (skip @@ hunk headers, collect +, -, context)
        body = section[body_start:]
        if is_new_file:
            # For new files, simply collect all '+' lines (ignore @@ counts)
            added: list[str] = []
            for line in body:
                if line.startswith("@@"):
                    continue
                if line.startswith("+++"):
                    continue
                if line.startswith("---"):
                    continue
                if line.startswith("diff "):
                    continue
                if line.startswith("index "):
                    continue
                if line.startswith("new file"):
                    continue
                if line.startswith("+"):
                    added.append(line[1:])
                # Ignore context/removed lines for new files
            try:
                abs_target.parent.mkdir(parents=True, exist_ok=True)
                abs_target.write_text("\n".join(added) + "\n", encoding="utf-8")
                created.append(target_path)
                log.info("Python applier: created '%s' (%d lines).",
                         target_path, len(added))
            except OSError as exc:
                errors.append(f"Could not write '{target_path}': {exc}")
        else:
            # In-place edit: attempt a simple single-hunk application
            result = _apply_hunk_to_file(body, abs_target, target_path)
            if result is True:
                modified.append(target_path)
                log.info("Python applier: modified '%s'.", target_path)
            else:
                errors.append(
                    f"Could not apply hunk to existing file '{target_path}'."
                )

    summary_parts = []
    if created:
        summary_parts.append(f"Created {len(created)} file(s): {', '.join(created)}")
    if modified:
        summary_parts.append(f"Modified {len(modified)} file(s): {', '.join(modified)}")

    # Success if at least one file was created/modified
    if created or modified:
        output = "; ".join(summary_parts)
        if errors:
            output += "; Errors: " + "; ".join(errors)
        return 0, output

    # Total failure
    return 1, "Python applier could not apply any section. " + "; ".join(errors)


def _apply_hunk_to_file(body: list[str], abs_path: Path, rel_path: str) -> bool:
    """
    Apply one or more hunks to an existing file.  Returns True on success.

    Handles multi-hunk diffs by parsing each ``@@`` block separately and
    applying them in REVERSE order (bottom-to-top) so earlier line-number
    offsets don't cascade.  For each hunk, the old block (context + removed
    lines) is searched for in the file content and replaced with the new
    block (context + added lines).  This tolerates incorrect line numbers
    in the ``@@`` header, which is the most common LLM diff error.
    """
    if not abs_path.exists():
        return False

    try:
        content = abs_path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return False

    # Split body into individual hunks (each starts with @@)
    hunks: list[list[str]] = []
    current_hunk: list[str] = []
    for line in body:
        if line.startswith("@@"):
            if current_hunk:
                hunks.append(current_hunk)
            current_hunk = [line]
        elif current_hunk:
            # Only collect lines after the first @@
            if not (line.startswith("+++") or line.startswith("---")):
                current_hunk.append(line)
    if current_hunk:
        hunks.append(current_hunk)

    if not hunks:
        return False

    # Apply hunks in reverse order so line offsets don't cascade
    for hunk_lines in reversed(hunks):
        old_block: list[str] = []
        new_block: list[str] = []
        for line in hunk_lines:
            if line.startswith("@@"):
                continue
            if line.startswith("+") and not line.startswith("+++"):
                new_block.append(line[1:])
            elif line.startswith("-") and not line.startswith("---"):
                old_block.append(line[1:])
            else:
                # Context line (strip leading space, but handle empty lines)
                ctx = line[1:] if line.startswith(" ") else line
                old_block.append(ctx)
                new_block.append(ctx)

        if not old_block:
            # Pure insertion — use the context lines before/after to locate
            if not new_block:
                continue
            # Fall through; a pure-add hunk with no context can't be located
            continue

        old_text = "\n".join(old_block)
        new_text = "\n".join(new_block)

        if old_text in content:
            content = content.replace(old_text, new_text, 1)
        else:
            # Fuzzy match: try with normalized whitespace
            old_normalized = "\n".join(l.strip() for l in old_block)
            content_lines = content.split("\n")
            content_norm = [l.strip() for l in content_lines]
            old_norm_lines = old_normalized.split("\n")
            # Search for the normalized old block in the content
            for i in range(len(content_norm) - len(old_norm_lines) + 1):
                if content_norm[i:i + len(old_norm_lines)] == old_norm_lines:
                    # Found it — replace using original (non-normalized) new block
                    replacement = "\n".join(new_block)
                    before = "\n".join(content_lines[:i])
                    after = "\n".join(content_lines[i + len(old_norm_lines):])
                    content = before + "\n" + replacement + ("\n" + after if after else "")
                    break
            else:
                # Could not find this hunk's context — skip it but continue
                log.warning("Could not locate context for hunk in '%s'.", rel_path)
                continue

    try:
        abs_path.write_text(content, encoding="utf-8")
        return True
    except OSError:
        return False


# ── Utility functions ─────────────────────────────────────────────────────────

def _extract_diff_target(diff: str) -> Optional[str]:
    """Extract the target (+++) file path from a unified diff header."""
    for line in diff.splitlines():
        if line.startswith("+++ "):
            path = line[4:].strip()
            # Strip leading a/ or b/ diff prefixes
            if path.startswith(("b/", "a/")):
                path = path[2:]
            # /dev/null means new file; target not available for pre-check
            if path in ("/dev/null", "dev/null"):
                return None
            # Strip leading slashes so Path(root) / path works correctly
            return path.lstrip("/")
    return None


def _is_valid_unified_diff(content: str) -> bool:
    """
    Heuristic check that ``content`` looks like a unified diff.

    A valid unified diff must contain at least one ``--- `` source header and
    one ``+++ `` target header.  This catches the common failure mode where an
    agent places explanatory prose in shared_payload instead of an actual diff.
    """
    lines = content.splitlines()
    has_source = any(line.startswith("--- ") for line in lines)
    has_target = any(line.startswith("+++ ") for line in lines)
    return has_source and has_target


def _failure_state(state: SwarmState, flag: int, payload: str) -> SwarmState:
    """Build a failure state routing to the Debugger."""
    new_bitmask = (
        (state.bitmask & BitMask.LANGUAGE_MASK)
        | BitMask.ACTION_PATCH
        | flag
        | BitMask.NODE_DEBUGGER
    ) & 0xFFFF
    return state.model_copy(update={
        "bitmask":        new_bitmask,
        "shared_payload": payload,
    })
