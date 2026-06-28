"""
PromptBuilder – constructs cloud API prompts in the volatility-ordered block
structure required for maximum prompt-cache efficiency (spec §4.4).

Block ordering (ascending volatility – stable prefix first):

  [Position 0]  Static system prompt  – model rules, operational schema, bitmask key
  [Position 1]  Static project scope  – immutable user requirements (never changes)
  [Position 2]  Volatile context      – ephemeral shared_payload + current bitmask value

By keeping high-volatility content strictly at the final index boundary,
cloud API gateways can match the stable prefix against their prompt cache,
minimising repeated processing costs on every iteration.
"""
from __future__ import annotations

import json
import re
from typing import Any

from sophron_swarm.state import SwarmState


class PromptBuilder:
    """
    Assembles message lists optimised for cloud provider prefix caching.

    The first two blocks are structurally identical between turns; only
    the final user message changes.
    """

    # ── Block 0: static system prompt (never changes between turns) ───────────
    _SYSTEM_PROMPT = (
        "You are a specialised software engineering agent operating inside the "
        "SophronSwarm multi-agent platform.\n\n"
        "COMMUNICATION PROTOCOL:\n"
        "You communicate with the swarm exclusively by returning a single JSON object "
        "with the following keys:\n"
        "  bitmask_update      – hex string (16-bit); the bitmask value you are setting\n"
        "  workspace_tree_update – dict mapping path → 'file'|'directory' (no content)\n"
        "  shared_payload      – string; your output for the next node\n"
        "  requested_files     – list of workspace-relative paths you need to read\n\n"
        "IMPORTANT CONSTRAINTS:\n"
        "- Never include file content in workspace_tree_update.\n"
        "- shared_payload is single-turn and ephemeral; do not assume persistence.\n"
        "- To read a file, list its path in requested_files; the runtime serves it next turn.\n"
        "- Output ONLY the JSON object. No markdown fences, no explanation.\n\n"
        "BITMASK REFERENCE:\n"
        "  Bits 15-12  Language: 0000=shell  0001=python  0010=nodejs  0011=rust  0100=go  0101=cpp\n"
        "  Bits 11-8   Action:   0000=idle   0001=scaffold 0010=install_deps 0011=build 0100=test 0101=patch\n"
        "  Bits 7-4    Flags:    bit7=HALT   bit6=TEST_FAIL   bit5=BUILD_ERR   bit4=MUTATION\n"
        "  Bits 3-0    Node:     0001=architect  0010=coder  0011=sandbox  0100=debugger  0101=reviewer\n"
    )

    def build(
        self,
        state: SwarmState,
        agent_system_addendum: str = "",
        *,
        include_workspace_tree: bool = True,
    ) -> list[dict[str, Any]]:
        """
        Return a messages list ordered for maximum prefix-cache efficiency.

        Parameters
        ----------
        state:
            The current SwarmState.
        agent_system_addendum:
            Agent-specific rules appended to the base system prompt.
        include_workspace_tree:
            Include the workspace_tree in the volatile context block.
        """
        messages: list[dict[str, Any]] = []

        # ── Block 0: static system prompt (position 0 – lowest volatility) ───
        system_content = self._SYSTEM_PROMPT
        if agent_system_addendum:
            system_content += f"\nAGENT-SPECIFIC RULES:\n{agent_system_addendum}\n"
        messages.append({"role": "system", "content": system_content})

        # ── Block 1: static project scope (position 1 – immutable) ──────────
        if state.project_requirements:
            messages.append({
                "role": "user",
                "content": (
                    "PROJECT REQUIREMENTS (immutable – never modify this scope):\n"
                    + state.project_requirements
                ),
            })
            messages.append({
                "role": "assistant",
                "content": '{"acknowledged": "Project requirements loaded."}',
            })

        # ── Block 2: volatile iteration context (position 2 – highest volatility)
        volatile_parts: list[str] = [
            f"CURRENT_BITMASK: 0x{state.bitmask:04X}",
            f"  ({state.describe_bitmask()})",
        ]

        if include_workspace_tree and state.workspace_tree:
            # Cap at 50 entries to avoid prompt inflation (spec §4.3 lazy access)
            capped = dict(list(state.workspace_tree.items())[:50])
            volatile_parts.append(f"\nWORKSPACE_TREE:\n{json.dumps(capped, indent=2)}")

        if state.specification:
            volatile_parts.append(f"\nARCHITECT_SPECIFICATION:\n{state.specification}")

        if state.shared_payload:
            volatile_parts.append(f"\nSHARED_PAYLOAD:\n{state.shared_payload}")

        if state.served_files:
            files_block = json.dumps(state.served_files, indent=2)
            volatile_parts.append(f"\nREQUESTED_FILE_CONTENTS:\n{files_block}")

        messages.append({"role": "user", "content": "\n".join(volatile_parts)})

        return messages

    def extract_response(self, raw: str) -> dict[str, Any]:
        """
        Parse the agent's JSON response string.

        Strips markdown code fences if the model wraps the output.
        Returns an empty dict on any parse failure so callers degrade gracefully.
        """
        # Strip markdown fences if present
        fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", raw)
        candidate = fence.group(1).strip() if fence else raw.strip()

        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            return {}
