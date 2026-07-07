# SophronSwarm V3 — Development Roadmap

> Ordered development timeline integrating the remaining phase work (5b, 7)
> with the proposed enhancements in [`IDEAS.md`](./IDEAS.md), and the
> **two-tier hierarchy** vision (global orchestrator above all projects).
>
> **Baseline (verified 2026-07-07):** 501/501 tests passing, clean `tsc`.
> Phases 0–6 complete. M1 (purifier) + M2 (named providers) + M3 (TUI rewrite)
> complete.
>
> **Last updated:** 2026-07-07

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
| **M4 — Context-aware `/help`** | 🔜 | `helpForView(view)` over M3's view set |
| **M5 — `sophron init` Templates** | 🔜 | seeds per-project orchestrator + global architect template |
| **M6 — `propose_roster`** | 🔜 | batch draft→approve→close; generalizes `propose_agent` |
| **M7 — Global Orchestrator meta-layer** | 🔬 | the "CEO" agent above all projects (no memory) |
| **M8 — Wire Global Orchestrator into TUI Home** | 🔬 | replaces the M3 Orchestrator tab stub with real chat |
| **M9 — Web UI (Phase 5b)** | ⏸ Deferred | CLI-first is locked (`PROJECT_OVERVIEW.md` §7.6); low-dependency, parallelizable |

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

### M4 — Context-Aware `/help` 🔜
**Why here:** the view set is defined by M3; help is `helpForView(view)` once
those views exist. Cheap, coordinated change.

**Scope:**
- Replace the static `HELP_TEXT` with `helpForView(view)`.
- Always-available core (`/help`, `/clear`, `/quit`, `/projects`, `/home`)
  + per-view section (Agent › Chat → agent-directing commands: free-text,
  `/approve`, `/interrupt`, `/rewind`).

---

### M5 — `sophron init` Templates 🔜
**Why here:** scaffolds a project's multi-agent structure from a curated starting
point; **every template seeds the standardized per-project orchestrator** (a
copy into the project's `agents/`) and installs the **global architect**
template at `~/.sophron/agents/architect.md` (used by the global orchestrator
in M7). Independent of M3 — can be built in parallel.

**Scope:**
- `sophron init [--template <name>] [--name <alias>] [--path <dir>]`.
- Built-in templates (`webapp`, `cli`, `data-pipeline`, `minimal`) + user
  templates under `~/.sophron/templates/<name>/`.
- Each template ships a **standardized `orchestrator.md`** as its first agent,
  plus template-specific starter agents.
- Seed `.sophron/shared/` (`OVERVIEW.md`, `CHECKPOINTS.md`).
- Default project path: `~/sophron_workspace/<name>`.
- Idempotent: refuses to overwrite an existing `agents/` unless `--force`.
- **Registers the project** in `~/.sophron/projects.json` with the `--name`
  alias if given.
- **Templates vs. runtime boundary:** templates are init-time scaffolding
  (free to edit afterward, no approval gate). Runtime roster creation is M6
  (draft→approval→closed).

**Delivers:** Phase 7's specialization kits *are* these templates; every
project starts with a known-good orchestrator.

---

### M6 — Architect Roster Bootstrap (`propose_roster`) 🔜
**Why here:** builds on M5 templates + the existing `propose_agent` flow;
generalizes single-agent draft→approve to a batch.

**Scope:**
- `propose_roster` tool — the Architect reads project requirements, drafts **N**
  agents in one pass, one operator approval gate covers the whole roster, then
  bootstrap closes. Matches the locked policy in `PROJECT_OVERVIEW.md` §5.1.
- Extend `AgentDraftStore` (`src/agent/drafts.ts`) for batched rosters.
- Batch-approval UI (list N drafts: accept-all / accept-selected / reject).
- Guardrails preserved from Phase 6: no `full-auto` drafts, no re-drafting
  resolved agents, no auto-approval.

**Delivers:** the runtime companion to M5 templates — a project can be
bootstrapped either from a template (M5) or from scratch via the architect
(M6).

---

### M7 — Global Orchestrator + Multi-Project Meta-Layer 🔬
**Why here:** the new meta-layer — one agent above all projects that the
operator talks to from Home. Depends on M5 (templates) and M6 (roster), since
project creation delegates to the architect (M6) and scaffolds via the template
machinery (M5).

**Scope:**
- **Global orchestrator agent** at `~/.sophron/agents/global-orchestrator.md`
  (distinct from the per-project orchestrator seeded by M5).
- **No memory.** The loader is configured to skip memory injection for this
  agent — no per-agent `MEMORY.md`, no shared-memory injection. Its only input
  beyond the chat thread is the **project registry** (`list_projects`). It is a
  pure project-lifecycle manager and must not inherit or interfere with any
  project's memory.
- **Scoped tool set:** `delegate` (to the global architect), `list_projects`,
  `propose_project` (drafts a project proposal: name, path, template,
  summary), `init_project` (controlled scaffolding after approval), and
  read-only `read_file` / `list_dir` over `~/.sophron/`. **No** `run_command`
  / `apply_patch` — no codebase workspace.
- **Project-creation flow:** operator proposes an idea → global orchestrator
  delegates to the global architect → architect drafts the roster via M6
  `propose_roster` → operator approves → `init_project` scaffolds the project
  at `~/sophron_workspace/<name>` + seeds the standardized per-project
  orchestrator → registered in `projects.json`.
- **Global architect:** a single `architect.md` (installed by M5) at user scope
  that drafts rosters for any new project.

**Delivers:** the operator can propose and spin up whole projects from a chat;
the meta-layer is the "CEO" of the org.

---

### M8 — Wire Global Orchestrator into TUI Home 🔬
**Why here:** M3 ships the Orchestrator tab as a stub because the global
orchestrator does not exist yet. M8 replaces the stub with the real chat and
the project-proposal flow once M7 lands.

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
picked up in parallel by a separate effort without blocking M3–M8. Revisit
when the CLI vision (M3–M8) is stable.

---

## Dependency graph

```
M1 ✅ (purifier)  ─┐
M2 ✅ (providers)  ─┴─ done

M5 (templates) ─► M6 (propose_roster) ─► M7 (global orchestrator) ──┐
                                                                     ├─► M8 (wire into Home)
M3 (TUI shell rewrite) ─► M4 (/help)                                 ┘

M9 (web UI) ── optional / parallel / deferred
```

- **M5 / M3** are both unblocked now and **independent** of each other — they
  can be built in parallel.
- **M4** depends on **M3** (its view set).
- **M6** depends on **M5**; **M7** depends on **M5 + M6**; **M8** depends on
  **M3 + M7**.

## Starting point

**M3 (TUI Shell rewrite)** is ✅ complete (501/501 tests). The next builds,
either order (both unblocked):
- **M4 (`/help`)** — cheap; `helpForView(view)` over M3's view set.
- **M5 (`sophron init` templates)** — independent of M4; seeds the standardized
  per-project orchestrator + global architect.

Then **M6 (`propose_roster`)** → **M7 (global orchestrator)** → **M8 (wire into
Home)**.
