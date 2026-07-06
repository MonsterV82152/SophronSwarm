# Phase 5 — CLI/TUI + Web UI (Design)

> Status: **DESIGN** — 2026-07-05
> Spec: [`PROJECT_OVERVIEW.md`](./PROJECT_OVERVIEW.md) §5.5 (UI/CLI Navigation), §7.6 (CLI-first)
> Depends on: Phases 0–4 complete (SharedServices, recorder JSONL, memory stores, MCP cost meter, permission gate).

---

## 1. Goal

Turn V3's batch CLI (`sophron run <agent> "<task>"`) into an **interactive operator surface**: a terminal UI where the operator can browse agents/checkpoints/runs/cost, run agents, and **interfere** (approve, rewind, inject). Per the locked decision (§7.6): **CLI-first, web-second**.

**Phase 5 scope (this increment):**
- ✅ Interactive **Ink TUI** — the primary surface (`sophron` with no args launches it).
- ✅ **Slash-commands** (`/agents`, `/runs`, `/checkpoint`, `/cost`, `/help`, `/run`, …).
- ✅ **Status dashboard** — panels surfacing agents, checkpoints, MCP token cost, recent runs.
- ✅ **Approvals desk** — the permission gate's "prompt" decisions route to a queue the operator can act on.

**Deferred to Phase 5b (separate Next.js app):** the web UI. It reads the same JSONL event log + SQLite checkpoints, so it's additive — building it later doesn't touch the TUI. The spec calls for it but CLI-first means the TUI ships first.

---

## 2. Architecture — two layers, one data model

```
┌─────────────────────────────────────────────────────────┐
│  TUI (Ink)  ←── reads ──  Dashboard model (pure)         │
│     │                     │                              │
│     │ slash-commands      │ aggregates from SharedServices│
│     ▼                     ▼                              │
│  CommandRouter ──────► SharedServices (the DI spine)     │
│     │                     │                              │
│     │ /run                │ agents / runs / checkpoints /│
│     ▼                     │ memory / mcpPool / costMeter │
│  runAgent (loop)          │                              │
│     │                     │                              │
│     ▼                     ▼                              │
│  ApprovalsQueue ◄── PermissionGate ("prompt" decisions)  │
└─────────────────────────────────────────────────────────┘
```

**Key principle:** the dashboard model and slash-command router are **pure functions** over `SharedServices` + on-disk state. This makes them unit-testable without a real terminal. The Ink components are thin renderers over the model.

---

## 3. Components

### 3.1 Dashboard model (`src/tui/dashboard.ts`)
Pure aggregation of service state into renderable shapes. No React, no Ink — just data.

```ts
interface DashboardModel {
  agents: { name: string; model: string; description: string }[];
  checkpoints: { milestones: Milestone[]; current: string };
  mcpCost: { perServer: ...; total: number };
  recentRuns: { runId: string; agent: string; status: string; turns: number; tokens: number; when: string }[];
  approvalsPending: number;
}
function buildDashboard(services: SharedServices, opts: { workspaceDir: string }): DashboardModel
```

- Agents: from `agentRegistry.list()`.
- Checkpoints: from `CheckpointManager` over `sharedMemoryStore`.
- MCP cost: from `mcpCostMeter.report()`.
- Recent runs: scan `runs/*.jsonl` for `run_start`/`run_end` events (the recorder's output).

### 3.2 Slash-commands (`src/tui/slashCommands.ts`)
A parser + dispatcher. Input like `/cost` or `/run builder "scaffold a project"` → structured command.

```ts
type Command =
  | { kind: "help" }
  | { kind: "agents" }
  | { kind: "runs"; limit?: number }
  | { kind: "checkpoint" }          // show current checkpoint
  | { kind: "advance" }             // advance checkpoint
  | { kind: "cost" }                // MCP token cost
  | { kind: "run"; agent: string; task: string }
  | { kind: "approve"; id: string; decision: "yes" | "no" }
  | { kind: "rewind"; runId: string }
  | { kind: "unknown"; raw: string };

function parseSlashCommand(input: string): Command   // pure, tested
```

### 3.3 Ink TUI shell (`src/tui/app.tsx`)
The interactive app. Layout:
- **Header**: workspace path + agent count + pending approvals badge.
- **Body**: the active panel (dashboard / agents / runs / checkpoint / cost), switched by slash-commands.
- **Footer**: input prompt (`> `) where the operator types commands or free-text tasks.

Built with `ink` + `react`. Tested with `ink-testing-library`.

### 3.4 Approvals desk (`src/tui/approvals.ts`)
A `PendingApproval` queue. The TUI's gate (a `PermissionGate` impl) pushes items here; the operator acts via `/approve <id> yes|no`. For non-interactive runs, the queue stays empty and the gate falls back to the existing `DefaultPermissionGate` behavior.

```ts
interface PendingApproval {
  id: string;
  agent: string;
  tool: string;
  args: Record<string, unknown>;
  createdAt: number;
}
class ApprovalsQueue {
  enqueue(item): string;
  resolve(id, decision): "allow" | "deny";
  pending(): PendingApproval[];
}
```

---

## 4. Build order

1. `src/tui/slashCommands.ts` — parser (pure, heavily tested).
2. `src/tui/dashboard.ts` — model builder (pure, tested).
3. `src/tui/approvals.ts` — queue (pure, tested).
4. `src/tui/components/*.tsx` — Ink panels (rendered via ink-testing-library).
5. `src/tui/app.tsx` — the shell tying it together.
6. Wire `sophron` (no subcommand) → launch TUI; keep `run`/`agents`/`replay` as-is.
7. Tests for every pure module + smoke tests for the Ink components.

---

## 5. Testing strategy

- **Pure modules** (slash-commands, dashboard, approvals): standard vitest, no terminal needed.
- **Ink components**: `ink-testing-library`'s `render()` returns the rendered output as a string — assert on it without a real TTY.
- **Integration**: launch the TUI against a temp workspace with seeded agents/checkpoints and assert the dashboard renders.
- **Regression**: all 262 existing tests unchanged.

---

## 6. Non-goals (deferred)

- **Next.js web UI** (Phase 5b) — org-chart, run replay, memory browser, cost dashboard. Reads JSONL + SQLite.
- **Live run streaming in the TUI** (the TUI shows recent runs from disk; live-following an in-progress run is Phase 5.5).
- **Full `/rewind` restore** (the checkpointer supports it; the TUI just surfaces the action for now).
