# SophronSwarm V3 — Goals & Ideas

> Living document of proposed features, architectural changes, and open
> directions. Items here are **not committed** — they're captured so context
> isn't lost between sessions. Each entry has a status and a proposed approach
> that can be debated before implementation.
>
> **Last updated:** 2026-07-08

---

## Status legend

| Tag | Meaning |
|---|---|
| 🔬 **Proposed** | Idea captured; not yet designed or scoped |
| 🟡 **Needs decision** | Approach sketched; awaiting operator sign-off on a trade-off |
| 📦 **Ready to build** | Approach agreed; scoped; waiting for sequencing |
| ❌ **Declined** | Considered and rejected (with reason) |

---

## 1. Named provider instances (multi-machine Ollama) — ✅ BUILT (M2)

### Problem
The system supports exactly **one** endpoint per provider kind. `ProviderName`
is a fixed 3-way union (`"openrouter" | "ollama" | "zai"`), and
`LLMClient.sdk(name)` caches one OpenAI SDK instance per name. So you cannot
point agent A at `machine1:11434` and agent B at `machine2:11434` — there is a
single global Ollama endpoint.

This blocks the multi-machine local-LLM setup (several boxes each running
models) and also blocks generic OpenAI-compatible endpoints (vLLM, LM Studio,
LocalAI, TGI, llama.cpp server).

### Spec (backward-compatible)
1. Make `ProviderName` a **free-form string** instead of a 3-way enum. Keep
   `"ollama"` / `"zai"` / `"openrouter"` as built-in defaults so existing
   configs keep working.
2. Extend `~/.sophron/config.json` `providers` from an object keyed by kind to
   an **array of named instances**, each with an explicit `kind`:
   ```json
   {
     "providers": [
       { "name": "ollama-laptop",  "kind": "ollama",      "baseURL": "http://laptop:11434/v1",  "defaultModel": "qwen3.5:9b" },
       { "name": "ollama-desktop", "kind": "ollama",      "baseURL": "http://desktop:11434/v1", "defaultModel": "llama3.1:8b" },
       { "name": "or-cloud",       "kind": "openrouter",  "apiKey": "${OPENROUTER_API_KEY}",   "defaultModel": "anthropic/claude-sonnet-4" }
     ]
   }
   ```
3. Add an optional `provider:` field to agent frontmatter so an agent can
   target a specific named instance:
   ```yaml
   model: qwen3.5:9b
   provider: ollama-desktop
   ```
   The loader already resolves `model` once at load time — it would resolve
   `provider` the same way.
4. Key the `LLMClient` SDK cache by **provider-instance name** instead of the
   3-way enum. Each named instance gets its own cached OpenAI SDK client with
   its own baseURL/apiKey/timeout.
5. Keep `resolveModel()`'s prefix shortcuts (`ollama:foo`, `zai:bar`,
   `openrouter:baz`) as shorthand that resolves to the *default* instance of
   that kind when no explicit named instance exists.
6. New `sophron providers` subcommand: list configured instances + `sophron
   providers test <name>` pings `GET /v1/models` to verify connectivity.

### Provider resolution order (in `resolveModel`)
1. Explicit `provider:` frontmatter → that named instance (model taken from
   `model:` field as-is).
2. Explicit model-id prefix (`ollama:` / `zai:` / `openrouter:`) → default
   instance of that kind.
3. Tier name (`frontier`/`mid`/`cheap`/`inherit`) → operator tier-map override.
4. Bare model id → OpenRouter (cloud router handles most models).
5. Fallback → first configured instance with a `defaultModel` + valid creds.

### Decisions (resolved)
- **Env-var interpolation in config: YES.** Simple `${VAR}` substitution in
  `baseURL` / `apiKey` / `defaultModel` values via a tiny `expandEnv()`
  helper. Lets operators keep API keys out of the JSON file. No full templating
  engine — just `process.env[VAR]` lookup.
- **Migration path: accept both shapes for one release.** If `providers` is a
  legacy object (`{ ollama: {...}, openrouter: {...} }`), convert at load: each
  key becomes a default instance
  `{ name: "<kind>", kind: "<kind>", ...legacyFields }`. Log a deprecation
  warning. Drop legacy support after one release.
