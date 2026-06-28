"""
Debugger Node – Cloud-Hosted Mid-Tier Reasoning Model (spec §3.3.D).

Responsibilities:
  - Triggered exclusively when FLAG_BUILD_ERR (bit 5) or FLAG_TEST_FAIL (bit 6) is set.
  - Reads the purified error log from shared_payload.
  - Produces a targeted minimal unified diff correction.
  - Clears the relevant error flags on successful analysis.

Infinite-loop protection (spec §5.2):
  If failure_streak reaches the threshold (5 consecutive failures on the same
  patch segment), FLAG_MUTATION is tripped and execution halts to protect the
  cloud API budget.
"""
from __future__ import annotations

import logging

from sophron_swarm.llm_client import LLMClient
from sophron_swarm.prompt_builder import PromptBuilder
from sophron_swarm.state import BitMask, SwarmState

log = logging.getLogger(__name__)

_MAX_FAILURE_STREAK = 5

_ADDENDUM = """\
You are the DEBUGGER agent.

You have been invoked because a compilation or test failure occurred.
SHARED_PAYLOAD contains a purified error log.

Your task:
1. Identify the exact root cause from the error output.
2. Produce a MINIMAL unified diff patch that corrects the fault.
3. Do NOT rewrite entire files.  Output changes in Unified Diff format only.

Output bitmask_update:
  - Preserve language (bits 15-12).
  - Set ACTION_PATCH=0x0500 (bits 11-8).
  - Set NODE_SANDBOX=0x0003 (bits 3-0).
  - Do NOT set BUILD_ERR or TEST_FAIL bits (your fix clears them).
  Example for Python: "0x1503"

Place the unified diff fix in shared_payload.
"""

_builder = PromptBuilder()


async def debugger_node(state: SwarmState, llm: LLMClient) -> SwarmState:
    """Invoke the Debugger agent and return updated SwarmState."""
    # Spec §5.2: trip MUTATION flag and halt after 5 consecutive failures
    if state.failure_streak >= _MAX_FAILURE_STREAK:
        log.warning(
            "failure_streak=%d reached threshold %d – tripping FLAG_MUTATION and halting.",
            state.failure_streak, _MAX_FAILURE_STREAK,
        )
        return (
            state
            .with_flag(BitMask.FLAG_MUTATION)
            .with_flag(BitMask.FLAG_HALT)
        )

    messages = _builder.build(state, _ADDENDUM)
    raw      = await llm.complete(messages)
    log.debug("Debugger raw response (first 400 chars): %s", raw[:400])
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
            # Debugger explicitly clears BUILD_ERR and TEST_FAIL on analysis
            cleared_flags = state.bitmask & ~(BitMask.FLAG_BUILD_ERR | BitMask.FLAG_TEST_FAIL)
            new_bitmask = (
                (cleared_flags  & BitMask.STATUS_MASK)
                | (agent_mask   & BitMask.LANGUAGE_MASK)
                | (agent_mask   & BitMask.ACTION_MASK)
                | (agent_mask   & BitMask.NODE_MASK)
            ) & 0xFFFF
            updates["bitmask"] = new_bitmask
        except (ValueError, TypeError):
            log.warning("Debugger returned invalid bitmask_update: %r", bitmask_hex)
            updates["bitmask"] = (
                (state.bitmask & ~(BitMask.FLAG_BUILD_ERR | BitMask.FLAG_TEST_FAIL) & BitMask.LANGUAGE_MASK)
                | BitMask.ACTION_PATCH
                | BitMask.NODE_SANDBOX
            ) & 0xFFFF

    # Increment failure streak; the sandbox resets it to 0 on a successful patch
    updates["failure_streak"] = state.failure_streak + 1

    return state.model_copy(update=updates)
