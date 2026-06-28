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

Your job is to implement the specification provided in SHARED_PAYLOAD.

IMPORTANT: WORKSPACE_TREE is metadata only.  Files listed there may NOT exist
on disk yet.  If REQUESTED_FILE_CONTENTS shows "(file does not exist on disk)"
for a path, that file has never been created — you MUST create it from scratch.

STRICT CONSTRAINTS:
- You MUST NEVER rewrite entire files.
- All code changes must be expressed in standard Unified Diff format:
    --- a/path/to/file
    +++ b/path/to/file
    @@ -start,count +start,count @@
     context line
    -removed line
    +added line
- Place the complete unified diff in shared_payload.
- Do NOT request files that don't exist yet.  Only request files you need to
  READ before EDITING.  For a new project, CREATE the files directly.

CREATING NEW FILES (when the file does not exist yet on disk):
  Use /dev/null as the source (---) line.  Example:
    --- /dev/null
    +++ b/index.html
    @@ -0,0 +1,N @@
    +<entire file content, one + line per source line>
  IMPORTANT: Strip leading slashes from file paths.  Use "index.html", not "/index.html".

IMPLEMENTATION ORDER:
  1. Implement ALL files specified in SHARED_PAYLOAD as a single combined
     unified diff in shared_payload.  Concatenate one diff hunk per file.
  2. Create every file from /dev/null on your FIRST turn — do not waste turns
     requesting files that don't exist.
  3. Set ACTION_PATCH=0x0500 and NODE_SANDBOX=0x0003 to apply the diff.
  4. Only use requested_files to read EXISTING files before modifying them.

Output bitmask_update:
  - Preserve language (bits 15-12).
  - Set ACTION_PATCH=0x0500 (bits 11-8).
  - Set NODE_SANDBOX=0x0003 (bits 3-0) when ready to apply the patch.
  Example for Node.js: "0x2503"
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
            new_bitmask = (
                (state.bitmask & BitMask.STATUS_MASK)
                | (agent_mask  & BitMask.LANGUAGE_MASK)
                | (agent_mask  & BitMask.ACTION_MASK)
                | (agent_mask  & BitMask.NODE_MASK)
            ) & 0xFFFF
            updates["bitmask"] = new_bitmask
        except (ValueError, TypeError):
            log.warning("Coder returned invalid bitmask_update: %r", bitmask_hex)
            # Fallback: ACTION_PATCH + NODE_SANDBOX, preserve language
            updates["bitmask"] = (
                (state.bitmask & BitMask.LANGUAGE_MASK)
                | BitMask.ACTION_PATCH
                | BitMask.NODE_SANDBOX
            ) & 0xFFFF

    return state.model_copy(update=updates)
