/**
 * remember tool — persist a note to per-agent or shared memory.
 *
 * The agent calls this DELIBERATELY (never auto-dumped) to promote a critical
 * insight so it survives the task boundary. Per-agent writes are quality-gated
 * (minimum length + exact-duplicate dedup).
 *
 * Two scopes (agent picks):
 *   - per-agent: appends a timestamped bullet to <memory>/<agent>/MEMORY.md.
 *                Section is one of the canonical memory sections (or an alias).
 *   - shared:    writes a section to <workspace>/.sophron/shared/<file>.md.
 *                Used to surface project-wide context the next agent needs.
 *
 * See docs/PROJECT_OVERVIEW.md §5.2/§5.3.
 */
import { log } from "../../util/log.js";
import { AGENT_MEMORY_SECTIONS, type AgentMemorySection } from "../../memory/agentStore.js";
import { SHARED_FILES, type SharedFileName } from "../../memory/sharedStore.js";
import type { ToolSpec } from "../schema.js";
import type { AgentDefinition } from "../../types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Canonical per-agent memory sections indexed by lowercase key. */
const SECTION_ALIASES: Record<string, AgentMemorySection> = {
  failure: AGENT_MEMORY_SECTIONS.FAILURES,
  failures: AGENT_MEMORY_SECTIONS.FAILURES,
  "past points of failure": AGENT_MEMORY_SECTIONS.FAILURES,
  issue: AGENT_MEMORY_SECTIONS.ISSUES,
  issues: AGENT_MEMORY_SECTIONS.ISSUES,
  "past encountered issues": AGENT_MEMORY_SECTIONS.ISSUES,
  "key point": AGENT_MEMORY_SECTIONS.KEY_POINTS,
  "key points": AGENT_MEMORY_SECTIONS.KEY_POINTS,
  [AGENT_MEMORY_SECTIONS.FAILURES.toLowerCase()]: AGENT_MEMORY_SECTIONS.FAILURES,
  [AGENT_MEMORY_SECTIONS.ISSUES.toLowerCase()]: AGENT_MEMORY_SECTIONS.ISSUES,
  [AGENT_MEMORY_SECTIONS.KEY_POINTS.toLowerCase()]: AGENT_MEMORY_SECTIONS.KEY_POINTS,
};

/** Resolve a friendly section name to a canonical per-agent section. */
function resolveSection(input: string): AgentMemorySection | undefined {
  return SECTION_ALIASES[input.trim().toLowerCase()];
}

/** Map a friendly shared-file key to the canonical file name. */
const SHARED_FILE_ALIASES: Record<string, SharedFileName> = {
  overview: SHARED_FILES.OVERVIEW,
  checkpoints: SHARED_FILES.CHECKPOINTS,
  "current checkpoint": SHARED_FILES.CURRENT_CHECKPOINT,
  "current-checkpoint": SHARED_FILES.CURRENT_CHECKPOINT,
  current: SHARED_FILES.CURRENT_CHECKPOINT,
  [SHARED_FILES.OVERVIEW.toLowerCase()]: SHARED_FILES.OVERVIEW,
  [SHARED_FILES.CHECKPOINTS.toLowerCase()]: SHARED_FILES.CHECKPOINTS,
  [SHARED_FILES.CURRENT_CHECKPOINT.toLowerCase()]: SHARED_FILES.CURRENT_CHECKPOINT,
};

function resolveSharedFile(input: string): SharedFileName {
  return SHARED_FILE_ALIASES[input.trim().toLowerCase()] ?? SHARED_FILES.OVERVIEW;
}

/**
 * Does the agent have permission for the requested memory scope?
 * `memoryScopes` undefined ⇒ default to per-agent + shared (both allowed).
 */
function hasMemoryScope(agent: AgentDefinition, scope: "per-agent" | "shared"): boolean {
  if (!agent.memoryScopes || agent.memoryScopes.length === 0) return true;
  return agent.memoryScopes.includes(scope);
}

function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || !v.trim()) throw new Error(`Missing or empty argument '${key}'`);
  return v.trim();
}

// ── Tool ─────────────────────────────────────────────────────────────────────

export const remember: ToolSpec = {
  name: "remember",
  description:
    "Save a note to memory so it survives beyond this task. Use per-agent scope " +
    "for personal lessons (failures, gotchas, key facts); use shared scope to publish " +
    "project context the next agent needs. Notes are deduplicated and quality-gated.",
  parameters: {
    type: "object",
    properties: {
      scope: {
        type: "string",
        enum: ["per-agent", "shared"],
        description: "Which memory tier to write to.",
      },
      section: {
        type: "string",
        description:
          "Memory section. For per-agent: 'failure', 'issue', or 'key-point' " +
          "(or the full section name). For shared: the section title within the file.",
      },
      note: {
        type: "string",
        description: "The insight to persist. Be specific and self-contained.",
      },
      file: {
        type: "string",
        description:
          "(shared scope only) Which shared file: 'overview', 'checkpoints', or " +
          "'current-checkpoint'. Defaults to 'overview'.",
      },
    },
    required: ["scope", "section", "note"],
  },
  handler: ({ args, agent, services }) => {
    const scope = requireString(args, "scope");
    const sectionRaw = requireString(args, "section");
    const note = requireString(args, "note");

    if (scope !== "per-agent" && scope !== "shared") {
      return `Invalid scope '${scope}'. Use 'per-agent' or 'shared'.`;
    }

    // Permission check.
    if (!hasMemoryScope(agent, scope)) {
      return `Memory scope '${scope}' is not permitted for agent '${agent.name}' (allowed: ${agent.memoryScopes?.join(", ") ?? "(none)"}).`;
    }

    if (scope === "per-agent") {
      const section = resolveSection(sectionRaw);
      if (!section) {
        const valid = [...new Set(Object.values(AGENT_MEMORY_SECTIONS))].join(", ");
        return `Unknown per-agent section '${sectionRaw}'. Valid: failure, issue, key-point (or full names: ${valid}).`;
      }
      const result = services.agentMemoryStore.append(agent.name, section, note);
      if (!result.appended) {
        return `Note not saved (${result.reason})`;
      }
      log.info({ agent: agent.name, section, note: note.slice(0, 80) }, "agent memory saved");
      return `Saved to per-agent memory [${agent.name}] → "${section}".`;
    }

    // shared scope
    const file = resolveSharedFile(typeof args["file"] === "string" ? String(args["file"]) : "overview");
    services.sharedMemoryStore.appendToSection(file, sectionRaw, note);
    log.info({ agent: agent.name, file, section: sectionRaw, note: note.slice(0, 80) }, "shared memory saved");
    return `Saved to shared memory ${file} → "${sectionRaw}".`;
  },
};
