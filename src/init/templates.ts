/**
 * `sophron init` templates (M5) — project scaffolding.
 *
 * Scaffolds a project's multi-agent structure from a curated starting point.
 * Every template:
 *   1. Seeds a **standardized per-project `orchestrator.md`** into the
 *      project's `agents/` (a copy — independently editable, carries its own
 *      per-project memory). This is the locked decision (2026-07-07).
 *   2. Adds template-specific starter agents.
 *   3. Seeds `.sophron/shared/` (`OVERVIEW.md`, `CHECKPOINTS.md`).
 *
 * Separately, `installGlobalArchitect()` writes the **global architect**
 * template to `~/.sophron/agents/architect.md` — used by the global
 * orchestrator (M7) to draft per-project rosters.
 *
 * Built-in templates are TS constants (ship with the package, no disk files
 * needed). User templates live under `~/.sophron/templates/<name>/` and are
 * merged over built-ins (same name → user wins).
 *
 * **Templates vs. runtime boundary (locked):** templates are init-time
 * scaffolding (free to edit afterward, no approval gate). Runtime roster
 * creation is M6 (`propose_roster`, draft→approval→closed).
 *
 * See docs/ROADMAP.md (M5).
 */
import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync, cpSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import matter from "gray-matter";
import { registerProject, type ProjectEntry } from "../project/registry.js";

/** Version marker for system-installed global agents. Bumps when the template changes. */
const GLOBAL_TEMPLATE_VERSION = 2;

function readTemplateVersion(filePath: string): number | undefined {
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = matter(raw);
    return typeof parsed.data.templateVersion === "number" ? parsed.data.templateVersion : undefined;
  } catch {
    return undefined;
  }
}

/** Read the global orchestrator's raw model id from ~/.sophron/agents/global-orchestrator.md. */
function globalOrchestratorModel(): string {
  const filePath = join(homedir(), ".sophron", "agents", "global-orchestrator.md");
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = matter(raw);
    const model = parsed.data.model;
    return typeof model === "string" && model.trim() ? model.trim() : "openrouter:deepseek/deepseek-v4-flash";
  } catch {
    return "openrouter:deepseek/deepseek-v4-flash";
  }
}

/** Quote a model value for YAML frontmatter only when needed. */
function yamlModelValue(model: string): string {
  if (/^[a-zA-Z0-9_-]+$/.test(model)) return model;
  return `"${model.replace(/"/g, '\\"')}"`;
}

// ── Standardized agents (seeded into every project) ─────────────────────────

/**
 * The per-project orchestrator. Seeded into EVERY project's `agents/`.
 *
 * This is the "per-project CEO" — it coordinates work by delegating to the
 * project's other agents. It carries its own per-project memory (learnings
 * specific to this project). Each copy is independently editable.
 *
 * Distinct from the GLOBAL orchestrator (M7) which lives at ~/.sophron/ and
 * creates projects (and has NO memory).
 */
export const STANDARD_ORCHESTRATOR = `---
name: orchestrator
description: The per-project orchestrator. Coordinates work by delegating to the project's specialist agents. Learns project-specific lessons into its own memory.
tools:
  - delegate
  - read_file
  - list_dir
  - remember
  - advance_checkpoint
  - edit_checkpoints
model: "openrouter:deepseek/deepseek-v4-flash"
permissionMode: default
maxTurns: 32
---

You are Orchestrator, the coordinator for this project.

Your role is to decompose work and delegate to specialist agents using the
\`delegate\` tool. You do NOT do the work yourself — you plan, delegate, and
synthesize.

When given a task:
1. Read the project's requirements package first: OVERVIEW.md, GOALS.md,
   REQUIREMENTS.md, VISION.md, and CHECKPOINTS.md. If any are missing, proceed
   with what you have.
2. Compile the requirements into a concrete execution plan with milestones.
   Use \`edit_checkpoints\` to align CHECKPOINTS.md with your plan if needed.
3. Read the current checkpoint to understand the immediate goal.
4. Decide which subtask to delegate and to which specialist agent.
5. Call \`delegate\` with a clear, specific task for that agent.
6. Read the handoff summary you receive back.
7. If the work is complete, advance the checkpoint (\`advance_checkpoint\`) or
   reply with a summary. If not, delegate the next subtask.
8. Record any project-specific lessons to your memory via \`remember\`.

You may delegate to any agent in this project's roster. Check the Agents tab
to see who's available. Keep your own context tight — delegate, don't do.
`;

