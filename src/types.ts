/**
 * Core shared types for SophronSwarm V3.
 *
 * These are the foundation interfaces every subsystem builds on. Later phases
 * (delegation, memory, MCP) extend these without rewriting the core.
 *
 * See docs/PHASE_0_DESIGN.md §2.
 */

// ── Agent definition (parsed from .md + frontmatter) ────────────────────────

export type PermissionMode =
  | "default" // prompt on risky actions (Phase 0: log only)
  | "accept-edits" // auto file edits
  | "auto" // classifier vets each command (Phase 6)
  | "plan" // read-only
  | "full-auto"; // sandboxed, no prompts (Phase 6)

/**
 * Model tier: a named abstraction resolved at runtime to a concrete provider
 * model id via the operator's config. Allows e.g. swapping the "frontier" model
 * without editing every agent definition.
 *
 * Can also be a concrete model id string directly.
 */
export type ModelTier = "inherit" | "frontier" | "mid" | "cheap" | (string & {});

export interface AgentDefinition {
  /** Unique id, lowercase-hyphenated. Must match filename (without ext). */
  name: string;
  /** When to delegate to this agent (used by the orchestrator in Phase 2). */
  description: string;
  /** System prompt — the markdown body of the definition file. */
  systemPrompt: string;
  /** Tool allowlist. Undefined = inherit all available tools. */
  tools?: string[];
  /** Tool denylist, applied before the allowlist. */
  disallowedTools?: string[];
  /** Resolved concrete model id (e.g. "anthropropic/claude-sonnet-4"). */
  model: string;
  /** Provider that serves `model` (resolved alongside it at load time). */
  provider?: import("./llm/providers.js").ProviderName;
  /** Original tier before resolution (for display / re-resolution). */
  modelTier: ModelTier;
  permissionMode: PermissionMode;
  /** MCP servers scoped to this agent (Phase 4). */
  mcpServers?: (string | Record<string, unknown>)[];
  /** Memory scopes this agent may read/write (Phase 3). */
  memoryScopes?: ("per-agent" | "shared" | "task")[];
  /** Which agent types this agent may spawn via `delegate` (Phase 2). */
  delegateAllowlist?: string[];
  /** Hard cap on loop iterations. Falls back to DEFAULT_MAX_TURNS. */
  maxTurns?: number;
  /** Where the definition was loaded from. */
  source: "project" | "user" | "builtin";
  /** Absolute path to the source file (for hot-reload). */
  filePath: string;
}

// ── LLM messaging ───────────────────────────────────────────────────────────

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string }; // arguments is a JSON string
}

export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  /** Required on role: "tool" — correlates to the originating tool_call.id. */
  tool_call_id?: string;
  /** Optional name tag on role: "tool" (which tool produced this). */
  name?: string;
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    /** JSON Schema describing the tool's parameters. */
    parameters: object;
  };
}

export interface ToolResult {
  tool_call_id: string;
  content: string;
  isError?: boolean;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export type FinishReason =
  | "stop"
  | "tool_calls"
  | "length"
  | "content_filter";

export interface LLMResponse {
  content: string | null;
  toolCalls: ToolCall[];
  usage: Usage;
  finishReason: FinishReason;
  /** The concrete model id that served the request (for telemetry). */
  model: string;
}

// ── Agent runtime state (per run) ───────────────────────────────────────────

export type RunStatus = "running" | "complete" | "error" | "halted";

export interface AgentRunState {
  /** Unique id per run. */
  runId: string;
  /** Groups a run + its (future) sub-runs. */
  threadId: string;
  agentName: string;
  /** The original task prompt that launched this run. */
  task: string;
  /** Full conversation (system + user + assistant + tool messages). */
  messages: LLMMessage[];
  /** Current turn index (0-based). */
  turn: number;
  status: RunStatus;
  /** Absolute path; tools are bound here. */
  workingDir: string;
  /** Cumulative token usage across all turns. */
  tokenUsage: Usage;
  startedAt: number;
  endedAt?: number;
  /** Last error message if status === "error". */
  error?: string;
  /** Checkpointer sequence number (set by Checkpointer.save). */
  seq?: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

export const EMPTY_USAGE: Usage = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
};

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}
