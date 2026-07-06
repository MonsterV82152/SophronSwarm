# Phase 5 — CLI/TUI (Completion Record)

> Status: **✅ COMPLETE (Phase 5a)** — 2026-07-05
> Acceptance criteria: all met. Tests: 321/321 passing (59 new). Clean `tsc`.
> Live render: TUI dashboard renders real agents/checkpoints/runs/MCP cost from the project workspace.
> Design: [`PHASE_5_DESIGN.md`](./PHASE_5_DESIGN.md)
> Spec: [`PROJECT_OVERVIEW.md`](./PROJECT_OVERVIEW.md) §5.5 (UI/CLI Navigation)
>
> **Note:** This is **Phase 5a (CLI/TUI)**. The Next.js web UI (**Phase 5b**) is deferred — it reads the same JSONL + SQLite data and is additive to the TUI. Per the locked decision (§7.6: CLI-first, web-second), the TUI ships first.

---

## What was built

```
src/
├── tui/                            # NEW — the interactive operator surface
│   ├── slashCommands.ts            # parser: /agents /runs /checkpoint /advance /cost /memory /run /approve /rewind /help /clear /quit
│   ├── dashboard.ts                # buildDashboard: aggregates services → renderable model
│   ├── approvals.ts                # ApprovalsQueue + gateDecisionFor (the prompt-gate backend)
│   ├── app.tsx                     # the Ink shell: input handling + view switching + command routing
│   ├── launch.tsx                  # JSX bridge (CLI .ts → App .tsx) so the CLI can render React
│   └── components/
│       └── DashboardView.tsx       # the dashboard panel (agents + checkpoint + MCP cost + runs)
└── (changed)
    ├── cli.ts                      # `sophron tui` (default command) launches the TUI; run/agents/replay unchanged
    └── tsconfig.json               # JSX support (react-jsx) + DOM lib for Ink

tests/
└── tui/                            # NEW — 59 tests
    ├── slashCommands.test.ts       (29) — every command + edge cases
    ├── approvals.test.ts           (13) — queue + gate decision matrix
    ├── dashboard.test.ts           (9)  — model aggregation + run parsing + formatTokens
    └── components.test.tsx         (8)  — Ink render smoke tests (ink-testing-library)
```

**59 new tests across 4 files; all 262 prior tests still pass (321 total).**

---

## Acceptance criteria — all met (Phase 5a scope)

1. ✅ **Interactive TUI** — `sophron` (no args) or `sophron tui` launches an Ink dashboard.
2. ✅ **Dashboard panels** — agents, checkpoint, MCP cost, recent runs, pending-approvals badge.
3. ✅ **Slash-commands** — `/help`, `/agents`, `/runs`, `/checkpoint`, `/advance`, `/cost`, `/memory`, `/run`, `/approve`, `/rewind`, `/clear`, `/quit` (+ aliases `/a`, `/cp`, `/r`, `/h`, `/exit`).
4. ✅ **Approvals desk** — `ApprovalsQueue` + `gateDecisionFor` route "prompt" decisions to a queue; `/approve <id> yes|no` resolves them.
5. ✅ **Quoted-argument parsing** — `/run builder "scaffold a project"` correctly splits agent + task.
6. ✅ **Degradation** — empty workspace (no agents, no runs, no checkpoints) renders gracefully.
7. ✅ All 262 Phase 0–4 tests still pass; 59 new TUI tests added.

---

## Live render proof (real project workspace)

```
$ sophron tui

 SophronSwarm V3 — Dashboard
  workspace: /home/.../V3

 Agents (5)
   builder [project] qwen3.5:9b-thinking
   A demo builder agent for Phase 1…
   echo-bot [project] qwen3.5:9b-thinking
   … (mcp-explorer, orchestrator, rememberer)

 Checkpoint
   current: (none set)
   (no milestones defined)

 MCP Cost (no servers configured)
   (no tools promoted — lazy)

 Recent Runs (last 5)
   mcp-explorer [halted] 0 turns, 10.8k tokens
   rememberer [complete] 0 turns, 1.2k tokens
   …

 > ▏
  type a command (/help) or free text · Ctrl+C to exit
```

The dashboard aggregates live state from `SharedServices` + on-disk `runs/*.jsonl` logs.

