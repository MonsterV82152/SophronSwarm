# SophronSwarm V3 — Development Roadmap

> Ordered development timeline integrating the remaining phase work (5b, 7)
> with the proposed enhancements in [`IDEAS.md`](./IDEAS.md), and the
> **two-tier hierarchy** vision (global orchestrator above all projects).
>
> **Baseline (verified 2026-07-08):** 686/686 tests passing, clean `tsc`.
> Phases 0–6 complete. M1 (purifier) + M2 (named providers) + M3 (TUI rewrite)
> + M4 (context-aware `/help`) + M5 (`sophron init` templates) + M6
> (`propose_roster` batch bootstrap) + M7 (global orchestrator meta-layer) +
> M8 (wire global orchestrator into Home) + M10 (operator ergonomics) + M11
> (runtime `/model` switching) + M12 (global orchestrator project context) +
> M13 (provider descriptions) complete.
>
> **Last updated:** 2026-07-08 (M12 complete)

---

## The vision: a two-tier hierarchy

SophronSwarm is a **multi-project** system. There is one **global
orchestrator** that lives *above* all projects, plus a **per-project
orchestrator** inside each project.

```
SophronSwarm (global)                          ← operator's home
  └─ Global Orchestrator (one, ~/.sophron/)      ← the "CEO": proposes & creates projects
       ├─ delegates to → Global Architect          ← drafts each project's roster (M6)
       ├─ Project A  → per-project orchestrator + its own agent roster
       ├─ Project B  → per-project orchestrator + its own agent roster
       └─ ...
```

**Key principles (locked 2026-07-07):**
- **Global orchestrator has NO memory.** It reads the project registry
  (`~/.sophron/projects.json`) and the current chat thread — nothing else. It
  is a pure project-lifecycle manager; it does not work inside projects or
  inherit their memory. This prevents cross-project interference.
- **Each project gets a standardized orchestrator.** Project creation seeds
  an identical `orchestrator.md` into every project's `agents/`. Each copy is
  independently editable and carries its own per-project memory.
- **Global orchestrator tool set is scoped:** `delegate` (to the architect),
  `propose_project` / `init_project` (controlled scaffolding, not raw shell),
  `list_projects`, read-only file tools over `~/.sophron/`. No `run_command`
  / `apply_patch` — it has no codebase workspace.
- **Projects live at `~/sophron_workspace/<name>`.**
- **Project creation flow:** operator proposes an idea in the Home ›
  Orchestrator chat → global orchestrator delegates to the global architect →
  architect drafts the roster (M6 `propose_roster`, one approval gate) →
  operator approves → `init_project` scaffolds the project + seeds the
  standardized orchestrator → registered in `projects.json`.

---

## Current state

