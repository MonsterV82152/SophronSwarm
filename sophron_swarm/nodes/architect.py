"""
Architect Node – Cloud-Hosted Frontier Model (spec §3.3.A).

Responsibilities:
  - Analyse user requirements and evaluate the current workspace layout
  - Choose the optimal language stack, framework, and scaffold blueprint
  - Coordinate system-level design and emit a structured technical spec
    in shared_payload for the Coder agent to implement

Input scope:  project_requirements + workspace_tree
Output:       bitmask with language + ACTION_SCAFFOLD + NODE_CODER
              shared_payload containing the technical specification
"""
from __future__ import annotations

import logging
import re
from pathlib import Path

from sophron_swarm.llm_client import LLMClient
from sophron_swarm.prompt_builder import PromptBuilder
from sophron_swarm.state import BitMask, SwarmState
from sophron_swarm.workspace import WorkspaceManager

log = logging.getLogger(__name__)


def _sanitize_project_name(raw: str) -> str:
    """
    Sanitise a model-provided project name into a safe single-segment folder name.

    - Lowercase
    - Replace runs of whitespace/underscores with a single hyphen
    - Strip path separators and dots so it cannot escape the workspace root
    - Collapse multiple hyphens
    Returns "" if the result is empty.
    """
    name = raw.strip().lower()
    name = re.sub(r"[\s_]+", "-", name)
    name = re.sub(r"[^a-z0-9-]", "", name)
    name = re.sub(r"-{2,}", "-", name).strip("-")
    return name

_ADDENDUM = """\
You are the ARCHITECT agent.

Your responsibilities:
1. Analyse the PROJECT REQUIREMENTS and the current WORKSPACE_TREE.
2. PROJECT ISOLATION — The WORKSPACE_TREE shows every project folder that ALREADY
   exists in the shared workspace (each top-level directory is a prior project).
   Decide whether the requirements describe:
     (a) a NEW project  → choose a new, unique, lowercase-kebab-case folder name
         (e.g. "schoology-dashboard", "todo-api"). Do NOT reuse an existing name.
     (b) a CONTINUATION of an existing project → reuse that existing folder name.
   Put the chosen folder name in `project_name`. All files you plan and all paths
   the Coder emits are RELATIVE TO THIS FOLDER — do NOT prefix paths with the
   project_name.
3. Autonomously choose the optimal language ecosystem and framework based solely on
   the requirements. Language selection is YOUR decision – it is not pre-set.
4. Produce a structured technical specification in shared_payload that the CODER
   agent will implement step by step.

Language selection (set bits 15-12 in bitmask_update to reflect your choice):
  0000 = shell/bash  – scripting, automation, no specific language indicated
  0001 = python      – data, ML, scripting, general backend, CLI tools
  0010 = nodejs      – web APIs, real-time services, JavaScript ecosystem
  0011 = rust        – systems programming, performance-critical, CLI binaries
  0100 = go          – network services, cloud infrastructure, concurrent backends
  0101 = cpp         – embedded, game engines, low-level systems

Output JSON schema:
  project_name          – REQUIRED: lowercase-kebab-case folder name for this project
                           (e.g. "schoology-dashboard"). The runtime creates it inside
                           the workspace. All subsequent file paths are relative to it.
  bitmask_update        – REQUIRED: language (bits 15-12, your autonomous choice),
                           ACTION_SCAFFOLD=0x0100 (bits 11-8), NODE_CODER=0x0002 (bits 3-0).
                           Example choosing Python: "0x1102"
                           Example choosing Rust:   "0x3102"
  workspace_tree_update – planned directory/file entries for the scaffold layout. Paths
                           are relative to project_name (NO project_name prefix).
  shared_payload        – complete technical specification for the Coder, beginning with
                           a one-line rationale for the language choice.
  requested_files       – any workspace files you need to read before deciding.
"""

_builder = PromptBuilder()