- **Built-in zero-config defaults preserved:** when no config file exists,
  `ollama` → `http://localhost:11434/v1`, `openrouter`/`zai` → env-only, exactly
  as today.

### Where it touches the code
- `src/llm/providers.ts` — `ProviderName` → `string`; `getProvider(name)`;
  `resolveModel`; config schema; `expandEnv()` helper; legacy-object migration.
- `src/llm/client.ts` — SDK cache keyed by instance name (already a `Map`, just
  widen the key type).
- `src/agent/loader.ts` — resolve + store `provider` instance name on
  `AgentDefinition`; frontmatter `provider:` field added to the zod schema.
- `src/types.ts` — `AgentDefinition.provider: string` (was `ProviderName`).
- `src/cli.ts` — new `providers` subcommand.

---

## 2. Project-scoped TUI navigation — ✅ DONE (M3–M8)

> **Status update (2026-07-08):** the *first* M3 attempt was replaced by the
> box-chrome tabbed shell described in `ROADMAP.md` (M3). The registry
> (`src/project/registry.ts`) and services teardown/rebuild
> (`src/services/lifecycle.ts`) were reused. The global-orchestrator chat is
> wired into Home › Orchestrator (M8). The design below is the **original**
> proposal; the authoritative current spec is in `ROADMAP.md` M3 + M7 + M8.

### The question
Operator vision: `Home (everything) → Projects (list) → Project 1 (agents,
memories, runs) → Agents (list) → Agent 1 (chat, /approve)` — i.e. agents are
local to projects, with a hierarchy to navigate them.

### Why 5 permanent levels is the wrong shape for a terminal
Every nesting level in a terminal UI eats vertical space (breadcrumbs, frames,
prompts per level) and adds keypresses. 95% of operator time is spent **inside
one project**, so making the project a nested grandchild of `Home → Projects`
means 3 navigations just to reach the workspace you actually want. Good
terminal apps (lazygit, k9s, tmux sessionizers) all treat project-selection as
a **transient launcher**, not a permanent nesting level.

### Proposed layout — two surfaces, permanent depth of 2

**Surface A — Landing Overview (the "everything" view, as a *screen*, not a
nesting level):**
- Aggregate stats across all known projects: total token spend, active runs,
  pending approvals anywhere, MCP cost.
- A list of recent/active projects (from the project registry, below).
- `Enter` on a project row → drops into that project's workspace.
- This *is* the "Home (everything)" view — but you don't navigate *through* it
  to reach a project; you either pick from it or jump straight to the active
  project.
- Reached via `Esc` / `/home`.

**Surface B — Project Switcher (transient overlay):**
- Triggered by `Ctrl+P` or `/projects`.
- Fuzzy-filter list of all known projects → `Enter` sets the active workspace
  and **rebuilds `SharedServices`** for it.
- `Esc` cancels, stays on current project.
- Collapses the `Home` + `Projects` levels into ONE transient action.

**Surface C — Per-project workspace (the real root — flat):**
- Tabs (left sidebar or top bar): `Agents · Runs · Checkpoint · Memory · Cost · Help`.
- Main content area replaces on tab switch (no new frames). Breadcrumb shows
  `Project › Tab`.
- **One** justified drill-down: selecting an Agent opens an **Agent detail
  view** with its own sub-tabs.

**The one drill-down — Agent detail view:**
```
Agents tab → [select agent] → Agent detail
                               ├── Overview   (frontmatter, model, tools, permission mode, status)
                               ├── Chat       (message log + input → free-text routes to THIS run, /approve, /interrupt)
                               ├── Memory     (MEMORY.md, editable inline)
                               └── Runs       (this agent's runs, open one to replay)
```

### Effective permanent depth: 2
```
[Overview screen] / [Ctrl+P switcher overlay — transient]
   │
   └── Project workspace  (root of daily work)
         ├── Agents  tab ──► Agent detail (Overview/Chat/Memory/Runs)   ← only drill-down
         ├── Runs    tab ──► Run detail (replay/rewind)
         ├── Checkpoint / Memory / Cost / Help  (flat)
         └── ...
```
Compare to the 5-level proposal: `Home → Projects → Project → Agents → Agent`.
The "everything" and "projects list" levels become a screen + an overlay; the
workspace becomes the root; the agent-list is a tab; the agent-detail is the
one real drill-down.

