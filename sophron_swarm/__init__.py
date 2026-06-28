"""SophronSwarm – Token-Efficient Multi-Agent Platform (v1.0.0)."""
from sophron_swarm.graph       import StateGraph
from sophron_swarm.state       import SwarmState, BitMask
from sophron_swarm.router      import BitmaskRouter
from sophron_swarm.checkpointer import Checkpointer
from sophron_swarm.llm_client  import LLMClient, OpenAICompatibleClient

__version__ = "1.0.0"

__all__ = [
    "StateGraph",
    "SwarmState",
    "BitMask",
    "BitmaskRouter",
    "Checkpointer",
    "LLMClient",
    "OpenAICompatibleClient",
]
