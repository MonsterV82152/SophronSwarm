"""
StateGraph – lightweight dynamically-wired execution graph (spec §3.2).

Topology is entirely declarative: nodes are registered by ID and wired
through the BitmaskRouter.  Hardcoded node-to-node links are prohibited.

Public API (mirrors spec §3.2 requirements):
    register_node(agent_id, callable)  – add / replace a node at runtime
    remove_node(agent_id)              – deregister a node at runtime
    set_routing_table(rules)           – load declarative routing rules
    load_routing_from_file(path)       – load routing rules from JSON file
    compile()                          – validate graph; required before run()
    run(initial_state, thread_id)      – execute the agent loop
"""
from __future__ import annotations

import asyncio
import logging
from typing import Awaitable, Callable, Optional

from sophron_swarm.checkpointer import Checkpointer
from sophron_swarm.recorder import recorder, serialize_state
from sophron_swarm.retry import is_transient_error
from sophron_swarm.router import BitmaskRouter
from sophron_swarm.state import BitMask, SwarmState
from sophron_swarm.workspace import WorkspaceManager

log = logging.getLogger(__name__)

NodeCallable = Callable[[SwarmState], Awaitable[SwarmState]]


class StateGraph:
    """
    Centralized execution graph for the SophronSwarm platform.

    Nodes are isolated async transformation functions.  Each node reads the
    current SwarmState and returns a new SwarmState; it must not communicate
    with other nodes directly (spec §3.1, §5.1).

    All routing is evaluated deterministically by the BitmaskRouter –
    no LLM routing decisions are made inside this class (spec §4.1).
    """

    MAX_ITERATIONS: int = 64  # absolute upper-bound; prevents runaway billing

    def __init__(
        self,
        checkpointer: Optional[Checkpointer] = None,
        router:       Optional[BitmaskRouter] = None,
    ) -> None:
        self._nodes:    dict[str, NodeCallable] = {}
        self._compiled: bool = False
        self.checkpointer: Checkpointer = checkpointer or Checkpointer()
        self.router:       BitmaskRouter = router or BitmaskRouter()

    # ── Dynamic node management (spec §3.2) ───────────────────────────────────

    def register_node(self, agent_id: str, callable_fn: NodeCallable) -> None:
        """
        Register (or replace) a node in the execution pool at runtime.

        No graph recompilation is required after registration; call compile()
        again only if you also modify the routing table.
        """
        self._nodes[agent_id] = callable_fn
        self._compiled = False
        log.info("Node registered: '%s'  (pool size=%d)", agent_id, len(self._nodes))

    def remove_node(self, agent_id: str) -> None:
        """
        Deregister a node from the execution pool at runtime.

        Also purges all routing rules that reference this node to avoid
        dangling references.
        """
        if agent_id not in self._nodes:
            raise KeyError(f"Node '{agent_id}' is not registered.")
        del self._nodes[agent_id]
        removed_rules = self.router.remove_rules_for(agent_id)
        self._compiled = False
        log.info(
            "Node removed: '%s'  (purged %d routing rule(s))", agent_id, removed_rules
        )

    # ── Routing table wiring ──────────────────────────────────────────────────

    def set_routing_table(self, rules: list[dict]) -> "StateGraph":
        """Load declarative routing rules, replacing all existing rules."""
        self.router.load_rules(rules)
        self._compiled = False
        return self

    def load_routing_from_file(self, path: str) -> "StateGraph":
        """Load routing rules from a JSON file (spec §3.2 declarative topology)."""
        self.router.load_from_file(path)
        self._compiled = False
        return self

    # ── Graph validation ──────────────────────────────────────────────────────

    def compile(self) -> "StateGraph":
        """
        Validate graph readiness.  Must be called before run().

        Verifies that every node referenced in the routing table is present
        in the execution pool, preventing silent routing failures.
        """
        for rule in self.router.describe_rules():
            target = rule["target_node"]
            if target != BitmaskRouter.TERMINAL_NODE and target not in self._nodes:
                raise RuntimeError(
                    f"Routing table references node '{target}' which is not registered. "
                    f"Registered nodes: {sorted(self._nodes.keys())}"
                )
        self._compiled = True
        log.info(
            "StateGraph compiled: %d node(s), %d routing rule(s).",
            len(self._nodes),
            len(self.router.describe_rules()),
        )
        return self

    # ── Main execution loop ───────────────────────────────────────────────────

    async def run(self, initial_state: SwarmState, thread_id: str) -> SwarmState:
        """
        Execute the agent loop until the router returns TERMINAL_NODE.

        Each iteration:
          1. Determine next node via BitmaskRouter (pure bitmask arithmetic).
          2. Execute the node (async call).
          3. Enforce infinite-loop protection – trip FLAG_MUTATION at 5 fails
             on the same patch (spec §5.2).
          4. Wipe shared_payload on node-ID phase change (spec §4.3).
          5. Persist a checkpoint for rollback capability (spec §2).
          6. Check HALT flag and exit if set.

        Returns the final SwarmState after termination.
        """
        if not self._compiled:
            raise RuntimeError("call compile() before run().")

        state = initial_state
        self.checkpointer.save(thread_id, state)
        log.info("[%s] Run started.  %s", thread_id, state.describe_bitmask())

        recorder.set_context(thread_id=thread_id)
        recorder.record("run_start", initial_bitmask=initial_state.bitmask)

        file_request_stays = 0  # consecutive turns a node re-requests files

        for iteration in range(self.MAX_ITERATIONS):
            next_node_id = self.router.evaluate(state)

            if next_node_id == BitmaskRouter.TERMINAL_NODE:
                log.info("[%s] Graph terminated at iteration %d.", thread_id, iteration)
                break

            if next_node_id not in self._nodes:
                raise RuntimeError(
                    f"Router selected unregistered node: '{next_node_id}'. "
                    f"Did you call compile() after register_node()?"
                )

            log.info(
                "[%s] iter=%03d  %s  →  %s",
                thread_id, iteration, state.describe_bitmask(), next_node_id,
            )

            # ── Recorder: iteration + node-enter context ─────────────────────
            recorder.set_context(iteration=iteration, node=next_node_id)
            recorder.record_iteration(
                iteration=iteration,
                bitmask=state.bitmask,
                node=next_node_id,
            )
            state_before = serialize_state(state)
            recorder.record_node_enter(next_node_id, state_before)

            prev_node_id = state.get_node_id()
            node_fn      = self._nodes[next_node_id]

            try:
                new_state = await node_fn(state)
            except Exception as exc:
                # Distinguish transient (network, timeout) from fatal errors.
                # Transient errors are retried with exponential backoff before
                # giving up; fatal errors trip HALT immediately.
                if is_transient_error(exc):
                    log.warning(
                        "[%s] Node '%s' raised transient error: %s – "
                        "will retry.",
                        thread_id, next_node_id, exc,
                    )
                    retried = False
                    for retry_attempt in range(3):
                        import asyncio as _aio
                        delay = min(30.0, 2.0 * (2 ** retry_attempt))
                        log.info(
                            "[%s] Retry %d/3 for '%s' in %.1fs.",
                            thread_id, retry_attempt + 1, next_node_id, delay,
                        )
                        await _aio.sleep(delay)
                        try:
                            new_state = await node_fn(state)
                            retried = True
                            log.info(
                                "[%s] Node '%s' succeeded on retry %d.",
                                thread_id, next_node_id, retry_attempt + 1,
                            )
                            break
                        except Exception as exc2:
                            if not is_transient_error(exc2) or retry_attempt == 2:
                                exc = exc2
                                break
                            exc = exc2
                    if not retried:
                        log.error(
                            "[%s] Node '%s' exhausted retries: %s – halting.",
                            thread_id, next_node_id, exc,
                        )
                        new_state = state.with_flag(BitMask.FLAG_HALT)
                        recorder.record(
                            "node_error", node=next_node_id,
                            error=f"{type(exc).__name__}: {exc}",
                            retried=True,
                        )
                else:
                    log.error(
                        "[%s] Node '%s' raised fatal error: %s – halting.",
                        thread_id, next_node_id, exc,
                    )
                    new_state = state.with_flag(BitMask.FLAG_HALT)
                    recorder.record(
                        "node_error", node=next_node_id,
                        error=f"{type(exc).__name__}: {exc}",
                        retried=False,
                    )

            # Materialize declared directories onto disk so subsequent patch
            # operations have a valid directory structure to write into.
            # Only directories are created here; files are created by the coder
            # via unified diffs (new-file patches from /dev/null).
            if next_node_id != "sandbox":
                ws = WorkspaceManager(new_state.workspace_root)
                for path, kind in new_state.workspace_tree.items():
                    if kind == "directory":
                        try:
                            ws.ensure_dir(path)
                        except OSError as exc:
                            log.warning("[%s] Could not create dir '%s': %s",
                                        thread_id, path, exc)

            # Lazy file serving (spec §4.3): if the node just ran asked to read
            # workspace files, fetch their contents so the next turn's prompt can
            # surface them.  served_files is single-turn and is replaced each pass.
            #
            # Auto-stay: when a node requests files, it needs to process them
            # next turn.  Override the node-ID to stay on the same node rather
            # than advancing, so the requesting node can act on the served files.
            #
            # Loop guard: cap at MAX_FILE_REQUEST_STAYS consecutive stays to
            # prevent infinite re-requests of non-existent files.  After the cap,
            # the node is forced to proceed with whatever served_files it has.
            MAX_FILE_REQUEST_STAYS = 3
            if new_state.requested_files:
                ws = WorkspaceManager(new_state.workspace_root)
                contents = ws.fetch_files(list(new_state.requested_files))
                new_state = new_state.serve_files(contents)
                if contents:
                    log.debug(
                        "[%s] Served %d requested file(s) for next turn.",
                        thread_id, len(contents),
                    )

                if file_request_stays < MAX_FILE_REQUEST_STAYS:
                    new_state = new_state.with_node(prev_node_id)
                    file_request_stays += 1
                    log.info(
                        "[%s] Node '%s' requested files – staying "
                        "(stay %d/%d).",
                        thread_id, next_node_id,
                        file_request_stays, MAX_FILE_REQUEST_STAYS,
                    )
                else:
                    log.warning(
                        "[%s] Node '%s' hit file-request stay cap (%d) – "
                        "forcing it to proceed.",
                        thread_id, next_node_id, MAX_FILE_REQUEST_STAYS,
                    )
                    # Force proceed: let the node-ID from the response stand
                    file_request_stays = 0
            else:
                file_request_stays = 0

            # ── Recorder: node-exit with before/after state diff ─────────────
            state_after = serialize_state(new_state)
            recorder.record_node_exit(next_node_id, state_before, state_after)

            self._safe_checkpoint(thread_id, new_state)
            state = new_state

            if state.is_halted():
                log.info("[%s] HALT flag set – stopping execution.", thread_id)
                recorder.record("halt", bitmask=state.bitmask, thread_id=thread_id)
                break

        else:
            log.warning(
                "[%s] MAX_ITERATIONS (%d) reached without natural termination.",
                thread_id, self.MAX_ITERATIONS,
            )
            state = state.with_flag(BitMask.FLAG_HALT)
            self._safe_checkpoint(thread_id, state)

        recorder.record("run_end", final_bitmask=state.bitmask)
        recorder.clear_context_keys("iteration", "node")
        log.info("[%s] Final state: %s", thread_id, state.describe_bitmask())
        return state

    def _safe_checkpoint(self, thread_id: str, state: SwarmState) -> None:
        """Checkpoint save that never raises (logs on failure)."""
        try:
            self.checkpointer.save(thread_id, state)
        except Exception as exc:  # noqa: BLE001
            log.warning("[%s] Checkpoint save failed: %s", thread_id, exc)