### Layout sketch (terminal)
```
┌─ SophronSwarm ───────────────────── my-webapp ────────┤
│ [Ctrl+P switch]  Pending approvals: 1   Spend: 4.2k    │
│ ─────────────────────────────────────────────────────  │
│  Agents   Runs   Checkpoint   Memory   Cost   Help     │ ← tabs
│ ─────────────────────────────────────────────────────  │
│  ▸ builder        [idle]     model: ollama:qwen3.5     │
│  ▸ orchestrator   [running]  turns: 4   tokens: 2.1k   │
│  ▸ echo-bot       [idle]                              │
│ └──────────────────────────────────────────────────────┘
```
Breadcrumb when drilled into an agent:
```
my-webapp › Agents › orchestrator › Chat
```
Any crumb is selectable to jump back — no "back-button chain."

### New concept this needs: a project registry
A TUI session must hold an `activeProject` and switch between multiple projects.
Currently `cli.ts` calls `buildServices(workingDir, ...)` **once at launch**
for a single `--dir`. To support switching:
- `~/.sophron/projects.json` — registry of known projects:
  `[{ name, path, lastOpened, pinned }]`. Auto-populated whenever `sophron`
  runs in a directory; editable; `name` is an operator alias.
- `buildServices()` becomes **re-invokable on project switch**. Teardown is
  already safe — `Checkpointer.close()`, `McpConnectionPool.closeAll()`,
  `AgentRegistry.stopWatch()` all exist and are called in `cli.ts`'s `finally`
  today. The TUI just calls them on switch-out, then rebuilds for the new dir.
- TUI state gains `activeProject: string` + a `switchProject(name)` action that
  tears down + rebuilds services + re-renders.

### Where it touches the code
- New `src/project/registry.ts` — load/save `~/.sophron/projects.json`, add on
  first-seen, sort by `lastOpened`.
- `src/cli.ts` — `buildServices()` factored out so the TUI can call it on
  switch (today it's inline in each subcommand's `action`).
- `src/tui/` — restructure: `OverviewScreen`, `ProjectWorkspace`, `AgentDetail`
  components; breadcrumb nav state; `Ctrl+P` switcher overlay.
- `src/tui/app.tsx` — `activeProject` state + `switchProject()`; the existing
  page set (Projects/Agents/Runs/...) folds into the workspace tabs + overview.

### Open questions (need operator sign-off)
- Is the aggregate **Overview** landing screen wanted, or overkill? (Alt: land
  directly in the most-recent project; Overview reachable via `/home`.) The
  Overview is where the "everything" cross-project spend/approval stats live —
  if you don't want those, skip it.
