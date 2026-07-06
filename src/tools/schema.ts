/**
 * Tool-definition helper. Lets built-in tools declare themselves with a
 * typed handler + JSON-Schema parameters, then be exported as the canonical
 * ToolDefinition for the LLM.
 */
import type { ToolDefinition } from "../types.js";

/**
 * Shared infrastructure instances passed to every tool invocation.
 * Created once at CLI level and threaded through the loop so delegation tools
 * can spawn sub-agents without re-constructing expensive objects.
 */
export interface SharedServices {
  llm: import("../llm/client.js").LLMClient;
  agentRegistry: import("../agent/registry.js").AgentRegistry;
  toolRegistry: import("./registry.js").ToolRegistry;
  dispatcher: import("./dispatcher.js").ToolDispatcher;
  checkpointer: import("../state/checkpointer.js").Checkpointer;
  /** Shared memory store (`.sophron/shared/`). Phase 3. */
  sharedMemoryStore: import("../memory/sharedStore.js").SharedMemoryStore;
  /** Per-agent memory store (`.sophron/memory/<id>/`). Phase 3. */
  agentMemoryStore: import("../memory/agentStore.js").AgentMemoryStore;
  /** MCP connection pool (one Client per server, kept alive). Phase 4. */
  mcpPool: import("../mcp/pool.js").McpConnectionPool;
  /** MCP tool search catalog (lazy-loaded tool index). Phase 4. */
  mcpCatalog: import("../mcp/catalog.js").McpToolCatalog;
  /** MCP token-cost meter (tracks promoted-tool cost). Phase 4. */
  mcpCostMeter: import("../mcp/costMeter.js").TokenCostMeter;
  /** Approvals queue (permission-gate prompts route here). Phase 6. */
  approvals: import("../tui/approvals.js").ApprovalsQueue;
  /** Output purifier — compresses noisy tool results before they enter message history (M1). */
  purifier: import("./purifier.js").Purifier;
}

export interface ToolContext {
  /** Parsed arguments object from the model. */
  args: Record<string, unknown>;
  /** The agent invoking the tool (for permission checks). */
  agent: import("../types.js").AgentDefinition;
  /** Current run state (working dir, run id, etc). */
  state: import("../types.js").AgentRunState;
  /** Shared infrastructure — available to tools that need to spawn sub-agents. */
  services: SharedServices;
}

export type ToolHandler = (ctx: ToolContext) => Promise<string> | string;

export interface ToolSpec {
  /** Tool name — lowercase-hyphenated, unique across the registry. */
  name: string;
  /** One-line description shown to the model. */
  description: string;
  /** JSON Schema for the parameters object. */
  parameters: object;
  /** Execute the tool; return a string result for the model. */
  handler: ToolHandler;
}

/** Convert a ToolSpec to the LLM-facing ToolDefinition. */
export function toToolDefinition(spec: ToolSpec): ToolDefinition {
  return {
    type: "function",
    function: {
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
    },
  };
}