| Phase / Milestone | Status | Notes |
|---|---|---|
| 0 — Skeleton | ✅ Complete | loop, dispatcher, loader, LLM client, checkpointer, recorder |
| 1 — Live tools + sandbox | ✅ Complete | `run_command` (bubblewrap), `apply_patch` (V2 chain) |
| 2 — Delegation | ✅ Complete | `delegate`, depth/cycle/allowlist, HandoffPacket |
| 3 — Memory | ✅ Complete | per-agent + shared + checkpoints |
| 4 — MCP | ✅ Complete | lazy loader, `mcp_tool_search`, cost meter, pool |
| 5a — TUI (Ink) | ✅ Complete | dashboard, slash-commands, approvals, components |
| 6 — Auto mode + agent-creation | ✅ Complete | classifier gate, `propose_agent` draft→approve |
| **M1 — Output Purifier** | ✅ Complete | deterministic + Tier-2 cheap-model filter; `read_raw_output` |
| **M2 — Named Providers** | ✅ Complete | free-form instance names; multi-endpoint; `sophron providers` |
| **M3 — TUI Shell (rewrite)** | ✅ Complete | box-chrome tabbed Home (Overview/Orchestrator-stub/Projects) + Project View (Status/Agents/Runs/Checkpoint/Memory/Cost) + Agent detail with live JSONL-tail stream; pure nav reducer |
| **M4 — Context-aware `/help`** | ✅ Complete | `helpForView(view)` over M3's 11 views; core + per-view sections; 21 tests |
| **M5 — `sophron init` Templates** | ✅ Complete | 4 built-in templates (minimal/cli/webapp/data-pipeline) + user templates; seeds standardized per-project orchestrator + global architect; 25 tests |
| **M6 — `propose_roster`** | ✅ Complete | batch draft→approve→close (transactional `writeRoster`); `sophron agents --drafts/--approve*/--reject*`; 50 tests |
| **M7 — Global Orchestrator meta-layer** | ✅ Complete | the "CEO" agent above all projects (NO memory via `noMemory`); scoped tools (`list_projects`/`propose_project`/`init_project`); `GLOBAL_ORCHESTRATOR` template + installer; 26 tests |
| **M8 — Wire Global Orchestrator into TUI Home** | ✅ Complete | real global-orchestrator chat in Home › Orchestrator; project-switch ghost-lines fix; `/clear` resets chat | 
| **M9 — Web UI (Phase 5b)** | ⏸ Deferred | CLI-first is locked (`PROJECT_OVERVIEW.md` §7.6); low-dependency, parallelizable |
| **M10 — Operator Ergonomics** | ✅ Complete | `sophron add-provider`/`edit-provider`/`remove-provider` (interactive + flags); `sophron projects` (list/remove/rename/pin); model-aware architect (`list_providers` tool + tier guidance + roster-tool allowlist fix) |
| **M11 — Runtime Model Switching (`/model`)** | ✅ Complete | runtime model override + `/model` slash command + default orchestrator/architect/global-orchestrator to `frontier`; 12 new tests |
| **M12 — Global Orchestrator Project Context** | ✅ Complete | `read_project_overview` tool + goal/constraints in proposal/creation + richer discovery/handoff prompt; 7 new tests |
| **M13 — Provider Descriptions** | ✅ Complete | `description` field on provider instances + CLI flags + surfaced in `list_providers`; 5 new tests |
| **M14 — TUI Surface-Switch Render Cleanup** | 🔜 Planned | Small–Medium — eliminate visual artifacts when switching between Home and Project surfaces |

---

## Milestones (ordered)

### M0 — Baseline ✅
473/473 tests, clean `tsc`. Re-verify before every merge:
`npm run typecheck && npm test`.

---

### M1 — Output Purifier ✅
**Why first:** highest immediate token-cost impact; touches a single chokepoint
(`ToolDispatcher.dispatch`); the cost win **compounds** with every feature
built on top.

**Built (2026-07-06):** `src/tools/purifier.ts` — Tier 1 deterministic rules
(strip ANSI / progress bars, collapse 3+ duplicates, head+tail truncate,
blank collapse) + Tier 2 cheap-model extraction (default `ollama:qwen3.5:9b-fast`,
only above threshold). Wired into `ToolDispatcher.dispatch`. Raw output stored
under `.sophron/raw/` (50 MB LRU); `read_raw_output` builtin retrieves it.
`outputPurifier` / `outputPurifierThreshold` frontmatter; `ToolResult.rawPath`.

**Delivers:** a major, ongoing token-cost reduction on the noisiest tool
(`run_command` build/test/install spam) without information loss.

---

### M2 — Named Provider Instances ✅
**Why second:** backward-compatible, small, independent; unblocks the
multi-machine local-LLM setup and generic OpenAI-compat endpoints.

**Built (2026-07-06):** `ProviderName` is a free-form instance name;
`ProviderKind` carries the old type info. `~/.sophron/config.json` `providers`
is an array of named instances (`{name, kind, baseURL, apiKey, defaultModel}`)
with `${VAR}` env expansion. Legacy object form auto-migrated. `provider:`
frontmatter targets a named instance directly. `sophron providers` lists;
`sophron providers <name>` connectivity-tests (`GET /v1/models`).