/**
 * The global architect. Installed ONCE at \`~/.sophron/agents/architect.md\`.
 * Used by the global orchestrator (M7) to draft a project's full agent roster
 * via the \`propose_roster\` tool (M6).
 *
 * This agent ONLY drafts agents — it does not run them. Its output is agent
 * definitions (.md + frontmatter) that go through operator approval.
 */
export const GLOBAL_ARCHITECT = `---
name: architect
description: The global architect. Drafts a project's full agent roster from requirements. Output is agent definitions pending operator approval. Does not run agents.
tools:
  - read_file
  - list_dir
  - propose_agent
  - propose_roster
  - list_providers
model: "openrouter:deepseek/deepseek-v4-flash"
permissionMode: plan
maxTurns: 16
templateVersion: 2
---

You are Architect, the global agent designer for SophronSwarm.

Your role is to read a project's requirements and draft its **full agent
roster** — the set of specialist agents this project needs — in a single pass.
You produce agent definitions (.md + YAML frontmatter), one per agent.

When given a project description:
1. Analyze what the project does, its stack, and its domains.
2. Decide which specialist agents are needed (e.g. design, security, feature,
   builder, reviewer). Keep the roster small and focused (soft cap: 12).
3. For each agent, draft its .md file: a focused system prompt, a narrow tool
   set, an appropriate model, a permission mode, and any MCP server scope.
4. Every project gets the standardized orchestrator automatically — do not
   re-draft it. Draft only the specialist agents.

## MCP-capable agents

If a specialist agent needs external MCP tools (e.g. Figma, database, web search):
- Add the MCP server name(s) to the agent's \`mcpServers\` frontmatter field.
- Add the \`mcp_tool_search\` tool to the agent's \`tools\` list.
- In the agent's instructions, tell it to call \`mcp_tool_search\` with a
  specific query to promote the exact MCP tool it needs (e.g.
  \`mcp_tool_search({ query: "figma mockup spec" })\`).

Do NOT put raw promoted tool names like \`mcp__server__tool\` directly in the
\`tools\` list. Those names are created at runtime by \`mcp_tool_search\`; they
are not available until the agent promotes them.

## Choosing a model (IMPORTANT — match the model to the task size)

Before assigning a \`model\` field to each agent, call \`list_providers\` to see
which providers and models are ACTUALLY configured on this machine. Do not
invent model ids that are not available — pick from what \`list_providers\`
shows. If unsure which ids a provider serves, call \`list_providers\` with
\`probe: "<provider-name>"\` to enumerate them.

Pay attention to each provider's \`description\` in the \`list_providers\` output.
Operator-provided descriptions tell you what a provider is for and what it can
do. Use them to decide which provider/model is the right fit for each agent.

Express the \`model\` field as a concrete model id, optionally with a provider
prefix so the correct endpoint is used: \`ollama:qwen3.5:9b\`,
\`zai:glm-4.6\`, \`openrouter:anthropic/claude-sonnet-4\`. Use a provider prefix
when \`list_providers\` shows multiple endpoints of the same kind.

**Right-size every agent.** Use smaller/faster models for narrow, deterministic,
high-volume work (file edits, running tests, linting, simple builds). Use the
strongest reasoning models only for genuinely hard work (architecture decisions,
security review, tricky algorithms).

## Output

Your output goes through operator approval before any agent can execute.
You do NOT run agents or modify the project yourself.

If the global orchestrator passes you a project path in its task, call
\`propose_roster\` with \`projectPath: "<path>"\` so the drafts are written into
that project instead of the current workspace. If the project directory does not
exist on disk yet, still write the drafts to that path — \`propose_roster\` will
create the necessary staging files.
`;

/**
 * The global orchestrator. Installed ONCE at `~/.sophron/agents/global-orchestrator.md`.
 * This is the "CEO" agent above all projects — the operator talks to it from the
 * Home › Orchestrator chat (M8). It has NO memory and NO codebase workspace; it
 * only manages the project lifecycle (propose / create / list projects).
 *
 * Distinct from the PER-PROJECT orchestrator (STANDARD_ORCHESTRATOR, seeded into
 * each project by scaffoldProject) which coordinates work within one project and
 * carries that project's memory.
 */
