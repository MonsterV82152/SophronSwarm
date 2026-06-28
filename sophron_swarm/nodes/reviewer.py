"""
Reviewer Node – Cloud-Hosted Code-Review Model (spec §3.3.E).

Responsibilities:
  - Receive the Coder's unified diff (in shared_payload) for review.
  - Check it against the Architect's technical specification
    (persisted in state.specification) and the immutable project_requirements.
  - If the diff satisfies the architecture requirements: forward it unchanged
    to the Sandbox for patch + build (preserve ACTION_PATCH + NODE_SANDBOX).
  - If requirements are NOT met: delegate back to the Coder by clearing the
    approval path, routing to NODE_CODER, and placing concrete, actionable
    feedback in shared_payload so the Coder can correct the work.

The Reviewer never rewrites the diff itself; it is an approval gate that either
lets the diff through or bounces it back with feedback.
"""
from __future__ import annotations

import logging

from sophron_swarm.llm_client import LLMClient
from sophron_swarm.prompt_builder import PromptBuilder
from sophron_swarm.state import BitMask, SwarmState

log = logging.getLogger(__name__)

_ADDENDUM = """\
You are the REVIEWER agent.

You have received a unified diff (in SHARED_PAYLOAD) produced by the CODER agent.
Your job is to review it against the ARCHITECT_SPECIFICATION and the PROJECT
REQUIREMENTS, then decide whether it is ready to be applied and built.

Review checklist (be strict but fair):
1. COMPLETENESS – Does the diff implement EVERY file/feature the spec lists?
   Flag any missing file, endpoint, UI section, or required capability.
2. ARCHITECTURE COMPLIANCE – Does the structure match the spec's blueprint
   (directory layout, tech stack, module responsibilities)?
3. CORRECTNESS – Obvious bugs, broken references, undefined variables, missing
   script/link tags, mismatched element IDs between HTML and JS.
4. UNIFIED-DIFF VALIDITY – The diff must contain valid '--- '/'+++ ' headers and
   '+' lines; flag garbage or prose masquerading as a diff.

DECISION (set in bitmask_update):
  - APPROVE: preserve the language (bits 15-12), set ACTION_PATCH=0x0500
    (bits 11-8), set NODE_SANDBOX=0x0003 (bits 3-0).  Example for Node.js: "0x2503".
    Do NOT change shared_payload – leave the coder's diff untouched so the sandbox
    applies exactly what you approved.  Do NOT set any error flags.
  - REJECT (delegate back to coder): preserve the language, set NODE_CODER=0x0002
    (bits 3-0), action 0000 (idle).  Example for Node.js: "0x2002".  You MUST put
    concrete, specific feedback in shared_payload: list each problem, the file it
    affects, and exactly what the coder must add or change.  Do not be vague.

STRICT CONSTRAINTS:
- Output ONLY the JSON object.
- When APPROVING, copy the coder's diff verbatim into shared_payload (do not edit it).
- When REJECTING, replace shared_payload entirely with your feedback (the coder will
  read it next turn and produce a corrected diff).
"""

_builder = PromptBuilder()


async def reviewer_node(state: SwarmState, llm: LLMClient) -> SwarmState:
    """Invoke the Reviewer agent and return the updated SwarmState."""
    # Safety net: if there's nothing to review, bounce straight to the sandbox
    # so we don't stall the pipeline on an empty payload.
    if not state.shared_payload.strip():
        log.warning("Reviewer: shared_payload is empty – forwarding to sandbox.")
        new_bitmask = (
            (state.bitmask & BitMask.LANGUAGE_MASK)
            | BitMask.ACTION_PATCH
            | BitMask.NODE_SANDBOX
        ) & 0xFFFF
        return state.model_copy(update={"bitmask": new_bitmask})

    messages = _builder.build(state, _ADDENDUM)
    raw = await llm.complete(messages)
    log.debug("Reviewer raw response (first 400 chars): %s", raw[:400])
    response = _builder.extract_response(raw)
    return _apply_response(state, response)


def _apply_response(state: SwarmState, response: dict) -> SwarmState:
    """Merge the Reviewer JSON response back into SwarmState."""
    updates: dict = {}

    bitmask_hex = response.get("bitmask_update")
    payload = response.get("shared_payload")

    if bitmask_hex:
        try:
            agent_mask = int(bitmask_hex, 16) if isinstance(bitmask_hex, str) else int(bitmask_hex)
            target_node = agent_mask & BitMask.NODE_MASK

            if target_node == BitMask.NODE_SANDBOX:
                # APPROVED: forward the diff to the sandbox unchanged.
                # Keep the coder's diff in shared_payload; only fall back to the
                # response payload if the model replaced it (it should not).
                if payload and "--- " in payload:
                    updates["shared_payload"] = payload
                else:
                    updates["shared_payload"] = state.shared_payload
                # Clear any stale error flags from a prior failed build cycle.
                cleared = state.bitmask & ~(BitMask.FLAG_BUILD_ERR | BitMask.FLAG_TEST_FAIL)
                new_bitmask = (
                    (cleared & BitMask.STATUS_MASK)
                    | (agent_mask & BitMask.LANGUAGE_MASK)
                    | BitMask.ACTION_PATCH
                    | BitMask.NODE_SANDBOX
                ) & 0xFFFF
                updates["bitmask"] = new_bitmask
                log.info("Reviewer APPROVED the diff – forwarding to sandbox.")
            else:
                # REJECTED (or any other target): treat as delegate-back-to-coder.
                updates["shared_payload"] = payload if payload else state.shared_payload
                new_bitmask = (
                    (state.bitmask & BitMask.STATUS_MASK)
                    | (agent_mask & BitMask.LANGUAGE_MASK)
                    | BitMask.NODE_CODER
                ) & 0xFFFF
                updates["bitmask"] = new_bitmask
                log.info("Reviewer REJECTED the diff – delegating back to coder.")
        except (ValueError, TypeError):
            log.warning("Reviewer returned invalid bitmask_update: %r", bitmask_hex)
            # Fail-safe: assume rejection, route back to coder with the response.
            updates["shared_payload"] = payload if payload else state.shared_payload
            updates["bitmask"] = (
                (state.bitmask & (BitMask.STATUS_MASK | BitMask.LANGUAGE_MASK))
                | BitMask.NODE_CODER
            ) & 0xFFFF
    else:
        # No decision emitted – conservatively bounce back to the coder.
        updates["shared_payload"] = payload if payload else state.shared_payload
        updates["bitmask"] = (
            (state.bitmask & (BitMask.STATUS_MASK | BitMask.LANGUAGE_MASK))
            | BitMask.NODE_CODER
        ) & 0xFFFF

    if req := response.get("requested_files"):
        updates["requested_files"] = req

    return state.model_copy(update=updates)
