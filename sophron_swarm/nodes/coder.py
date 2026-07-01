"""
Coder Node – Cloud-Hosted Code-Specialised Model (spec §3.3.B).

Responsibilities:
  - Read the technical specification from the Architect's shared_payload
  - Generate source code changes exclusively in Unified Diff / Patch Format
  - Signal the Local Execution Node to apply the patch and build

Strict constraint (spec §3.3.B):
  The Coder is PROHIBITED from rewriting entire files.  Every code change
  must be expressed as a standard Unified Diff::

      --- a/path/to/file
      +++ b/path/to/file
      @@ -start,count +start,count @@
       context line
      -removed line
      +added line
"""
from __future__ import annotations

import logging

from sophron_swarm.llm_client import LLMClient
from sophron_swarm.prompt_builder import PromptBuilder
from sophron_swarm.state import BitMask, SwarmState

log = logging.getLogger(__name__)

_ADDENDUM = """\
You are the CODER agent.

Your job is to implement the specification provided in SHARED_PAYLOAD or, if
SHARED_PAYLOAD contains reviewer feedback, address that feedback.

IMPORTANT: WORKSPACE_TREE is metadata only.  Files listed there may NOT exist
on disk yet.  If REQUESTED_FILE_CONTENTS shows "(file does not exist on disk)"
for a path, that file has never been created — you MUST create it from scratch.

PROJECT FOLDER: If CURRENT_PROJECT_FOLDER is set, ALL file paths you emit
(requested_files, diff headers, workspace_tree_update) are RELATIVE TO that
folder.  Do NOT prefix paths with the project folder name.

═══════════════════════════════════════════════════════════════════════════
INCREMENTAL GENERATION (one file per turn) — avoids output-token truncation.
═══════════════════════════════════════════════════════════════════════════
You MUST implement ONE file per turn.  Never attempt to emit the entire project
in a single turn — it will be truncated.  Each turn:
  1. Compare the ARCHITECT_SPECIFICATION's file list against the WORKSPACE_TREE
     (which is re-scanned after every patch, so just-created files appear).
  2. Pick exactly ONE not-yet-existing file from the spec and implement ONLY it
     as a single new-file diff (from /dev/null).
  3. Set ACTION_PATCH=0x0500 and NODE_SANDBOX=0x0003 so the sandbox applies it.
  4. On the NEXT turn the sandbox will have applied your file and returned control
     to you with an updated WORKSPACE_TREE.  Repeat for the next missing file.
  5. When EVERY file the spec requires already exists in WORKSPACE_TREE, you are
     DONE: set NODE_REVIEWER=0x0005 (bits 3-0), action 0000 (idle), and put a
     one-line summary like "All N files implemented." in shared_payload.

DIFF FORMAT (strict):
- You MUST NEVER rewrite entire existing files.
- All code changes must be expressed in standard Unified Diff format:
    --- /dev/null            (for new files)
    +++ b/path/to/file
    @@ -0,0 +1,N @@
    +<file content, one + line per source line>
- Place the diff for the single file in shared_payload.
- Strip leading slashes from file paths.  Use "index.html", not "/index.html".

CORRECTION TURNS: If SHARED_PAYLOAD contains reviewer feedback (not a spec),
address every issue by emitting a corrective diff for the affected file(s),
then route back to NODE_REVIEWER=0x0005.

Output bitmask_update:
  - For each new file:     preserve language, set 0x0500 (ACTION_PATCH + NODE_SANDBOX).
  - When all files exist:  preserve language, set 0x0002 (NODE_CODER, action idle)
                           is WRONG — set NODE_REVIEWER: example Node.js "0x2005".
"""

_builder = PromptBuilder()


async def coder_node(state: SwarmState, llm: LLMClient) -> SwarmState:
    """Invoke the Coder agent and return updated SwarmState."""
    messages = _builder.build(state, _ADDENDUM)
    raw      = await llm.complete(messages)
    log.debug("Coder raw response (first 400 chars): %s", raw[:400])
    response = _builder.extract_response(raw)
    return _apply_response(state, response)


def _apply_response(state: SwarmState, response: dict) -> SwarmState:
    updates: dict = {}

    if payload := response.get("shared_payload"):
        updates["shared_payload"] = payload

    if tree_update := response.get("workspace_tree_update"):
        updates["workspace_tree"] = {**state.workspace_tree, **tree_update}

    if req := response.get("requested_files"):
        updates["requested_files"] = req

    if bitmask_hex := response.get("bitmask_update"):
        try:
            agent_mask = int(bitmask_hex, 16) if isinstance(bitmask_hex, str) else int(bitmask_hex)
            target_node = agent_mask & BitMask.NODE_MASK
            target_action = agent_mask & BitMask.ACTION_MASK

            # Defensive guard: if the coder emits a diff (ACTION_PATCH) but sets
            # the node-ID to 0x0 (none) — a common model slip — force it to
            # NODE_SANDBOX. A patch MUST go to the sandbox to be applied; node-ID
            # 0x0 has no routing rule and would silently terminate the run.
            if target_action == BitMask.ACTION_PATCH and target_node == 0x0:
                log.warning(
                    "Coder emitted ACTION_PATCH with node-ID 0x0 (none) — "
                    "correcting to NODE_SANDBOX (0x3) to avoid silent termination."
                )
                target_node = BitMask.NODE_SANDBOX

            new_bitmask = (
                (state.bitmask & BitMask.STATUS_MASK)
                | (agent_mask  & BitMask.LANGUAGE_MASK)
                | (agent_mask  & BitMask.ACTION_MASK)
                | target_node
            ) & 0xFFFF
            updates["bitmask"] = new_bitmask
            # Drive the incremental loop: emit one file at a time to the sandbox,
            # which routes back to us until we're done, then hand off to the reviewer.
            if target_node == BitMask.NODE_SANDBOX:
                updates["incremental_mode"] = True
            elif target_node == BitMask.NODE_REVIEWER:
                updates["incremental_mode"] = False
        except (ValueError, TypeError):
            log.warning("Coder returned invalid bitmask_update: %r", bitmask_hex)
            # Fallback: ACTION_PATCH + NODE_SANDBOX (start incremental loop)
            updates["bitmask"] = (
                (state.bitmask & BitMask.LANGUAGE_MASK)
                | BitMask.ACTION_PATCH
                | BitMask.NODE_SANDBOX
            ) & 0xFFFF
            updates["incremental_mode"] = True

    return state.model_copy(update=updates)
