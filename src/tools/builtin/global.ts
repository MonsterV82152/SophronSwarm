/**
 * Global-orchestrator tools (M7) — project-lifecycle management scoped to
 * `~/.sophron/` and `~/sophron_workspace/`.
 *
 * The global orchestrator is the "CEO" agent above all projects. It has NO
 * memory and NO codebase workspace — it only manages the project lifecycle.
 * Its scoped tool set (no `run_command` / `apply_patch`):
 *   - list_projects   — read the project registry
 *   - propose_project — draft a project proposal (name, path, template, summary)
 *   - init_project    — controlled scaffolding (after operator approval)
 *
 * `propose_project` vs `init_project` separation:
 *   - propose_project DRAFTS a proposal as a structured result for the operator
 *     to review. It does NOT create anything — there is no auto-creation path.
 *   - init_project performs the controlled scaffold (delegates to M5's
 *     scaffoldProject) once the operator agrees. It refuses to clobber.
 *
 * These tools are restricted to paths under ~/sophron_workspace (init) and
 * ~/.sophron (read). They never touch arbitrary filesystem paths.
 *
 * See docs/ROADMAP.md (M7) + docs/IDEAS.md §6.
 */
import { homedir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { listProjects, findByName, type ProjectEntry } from "../../project/registry.js";
import { scaffoldProject, listTemplates, getTemplate } from "../../init/templates.js";
import { listProviders } from "../../llm/providers.js";
import type { ToolSpec } from "../schema.js";

/** The canonical workspace root for all SophronSwarm projects. */
export function workspaceRoot(): string {
  return join(homedir(), "sophron_workspace");
}

/** The global SophronSwarm config root. */
export function sophronRoot(): string {
  return join(homedir(), ".sophron");
}

/** Coerce a proposed path to an absolute path under ~/sophron_workspace.
 *  Relative paths are resolved against the workspace root. Throws if the
 *  resolved path escapes the workspace root (path-traversal guard). */
function coerceToWorkspace(p: string): string {
  const abs = isAbsolute(p) ? resolve(p) : resolve(workspaceRoot(), p);
  const rel = relative(workspaceRoot(), abs);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(
      `Path '${p}' resolves outside the SophronSwarm workspace (${workspaceRoot()}). ` +
        `Projects must live under ${workspaceRoot()}/<name>.`,
    );
  }
  return abs;
}

// ── list_projects ───────────────────────────────────────────────────────────

export const list_projects: ToolSpec = {
  name: "list_projects",
  description:
    "List all known SophronSwarm projects from the registry (~/.sophron/projects.json). " +
    "Returns each project's name, path, pinned status, and last-opened time. " +
    "This is the global orchestrator's view of all projects — read-only.",
  parameters: {
    type: "object",
    properties: {},
  },
  handler: () => {
    const projects = listProjects();
    if (projects.length === 0) {
      return "No projects registered yet. Use propose_project to draft a new project proposal.";
    }
    const lines = projects.map((p: ProjectEntry) => {
      const pin = p.pinned ? " [pinned]" : "";
      const ago = relativeTime(p.lastOpened);
      return `- ${p.name}${pin}: ${p.path}  (last opened ${ago})`;
    });
    return `Registered projects (${projects.length}):\n${lines.join("\n")}`;
  },
};

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

// ── propose_project ─────────────────────────────────────────────────────────

export const propose_project: ToolSpec = {
  name: "propose_project",
  description:
    "Draft a project proposal for the operator to review. Does NOT create anything — " +
    "it returns a structured proposal (name, path, template, summary) that the operator " +
    "must approve before init_project runs. Validates the name + template. " +
    "Projects live under ~/sophron_workspace/<name>.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Project alias (lowercase-hyphenated). Becomes the directory name under ~/sophron_workspace/.",
      },
      summary: {
        type: "string",
        description: "One-or-two-line description of what the project does and why it's needed.",
      },
      template: {
        type: "string",
        description: "Template to scaffold from (e.g. minimal, cli, webapp, data-pipeline). Omit for 'minimal'.",
      },
    },
    required: ["name", "summary"],
  },
  handler: ({ args }) => {
    const name = typeof args["name"] === "string" ? (args["name"] as string).trim() : "";
    const summary = typeof args["summary"] === "string" ? (args["summary"] as string).trim() : "";
    const template = typeof args["template"] === "string" ? (args["template"] as string).trim() : "minimal";

    if (!name) return "Refused: 'name' is required.";
    if (!summary) return "Refused: 'summary' is required.";
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      return `Refused: name '${name}' must be lowercase-hyphenated (a-z, 0-9, -), starting alphanumeric.`;
    }

    // Already registered? The operator may want a status update instead.
    const existing = findByName(name);
    if (existing) {
      return `A project named '${name}' is already registered at ${existing.path}. Choose a different name, or discuss the existing project.`;
    }

    // Validate the template (if given).
    const t = getTemplate(template);
    if (!t) {
      const available = listTemplates().map((x) => x.name).join(", ");
      return `Refused: unknown template '${template}'. Available: ${available}.`;
    }

    const path = join(workspaceRoot(), name);
    return [
      `PROPOSED PROJECT`,
      `  name:     ${name}`,
      `  path:     ${path}`,
      `  template: ${template} — ${t.description}`,
      `  summary:  ${summary}`,
      ``,
      `This is a DRAFT. Nothing has been created. If the operator approves, run`,
      `init_project with the same name to scaffold it.`,
    ].join("\n");
  },
};

