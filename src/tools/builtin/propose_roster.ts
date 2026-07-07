/**
 * propose_roster tool — the Architect drafts the FULL agent roster in one pass
 * for one operator approval gate (M6).
 *
 * Generalizes Phase 6's single-agent `propose_agent` to a batch: the architect
 * reads project requirements → drafts N agents → one approval gate covers the
 * whole batch → bootstrap closes. This is the runtime companion to M5 templates
 * (a project bootstraps either from a template OR from scratch via this tool).
 *
 * Guardrails (preserved from Phase 6 §5.1 / §7.1):
 *   - No entry may use `full-auto` (operator must explicitly set it post-approval).
 *   - No re-drafting already-resolved agents (writeRoster throws).
 *   - Refuses if bootstrap creation is closed.
 *   - No auto-approval path — every draft requires explicit operator action.
 *
 * The writes are TRANSACTIONAL (`AgentDraftStore.writeRoster`): if ANY entry
 * fails validation, NOTHING is written (no half-applied rosters).
 *
 * See docs/ROADMAP.md (M6) + docs/IDEAS.md §6 Piece 2 + docs/PHASE_6_DESIGN.md §3.
 */
import { log } from "../../util/log.js";
import { AgentDraftStore } from "../../agent/drafts.js";
import { serializeDraft, type DraftFields } from "../../agent/serialize.js";
import type { ToolSpec } from "../schema.js";

/** Soft cap (warn, don't block) — matches the registry warn (§5.1). */
const ROSTER_SOFT_CAP = 12;

/** One agent within a roster proposal. Mirrors propose_agent's parameters. */
interface RosterAgentSpec {
  name: string;
  description: string;
  systemPrompt: string;
  tools?: string[];
  model?: string;
  permissionMode?: string;
  delegateAllowlist?: string[];
  mcpServers?: string[];
  maxTurns?: number;
}

function requireString(v: unknown, key: string, which?: string): string {
  if (typeof v !== "string" || !v.trim()) {
    const where = which ? ` in roster entry '${which}'` : "";
    throw new Error(`Missing or non-string argument '${key}'${where}`);
  }
  return v.trim();
}

/**
 * Normalize + serialize one roster entry. Returns the validated name + the
 * serialized `.md` content. Throws on any missing field or full-auto attempt.
 */
function serializeRosterEntry(spec: unknown): { name: string; content: string } {
  const e = spec as Record<string, unknown>;
  const name = requireString(e["name"], "name");
  const description = requireString(e["description"], "description", name);
  const systemPrompt = requireString(e["systemPrompt"], "systemPrompt", name);

  const permissionMode = typeof e["permissionMode"] === "string" ? e["permissionMode"] : "default";
  if (permissionMode === "full-auto") {
    throw new Error(
      `Entry '${name}': drafts may not use 'full-auto' permission. The operator must explicitly set it after approving the agent.`,
    );
  }

  const fields: DraftFields = {
    name,
    description,
    systemPrompt,
    tools: e["tools"],
    model: e["model"],
    permissionMode,
    delegateAllowlist: e["delegateAllowlist"],
    mcpServers: e["mcpServers"],
    maxTurns: e["maxTurns"],
  };
  return { name, content: serializeDraft(fields) };
}

export const propose_roster: ToolSpec = {
  name: "propose_roster",
  description:
    "Propose the FULL agent roster for this project in one pass. Each agent is written as a DRAFT and the " +
    "WHOLE batch is covered by ONE operator approval gate. Use ONCE at project bootstrap (instead of calling " +
    "propose_agent N times). After the roster is approved/rejected, creation closes. Guardrails: no 'full-auto' " +
    "drafts; drafts cannot execute until the operator approves them.",
  parameters: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description: "A one-or-two-line rationale for this roster (shown to the operator at the approval gate).",
      },
      agents: {
        type: "array",
        description: "The full roster of agents to draft (one object per agent).",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "Unique agent id (lowercase-hyphenated, matches filename)." },
            description: { type: "string", description: "One-line description of when to delegate to this agent." },
            systemPrompt: { type: "string", description: "The agent's system prompt (markdown body)." },
            tools: { type: "array", items: { type: "string" }, description: "Tool allowlist." },
            model: { type: "string", description: "Model tier (inherit/frontier/mid/cheap) or concrete id." },
            permissionMode: {
              type: "string",
              enum: ["default", "accept-edits", "auto", "plan", "full-auto"],
              description: "Permission mode. Drafts may NOT use 'full-auto' (operator must edit after promotion).",
            },
            delegateAllowlist: { type: "array", items: { type: "string" }, description: "Agents this one may delegate to." },
            mcpServers: { type: "array", items: { type: "string" }, description: "MCP server names scoped to this agent." },
            maxTurns: { type: "integer", description: "Hard cap on loop iterations." },
          },
          required: ["name", "description", "systemPrompt"],
        },
      },
    },
    required: ["agents"],
  },
  handler: ({ args, state, services }) => {
    const rawAgents = args["agents"];
    if (!Array.isArray(rawAgents) || rawAgents.length === 0) {
      return "Refused: 'agents' must be a non-empty array of agent specs.";
    }

    // Serialize + validate EVERY entry up front. If any entry is bad (missing
    // field, full-auto), refuse the whole batch — nothing is written.
    let roster;
    try {
      roster = rawAgents.map((spec) => serializeRosterEntry(spec));
    } catch (e) {
      return `Refused: ${(e as Error).message}`;
    }

    // Check for duplicate names within the batch (writeRoster also checks, but
    // surfacing it here yields a clearer tool result before touching the store).
    const names = roster.map((r) => r.name);
    const dup = names.find((n, i) => names.indexOf(n) !== i);
    if (dup) return `Refused: duplicate agent name '${dup}' in the roster.`;

    const store = new AgentDraftStore(state.workingDir);
    try {
      const entries = store.writeRoster(roster);
      const approved = services.agentRegistry.scan().agents.length;
      const after = approved + entries.length;
      const capWarn = after > ROSTER_SOFT_CAP
        ? `\nNote: the resulting roster (${after} agents) exceeds the soft cap of ${ROSTER_SOFT_CAP}. The registry will warn on load.`
        : "";
      log.info({ count: entries.length, names, agent: state.agentName }, "agent roster proposed (drafts)");
      return (
        `Drafted ${entries.length} agent(s) as a batch: ${names.join(", ")}.` +
        ` All are awaiting operator approval in .sophron/agents.draft/.` +
        ` The operator approves the whole roster with one gate:` +
        ` 'sophron agents --approve-all' (or --approve ${names.join(" ")} for a subset).` +
        capWarn
      );
    } catch (e) {
      return `Could not draft roster: ${(e as Error).message}`;
    }
  },
};
