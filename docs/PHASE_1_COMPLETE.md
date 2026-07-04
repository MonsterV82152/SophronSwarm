# Phase 1 — Live Tools + Sandbox (Completion Record)

> Status: **✅ COMPLETE** — 2026-07-04
> Acceptance criteria: all 8 met. Tests: 106/106 passing (72 new). Clean `tsc`.
> Live demo: builder agent scaffolded + ran a Node project under bubblewrap.
> Design doc: [`PHASE_1_DESIGN.md`](./PHASE_1_DESIGN.md)

---

## What was built

```
src/
├── sandbox/
│   ├── backend.ts              # ExecutionBackend interface + getBackend() factory
│   ├── spawn.ts                # spawnWithTimeout (AbortController-based)
│   ├── bubblewrap.ts           # PRIMARY: bwrap namespace isolation
│   ├── docker.ts               # OPT-IN: container isolation + image heuristics
│   ├── host.ts                 # GATED: SOPHRON_ALLOW_HOST_BACKEND=1 only
│   ├── dangerousCommands.ts    # blocklist + heuristics classifier (13 + 6 rules)
│   └── patchApplier.ts         # V2 chain port: TS applier → patch -p1 → patch -p0
└── tools/
    └── builtin/
        ├── run_command.ts      # shell exec under sandbox + blocker gate
        └── apply_patch.ts      # unified-diff applier tool
```

**Changed:** `tools/builtin/index.ts` (registers 2 new tools), `tools/dispatcher.ts`
(tool- + mode-aware `DefaultPermissionGate`: `plan` denies mutations).

## Acceptance criteria — all met

1. ✅ `run_command` runs arbitrary shell under bubblewrap; writes confined to workspace; network off by default.
2. ✅ Dangerous-command blocker (blocklist + heuristics) gates every `run_command`; blocks return errors to the model.
3. ✅ `apply_patch` applies unified diffs via the V2 chain (TS → `-p1` → `-p0`), rejects non-diff payloads.
4. ✅ Permission modes honored (`plan` denies mutations; modes route through blocker).
5. ✅ Docker backend selectable per-command (opt-in).
6. ✅ Live demo: builder agent scaffolded `index.js`, ran `node index.js` under bubblewrap, exit 0.
7. ✅ Every `run_command` + every block recorded to JSONL.
8. ✅ Phase 0 still green (106/106); new tests cover blocker, patch applier, bubblewrap (live).

## Live demo proof

```
agent: builder   status: complete   turns: 4   tokens: 4617
  turn 0: write_file  → index.js ("console.log('built by sophronswarm')")
  turn 1: run_command → "node index.js"  exit=0 backend=bubblewrap
  turn 2: read_file   → confirmed content
  turn 3: final answer
file on disk: index.js ✓
```

## Gotchas discovered (in repo memory)

1. **bwrap `--tmpfs /tmp` masks workspaces under `/tmp`.** When the workspace
   lives under `/tmp` (e.g. tests), use `--bind-try /tmp /tmp` instead, and
   skip the parent read-only bind (it would shadow the writable `/tmp`).
2. **bwrap mount order is load-bearing.** Read-only parent bind must come
   BEFORE the read-write workspace bind; later mounts shadow earlier ones.
3. **Operator toolchains live under `$HOME`** (node at `~/.local/bin/node`,
   not `/usr/bin`). Bind `$HOME` read-only + pass `PATH` through, or `node`,
   `cargo`, etc. won't be found inside the sandbox.
4. **AbortController timeout race:** set `timedOut` synchronously in the
   timeout callback, and gate resolution with a `settled` flag — the abort
   listener and `close` event race otherwise.
5. **Regex `\b` after `/`** (a non-word char) doesn't match at end-of-string.
   The dangerous-command classifier was refactored to predicate functions for
   the filesystem-destruction rules (clearer + correct).

## Design refinements vs. the doc

- **`BackendName` type** lives in `backend.ts` (not a string union inline).
- **`pickImage`** in `docker.ts` heuristically picks an image by command
  content (node→`node:22-slim`, cargo→`rust:1-slim`, etc.) when not overridden.
- **Output truncation** keeps first 2 KB + last 4 KB (where build errors live),
  matching V2's log-purifier intent.

## Phase 1 → Phase 2 handoff

The stable additions Phase 2 builds on:
- **`run_command` / `apply_patch`** — delegation (Phase 2) will let an
  orchestrator ask a sub-agent to use these in an isolated context.
- **`BackendName` + `getBackend()`** — Phase 6's auto-mode classifier can
  refuse `host` and force `bubblewrap` for risky commands.
- **`classifyCommand()`** — Phase 6's classifier composes with this (it
  already returns structured `{ severity, rule, reason }`).
- **Permission-gate contract** (`PermissionGate` interface) — Phase 6 swaps
  `DefaultPermissionGate` for the real auto-mode + interactive-prompt gate.
