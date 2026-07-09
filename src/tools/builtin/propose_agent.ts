/**
 * propose_agent tool — the Architect drafts a new agent for operator approval.
 *
 * Writes a draft `.md` to `.sophron/agents.draft/<name>.md` + records it in the
 * ledger. Drafts CANNOT execute (the registry only scans `agents/`). Promotion
 * is operator-initiated (`sophron agents --approve <name>` or the TUI).
 *
 * Guardrails (§5.1 / §7.1):
 *   - Refuses if bootstrap creation is closed (one-time step).
 *   - Drafts can't grant themselves `full-auto` (validated — full-auto requires
 *     operator edit after promotion).
 *   - Soft cap at 12 agents (warned by the registry on load).
 *
 * See docs/PHASE_6_DESIGN.md §3.
 */
import { log } from "../../util/log.js";
import { AgentDraftStore } from "../../agent/drafts.js";
import { serializeDraft } from "../../agent/serialize.js";
import type { ToolSpec } from "../schema.js";

function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || !v.trim()) throw new Error(`Missing or non-string argument '${key}'`);
  return v.trim();
}

export const propose_agent: ToolSpec = {
  name: "propose_agent",
  description:
    "Propose a new agent definition for this project. The agent is written as a DRAFT and " +
    "requires explicit operator approval before it can execute. Use ONCE at project bootstrap " +
    "to create the full agent roster. After the roster is approved, creation closes.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Unique agent id (lowercase-hyphenated, matches filename)." },
      description: { type: "string", description: "One-line description of when to delegate to this agent." },
      systemPrompt: { type: "string", description: "The agent's system prompt (markdown body)." },
      tools: { type: "array", items: { type: "string" }, description: "Tool allowlist." },
      model: { type: "string", description: "Concrete model id, optionally with a provider prefix (e.g. 'ollama:qwen3.5:9b' or 'openrouter:deepseek/deepseek-v4-flash'). Call list_providers first to see what is configured on this machine." },
      permissionMode: {
        type: "string",
        enum: ["default", "accept-edits", "auto", "plan", "full-auto"],
        description: "Permission mode. Drafts may NOT use 'full-auto' (operator must edit after promotion).",
      },
      delegateAllowlist: { type: "array", items: { type: "string" }, description: "Agents this one may delegate to." },
      mcpServers: { type: "array", items: { type: "string" }, description: "MCP server names scoped to this agent." },
      maxTurns: { type: "integer", description: "Hard cap on loop iterations." },
    },
    required: ["name", "description", "systemPrompt", "model"],
  },
  handler: ({ args, state, services }) => {
    const name = requireString(args, "name");
    const description = requireString(args, "description");
    const systemPrompt = requireString(args, "systemPrompt");
    const model = requireString(args, "model");

    // Guardrail: drafts may not use full-auto (operator must explicitly enable it post-promotion).
    const permissionMode = typeof args["permissionMode"] === "string" ? args["permissionMode"] : "default";
    if (permissionMode === "full-auto") {
      return `Refused: drafts may not use 'full-auto' permission. The operator must explicitly set it after approving the agent.`;
    }

    // Serialize to .md + YAML frontmatter.
    const content = serializeDraft({
      name,
      description,
      systemPrompt,
      tools: args["tools"],
      model,
      permissionMode,
      delegateAllowlist: args["delegateAllowlist"],
      mcpServers: args["mcpServers"],
      maxTurns: args["maxTurns"],
    });

    const store = new AgentDraftStore(state.workingDir);
    try {
      const entry = store.writeDraft(name, content);
      log.info({ name, agent: state.agentName }, "agent proposed (draft)");
      return `Drafted agent '${name}' (status: ${entry.status}). It has been written to .sophron/agents.draft/ and requires operator approval before it can execute. Use the TUI or 'sophron agents --approve ${name}' to promote it.`;
    } catch (e) {
      return `Could not draft agent '${name}': ${(e as Error).message}`;
    }
  },
};
