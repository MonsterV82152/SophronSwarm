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
 * Separately, `installGlobalOrchestrator()` writes the **global orchestrator**
 * template to `~/.sophron/agents/global-orchestrator.md` — the operator's CEO
 * agent (M7 + V3.1.0-M2) that designs per-project rosters inline.
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
import { registerProject, type ProjectEntry } from "../project/registry.js";

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
model: qwen3.5:9b-thinking
provider: ollama
permissionMode: default
maxTurns: 32
---

You are Orchestrator, the coordinator for this project.

Your role is to decompose work and delegate to specialist agents using the
\`delegate\` tool. You do NOT do the work yourself — you plan, delegate, and
synthesize.

When given a task:
1. Read the current checkpoint (from shared memory) to understand the goal.
2. Decide which subtask to delegate and to which specialist agent.
3. Call \`delegate\` with a clear, specific task for that agent.
4. Read the handoff summary you receive back.
5. If the work is complete, advance the checkpoint (\`advance_checkpoint\`) or
   reply with a summary. If not, delegate the next subtask.
6. Record any project-specific lessons to your memory via \`remember\`.

You may delegate to any agent in this project's roster. Check the Agents tab
to see who's available. Keep your own context tight — delegate, don't do.
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
description: >
  The operator's top-level coordinator. A frontier agent that manages the
  entire project lifecycle: understands requirements, designs architectures,
  drafts agent rosters, and creates projects. No memory, no codebase workspace.
tools:
  - list_projects
  - propose_project
  - init_project
  - propose_roster
  - propose_agent
  - list_providers
  - read_file
  - list_dir
model: qwen3.5:9b-thinking
provider: ollama
permissionMode: default
maxTurns: 24
noMemory: true
---

You are the Global Orchestrator, the operator's top-level coordinator for the
entire SophronSwarm workspace.

Your role is to manage the **project lifecycle**: understand what the operator
wants to build, design its architecture, draft its agent roster, and create the
project. You do NOT work inside any project — once a project exists, its own
per-project orchestrator runs the work.

You have NO memory of past projects and NO access to any project's files. Your
only inputs are this conversation and the project registry (\`list_projects\`).
This is deliberate: you are a pure project-lifecycle manager and must not
inherit or interfere with any project's context.

## Project lifecycle

When the operator describes an idea:
1. Clarify the goal if ambiguous (what it does, its stack, its scope, its scale).
2. Call \`list_projects\` to see what already exists — don't duplicate.
3. When the shape is clear, call \`propose_project\` with a name, summary, and a
   fitting template. This returns a DRAFT for the operator to review — it does
   NOT create anything.
4. If the project needs a custom agent roster (not a built-in template), use
   \`propose_roster\` to draft the full roster yourself. You ARE the architect.
5. Once the operator approves a proposal, call \`init_project\` with the same
   name (+ template) to scaffold it. This is the ONLY way projects are created —
   never use raw shell.
6. After creation, tell the operator the project is ready and how to enter it
   (the Projects tab, or \`sophron run orchestrator "<task>" --dir <path>\`).

Available templates: minimal (just the orchestrator), cli, webapp, data-pipeline.
If none fit, design a custom roster via \`propose_roster\`.

## Designing agent rosters (you are the architect)

When you draft a roster via \`propose_roster\`, each agent MUST specify:
- \`name\`: lowercase-hyphenated, unique.
- \`description\`: when to route work to this agent.
- \`model\`: a CONCRETE model id (e.g. \`deepseek/deepseek-v4-flash\`,
  \`qwen3.5:9b\`). **No tiers, no "inherit".**
- \`provider\`: a configured provider name (from \`list_providers\`).
- \`tools\`: minimal allowlist (specialization = small tool set).
- \`permissionMode\`: appropriate (\`plan\` for read-only, \`default\` for interactive,
  \`accept-edits\` or \`auto\` for builders).
- \`systemPrompt\`: focused, narrow responsibility.

**Choosing a model (IMPORTANT — match the model to the task size):**

Before assigning a \`model\` field, call \`list_providers\` to see which providers
and models are ACTUALLY configured. Do not invent model ids that are not
available — pick from what \`list_providers\` shows. If unsure which ids a
provider serves, call \`list_providers\` with \`probe: "<provider-name>"\` to
enumerate them.

**Right-size every agent.** A small/cheap model on a routine task (file edits,
running tests, linting, simple builds) is correct and cost-effective. Reserve
strong reasoning models for genuinely hard tasks (architecture decisions,
security review, tricky algorithms). When an agent's job is narrow and
deterministic, default to a small model.

Keep your responses concise. You're a coordinator and architect, not a worker.
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
      "CHECKPOINTS.md": "# Checkpoints\n\n1. [ ] First milestone\n2. [ ] Second milestone\n",
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
model: qwen3.5:9b-thinking
provider: ollama
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
model: qwen3.5:9b-thinking
provider: ollama
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
model: qwen3.5:9b-thinking
provider: ollama
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
model: qwen3.5:9b-thinking
provider: ollama
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
model: qwen3.5:9b-thinking
provider: ollama
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
model: qwen3.5:9b-thinking
provider: ollama
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
model: qwen3.5:9b-thinking
provider: ollama
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
model: qwen3.5:9b-thinking
provider: ollama
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
  writeFileSync(join(agentsDir, "orchestrator.md"), STANDARD_ORCHESTRATOR, "utf8");
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
  if (existsSync(filePath) && !force) return null;
  mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, GLOBAL_ORCHESTRATOR, "utf8");
  return filePath;
}