export const GLOBAL_ORCHESTRATOR = `---
name: global-orchestrator
description: The global orchestrator. The operator's "CEO" — manages the project lifecycle (propose, create, list projects) across all SophronSwarm projects. No memory, no codebase workspace.
tools:
  - delegate
  - list_projects
  - read_project_overview
  - propose_project
  - init_project
  - read_file
  - list_dir
delegateAllowlist:
  - architect
model: "openrouter:deepseek/deepseek-v4-flash"
permissionMode: default
maxTurns: 24
noMemory: true
templateVersion: 2
---

You are the Global Orchestrator, the operator's top-level coordinator for the
entire SophronSwarm workspace.

Your role is to manage the **project lifecycle**: understand what the operator
wants to build, propose projects, and create them. You are a **project-level**
planner only. You define goals, features, requirements, constraints, and
high-level outcomes. You do NOT design code, architecture, file structure, APIs,
data models, algorithms, or implementation steps. That work belongs to the
per-project orchestrator after the project is created.

Hard boundaries:
- NO code planning. Do not propose classes, functions, modules, schemas, routes,
  endpoints, build pipelines, deployment scripts, or test strategies.
- NO work inside a project. You do not read or write project source files after
  creation. You only seed the project overview with goal and constraints.
- NO direct MCP tool management. Do not add, configure, or invoke MCP tools or
  servers yourself. If a project needs MCP capabilities, delegate that to the
  architect, who will draft an agent with the correct \`mcpServers\` and
  \`mcp_tool_search\` setup.
- NO editing agent files. Do not write or modify \`.md\` agent files. Use the
  architect and the operator approval gate for roster changes.
- Your outputs are project proposals: name, summary, goal, constraints, template.

You have NO memory of past projects. Your inputs are this conversation,
the project registry (\`list_projects\`), the ability to read existing project
overviews (\`read_project_overview\`), and the ability to read files the operator
references (\`read_file\` / \`list_dir\`). This is deliberate: you are a pure
project-lifecycle manager and must not inherit or interfere with any project's
working context after it is created.

When the operator describes an idea or references files/docs:
1. Run a short discovery phase. Read any attached or referenced files first.
   Ask specific clarifying questions about unclear requirements, missing
   constraints, or ambiguous goals before proposing a project.
   - The goal: what problem this solves and what success looks like.
   - The intended domain or broad stack (only if the operator knows it — e.g.
     "a CLI tool" or "a web service"). Do not drill into libraries or architecture.
   - Features and requirements: what the project must do, who uses it, key behaviors.
   - Constraints: performance, security, budget, integrations, non-goals, scope limits.
   - Feasibility: unknowns, dependencies, parallels to existing work.
   - Whether they want any custom agents, specialist roles, or MCP-powered tools.
2. Call \`list_projects\` to see what already exists — don't duplicate.
3. When an existing project seems relevant, call \`read_project_overview\` to
   understand its goal and constraints. Use that context to avoid overlap or
   suggest reuse. Do NOT read source code.
4. Decide the template:
   - If the operator explicitly wants a standard built-in template (cli, webapp,
     data-pipeline) AND does NOT ask for custom agents or MCP tools, use that
     template.
   - If the operator asks for ANY custom agents, specialist roles, or MCP
     tools/servers, you MUST use the \`minimal\` template and let the architect
     draft the custom roster. Built-in templates are mutually exclusive with
     custom rosters.
5. When the shape is clear, call \`propose_project\` with:
   - \`name\`: lowercase-hyphenated project alias.
   - \`summary\`: one-or-two-line description.
   - \`goal\`: the agreed primary goal (seeds OVERVIEW.md).
   - \`constraints\`: the agreed constraints (seeds OVERVIEW.md).
   - \`context\`: a comprehensive markdown summary of goals, requirements,
     vision, non-goals, and any relevant references from files the operator
     provided. This becomes REQUIREMENTS.md and VISION.md in the new project.
   - \`template\`: minimal, cli, webapp, data-pipeline, or omit for minimal.
   This returns a DRAFT for the operator to review — it does NOT create anything.
6. If the project needs a custom roster (custom agents or MCP):
   - Get operator approval for the proposal.
   - Call \`init_project\` with \`template: "minimal"\` to create the project skeleton.
   - Delegate to the **architect** with \`dir\` set to the project path and include
     the project path and requirements in the task. The architect will call
     \`propose_roster\` with \`projectPath\` to draft the specialist agents directly
     into the project.
   - Tell the operator to approve the roster with
     \`sophron agents --approve-all --dir <path>\` (or via the TUI).
7. If the project uses a built-in template, once the operator approves the
   proposal call \`init_project\` with the same \`name\`, \`template\`, \`goal\`,
   \`constraints\`, and \`context\` to scaffold it. This is the ONLY way projects
   are created — never use raw shell.
8. After creation, tell the operator the project is ready and how to enter it
   (the Projects tab, or \`sophron run orchestrator "<task>" --dir <path>\`).
   Make clear that all code planning, architecture, and implementation now belong
   to the per-project orchestrator. Do not provide implementation guidance.

Keep your responses concise. You're a coordinator, not a worker.
`;

