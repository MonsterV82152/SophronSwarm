"""
SophronSwarm – main entry point.

Constructs the multi-agent StateGraph, wires the declarative routing table,
and launches a complete software engineering task from a user requirements
document.

Usage (environment variables):
  OPENAI_API_KEY          – required for cloud model access
  SOPHRON_WORKSPACE       – local workspace directory (default: ~/sophron_workspace)
  SOPHRON_ARCHITECT_MODEL – frontier model for architect (default: gpt-4o)
  SOPHRON_CODER_MODEL     – code-specialised model for coder (default: gpt-4o)
  SOPHRON_DEBUGGER_MODEL  – mid-tier model for debugger (default: gpt-4o-mini)

Note: the target language is chosen autonomously by the Architect agent based on
the project requirements. No language flag is needed.
"""
from __future__ import annotations

import asyncio
import logging
import os
import sys
from pathlib import Path
from typing import Optional

from sophron_swarm.checkpointer import Checkpointer
from sophron_swarm.debug_server import start_debug_server
from sophron_swarm.graph import StateGraph
from sophron_swarm.llm_client import LLMClient, OpenAICompatibleClient, OpenRouterClient
from sophron_swarm.nodes.architect import architect_node
from sophron_swarm.nodes.coder import coder_node
from sophron_swarm.nodes.debugger import debugger_node
from sophron_swarm.nodes.reviewer import reviewer_node
from sophron_swarm.nodes.sandbox import sandbox_node
from sophron_swarm.recorder import recorder
from sophron_swarm.router import BitmaskRouter
from sophron_swarm.state import BitMask, SwarmState
from sophron_swarm.workspace import WorkspaceManager

from dotenv import load_dotenv

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(name)s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger(__name__)

# Routing table location (relative to this file)
_ROUTING_TABLE = Path(__file__).parent / "config" / "routing_table.json"


def build_graph(
    llm_architect: LLMClient,
    llm_coder:     LLMClient,
    llm_reviewer:  LLMClient,
    llm_debugger:  LLMClient,
    db_path:       str = ":memory:",
) -> StateGraph:
    """
    Assemble and compile the SophronSwarm StateGraph.

    Node registration and routing table loading follow spec §3.2:
      - Nodes are registered via register_node(); no hardcoded links.
      - Routing is purely declarative from config/routing_table.json.

    Parameters
    ----------
    llm_architect : LLMClient  – frontier model client for the Architect agent
    llm_coder     : LLMClient  – code-specialised client for the Coder agent
    llm_reviewer  : LLMClient  – code-review client for the Reviewer agent
    llm_debugger  : LLMClient  – mid-tier reasoning client for the Debugger agent
    db_path       : str        – SQLite path for the checkpointer; ":memory:" by default
    """
    checkpointer = Checkpointer(db_path=db_path)
    router       = BitmaskRouter()
    graph        = StateGraph(checkpointer=checkpointer, router=router)

    # ── Register agent nodes (spec §3.2 register_node API) ───────────────────

    async def _architect(state: SwarmState) -> SwarmState:
        return await architect_node(state, llm_architect)

    async def _coder(state: SwarmState) -> SwarmState:
        return await coder_node(state, llm_coder)

    async def _reviewer(state: SwarmState) -> SwarmState:
        return await reviewer_node(state, llm_reviewer)

    async def _debugger(state: SwarmState) -> SwarmState:
        return await debugger_node(state, llm_debugger)

    graph.register_node("architect", _architect)
    graph.register_node("coder",     _coder)
    graph.register_node("reviewer",  _reviewer)
    graph.register_node("sandbox",   sandbox_node)
    graph.register_node("debugger",  _debugger)

    # ── Load declarative routing table ───────────────────────────────────────
    if _ROUTING_TABLE.exists():
        graph.load_routing_from_file(str(_ROUTING_TABLE))
        log.info("Routing table loaded from %s", _ROUTING_TABLE)
    else:
        log.warning("routing_table.json not found – using inline fallback rules.")
        graph.set_routing_table([
            {"mask": "0x0080", "value": "0x0080", "target_node": "__end__",  "description": "HALT"},
            {"mask": "0x0010", "value": "0x0010", "target_node": "__end__",  "description": "MUTATION"},
            {"mask": "0x0020", "value": "0x0020", "target_node": "debugger", "description": "BUILD_ERR"},
            {"mask": "0x0040", "value": "0x0040", "target_node": "debugger", "description": "TEST_FAIL"},
            {"mask": "0x000F", "value": "0x0001", "target_node": "architect"},
            {"mask": "0x000F", "value": "0x0002", "target_node": "coder"},
            {"mask": "0x000F", "value": "0x0003", "target_node": "sandbox"},
            {"mask": "0x000F", "value": "0x0004", "target_node": "debugger"},
            {"mask": "0x000F", "value": "0x0005", "target_node": "reviewer"},
        ])

    return graph.compile()


