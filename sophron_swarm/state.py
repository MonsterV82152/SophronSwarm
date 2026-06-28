"""
SwarmState – Centralized state memory for SophronSwarm (spec §3.1).

All coordination state is encoded in a single unsigned 16-bit integer:

  ┌─────────────────┬───────────────────┬────────────────────┬─────────────────┐
  │ Bits 15-12      │ Bits 11-8         │ Bits 7-4           │ Bits 3-0        │
  │ Target Language │ Requested Action  │ Error/Status Flags │ Active Node ID  │
  └─────────────────┴───────────────────┴────────────────────┴─────────────────┘

Agents are isolated transformation functions that read from and write updates
to this single shared object; direct agent-to-agent communication is prohibited.
"""
from __future__ import annotations

from pydantic import BaseModel, Field


class BitMask:
    """16-bit bitmask segment definitions and bit-level constants."""

    # ── Segment extraction masks ───────────────────────────────────────────────
    LANGUAGE_MASK: int = 0xF000   # bits 15-12
    ACTION_MASK:   int = 0x0F00   # bits 11-8
    STATUS_MASK:   int = 0x00F0   # bits 7-4
    NODE_MASK:     int = 0x000F   # bits 3-0

    # ── Language codes (bits 15-12) ───────────────────────────────────────────
    LANG_SHELL:  int = 0x0000
    LANG_PYTHON: int = 0x1000
    LANG_NODE:   int = 0x2000
    LANG_RUST:   int = 0x3000
    LANG_GO:     int = 0x4000
    LANG_CPP:    int = 0x5000

    LANG_NAMES: dict[int, str] = {
        0x0: "shell",
        0x1: "python",
        0x2: "nodejs",
        0x3: "rust",
        0x4: "go",
        0x5: "cpp",
    }

    # ── Action codes (bits 11-8) ──────────────────────────────────────────────
    ACTION_IDLE:        int = 0x0000   # idle
    ACTION_SCAFFOLD:    int = 0x0100   # initialize scaffold
    ACTION_INSTALL_DEP: int = 0x0200   # install dependencies
    ACTION_BUILD:       int = 0x0300   # run compiler / build
    ACTION_TEST:        int = 0x0400   # execute test suites
    ACTION_PATCH:       int = 0x0500   # apply source file patch

    ACTION_NAMES: dict[int, str] = {
        0x0: "idle",
        0x1: "scaffold",
        0x2: "install_deps",
        0x3: "build",
        0x4: "test",
        0x5: "patch",
    }

    # ── Status / error flags (bits 7-4) ──────────────────────────────────────
    FLAG_HALT:      int = 0x0080   # bit 7 – system complete / terminate
    FLAG_TEST_FAIL: int = 0x0040   # bit 6 – unit-test failure present
    FLAG_BUILD_ERR: int = 0x0020   # bit 5 – compilation / build error
    FLAG_MUTATION:  int = 0x0010   # bit 4 – loop / mutation detected

    # ── Active node IDs (bits 3-0) ────────────────────────────────────────────
    NODE_ARCHITECT: int = 0x0001
    NODE_CODER:     int = 0x0002
    NODE_SANDBOX:   int = 0x0003
    NODE_DEBUGGER:  int = 0x0004

    NODE_NAMES: dict[int, str] = {
        0x0: "none",
        0x1: "architect",
        0x2: "coder",
        0x3: "sandbox",
        0x4: "debugger",
    }