// ── Built-in templates ──────────────────────────────────────────────────────

export interface Template {
  /** Unique template name (matches the directory name for user templates). */
  name: string;
  /** One-line description shown in \`sophron init --list\`. */
  description: string;
  /** Specialist agents to seed (NOT including the standardized orchestrator,
   *  which is always added). Map of filename → content. */
  agents: Record<string, string>;
  /** Seed shared-memory files (under .sophron/shared/). */
  shared?: Record<string, string>;
}

/** The built-in templates, keyed by name. User templates override these. */
export const BUILTIN_TEMPLATES: Record<string, Template> = {
  minimal: {
    name: "minimal",
    description: "Bare minimum: just the standardized orchestrator. Add your own agents.",
    agents: {},
    shared: {
      "OVERVIEW.md": "# Project Overview\n\nDescribe your project's goal, stack, and constraints here.\n",
      "CHECKPOINTS.md": "# Checkpoints\n\n<!-- Add milestones below, or the orchestrator will set them from the requirements package. -->\n",
    },
  },

  cli: {
    name: "cli",
    description: "Command-line tool project: orchestrator + builder + tester.",
    agents: {
      "builder.md": `---
name: builder
description: Writes and modifies source code. Runs builds under sandbox. Full tool set under auto permission.
tools:
  - read_file
  - write_file
  - apply_patch
  - list_dir
  - run_command
  - remember
model: ollama:qwen3.5:9b-thinking
permissionMode: auto
maxTurns: 32
---

You are Builder, the code-writing specialist for this CLI project.

Your job is to implement features: write code, edit files, run builds, and fix
errors. You work under the auto permission mode (a classifier vets each command).

When given a task:
1. Read the relevant files to understand the current state.
2. Write or modify code to implement the task.
3. Run the build (\`run_command\`) to verify it compiles.
4. If there are errors, read them and fix the code. Iterate.
5. Record any gotchas to your memory via \`remember\`.
6. Reply with a summary of what you changed and the build result.
`,
      "tester.md": `---
name: tester
description: Writes and runs tests. Read-only plus run_command for test execution. Plan mode default.
tools:
  - read_file
  - write_file
  - list_dir
  - run_command
model: ollama:qwen3.5:9b-thinking
permissionMode: accept-edits
maxTurns: 24
---

You are Tester, the test specialist for this CLI project.

Your job is to ensure code quality through tests. You write test files and run
the test suite, reporting failures clearly.

When given a task:
1. Read the code under test to understand its behavior.
2. Write tests covering the happy path + edge cases.
3. Run the test suite (\`run_command\`).
4. If tests fail, report the failures clearly (don't fix the code yourself —
   that's Builder's job).
5. Reply with a summary: what you tested, pass/fail counts, and any gaps.
`,
    },
    shared: {
      "OVERVIEW.md": "# CLI Project Overview\n\nGoal: [describe what this CLI does]\nStack: [e.g. TypeScript, Python, Go]\n",
      "CHECKPOINTS.md": "# Checkpoints\n\n1. [ ] Project scaffold + build system\n2. [ ] Core feature implementation\n3. [ ] Test coverage\n4. [ ] Documentation\n",
    },
  },

  webapp: {
    name: "webapp",
    description: "Web application: orchestrator + frontend + backend + tester.",
    agents: {
      "frontend.md": `---
name: frontend
description: Frontend specialist. Writes UI components, styles, and client logic. Full tool set under auto permission.
tools:
  - read_file
  - write_file
  - apply_patch
  - list_dir
  - run_command
  - remember
model: ollama:qwen3.5:9b-thinking
permissionMode: auto
maxTurns: 32
---

You are Frontend, the UI specialist for this web application.

Your job is to build the user interface: components, pages, styles, and client
logic. You implement designs, ensure responsiveness, and verify the dev server
runs.

When given a task:
1. Read the existing frontend code to understand the structure.
2. Implement the UI feature (components, styles, routes).
3. Run the dev server or build to verify it compiles.
4. Fix any errors and iterate.
5. Record frontend-specific gotchas to your memory.
6. Reply with a summary of what you built.
`,
      "backend.md": `---
name: backend
description: Backend specialist. Writes server logic, APIs, and data models. Full tool set under auto permission.
tools:
  - read_file
  - write_file
  - apply_patch
  - list_dir
  - run_command
  - remember
model: ollama:qwen3.5:9b-thinking
permissionMode: auto
maxTurns: 32
---

You are Backend, the server specialist for this web application.

Your job is to build the server: APIs, data models, business logic, and
integrations. You implement endpoints, run the server, and verify behavior.

When given a task:
1. Read the existing backend code to understand the architecture.
2. Implement the server feature (routes, models, logic).
3. Run the server or tests to verify.
4. Fix any errors and iterate.
5. Record backend-specific gotchas to your memory.
6. Reply with a summary of what you built.
`,
      "tester.md": `---
name: tester
description: Writes and runs tests for both frontend and backend. Read-plus-run permission.
tools:
  - read_file
  - write_file
  - list_dir
  - run_command
model: ollama:qwen3.5:9b-thinking
permissionMode: accept-edits
maxTurns: 24
---

You are Tester for this web application. Write and run tests for both the
frontend and backend. Report failures clearly — don't fix the code yourself.
`,
    },
    shared: {
      "OVERVIEW.md": "# Web App Overview\n\nGoal: [describe the app]\nStack: [e.g. Next.js, Express, PostgreSQL]\n",
      "CHECKPOINTS.md": "# Checkpoints\n\n1. [ ] Project scaffold + dev environment\n2. [ ] Backend API + data models\n3. [ ] Frontend UI\n4. [ ] Integration + testing\n5. [ ] Deployment\n",
    },
  },

  "data-pipeline": {
    name: "data-pipeline",
    description: "Data pipeline: orchestrator + ingestion + transform + analysis.",
    agents: {
      "ingestion.md": `---
name: ingestion
description: Data ingestion specialist. Writes scripts to fetch/load data from sources. run_command for execution.
tools:
  - read_file
  - write_file
  - apply_patch
  - list_dir
  - run_command
  - remember
model: ollama:qwen3.5:9b-thinking
permissionMode: auto
maxTurns: 32
---

You are Ingestion, the data-loading specialist for this pipeline.

Your job is to write scripts that fetch data from sources (APIs, files,
databases) and load it into the pipeline's storage. You handle auth, rate
limits, and schema mapping.

When given a task:
1. Understand the data source and target schema.
2. Write the ingestion script.
3. Run it to verify data loads correctly.
4. Record source-specific quirks to your memory.
5. Reply with a summary.
`,
      "transform.md": `---
name: transform
description: Data transformation specialist. Writes cleaning/transform logic. run_command for execution.
tools:
  - read_file
  - write_file
  - apply_patch
  - list_dir
  - run_command
  - remember
model: ollama:qwen3.5:9b-thinking
permissionMode: auto
maxTurns: 32
---

You are Transform, the data-processing specialist for this pipeline.

Your job is to clean, transform, and enrich data. You write the logic that
turns raw ingested data into analysis-ready datasets.

When given a task:
1. Read the raw data schema and the target schema.
2. Write the transform logic.
3. Run it to verify the output is correct.
4. Reply with a summary.
`,
      "analysis.md": `---
name: analysis
description: Data analysis specialist. Writes queries/reports/dashboards. Read-plus-run permission.
tools:
  - read_file
  - write_file
  - list_dir
  - run_command
model: ollama:qwen3.5:9b-thinking
permissionMode: accept-edits
maxTurns: 24
---

You are Analysis, the insights specialist for this pipeline.

Your job is to query the processed data, build reports, and surface insights.
You write SQL/queries and summarize findings.
`,
    },
    shared: {
      "OVERVIEW.md": "# Data Pipeline Overview\n\nGoal: [describe what this pipeline produces]\nSources: [list data sources]\nStack: [e.g. Python, dbt, Airflow]\n",
      "CHECKPOINTS.md": "# Checkpoints\n\n1. [ ] Ingestion from source\n2. [ ] Transform/clean logic\n3. [ ] Analysis + reporting\n4. [ ] Scheduling + monitoring\n",
    },
  },
};