**Delivers:** agent A → machine1:11434, agent B → machine2:11434, in the same
project.

---

### M3 — TUI Shell + Navigation (REWRITE) ✅
**Why a rewrite:** the first M3 attempt (project registry + `switchServices` +
overlay switcher) shipped and was **mechanically correct** but the navigation was
broken and confusing. The rewrite replaces the UX on top while **reusing** the
registry (`src/project/registry.ts`) and services teardown/rebuild
(`src/services/lifecycle.ts`).

**Built (2026-07-07):** the fix for "broken and confusing" is a **pure nav
reducer** (`src/tui/nav.ts`) that owns all navigation logic — no tangled
`useInput` handlers. 33 unit tests lock the state machine. The shell renders an
ASCII "SophronSwarm" banner + divider + horizontal tab bar inside one box.
- **Home surface — three tabs:** Overview (cross-project health via
  `buildOverview()`), Orchestrator (stub until M8), Projects (list → Enter
  switches project).
- **Project surface — six tabs:** Status · Agents · Runs · Checkpoint · Memory ·
  Cost. Agent detail (drill-down from Agents) shows config + a **live JSONL-tail
  stream** (re-reads the agent's latest run every 500ms).
- **Input bar** at the bottom: any printable char focuses it; Enter submits
  (slash command or, on Agent detail, a task for that agent); Esc cancels.
- ←/→ tabs, ↑/↓ lists, Enter open, Esc back. 501/501 tests pass.

**Scope:**
- **Box-chrome shell:** one outer box; "SophronSwarm" ASCII header +
  horizontal divider + horizontal tab bar. Tabs navigated with ←/→; Enter or ↓
  enters a drill-in-able tab; Esc or ↑ exits back to the tab bar.
- **Home surface — three horizontal tabs:**
  - **Overview** (display-only, no drill-in): aggregate health across all
    projects — active runs, pending approvals, token spend, agents in HALT.
    Event-driven, not polling.
  - **Orchestrator** (STUB until M8): Claude-Code/Codex-style two-pane chat.
    Left = conversation list (↑↓ nav, →/Enter open, Esc/← back); right = chat.
    As a stub it renders a placeholder + "global orchestrator not yet built"
    notice. **M8 fills it in.**
  - **Projects**: list all projects from the registry; ↑↓ + Enter enters a
    project's Project View.
- **Project View surface** (entered from Projects tab): its own tabs —
  **Status** (project-specific pending approvals / runs / token use) and
  **Agents** (list). Selecting an agent → **Agent detail** showing a **live
  stream** of what it is currently doing.
- **Live stream (new capability):** the agent loop (`src/agent/loop.ts`)
  currently writes events only to JSONL. M3 adds a lightweight in-process
  `EventEmitter` the loop emits to; the agent-detail view subscribes.
  Historical runs still come from JSONL via `readRunDetail`.
- **Tear down the old UX:** `src/tui/app.tsx`, `components/pages.tsx`,
  `components/projectSwitcher.tsx` are replaced by the new shell + views.

**Delivers:** a navigable, non-confusing terminal shell for the whole system —
Home tabs + Project View — with the Orchestrator chat slot reserved for M8.

---

### M4 — Context-Aware `/help` ✅
**Why here:** the view set is defined by M3; help is `helpForView(view)` once
those views exist. Cheap, coordinated change.

**Built (2026-07-07):** `src/tui/help.ts` — `helpForView(view)` +
`helpViewFor(surface, homeTab, projectTab, detail)` (derives the active view
from nav state). Every view returns the **core section** (navigation keys +
always-available commands: `/help`, `/projects`, `/clear`, `/quit`) plus a
**per-view section** specific to the 11 M3 views (home:overview/orchestrator/
projects; project:status/agents/agentDetail/runs/runDetail/checkpoint/memory/
cost). The `/help` handler in `app.tsx` computes the view from nav state and
renders it. The old static `HELP_TEXT` is kept as a deprecated re-export.
21 unit tests (pure logic). 522/522 total.

---

### M5 — `sophron init` Templates ✅
**Why here:** scaffolds a project's multi-agent structure from a curated starting
point; **every template seeds the standardized per-project orchestrator** (a
copy into the project's `agents/`) and installs the **global architect**
template at `~/.sophron/agents/architect.md` (used by the global orchestrator
in M7). Independent of M3 — can be built in parallel.

**Built (2026-07-07):** `src/init/templates.ts` — 4 built-in templates
(`minimal`, `cli`, `webapp`, `data-pipeline`) + user template support under
`~/.sophron/templates/<name>/`. Every scaffold seeds the **standardized
`orchestrator.md`** (always) + the template's specialist agents + shared
memory seeds (`OVERVIEW.md`, `CHECKPOINTS.md`).
- `sophron init [--template <name>] [--name <alias>] [--path <dir>] [--force]`.
- `sophron init --list` lists available templates.
- `sophron init --install-architect` writes the global architect to
  `~/.sophron/agents/architect.md` (used by M7).
- Default path: `~/sophron_workspace/<name>`.
- Idempotent: refuses to overwrite a non-empty `agents/` unless `--force`.
- Registers the project in `~/.sophron/projects.json`.
- **Templates vs. runtime boundary:** templates are init-time scaffolding (free
  to edit afterward, no approval gate); runtime roster creation is M6.
- 25 unit tests (pure logic). 547/547 total.

**Delivers:** Phase 7's specialization kits *are* these templates; every
project starts with a known-good orchestrator.

---

### M6 — Architect Roster Bootstrap (`propose_roster`) ✅
**Why here:** builds on M5 templates + the existing `propose_agent` flow;
generalizes single-agent draft→approve to a batch.

**Built (2026-07-07):** `propose_roster` drafts **N** agents in ONE pass behind
ONE operator approval gate, then bootstrap closes. It is the runtime companion
to M5 templates — a project bootstraps either from a template (M5) or from
scratch via the architect (M6).
- `src/agent/drafts.ts` — `AgentDraftStore` extended with **transactional batch
  methods**: `writeRoster(drafts[])` (validates ALL entries before touching the
  filesystem — all-or-nothing), `approveMany(names[])` / `rejectMany(names[])`
  (one ledger write; atomic — a bad name resolves NOTHING), `approveAll()` /
  `rejectAll()` (resolve every pending draft).
- `src/agent/serialize.ts` (NEW) — `serializeDraft()` + `yamlString()` extracted
  from `propose_agent.ts` so both the single + batch tools share one serializer.
- `src/tools/builtin/propose_roster.ts` (NEW) — the batch tool. Takes an
  `agents[]` array (+ optional `summary`); serializes + validates every entry up
  front (refuses the whole batch if ANY entry is bad: missing field, `full-auto`,
  duplicate name); warns when the resulting roster exceeds the 12-agent soft cap.
- Guardrails preserved from Phase 6: no `full-auto` drafts, no re-drafting
  resolved agents (checked **before** the closed-check, matching `writeDraft`),
  no auto-approval, bootstrap closes when all drafts resolve.
- **CLI batch approval:** `sophron agents --drafts` lists pending; `--approve
  <names...>` / `--reject <names...>` resolve a subset; `--approve-all` /
  `--reject-all` resolve everything. Listing surfaces a pending-draft hint.
- 50 new tests (16 serialize + 23 drafts-batch + 11 propose_roster). 597/597 total.

**Delivers:** the runtime companion to M5 templates — a project can be
bootstrapped either from a template (M5) or from scratch via the architect
(M6).

---

### M7 — Global Orchestrator + Multi-Project Meta-Layer ✅
**Why here:** the new meta-layer — one agent above all projects that the
operator talks to from Home. Depends on M5 (templates) and M6 (roster), since
project creation delegates to the architect (M6) and scaffolds via the template
machinery (M5).

**Built (2026-07-07):** the global orchestrator is a real, loadable agent at
`~/.sophron/agents/global-orchestrator.md` — the operator's "CEO" for the whole
workspace. It manages the **project lifecycle** (propose / create / list) with
**NO memory** and **NO codebase workspace**.
- **No-memory mechanism (`noMemory: true` frontmatter, M7):** `AgentDefinition`
  + the zod loader gained a `noMemory?: boolean` field. When true, the agent
  loop (`src/agent/loop.ts`) skips BOTH shared-memory AND per-agent memory
  injection — the global orchestrator's prompt is pure system-prompt + chat
  thread + `list_projects` output. This prevents any cross-project memory
  interference (locked decision).
- **Scoped global tools (`src/tools/builtin/global.ts`, NEW):**
  - `list_projects` — read-only view of `~/.sophron/projects.json`.
  - `propose_project` — drafts a structured proposal (name, path, template,
    summary) for the operator. **Does NOT create anything** — validates the
    name (lowercase-hyphenated) + template + checks for duplicates; returns a
    draft for review. There is no auto-creation path.
  - `init_project` — controlled scaffolding after approval. Calls M5's
    `scaffoldProject`; refuses to clobber an existing `agents/` dir; path-
    traversal-guarded (all paths coerced under `~/sophron_workspace/`).
- **`GLOBAL_ORCHESTRATOR` template (`src/init/templates.ts`, NEW const):** the
  agent definition. `tools:` = the scoped set + `delegate` (to architect) +
  read-only fs; `delegateAllowlist: [architect]`; `noMemory: true`; **no**
  `run_command` / `apply_patch`. `installGlobalOrchestrator()` writes it to
  `~/.sophron/agents/global-orchestrator.md` (idempotent, like the architect).
- **CLI:** `sophron init --install-orchestrator` installs/updates it.
- **Wired into `BUILTIN_TOOLS`** so the global orchestrator's allowlist resolves
  the new tools; other agents don't list them.
- **Project-creation flow (now end-to-end capable):** operator proposes an idea →
  global orchestrator `propose_project` (draft) → optionally `delegate` to
  architect for a custom roster (M6 `propose_roster`) → operator approves →
  `init_project` scaffolds + seeds the standardized orchestrator + registers.
- 26 new tests (loader `noMemory` ×2 + global tools ×15 + template/installer ×9).
  623/623 total.

**Delivers:** the operator can propose and spin up whole projects from a chat;
the meta-layer is the "CEO" of the org. The runtime machinery is complete —
M8 wires it into the TUI Home chat.

---

### M8 — Wire Global Orchestrator into TUI Home ✅
**Why here:** M3 shipped the Orchestrator tab as a stub because the global
orchestrator did not exist yet. M8 replaced the stub with the real chat
(`OrchestratorChat`) backed by `runAgent`, plus the project-switch
ghost-lines fix and `/clear` chat reset.

**Delivered:** the full Home experience — talk to the global orchestrator,
propose/create projects, monitor all project health, jump into any project —
all from one terminal session.

**Scope:**
- Replace the M3 Orchestrator-tab stub with the real global-orchestrator chat
  (two-pane: conversation list + chat).
- Conversation persistence: global-orchestrator threads; a thread is linked to
  a project once it produces one; free-form chats also allowed.
- Project-proposal flow surfaced in the TUI (the M7 `propose_project` →
  `init_project` chain behind the chat).
- Wire the M3 Overview aggregate-health view to live cross-project data.

**Delivers:** the full Home experience — propose projects, monitor all project
health, jump into any project — all from one terminal session.

---

### M9 — Web UI (Phase 5b) ⏸ Deferred
**Why deferred:** CLI-first is a locked decision (`PROJECT_OVERVIEW.md` §7.6).
The web UI shares the JSONL event log and is low-dependency, so it can be
picked up in parallel by a separate effort without blocking the CLI vision.
Revisit when the CLI vision (M3–M10) is stable.

---

### M10 — Operator Ergonomics ✅
**Why here:** three operator-facing gaps surfaced in use: (1) no easy way to
add providers (manual `config.json` editing only), (2) the architect wasn't
model-aware and couldn't actually call `propose_roster`, (3) no way to delete
an accidentally-created project.

**Scope / delivered:**
- **Provider management** — `sophron add-provider` (interactive menu OR
  `--name/--kind/--base-url/--api-key/--model/--default` flags) + `sophron
  edit-provider <name>` (partial update — add/change a key or model without
  re-adding; interactive pre-filled prompts OR flags like `--api-key` /
  `--clear-key`) + `sophron remove-provider <name>`. New
  `addProviderInstance`/`updateProviderInstance`/`removeProviderInstance` in
  `providers.ts` (read-modify-write, atomic, migrates legacy object form).
  `${ENV_VAR}` references encouraged for secrets (expanded at load).
- **Model-aware architect** — new `list_providers` global tool (read-only:
  lists configured instances + default models + tier guidance; optional
  `probe` pings `/v1/models`). `GLOBAL_ARCHITECT` prompt now documents the
  cheap/mid/frontier/inherit tiers + the right-size principle. **Bug fix:**
  the architect's `tools:` list was missing `propose_roster`/`propose_agent`
  (the dispatcher allowlist silently blocked them) — now included.
- **Project management** — `sophron projects` command exposing the existing
  registry functions: `list` (default), `remove <name|path>` (with confirm /
  `-y`; unregisters only — does NOT delete files), `rename`, `pin`/`unpin`.

**Delivers:** operators can self-serve providers, projects, and expect the
architect to pick sensible models — no config-file editing or hand-holding
required.

---

### M11 — Runtime Model Switching (`/model`) ✅
**Size:** Medium  
**Built (2026-07-08):** default templates now use `frontier`; operators can
change any agent's model on the fly via `/model` or `--model`.

**Scope:**
- Updated `STANDARD_ORCHESTRATOR`, `GLOBAL_ARCHITECT`, and `GLOBAL_ORCHESTRATOR`
  templates so their default `model:` is `frontier` (resolved via the operator's
  tier map) instead of `ollama:qwen3.5:9b-thinking`.
- Added a runtime model-override path:
  - `RunOptions` accepts an optional `modelOverride` (`{ model, provider? }`).
  - The agent loop (`src/agent/loop.ts`) uses the override for `llm.complete`
    when present, otherwise falls back to `agent.model`/`agent.provider`.
  - The TUI keeps a per-session override map keyed by agent name.
- Extended `parseSlashCommand` with `/model <agent> <model-spec>` (and a bare
  `/model <model-spec>` when viewing an agent detail). Model specs support named
  tiers (`frontier`/`mid`/`cheap`), provider-prefixed ids (`ollama:...`), and
  named provider instances (`my-ollama:qwen3.5:9b`).
- Added `resolveModelSpec()` in `src/llm/providers.ts` to resolve those specs.
- Surfaced the effective model in the TUI Agent detail header (with an
  "override" badge) and acknowledged changes via the output log.
- Added a `--model <spec>` flag to `sophron run` so the CLI path supports the
  same override.
- 12 new tests: `resolveModelSpec`, `/model` slash parsing, template defaults,
  AgentDetail override display.

**Delivers:** orchestrator/architect/global-orchestrator default to frontier;
operators can flip any agent's model on the fly from chat or CLI.

---

### M12 — Global Orchestrator Project Context ✅
**Size:** Small–Medium  
**Built (2026-07-08):** the global orchestrator can now read existing project
overviews and carry a structured discovery/handoff conversation.

**Scope:**
- Added `read_project_overview` global tool that reads
  `<project>/.sophron/shared/OVERVIEW.md` for any registered project (or an
  absolute workspace path), guarded by the same path-traversal rules as
  `init_project`.
- Enriched `propose_project` and `init_project` with optional `goal` and
  `constraints` fields. When provided, `init_project` seeds `OVERVIEW.md` with
  structured `## Goal`, `## Constraints`, and `## Stack` sections.
- Rewrote the `GLOBAL_ORCHESTRATOR` prompt:
  - Encourages a short discovery phase (goal, stack, constraints, feasibility).
  - Uses `read_project_overview` on existing projects to avoid duplication.
  - Captures agreed goal/constraints in the proposal and seeds them into the
    new project's overview.
  - Explicitly hands off code-level planning to the per-project orchestrator.
- Added `read_project_overview` to the global orchestrator's `tools:` allowlist.
- 7 new tests: overview read (found/missing/unknown/traversal), proposal
  goal/constraints, init overview seeding, and template prompt assertions.

**Delivers:** the global orchestrator can discuss projects in context and
produce clearer, goal-driven handoffs to per-project orchestrators.

---

### M13 — Provider Descriptions ✅
**Size:** Small  
**Built (2026-07-08):** provider instances can carry operator-provided
descriptions, and the architect prompt instructs using them.

**Scope:**
- Added `description?: string` to `ProviderConfig`, `RawProviderEntry`,
  `AddProviderInput`, and `ProviderPatch`.
- Preserved the field through `applyKindDefaults`, legacy config migration,
  and the `addProviderInstance`/`updateProviderInstance` read-modify-write flow.
- Added `--description <text>` to `sophron add-provider` and
  `sophron edit-provider`, plus `--clear-description` for edit-provider.
- Updated the `list_providers` tool output to include each provider's
  description.
- Updated the `GLOBAL_ARCHITECT` prompt to instruct the architect to read
  provider descriptions when choosing models.
- 5 new tests: description persistence on add, set/clear on edit, raw entry
  round-trip, config load round-trip, `list_providers` output, and prompt
  assertion.

**Delivers:** every provider instance can carry an operator-provided
description, and the architect uses it when assigning models.

---

### M14 — TUI Surface-Switch Render Cleanup 🔜
**Size:** Small–Medium  
**Why now:** switching from the Project surface back to Home leaves visual
artifacts on top of the current TUI, indicating Ink's remount key is not fully
clearing the previous buffer.

**Scope:**
- Reproduce the project→home artifact reliably.
- Add an explicit terminal buffer clear around surface switches in
  `src/tui/app.tsx` (e.g., on `goHome`, `enterProject`, and `switchProject`).
  Use ANSI erase-in-display + home-cursor, guarded so it does not run in test
  renderers.
- Ensure state resets (`setBlocks([])`, `setMemoryContent("")`,
  `setRunDetail(null)`) complete before the next frame, and tighten the content
  area remount key so old components are fully unmounted.
- Consider moving the static output log to Ink `<Static>` so historical lines
  do not interfere with dynamic content height.
- Add a regression test if feasible (Ink render snapshot or nav-action test).

**Delivers:** clean, artifact-free transitions between Home and Project
surfaces.

---

## Dependency graph

```
M1 ✅ (purifier)  ─┐
M2 ✅ (providers)  ─┴─ done

M5 ✅ (templates) ─► M6 ✅ (propose_roster) ─► M7 ✅ (global orchestrator) ──┐
                                                                            ├─► M8 ✅ (wire into Home)
M3 ✅ (TUI shell rewrite) ─► M4 ✅ (/help)                                  ┘

M10 ✅ (operator ergonomics) ── builds on M2 (providers) + M5/M7 (architect)

M11 (model switching) ── builds on M2 (providers) + M3 (TUI) + M5/M7 (templates)
M12 (global orch context) ── builds on M7 (global orchestrator)
M13 (provider descriptions) ── builds on M2 + M10 (provider CLI)
M14 (TUI render cleanup) ── builds on M3 + M8 (home/project switching)

M9 (web UI) ── optional / parallel / deferred
```

- **M10** builds on **M2** (provider config) + **M5/M7** (the global
  architect template).

## Starting point

M3–M8, **M10 (operator ergonomics)**, **M11 (runtime `/model` switching)**, **M12
(global-orchestrator project context)**, and **M13 (provider descriptions)** are
✅ complete. The remaining milestone is **M14**: TUI surface-switch render cleanup.
**M9 (web UI)** remains deferred (CLI-first is locked) and can be picked up in
parallel by a separate effort.