async def architect_node(state: SwarmState, llm: LLMClient) -> SwarmState:
    """Invoke the Architect agent and return the updated SwarmState."""
    messages = _builder.build(state, _ADDENDUM)
    raw      = await llm.complete(messages)
    log.debug("Architect raw response (first 400 chars): %s", raw[:400])
    response = _builder.extract_response(raw)
    return _apply_response(state, response)


def _apply_response(state: SwarmState, response: dict) -> SwarmState:
    """Merge the Architect JSON response back into SwarmState."""
    updates: dict = {}

    # ── Project isolation: resolve the project subfolder BEFORE merging the ─
    #    workspace_tree_update, because the tree paths are relative to the
    #    subfolder and the rescan must happen from the new root.
    new_root = Path(state.workspace_root)
    rescan_tree = False
    project_name_raw = str(response.get("project_name", "")).strip()
    project_name = _sanitize_project_name(project_name_raw)
    if project_name:
        base = Path(state.workspace_root)
        candidate = (base / project_name).resolve()
        # Guard against path traversal: candidate must stay under base.
        if str(candidate).startswith(str(base)):
            try:
                candidate.mkdir(parents=True, exist_ok=True)
                new_root = candidate
                rescan_tree = True
                updates["project_name"] = project_name
                log.info(
                    "Architect scoped project to subfolder '%s' (root=%s).",
                    project_name, new_root,
                )
            except OSError as exc:
                log.warning(
                    "Could not create project subfolder '%s': %s – "
                    "using base workspace root.",
                    project_name, exc,
                )
        else:
            log.warning(
                "Architect project_name '%s' escapes workspace root – ignored.",
                project_name_raw,
            )
    elif project_name_raw:
        log.warning(
            "Architect project_name '%s' sanitized to empty – ignored.",
            project_name_raw,
        )

    if rescan_tree:
        updates["workspace_root"] = str(new_root)

    # ── Merge workspace_tree_update (paths are relative to the subfolder) ───
    base_tree: dict[str, str] = {}
    if rescan_tree:
        # Re-scan the (possibly pre-existing) project folder so reused files
        # appear in the tree alongside the architect's planned entries.
        base_tree = WorkspaceManager(new_root).scan_tree()
    else:
        base_tree = dict(state.workspace_tree)

    if tree_update := response.get("workspace_tree_update"):
        updates["workspace_tree"] = {**base_tree, **tree_update}
    elif rescan_tree:
        updates["workspace_tree"] = base_tree

    if payload := response.get("shared_payload"):
        updates["shared_payload"] = payload
        # Persist the spec so the Reviewer can check the Coder's diff against it.
        updates["specification"] = payload

    if req := response.get("requested_files"):
        updates["requested_files"] = req

    if bitmask_hex := response.get("bitmask_update"):
        try:
            agent_mask = int(bitmask_hex, 16) if isinstance(bitmask_hex, str) else int(bitmask_hex)
            # Preserve existing status flags; replace language + action + node-ID
            new_bitmask = (
                (state.bitmask  & BitMask.STATUS_MASK)    # keep existing error flags
                | (agent_mask   & BitMask.LANGUAGE_MASK)  # language from agent
                | (agent_mask   & BitMask.ACTION_MASK)    # action from agent
                | (agent_mask   & BitMask.NODE_MASK)      # target node from agent
            ) & 0xFFFF
            updates["bitmask"] = new_bitmask
        except (ValueError, TypeError):
            log.warning("Architect returned invalid bitmask_update: %r", bitmask_hex)
            # Fallback: set NODE_CODER + ACTION_SCAFFOLD, keep language
            updates["bitmask"] = (
                (state.bitmask & BitMask.LANGUAGE_MASK)
                | BitMask.ACTION_SCAFFOLD
                | BitMask.NODE_CODER
            ) & 0xFFFF

    return state.model_copy(update=updates)