- Switcher UX: `Ctrl+P` overlay + `/projects` command (both), or one only?
- Confirm multi-project-per-TUI-session is worth the services-rebuild
  complexity vs. just restarting `sophron` per project. (Recommendation: yes,
  it's worth it — the teardown/rebuild is already clean, and the Overview +
  switcher are the whole point of "agents are local to projects but I manage
  many projects.")
- Does a project need a `name`, or just use its directory basename? (Recommend:
  allow optional alias in registry; default to basename.)

---

## 3. Context-aware `/help` — 📦 Ready to build (depends on #2)

### Problem
`HELP_TEXT` is a single global static string (`src/tui/slashCommands.ts:140`).
`/help` renders the same command list regardless of which TUI page is active.

### Spec
Once navigation (#2) defines the view set, help becomes `helpForView(view)`:
- Replace the static `HELP_TEXT` string with `helpForView(view: View): string`.
- **Always-available core** on every screen: `/help`, `/clear`, `/quit`,
  `/projects` (switch), `/home` (overview).
- **Per-view section**, filtered to commands valid there:
  - Overview → `/projects`, open project, aggregate commands.
  - Agents tab → `/run`, `/memory`, how to open an agent.
  - Agent › Chat → free-text sends to the run, `/approve <id> y|n`,
    `/interrupt`, `/rewind <runId>`.
  - Checkpoint → `/checkpoint`, `/advance`.
  - Cost → `/cost`, `/providers`.
- The "per-run conversation view" from earlier discussion is now the
  **Agent › Chat** sub-view in the nav design (#2) — so the help work and the
  nav work are one coordinated change, not two.

### Where it touches the code
- `src/tui/slashCommands.ts` — `HELP_TEXT` constant → `helpForView()` function;
  the parser is unchanged.
- `src/tui/app.tsx` — pass current view into help rendering.

---

## 4. Project-local agent structure templates (`sophron init`) — 📦 Ready to build

### Vision
Every project already gets its own `agents/` directory (project scope > user
scope in the registry, `src/agent/registry.ts`). What's missing is a way to
*scaffold* a project's multi-agent structure from a curated starting point, and
to let the Architect generate a custom structure for projects that don't fit a
template.

This is a natural first deliverable of Phase 7 (specialization kits) — the kits
*are* essentially templates.

> **Update (2026-07-07):** every template now **seeds a standardized
> `orchestrator.md`** as its first agent (the per-project orchestrator) and
> installs a **global `architect.md`** at `~/.sophron/agents/architect.md`
> (used by the global orchestrator in §6). Default project path is
> `~/sophron_workspace/<name>`. See `ROADMAP.md` M5.

### Spec (three pieces)

**Piece 1 — `sophron init [--template <name>] [--name <alias>]` (low-risk):**
- Copies a curated `agents/*.md` roster + seed `.sophron/shared/` (OVERVIEW.md,
  CHECKPOINTS.md) into the current/`--dir` project.
- Built-in templates: `webapp`, `cli`, `data-pipeline`, `minimal`.
- User-customizable templates under `~/.sophron/templates/<name>/`.
- Idempotent: refuses to overwrite an existing `agents/` unless `--force`.
- **Registers the project in `~/.sophron/projects.json`** (ties to nav #2) with
  the `--name` alias if given.

**Piece 2 — Architect-generated roster (`propose_roster`):**
- Generalize the single-agent `propose_agent` (Phase 6) to batch: Architect
  reads project requirements → drafts N agents in one pass → **one** operator
  approval gate covers the whole roster → bootstrap closes.
- Matches the locked policy in `PROJECT_OVERVIEW.md` §5.1.

**Piece 3 — Templates vs. bootstrap boundary (design note to carry forward):**
- **Templates** = init-time starting point. Free to edit afterward; just files.
  No approval gate.
- **Architect bootstrap** = runtime capability, draft→approval→closed.
  Prevents self-modifying swarms (§5.1 / §7.1).
- Different layers (scaffolding vs. runtime creation); they do **not** conflict
  once framed this way. The authoritative scope for both pieces now lives in
  `ROADMAP.md` (M5 = templates, M6 = `propose_roster`).

### Where it touches the code
- `src/cli.ts` — new `init` subcommand.
- `templates/` (built-ins in repo) + `~/.sophron/templates/` (user overrides).
- `src/project/registry.ts` (from #2) — `init` registers the project.
- `src/agent/drafts.ts` — extend `AgentDraftStore` for batched rosters.
- New `propose_roster` builtin tool alongside `propose_agent`.

### Open questions
- Should templates include seed checkpoints, or just agents? (Recommend: both,
  gated by a `template.json` manifest.)
- Batch-approval UI for `propose_roster` — list N drafts with accept-all /
  accept-selected / reject.

---

## 5. Output purifier — deterministic-first filter pipeline — ✅ BUILT (M1)

> **Built 2026-07-06.** Shape is exactly the two-tier deterministic-first
> filter below, wired into the `ToolDispatcher.dispatch` chokepoint. Tier 2
> reuses the auto-classifier model (`ollama:qwen3.5:9b-fast`). Raw output is
> stored under `.sophron/raw/` (50 MB LRU) and retrievable via the
> `read_raw_output` builtin. See `ROADMAP.md` M1 + repo memory for details.
> The spec below is kept as the design record.

### Vision
Tool output is the #1 context-bloater: a noisy `cargo build` with 50 warnings,
a web-page scrape full of nav/ads/chrome, `pip install` spam — these easily
dump 5–20k tokens of noise per call, every turn, into a frontier model's
context. A purification stage that compresses tool output *before* it reaches
the agent's message history cuts a major ongoing token cost.

Not speculative — **V2 had a "log purifier"** (referenced in
`PROJECT_OVERVIEW.md` §10 as a thing to port), and SwarmClaw routes `/compact`
to a cheap model. Validated pattern.

### Why NOT a peer "agent"
A separate agent you delegate to adds a round-trip + coordination on *every*
tool call, and "model decides to invoke it" makes purification optional/chatty.
The right shape is a **synchronous filter in the tool-result path** — a pure
function `purify(tool, output) → compressed` that runs *before* the result
enters message history. Matches the locked principle "spend tokens only where
an LLM's judgment is required" (§0 of `AGENT_CONTEXT.md`).

### Spec — two-tier, deterministic-first

**Tier 1 — deterministic rules (free, zero tokens, µs latency):**
1. Strip ANSI escape codes (`\x1b\[[0-9;]*[a-zA-Z]`).
2. Collapse 3+ consecutive identical lines → one + `[… N duplicate lines …]`.
3. Head+tail truncation: if output > threshold, keep first 40 + last 40 lines,
   insert `[… N lines omitted …]`.
4. Strip carriage-return progress bars (lines with many `\r` overwrites).
5. Drop `node_modules/`, `.git/`, `dist/`, `build/`, `target/`, `.next/` paths
   in file listings.
6. Collapse runs of blank lines to max 1.
7. Known-noisy tools (`npm install`, `pip install`, `cargo build`, `yarn`) →
   aggressive truncation profile.
- Handles ~80% of real-world noise with no model cost. This is what V2's
  purifier mostly was.

**Tier 2 — cheap model (optional, fires only when needed):**
- Triggers when output still > threshold after Tier 1 **and** a heuristic flags
  it as noisy (long, repetitive, or a known-noisy tool).
- Local small model (`qwen2.5:1.5b` / `llama3.2:1b`) — same model as the auto
  classifier (see "Decisions" below). Routed through `LLMClient` on the cheap
  tier.
- Prompt: *"Extract: (1) any errors/warnings, (2) the final result/exit cause,
  (3) files changed or key outputs. Output ≤ 300 tokens. If nothing failed,
  say 'succeeded' + 1-line summary."*

**Safety valve — no information loss:**
- Raw output written to `.sophron/raw/<callId>.txt` before purification.
- Only the purified version enters the agent's message history.
- `read_raw_output(callId)` tool lets the agent dig deeper when a summary is
  ambiguous.

**Per-agent opt-in:**
- Frontmatter `outputPurifier: "default" | "aggressive" | "off"` (default:
  `"default"`). `plan`-mode reviewers may set `"off"` for fidelity.

### Decisions (resolved)
- **Threshold:** configurable, default **1500 tokens (~5250 chars)** for the
  Tier 2 trigger. Per-agent override via `outputPurifierThreshold`.
- **Purifier model:** reuse the auto-mode classifier model. New
  `~/.sophron/config.json` field `purifierModel` (default `"ollama:qwen2.5:1.5b"`
  if that instance is configured, else deterministic-only). Ties into the open
  Ollama-classifier-model question (`PROJECT_OVERVIEW.md` §11) — recommend one
  small local model serve both vetting and purification.
- **Batch, not streaming** — simpler; tool output is already complete when we
  receive it, so latency is just one cheap-model call when Tier 2 fires.
- **Retention:** `.sophron/raw/` capped at **50 MB per project**, LRU-pruned.
  Configurable.

### Where it touches the code
- New `src/tools/purifier.ts` — Tier 1 rule chain + Tier 2 model dispatcher +
  raw-output writer + LRU pruner.
- `src/tools/dispatcher.ts` — single chokepoint: after handler returns, before
  result enters messages,
  `result.content = await purify(tool, result, agent.outputPurifier)`.
- Generalizes `flattenMcpResult` (`src/mcp/promotion.ts`) from MCP-only to all
  tool results.
- New `read_raw_output` builtin tool.
- `AgentDefinition.outputPurifier` + `outputPurifierThreshold` frontmatter →
  loader zod schema.
- `ToolResult` gains `rawPath?: string` when purification applied (UI can show
  "raw available").

---

## 6. Global orchestrator + two-tier hierarchy — 🔬 Proposed (→ M7/M8)

### Vision
SophronSwarm is **multi-project**: there is one **global orchestrator** that
lives *above* all projects (the operator's "CEO"), plus a **per-project
orchestrator** inside each project (seeded by `sophron init`, §4). The global
orchestrator is what the operator talks to from the Home › Orchestrator tab to
propose and create whole projects.

### Locked decisions (2026-07-07)
- **Global orchestrator has NO injected project memory.** No per-agent
  `MEMORY.md`, no shared-memory injection. It reads the project registry
  (`list_projects`) and the current chat thread — nothing else. The chat thread
  is retained for the session so the conversation is coherent, but it is not
  persisted and is not injected as project memory. It is a pure project-lifecycle
  manager and must not inherit or interfere with any project's memory.
- **Per-project orchestrator = a copy.** `sophron init` seeds an identical
  `orchestrator.md` into every project's `agents/`; each copy is independently
  editable and carries its own per-project memory.
- **Scoped tool set:** `delegate` (to the global architect), `list_projects`,
  `propose_project`, `init_project` (controlled scaffolding, not raw shell),
  read-only `read_file` / `list_dir` over `~/.sophron/`. **No** `run_command`
  / `apply_patch`.
- **Projects live at `~/sophron_workspace/<name>`.**
- **Project-creation flow:** operator proposes idea → global orchestrator
  delegates to global architect → architect drafts roster via M6
  `propose_roster` → operator approves → `init_project` scaffolds + seeds the
  standardized orchestrator → registered in `projects.json`.
- **Global architect:** a single `architect.md` at user scope (installed by M5)
  that drafts rosters for any new project. This *is* the M6 `propose_roster`
  capability, invoked at bootstrap time.

### Where it touches the code
- New agent `~/.sophron/agents/global-orchestrator.md` (distinct from the
  per-project orchestrator).
- Loader: a way to mark an agent as **memory-less** (skip per-agent + shared
  injection).
- New tools: `propose_project`, `init_project`, `list_projects`.
- TUI Home: the M3 Orchestrator-tab stub was replaced with the real chat +
  project-proposal flow (M8).

### Open questions
- ~~Should the global orchestrator's *chat history* persist across sessions?~~
  **RESOLVED (2026-07-08):** Chat history is retained for the session and
  passed into each run, but it is **not persisted across sessions** and is
  **not injected as memory**.
- Health-check definitions for the Home Overview: recommend concrete signals —
  failed/stuck runs, pending approvals older than N, token-budget breaches,
  agents in HALT.

---

## Sequencing recommendation

The authoritative, current plan lives in [`ROADMAP.md`](./ROADMAP.md) (M1–M9).
Summary of how these IDEAS items map to milestones and order:

1. **Output purifier (#5)** — ✅ DONE (M1).
2. **Named providers (#1)** — ✅ DONE (M2).
3. **TUI shell rewrite (#2)** — 🔨 next (M3); unblocks `/help` (#3 → M4) and
   the global-orchestrator chat wiring (M8).
4. **`sophron init` templates (#4, Piece 1)** — 🔜 M5; independent of M3, can
   build in parallel. Now also seeds the standardized orchestrator.
5. **Architect roster bootstrap (#4, Piece 2)** — 🔜 M6; depends on M5.
6. **Global orchestrator + two-tier hierarchy (#6)** — 🔬 M7; depends on M5+M6.
7. **Wire global orchestrator into TUI Home (#6 UI)** — 🔬 M8; depends on M3+M7.
8. **Context-aware `/help` (#3)** — 🔜 M4; any time after M3.

Independent tracks: **M3** (TUI) and **M5** (templates) can proceed in
parallel; everything else chains off them.