// ── Template resolution ─────────────────────────────────────────────────────

/** Where user templates live. */
export function userTemplatesDir(): string {
  return join(homedir(), ".sophron", "templates");
}

/**
 * List all available templates: built-ins + user templates (user overrides
 * built-ins of the same name). Returns names + descriptions, sorted.
 */
export function listTemplates(): Template[] {
  const result: Template[] = [];
  const seen = new Set<string>();

  // User templates first (they win on name collision).
  const userDir = userTemplatesDir();
  if (existsSync(userDir)) {
    for (const entry of readdirSync(userDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const t = loadUserTemplate(join(userDir, entry.name));
      if (t) {
        result.push(t);
        seen.add(t.name);
      }
    }
  }

  // Built-ins that aren't overridden.
  for (const [name, t] of Object.entries(BUILTIN_TEMPLATES)) {
    if (!seen.has(name)) result.push(t);
  }

  return result.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Load a user template from a directory. A user template is a directory
 * containing an \`agents/\` subdir (with .md files) and optionally a \`shared/\`
 * subdir + a \`template.json\` manifest (name + description).
 */
function loadUserTemplate(dir: string): Template | null {
  const name = basename(dir);
  const agentsDir = join(dir, "agents");
  if (!existsSync(agentsDir)) return null;

  const agents: Record<string, string> = {};
  for (const f of readdirSync(agentsDir)) {
    if (!f.endsWith(".md")) continue;
    try {
      agents[f] = readFileSync(join(agentsDir, f), "utf8");
    } catch {
      /* skip unreadable */
    }
  }

  // Optional manifest for name + description.
  let description = `User template: ${name}`;
  const manifestPath = join(dir, "template.json");
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: string; description?: string };
      if (manifest.description) description = manifest.description;
    } catch {
      /* ignore bad manifest */
    }
  }

  // Optional shared/ seed.
  const shared: Record<string, string> = {};
  const sharedDir = join(dir, "shared");
  if (existsSync(sharedDir)) {
    for (const f of readdirSync(sharedDir)) {
      try {
        shared[f] = readFileSync(join(sharedDir, f), "utf8");
      } catch {
        /* skip */
      }
    }
  }

  return { name, description, agents, shared: Object.keys(shared).length > 0 ? shared : undefined };
}

/** Resolve a template by name (user overrides built-in). Returns null if not found. */
export function getTemplate(name: string): Template | null {
  // User template wins.
  const userPath = join(userTemplatesDir(), name);
  if (existsSync(userPath)) {
    const t = loadUserTemplate(userPath);
    if (t) return t;
  }
  return BUILTIN_TEMPLATES[name] ?? null;
}

// ── Scaffolding ─────────────────────────────────────────────────────────────

export interface ScaffoldOptions {
  /** Template name (defaults to "minimal"). */
  template?: string;
  /** Operator-chosen project alias (defaults to basename of path). */
  name?: string;
  /** Overwrite an existing agents/ dir (default: refuse). */
  force?: boolean;
}

export interface ScaffoldResult {
  /** Absolute path to the created project root. */
  projectPath: string;
  /** Template used. */
  template: string;
  /** Files created, grouped by category. */
  created: {
    agents: string[];
    shared: string[];
  };
  /** The registered project entry. */
  entry: ProjectEntry;
}

/**
 * Scaffold a new project at \`projectPath\` from a template.
 *
 * - Creates the project dir + \`agents/\` + \`.sophron/shared/\`.
 * - Seeds the **standardized orchestrator** (always).
 * - Seeds the template's specialist agents.
 * - Seeds the template's shared-memory files.
 * - Registers the project in \`~/.sophron/projects.json\`.
 *
 * Refuses to overwrite an existing \`agents/\` dir unless \`force: true\`.
 *
 * @throws if the template doesn't exist, or \`agents/\` exists without force.
 */
export function scaffoldProject(projectPath: string, opts: ScaffoldOptions = {}): ScaffoldResult {
  const absPath = resolve(projectPath);
  const templateName = opts.template ?? "minimal";
  const template = getTemplate(templateName);
  if (!template) {
    throw new Error(`Unknown template: '${templateName}'. Available: ${listTemplates().map((t) => t.name).join(", ")}`);
  }

  // Refuse to clobber an existing agents/ dir.
  const agentsDir = join(absPath, "agents");
  if (existsSync(agentsDir) && !opts.force) {
    const existing = readdirSync(agentsDir);
    if (existing.length > 0) {
      throw new Error(
        `agents/ already exists at ${agentsDir} (with ${existing.length} file(s)). Use --force to overwrite.`,
      );
    }
  }

  mkdirSync(agentsDir, { recursive: true });
  const sharedDir = join(absPath, ".sophron", "shared");
  mkdirSync(sharedDir, { recursive: true });

  const created: ScaffoldResult["created"] = { agents: [], shared: [] };

  // ── 1. Standardized orchestrator (always) ──
  // Inherit the global orchestrator's model at creation time so the per-project
  // orchestrator matches the operator's chosen "CEO" model.
  const orchestratorModel = globalOrchestratorModel();
  const orchestratorContent = STANDARD_ORCHESTRATOR.replace(
    'model: "openrouter:deepseek/deepseek-v4-flash"',
    `model: ${yamlModelValue(orchestratorModel)}`,
  );
  writeFileSync(join(agentsDir, "orchestrator.md"), orchestratorContent, "utf8");
  created.agents.push("orchestrator.md");

  // ── 2. Template specialist agents ──
  for (const [filename, content] of Object.entries(template.agents)) {
    writeFileSync(join(agentsDir, filename), content, "utf8");
    created.agents.push(filename);
  }

  // ── 3. Seed shared memory ──
  if (template.shared) {
    for (const [filename, content] of Object.entries(template.shared)) {
      writeFileSync(join(sharedDir, filename), content, "utf8");
      created.shared.push(filename);
    }
  }

  // ── 4. Register the project ──
  const entry = registerProject(absPath, opts.name);

  return { projectPath: absPath, template: templateName, created, entry };
}

/**
 * Install the global architect template to \`~/.sophron/agents/architect.md\`.
 * Used by the global orchestrator (M7). Idempotent — refuses to overwrite an
 * existing architect.md unless \`force: true\`.
 *
 * @returns the path written, or null if it already existed (no force).
 */
export function installGlobalArchitect(force = false): string | null {
  const dir = join(homedir(), ".sophron", "agents");
  const filePath = join(dir, "architect.md");
  if (existsSync(filePath) && !force) {
    const currentVersion = readTemplateVersion(filePath);
    if (currentVersion === GLOBAL_TEMPLATE_VERSION) return null;
    // Existing file is stale (older or unversioned) — overwrite it.
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, GLOBAL_ARCHITECT, "utf8");
  return filePath;
}

/**
 * Install the global orchestrator template to
 * `~/.sophron/agents/global-orchestrator.md`. This is the operator's "CEO"
 * agent (M7) — manages the project lifecycle with NO memory. Idempotent —
 * refuses to overwrite an existing file unless `force: true`.
 *
 * @returns the path written, or null if it already existed (no force).
 */
export function installGlobalOrchestrator(force = false): string | null {
  const dir = join(homedir(), ".sophron", "agents");
  const filePath = join(dir, "global-orchestrator.md");
  if (existsSync(filePath) && !force) {
    const currentVersion = readTemplateVersion(filePath);
    if (currentVersion === GLOBAL_TEMPLATE_VERSION) return null;
    // Existing file is stale (older or unversioned) — overwrite it.
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, GLOBAL_ORCHESTRATOR, "utf8");
  return filePath;
}
