"""
LogPurificationEngine – strips noise from raw console output before injecting
it into SwarmState.shared_payload (spec §4.2).

Processing pipeline:
  1. ANSI / terminal formatting strip
  2. Language-specific targeted extraction
       Rust   – error[EXXXX] blocks and panic descriptions
       Python  – final Traceback frame + exception type line
       Node.js – Error / TypeError / ReferenceError lines
       Go      – file:line:col: error lines
  3. Tail-truncation fallback: return final 15 lines for unknown log structures
"""
from __future__ import annotations

import re
from typing import Optional

# ── Pre-compiled ANSI / terminal control patterns ─────────────────────────────
_ANSI_ESCAPE          = re.compile(r"\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])")
_CR_PROGRESS_OVERWRITE = re.compile(r"[^\n]*\r")  # progress-bar carriage returns

# ── Language-specific extraction patterns ─────────────────────────────────────

# Rust: error[EXXXX] blocks up to next error/warning or end-of-string
_RUST_ERROR_BLOCK = re.compile(
    r"(error\[E\d+\].*?)(?=\nerror|\nwarning|\Z)",
    re.DOTALL,
)
# Rust: thread panic messages
_RUST_PANIC = re.compile(
    r"(thread '.*?' panicked.*?)(?=\n\n|\Z)",
    re.DOTALL,
)

# Python: full Traceback block (last occurrence is most relevant)
_PYTHON_TRACEBACK = re.compile(
    r"(Traceback \(most recent call last\):.*?)(?=\n\n|\Z)",
    re.DOTALL,
)
# Python: bare exception type lines (e.g. "ValueError: bad value")
_PYTHON_EXCEPTION_LINE = re.compile(
    r"^([A-Za-z][A-Za-z0-9_]*(?:Error|Exception|Warning|Interrupt)[^\n]*)",
    re.MULTILINE,
)

# Node.js: named error type on a single line
_NODE_ERROR = re.compile(
    r"((?:Error|TypeError|ReferenceError|SyntaxError|RangeError):[^\n]+)",
    re.MULTILINE,
)

# Go: compiler/linker error lines  (file.go:line:col: message)
_GO_ERROR = re.compile(r"(\.go:\d+:\d+: [^\n]+)", re.MULTILINE)

# C++: g++/clang error lines  (file.cpp:line:col: error: ...)
_CPP_ERROR = re.compile(r"(\S+\.(?:cpp|cc|cxx|h|hpp):\d+:\d+: (?:error|fatal error):[^\n]+)", re.MULTILINE)

_TAIL_LINES: int = 15


class LogPurifier:
    """
    Stateless log purification engine.

    Call ``purify(raw_log, language)`` to obtain a compact, cleaned string
    suitable for injection into ``SwarmState.shared_payload``.
    """

    SUPPORTED_LANGUAGES = frozenset({"python", "rust", "nodejs", "go", "cpp", "shell"})

    def purify(self, raw_log: str, language: str = "shell") -> str:
        """
        Full purification pipeline: ANSI strip → language extract → tail fallback.

        Parameters
        ----------
        raw_log:  The raw console output string.
        language: One of: python | rust | nodejs | go | cpp | shell.

        Returns a compact string never larger than needed to describe the
        root failure to a debugging agent.
        """
        cleaned   = self._strip_ansi(raw_log)
        extracted = self._extract_for_language(cleaned, language.lower())
        if extracted:
            return extracted.strip()
        # Fallback: return only the final N lines
        return self._tail(cleaned, _TAIL_LINES)

    # ── Stage 1: ANSI / terminal formatting strip ──────────────────────────────

    @staticmethod
    def _strip_ansi(text: str) -> str:
        text = _ANSI_ESCAPE.sub("", text)
        text = _CR_PROGRESS_OVERWRITE.sub("", text)
        return text

    # ── Stage 2: Language-targeted extraction ────────────────────────────────

    def _extract_for_language(self, text: str, language: str) -> Optional[str]:
        if language == "rust":   return self._extract_rust(text)
        if language == "python": return self._extract_python(text)
        if language == "nodejs": return self._extract_nodejs(text)
        if language == "go":     return self._extract_go(text)
        if language == "cpp":    return self._extract_cpp(text)
        # shell / unknown → tail fallback
        return None

    @staticmethod
    def _extract_rust(text: str) -> Optional[str]:
        blocks = _RUST_ERROR_BLOCK.findall(text)
        panics = _RUST_PANIC.findall(text)
        combined = blocks + panics
        return "\n\n".join(combined) if combined else None

    @staticmethod
    def _extract_python(text: str) -> Optional[str]:
        tracebacks = _PYTHON_TRACEBACK.findall(text)
        if tracebacks:
            # Surface only the last (most relevant) traceback
            return tracebacks[-1]
        exceptions = _PYTHON_EXCEPTION_LINE.findall(text)
        return "\n".join(exceptions) if exceptions else None

    @staticmethod
    def _extract_nodejs(text: str) -> Optional[str]:
        matches = _NODE_ERROR.findall(text)
        return "\n".join(matches) if matches else None

    @staticmethod
    def _extract_go(text: str) -> Optional[str]:
        matches = _GO_ERROR.findall(text)
        return "\n".join(matches) if matches else None

    @staticmethod
    def _extract_cpp(text: str) -> Optional[str]:
        matches = _CPP_ERROR.findall(text)
        return "\n".join(matches) if matches else None

    # ── Stage 3: Tail-truncation fallback ────────────────────────────────────

    @staticmethod
    def _tail(text: str, n: int) -> str:
        lines = text.rstrip().splitlines()
        return "\n".join(lines[-n:]) if lines else ""