class SwarmState(BaseModel):
    """
    Centralized shared state object for the SophronSwarm platform.

    The three core fields mandated by spec §3.1 are:
      - bitmask          : unsigned 16-bit coordination mask
      - workspace_tree   : lightweight structural file map (no content)
      - shared_payload   : single-turn ephemeral execution context

    Additional fields support operational bookkeeping without being exposed
    to cloud model contexts.
    """

    model_config = {"arbitrary_types_allowed": True}

    # ── Core spec fields (§3.1) ───────────────────────────────────────────────
    bitmask: int = Field(
        default=0,
        ge=0,
        le=0xFFFF,
        description="16-bit coordination mask: language | action | flags | node-id",
    )
    workspace_tree: dict[str, str] = Field(
        default_factory=dict,
        description="Structural workspace map path→'file'|'directory'. No content stored here.",
    )
    shared_payload: str = Field(
        default="",
        description="Single-turn ephemeral execution context; wiped on phase transition.",
    )

    # ── Operational bookkeeping (never exposed to cloud models) ───────────────
    project_requirements: str = Field(
        default="",
        description="Immutable user requirements text (prompt-cached at position 1).",
    )
    failure_streak: int = Field(
        default=0,
        ge=0,
        description="Consecutive patch-fail counter; trips FLAG_MUTATION at threshold 5.",
    )
    workspace_root: str = Field(
        default="/workspace",
        description="Absolute filesystem path to the local workspace directory.",
    )
    served_files: dict[str, str] = Field(
        default_factory=dict,
        description=(
            "Ephemeral file contents served in response to a prior turn's "
            "requested_files (spec §4.3).  Read by the next node's prompt, "
            "then replaced each turn."
        ),
    )
    requested_files: list[str] = Field(
        default_factory=list,
        description=(
            "Paths an agent asked to read; consumed by the runtime to populate "
            "served_files for the next turn (spec §4.3)."
        ),
    )

    # ── Bitmask segment accessors ─────────────────────────────────────────────

    def get_language(self) -> int:
        """Return the language nibble (bits 15-12 shifted to 0-15)."""
        return (self.bitmask & BitMask.LANGUAGE_MASK) >> 12

    def get_action(self) -> int:
        """Return the action nibble (bits 11-8 shifted to 0-15)."""
        return (self.bitmask & BitMask.ACTION_MASK) >> 8

    def get_node_id(self) -> int:
        """Return the active node ID (bits 3-0)."""
        return self.bitmask & BitMask.NODE_MASK

    def get_status_nibble(self) -> int:
        """Return the error/status nibble (bits 7-4 shifted to 0-15)."""
        return (self.bitmask & BitMask.STATUS_MASK) >> 4

    # ── Flag predicate helpers ────────────────────────────────────────────────

    def is_halted(self) -> bool:
        return bool(self.bitmask & BitMask.FLAG_HALT)

    def has_build_error(self) -> bool:
        return bool(self.bitmask & BitMask.FLAG_BUILD_ERR)

    def has_test_failure(self) -> bool:
        return bool(self.bitmask & BitMask.FLAG_TEST_FAIL)

    def has_mutation_flag(self) -> bool:
        return bool(self.bitmask & BitMask.FLAG_MUTATION)

    # ── Immutable state-update helpers ────────────────────────────────────────

    def with_segment(self, mask: int, value: int) -> "SwarmState":
        """Return a new state with a bitmask segment replaced."""
        new_mask = (self.bitmask & ~mask) | (value & mask)
        return self.model_copy(update={"bitmask": new_mask & 0xFFFF})

    def with_flag(self, flag: int) -> "SwarmState":
        """Return a new state with a specific flag bit set."""
        return self.model_copy(update={"bitmask": (self.bitmask | flag) & 0xFFFF})

    def without_flag(self, flag: int) -> "SwarmState":
        """Return a new state with a specific flag bit cleared."""
        return self.model_copy(update={"bitmask": (self.bitmask & ~flag) & 0xFFFF})

    def with_node(self, node_id: int) -> "SwarmState":
        """Return a new state with the active node-ID segment updated."""
        return self.with_segment(BitMask.NODE_MASK, node_id)

    def with_action(self, action: int) -> "SwarmState":
        """Return a new state with the requested-action segment updated."""
        return self.with_segment(BitMask.ACTION_MASK, action)

    def with_language(self, lang: int) -> "SwarmState":
        """Return a new state with the target-language segment updated."""
        return self.with_segment(BitMask.LANGUAGE_MASK, lang)

    def wipe_payload(self) -> "SwarmState":
        """Return a new state with shared_payload cleared (phase transition)."""
        return self.model_copy(update={"shared_payload": ""})

    def serve_files(self, contents: dict[str, str]) -> "SwarmState":
        """Populate served_files for the next turn and clear the request list."""
        return self.model_copy(update={
            "served_files":   contents,
            "requested_files": [],
        })

    # ── Diagnostic helper ─────────────────────────────────────────────────────

    def describe_bitmask(self) -> str:
        """Human-readable expansion of the current bitmask value (logging only)."""
        lang  = BitMask.LANG_NAMES.get(self.get_language(),  f"0x{self.get_language():X}")
        act   = BitMask.ACTION_NAMES.get(self.get_action(),  f"0x{self.get_action():X}")
        node  = BitMask.NODE_NAMES.get(self.get_node_id(),   f"0x{self.get_node_id():X}")
        flags: list[str] = []
        if self.is_halted():          flags.append("HALT")
        if self.has_test_failure():   flags.append("TEST_FAIL")
        if self.has_build_error():    flags.append("BUILD_ERR")
        if self.has_mutation_flag():  flags.append("MUTATION")
        flag_str = "|".join(flags) if flags else "OK"
        return (
            f"bitmask=0x{self.bitmask:04X}  "
            f"[lang={lang} | action={act} | flags={flag_str} | node={node}]"
        )
