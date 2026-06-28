"""
BitmaskRouter – purely deterministic routing via bitwise mask evaluation (spec §4.1).

All routing decisions reduce to a single bitwise operation:

    next_node = rule.target_node  if  (bitmask & rule.mask) == rule.value

Natural-language classification prompts and JSON LLM-based routers are
strictly prohibited.  Rules are loaded from a declarative routing table
(dict list or JSON file) and evaluated in priority order (lower index wins).
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from sophron_swarm.state import BitMask, SwarmState


@dataclass(frozen=True)
class RoutingRule:
    """A single declarative routing rule evaluated through bitmask masking."""
    mask:        int    # AND-mask to apply to the current bitmask
    value:       int    # Expected result after AND
    target_node: str    # Destination node identifier string
    description: str = ""  # Human-readable label (never used in routing logic)

    def matches(self, bitmask: int) -> bool:
        """Return True iff (bitmask & mask) == value."""
        return (bitmask & self.mask) == self.value


class BitmaskRouter:
    """
    Evaluates a priority-ordered list of RoutingRules against the current
    SwarmState bitmask.  The first matching rule determines the next node.

    Usage
    -----
    router = BitmaskRouter()
    router.load_from_file("config/routing_table.json")
    next_node = router.evaluate(state)   # pure bitmask arithmetic, no LLM
    """

    TERMINAL_NODE: str = "__end__"

    def __init__(self) -> None:
        self._rules: list[RoutingRule] = []

    # ── Rule loading ──────────────────────────────────────────────────────────

    def load_rules(self, rules: list[dict]) -> None:
        """
        Populate routing rules from a list of dicts.

        Each dict must contain:
          mask        – hex string (e.g. "0x0020") or plain int
          value       – hex string or plain int
          target_node – destination node id string
          description – optional human-readable label (ignored in routing)
        """
        self._rules.clear()
        for i, r in enumerate(rules):
            try:
                mask  = int(r["mask"],  16) if isinstance(r["mask"],  str) else int(r["mask"])
                value = int(r["value"], 16) if isinstance(r["value"], str) else int(r["value"])
                self._rules.append(
                    RoutingRule(
                        mask=mask,
                        value=value,
                        target_node=r["target_node"],
                        description=r.get("description", ""),
                    )
                )
            except (KeyError, ValueError, TypeError) as exc:
                raise ValueError(
                    f"Malformed routing rule at index {i}: {r} ({exc})"
                ) from exc

    def load_from_file(self, path: str | Path) -> None:
        """Load routing rules from a JSON file containing a 'routes' list."""
        try:
            data = json.loads(Path(path).read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise ValueError(f"Invalid JSON in routing table {path}: {exc}") from exc
        if "routes" not in data:
            raise ValueError(f"Routing table {path} missing 'routes' key")
        self.load_rules(data["routes"])

    def add_rule(
        self,
        mask: int,
        value: int,
        target_node: str,
        description: str = "",
        priority: Optional[int] = None,
    ) -> None:
        """Insert a rule at a given priority position (appends at end if None)."""
        rule = RoutingRule(mask=mask, value=value, target_node=target_node, description=description)
        if priority is None:
            self._rules.append(rule)
        else:
            self._rules.insert(priority, rule)

    def remove_rules_for(self, target_node: str) -> int:
        """Remove all rules pointing to a node; return count removed."""
        before = len(self._rules)
        self._rules = [r for r in self._rules if r.target_node != target_node]
        return before - len(self._rules)

    # ── Core routing evaluation (spec §4.1) ───────────────────────────────────

    def evaluate(self, state: SwarmState) -> str:
        """
        Return the target node identifier for the given state.

        Evaluation order: rules are tested in insertion order; first match wins.

        The HALT flag (bit 7) hard-wires an immediate stop regardless of rules.
        Returns TERMINAL_NODE ("__end__") if no rule matches or HALT is set.
        """
        # Hard-wire HALT flag → unconditional termination (spec §3.1 bit 7)
        if state.bitmask & BitMask.FLAG_HALT:
            return self.TERMINAL_NODE

        for rule in self._rules:
            if rule.matches(state.bitmask):
                return rule.target_node

        return self.TERMINAL_NODE

    # ── Introspection helpers ─────────────────────────────────────────────────

    def describe_rules(self) -> list[dict]:
        """Return a JSON-serialisable summary of all active routing rules."""
        return [
            {
                "priority":    i,
                "mask":        f"0x{r.mask:04X}",
                "value":       f"0x{r.value:04X}",
                "target_node": r.target_node,
                "description": r.description,
            }
            for i, r in enumerate(self._rules)
        ]