---

## Architecture — two layers, one data model

```
  TUI (Ink, app.tsx)  ──reads──►  Dashboard model (pure, dashboard.ts)
     │                              │
     │ slash-commands               │ aggregates from SharedServices
     ▼                              ▼
  parseSlashCommand ──────► SharedServices (the DI spine)
     │                              │
     │ /run, /approve               │ agents / runs / checkpoints /
     ▼                              │ memory / mcpPool / costMeter
  ApprovalsQueue ◄── gateDecisionFor (PermissionGate "prompt")
```

**Key design principle:** the dashboard model, slash-command parser, and approvals queue are **pure functions/objects** with no React/Ink dependency. This makes them heavily unit-testable (51 tests) without a terminal. The Ink components are thin renderers (8 smoke tests via `ink-testing-library`).

---

## Design decisions & deviations

1. **Pure logic + thin components.** All business logic (parsing, aggregation, gate decisions) lives in `.ts` modules. The `.tsx` files only render. This split maximizes test coverage without TTY friction.

2. **JSX lives in `.tsx` files only.** The CLI (`cli.ts`) can't contain JSX under NodeNext resolution. A thin `launch.tsx` module bridges the CLI → Ink App, keeping the import boundary clean.

3. **`tsconfig.json` gains JSX support.** `"jsx": "react-jsx"` (modern transform — no `import React` needed) + `"DOM"` lib (Ink needs `useInput`/DOM-adjacent types).

4. **`sophron tui` is the default command.** `sophron` with no args launches the TUI (`{ isDefault: true }` on the commander command). `run`/`agents`/`replay` remain as explicit subcommands for batch use.

5. **Run execution from the TUI is stubbed (Phase 5.5).** `/run` and free-text tasks are accepted and queued, but the actual async runner (running an agent while the TUI stays responsive) is Phase 5.5 — it needs the recorder/loop to be event-emitter-driven. For now, operators use `sophron run` for execution and the TUI for inspection/control.

6. **Approvals gate is opt-in.** Batch runs keep using `DefaultPermissionGate` (allow+log). The TUI's `gateDecisionFor` enqueues mutating-tool requests in `default` mode; `accept-edits`/`auto`/`full-auto` still auto-allow. Wiring the gate into the loop's dispatcher is Phase 5.5 (it needs the dispatcher to await the queue).

---

## Gotchas discovered (for Phase 5b/5.5)

1. **`ink-testing-library` renders to a string** — no TTY needed. `render(<Comp />).lastFrame()` returns the output as a string. This is how the component smoke tests work.

2. **`useInput` is Ink's input hook** — it receives one char at a time + a `key` object (`return`, `backspace`, `ctrl`, etc.). The App accumulates chars into `input` and dispatches on Enter. Ctrl+C exits via `useApp().exit()`.

3. **Recent-runs parsing reads every JSONL file's first+last lines.** For workspaces with thousands of runs this could be slow; Phase 5b should add an index or cache. For now (tens of runs) it's instant.

4. **The `turns` field in run summaries reads as 0 from some run logs** — older runs (pre-Phase 2) may not have emitted `turns` in `run_end`. The dashboard shows what's available.

5. **`React.createElement` works in `.ts` files** but JSX syntax requires `.tsx`. The launcher pattern (a `.tsx` shim) is the clean workaround.

---

## Phase 5 → Phase 5b/6 handoff

**What Phase 5b (web UI) builds on:**
- The **JSONL event log** (`runs/*.jsonl`) is the shared data source — the web UI reads the same files the dashboard does.
- The **dashboard model** (`buildDashboard`) is reusable server-side (it's pure).
- The **SQLite checkpointer** enables the web UI's rewind view.

**What Phase 6 (auto-mode + agent-creation) builds on:**
- The **approvals queue + gate** (`gateDecisionFor`) is the foundation for the auto-mode classifier (Phase 6 replaces "prompt" with a cheap-model vetting step).

**Deferred (explicitly):**
- Next.js web UI (Phase 5b).
- Live run-following in the TUI (Phase 5.5 — needs event-emitter-driven recorder).
- Full `/rewind` restore + async `/run` from the TUI (Phase 5.5).