// ── init_project ────────────────────────────────────────────────────────────

export const init_project: ToolSpec = {
  name: "init_project",
  description:
    "Scaffold a new project (after the operator approved a propose_project proposal). " +
    "Creates ~/sophron_workspace/<name>/ with the template's agents + seeds the standardized " +
    "orchestrator + registers it in projects.json. Refuses to clobber an existing agents/ dir. " +
    "This is the ONLY way the global orchestrator creates projects — no raw shell.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Project alias (must match the approved proposal)." },
      template: { type: "string", description: "Template to scaffold from. Omit for 'minimal'." },
      force: { type: "boolean", description: "Overwrite an existing agents/ dir (default: refuse)." },
    },
    required: ["name"],
  },
  handler: ({ args }) => {
    const name = typeof args["name"] === "string" ? (args["name"] as string).trim() : "";
    const template = typeof args["template"] === "string" ? (args["template"] as string).trim() : "minimal";
    const force = args["force"] === true;

    if (!name) return "Refused: 'name' is required.";
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      return `Refused: name '${name}' must be lowercase-hyphenated (a-z, 0-9, -), starting alphanumeric.`;
    }

    const path = join(workspaceRoot(), name);
    try {
      // coerceToWorkspace guards against path traversal (belt-and-suspenders,
      // since `name` is validated above, but keep the invariant explicit).
      const abs = coerceToWorkspace(path);
      const result = scaffoldProject(abs, { template, name, force });
      const agentList = result.created.agents.join(", ");
      const sharedList = result.created.shared.length > 0 ? result.created.shared.join(", ") : "(none)";
      return [
        `Created project '${result.entry.name}' at ${result.projectPath}.`,
        `  template: ${result.template}`,
        `  agents:   ${agentList}`,
        `  shared:   ${sharedList}`,
        `  registered in ~/.sophron/projects.json`,
        ``,
        `The project is ready. Its orchestrator can be delegated to from a project-scoped session.`,
      ].join("\n");
    } catch (e) {
      return `Could not create project '${name}': ${(e as Error).message}`;
    }
  },
};

// ── list_providers ──────────────────────────────────────────────────────────

/**
 * List configured LLM provider instances + their default models. This is the
 * read-only way for the architect (and any agent) to discover WHICH providers
 * and models are actually available before assigning a `model` to a drafted
 * agent. Optionally probes one provider's `/v1/models` (network) to enumerate
 * every model id it serves.
 *
 * This is what makes the architect model-aware: it can see the concrete
 * providers/models instead of guessing. See docs/ROADMAP.md (M10).
 */
export const list_providers: ToolSpec = {
  name: "list_providers",
  description:
    "List the configured LLM provider instances and their default models, so you can pick a concrete " +
    "model that actually exists. Use this BEFORE assigning a 'model' field to a drafted agent. " +
    "Set 'probe' to a provider name to also enumerate every model id it serves (network call).",
  parameters: {
    type: "object",
    properties: {
      probe: {
        type: "string",
        description: "Optional provider instance name to probe for its full model list (GET /v1/models). Omit to just list configured instances.",
      },
    },
    required: [],
  },
  handler: async ({ args }) => {
    const probe = typeof args["probe"] === "string" ? (args["probe"] as string).trim() : "";
    const providers = listProviders();
    const lines: string[] = [`Configured provider instances (${providers.length}):`];
    for (const p of providers) {
      const creds = p.apiKey ? "key set" : p.kind === "ollama" ? "(no key needed)" : "NO KEY";
      const model = p.defaultModel ?? "(no default model)";
      lines.push(`- ${p.name} [${p.kind}]  ${p.baseURL}  ${creds}  default: ${model}`);
    }
    lines.push("");
    lines.push(
      "Model field guidance for drafted agents:",
      "  - Use a NAMED TIER to stay portable: 'cheap' (small/routine), 'mid' (general),",
      "    'frontier' (hardest reasoning), 'inherit' (use the orchestrator's model).",
      "  - Or a CONCRETE id with a provider prefix: 'ollama:qwen3.5:9b', 'zai:glm-4.6',",
      "    'openrouter:anthropic/claude-sonnet-4'.",
      "  - Match the model to the TASK SIZE: cheap for routine/build/test, mid for",
      "    general features, frontier only for hard design/security work.",
    );

    if (probe) {
      lines.push("", `Probing '${probe}' (GET /v1/models) …`);
      try {
        const { LLMClient } = await import("../../llm/client.js");
        const llm = new LLMClient();
        const models = await llm.listModels(probe);
        if (models.length === 0) {
          lines.push(`  (reachable, but returned 0 models)`);
        } else {
          lines.push(`  ${models.length} model(s): ${models.slice(0, 40).map((m) => m.id).join(", ")}${models.length > 40 ? ", …" : ""}`);
        }
      } catch (e) {
        lines.push(`  ✗ unreachable — ${(e as Error).message}`);
      }
    }

    return lines.join("\n");
  },
};

export const GLOBAL_TOOLS: ToolSpec[] = [list_projects, propose_project, init_project, list_providers];
