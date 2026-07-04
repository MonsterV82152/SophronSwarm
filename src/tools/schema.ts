/**
 * Tool-definition helper. Lets built-in tools declare themselves with a
 * typed handler + JSON-Schema parameters, then be exported as the canonical
 * ToolDefinition for the LLM.
 */
import type { ToolDefinition } from "../types.js";

export interface ToolContext {
  /** Parsed arguments object from the model. */
  args: Record<string, unknown>;
  /** The agent invoking the tool (for permission checks). */
  agent: import("../types.js").AgentDefinition;
  /** Current run state (working dir, run id, etc). */
  state: import("../types.js").AgentRunState;
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