async def run_task(
    requirements:  str,
    workspace_root: str,
    llm_architect: LLMClient,
    llm_coder:     LLMClient,
    llm_reviewer:  LLMClient,
    llm_debugger:  LLMClient,
    thread_id:     str = "default",
    db_path:       str = ":memory:",
) -> SwarmState:
    """
    Execute a complete software engineering task end-to-end.

    Parameters
    ----------
    requirements   : The user's functional requirements document (plain text).
    workspace_root : Absolute path to the local workspace directory.
    llm_*          : Pre-configured LLM clients for each agent role.
    thread_id      : Unique identifier for this thread (used by the checkpointer).
    db_path        : SQLite checkpoint database path.

    Returns the final SwarmState after graph termination.

    Note: the target language is not specified here. The Architect agent selects
    the language ecosystem autonomously and encodes it into bits 15-12 of the
    bitmask during its first execution.
    """
    # Language bits start unset (0x0000); the Architect will set bits 15-12
    initial_bitmask = (BitMask.ACTION_SCAFFOLD | BitMask.NODE_ARCHITECT) & 0xFFFF

    wm = WorkspaceManager(workspace_root)
    initial_state = SwarmState(
        bitmask=initial_bitmask,
        workspace_tree=wm.scan_tree(),
        project_requirements=requirements,
        workspace_root=workspace_root,
    )

    log.info("Task started  thread=%s  (language: Architect will decide)", thread_id)
    log.info("Initial state: %s", initial_state.describe_bitmask())

    # ── Start the event recorder and debug UI server ────────────────────────
    log_path = recorder.start(thread_id=thread_id, log_dir="./debug_runs")
    log.info("Event log: %s", log_path)

    graph       = build_graph(llm_architect, llm_coder, llm_reviewer, llm_debugger, db_path=db_path)
    final_state = await graph.run(initial_state, thread_id)

    recorder.finish(final_state=final_state.model_dump())
    log.info("Task complete  thread=%s", thread_id)
    return final_state

# ── CLI entry point ───────────────────────────────────────────────────────────

if __name__ == "__main__":
    load_dotenv()
    # openai_api_key = os.environ.get("OPENAI_API_KEY", "")
    openrouter_api_key = os.environ.get("OPENROUTER_API_KEY", "")
    # if not openai_api_key:
    #     print("ERROR: Set the OPENAI_API_KEY environment variable.", file=sys.stderr)
    #     sys.exit(1)
    if not openrouter_api_key:
        print("ERROR: Set the OPENROUTER_API_KEY environment variable.", file=sys.stderr)
        sys.exit(1)
    
    architect_model = os.environ.get("SOPHRON_ARCHITECT_MODEL", "z-ai/glm-5.2")
    coder_model     = os.environ.get("SOPHRON_CODER_MODEL",     "deepseek/deepseek-v4-pro")
    reviewer_model  = os.environ.get("SOPHRON_REVIEWER_MODEL",  "deepseek/deepseek-v4-pro")
    debugger_model  = os.environ.get("SOPHRON_DEBUGGER_MODEL",  "deepseek/deepseek-v4-flash")

    # architect_model = os.environ.get("SOPHRON_ARCHITECT_MODEL", "deepseek/deepseek-v4-flash")
    # coder_model     = os.environ.get("SOPHRON_CODER_MODEL",     "deepseek/deepseek-v4-flash")
    # debugger_model  = os.environ.get("SOPHRON_DEBUGGER_MODEL",  "deepseek/deepseek-v4-flash")

    workspace       = os.environ.get(
        "SOPHRON_WORKSPACE",
        str(Path.home() / "sophron_workspace"),
    )

    Path(workspace).mkdir(parents=True, exist_ok=True)

    # max_tokens=16384 ensures large multi-file diffs are not truncated mid-JSON
    architect_llm = OpenRouterClient(model=architect_model, api_key=openrouter_api_key, temperature=0.1, max_tokens=16384)
    coder_llm     = OpenRouterClient(model=coder_model,     api_key=openrouter_api_key, temperature=0.0, max_tokens=16384)
    reviewer_llm  = OpenRouterClient(model=reviewer_model,  api_key=openrouter_api_key, temperature=0.0, max_tokens=16384)
    debugger_llm  = OpenRouterClient(model=debugger_model,  api_key=openrouter_api_key, temperature=0.0, max_tokens=16384)

    # ── Launch the debug replay server (background thread) ──────────────────
    debug_port = int(os.environ.get("SOPHRON_DEBUG_PORT", "8877"))
    start_debug_server(port=debug_port)

    # Example requirements document
    requirements_doc = """\
Build a simple web application that allows the user to connect their Schoology account via api key and allow the application to fetch the user's assignments, courses, and grades. The application should have a clean and user-friendly interface, and it should display the fetched data in an organized manner. The user should be able to filter assignments by course and due date, and the application should provide notifications for upcoming deadlines. Additionally, implement a feature that allows users to export their grades and assignments to a CSV file for offline access. Create a built in GPA calculator that calculates the user's GPA based on their grades and course credits. The application should be responsive and work well on both desktop and mobile devices. Ensure that the application follows best practices for security and data privacy, and provide clear instructions for users on how to connect their Schoology account and use the application's features.
"""
#     requirements_doc = """\
# Build a simple web based flappy bird game that allows the user to play the game and keep track of their high score. The game should have a clean and user-friendly interface, and it should display the user's current score and high score in an organized manner. The user should be able to start a new game, pause the game, and reset their high score. Additionally, implement a feature that allows users to share their high score on social media platforms. The game should be responsive and work well on both desktop and mobile devices. Ensure that the game follows best practices for performance and user experience, and provide clear instructions for users on how to play the game and use its features.
# """
    asyncio.run(
        run_task(
            requirements=requirements_doc,
            workspace_root=workspace,
            llm_architect=architect_llm,
            llm_coder=coder_llm,
            llm_reviewer=reviewer_llm,
            llm_debugger=debugger_llm,
        )
    )
