# SophronSwarm V3 — Development Roadmap

> Ordered development timeline integrating the remaining phase work (5b, 7)
> with the proposed enhancements in [`IDEAS.md`](./IDEAS.md).
>
> **Baseline (verified 2026-07-06):** 384/384 tests passing, clean `tsc`.
> Phases 0–4, 5a (TUI), and 6 (auto-mode + agent-creation) complete.
>
> **Last updated:** 2026-07-06

---

## Current state

| Phase | Status | Notes |
|---|---|---|
| 0 — Skeleton | ✅ Complete | loop, dispatcher, loader, LLM client, checkpointer, recorder |
| 1 — Live tools + sandbox | ✅ Complete | `run_command` (bubblewrap), `apply_patch` (V2 chain) |
| 2 — Delegation | ✅ Complete | `delegate`, depth/cycle/allowlist, HandoffPacket |
| 3 — Memory | ✅ Complete | per-agent + shared + checkpoints (74 tests) |
| 4 — MCP | ✅ Complete | lazy loader, `mcp_tool_search`, cost meter, pool |
| 5a — TUI (Ink) | ✅ Complete | dashboard, slash-commands, approvals, components |
| **5b — Web UI** | ❌ **Incomplete** | promote V2 debug server to Next.js |
| 6 — Auto mode + agent-creation | ✅ Complete | classifier gate, `propose_agent` draft→approve |
| **7 — Specialization kits** | ❌ **Incomplete** | starter agent packs (design/security/feature/orchestrator) |

## Incomplete work + how IDEAS items map in

- **Phase 5b (web UI):** deferred — the locked CLI-first decision (§7.6 of
  `PROJECT_OVERVIEW.md`) deprioritizes it. Optional, parallelizable, low
  dependency surface (shares the JSONL event log with the CLI).
- **Phase 7 (kits):** maps to IDEAS #4 — `sophron init` templates ARE the
  specialization kits (Piece 1), with `propose_roster` as the runtime
  companion (Piece 2).

---

## Milestones (ordered)

### M0 — Baseline ✅
384/384 tests, clean `tsc`. Re-verify before every merge: `npm run typecheck && npm test`.

---

### M1 — Output Purifier  *(IDEAS #5 — 📦 ready)*
**Why first:** highest immediate token-cost impact; touches a single chokepoint
(`ToolDispatcher.dispatch`); independent of all other work; the cost win
**compounds** with every subsequent feature (less noise to debug during dev).

**Scope:**
- `src/tools/purifier.ts` — Tier 1 deterministic rules (ANSI strip, duplicate
  collapse, head+tail truncation, blank collapse, progress-bar strip) + Tier 2
  cheap-model extraction (reuses classifier model) + raw-output store +
  LRU pruner.
- Wire into `ToolDispatcher.dispatch` — purify successful tool results before
  they enter message history.
- `read_raw_output` builtin — escape hatch so the agent can retrieve full raw
  output when a summary is ambiguous.
- `outputPurifier` + `outputPurifierThreshold` frontmatter fields.
- `ToolResult.rawPath` field.
- Default purifies only known-noisy tools (`run_command`, `mcp__*`); `"off"`
  and `"aggressive"` modes control scope.

**Delivers:** a major, ongoing token-cost reduction on the noisiest tool
(`run_command` build/test/install spam) without information loss.

---

### M2 — Named Provider Instances  *(IDEAS #1 — 📦 ready)*
**Why second:** backward-compatible, small, independent; unblocks the
multi-machine local-LLM setup that is core to the operator's vision; also
unlocks generic OpenAI-compat endpoints (vLLM, LM Studio, LocalAI).

**Scope:**
- `ProviderName` → free-form string (defaults preserved).
- `~/.sophron/config.json` `providers` → array of named instances with `kind`.
- `provider:` frontmatter field; `${VAR}` env interpolation in config.
- Legacy object-config auto-migrated with deprecation warning.
- `sophron providers` + `providers test <name>` subcommands.

**Delivers:** agent A → machine1:11434, agent B → machine2:11434, in the same
project.

---

### M3 — Project-Scoped TUI Navigation  *(IDEAS #2 — 🟡 needs final UX call)*
**Why third:** the big TUI restructure that makes the multi-project vision real.
Depends on a project registry + the (already clean) services teardown/rebuild.

**Scope:**
- Depth-2 layout: Landing Overview (screen) + Project Switcher (`Ctrl+P`
  transient overlay) + per-project workspace (flat tabs) + one drill-down
  (Agent detail with `Overview/Chat/Memory/Runs` sub-tabs).
- New `src/project/registry.ts` — `~/.sophron/projects.json`.
- Factor `buildServices()` out of `cli.ts` so it's re-callable on switch
  (teardown via existing `close()`/`closeAll()`/`stopWatch()`).
- TUI restructure: `OverviewScreen`, `ProjectWorkspace`, `AgentDetail`.

**Delivers:** manage many projects in one session; agents/memories/runs
genuinely local to each project.

---

### M4 — Context-Aware `/help`  *(IDEAS #3 — 📦, folds into M3)*
**Why here:** the view set is defined by M3; help is `helpForView(view)` once
those views exist. Cheap, coordinated change.

**Scope:**
- Replace static `HELP_TEXT` with `helpForView(view)`.
- Always-available core + per-view section (Agent › Chat → agent-directing
  commands: free-text, `/approve`, `/interrupt`, `/rewind`).

---

### M5 — `sophron init` Templates  *(IDEAS #4 Piece 1 = Phase 7 starter — 📦)*
**Why here:** depends on M3's project registry (`init` registers the project).

**Scope:**
- `sophron init [--template <name>] [--name <alias>]`.
- Built-in templates (`webapp`, `cli`, `data-pipeline`, `minimal`) + user
  templates under `~/.sophron/templates/`.
- Ships the specialization kits (these ARE Phase 7's starter packs).

---

### M6 — Architect Roster Bootstrap  *(IDEAS #4 Piece 2 = Phase 7 remainder)*
**Why last:** largest scope; builds on M5 templates + the existing
`propose_agent` flow.

**Scope:**
- `propose_roster` tool — batch draft N agents → one approval gate → close.
- Batch-approval UI in the TUI.
- Generalizes the Phase 6 single-agent draft→approve.

---

### M7 (optional, deferred) — Phase 5b Web UI
**Why deferred:** CLI-first is a locked decision (§7.6). The web UI shares the
JSONL event log and is low-dependency, so it can be picked up in parallel by a
separate effort without blocking M1–M6. Revisit when the CLI vision (M3–M6) is
stable.

---

## Dependency graph

```
M0 (baseline) ─┬─► M1 (purifier)          ── independent
               ├─► M2 (providers)         ── independent
               └─► M3 (TUI nav) ──► M4 (help)
                                  └─► M5 (templates) ──► M6 (roster bootstrap)

M7 (web UI) ── optional / parallel / deferred
```

- **M1, M2** are fully independent — can be built in either order, even in
  parallel.
- **M3** is independent of M1/M2 but is the larger TUI restructure.
- **M4, M5** depend on M3; **M6** depends on M5.

## Starting point

**M1 (Output Purifier)** is selected as the first build: highest leverage,
lowest risk, no dependencies. Work begins immediately after this roadmap is
written.
