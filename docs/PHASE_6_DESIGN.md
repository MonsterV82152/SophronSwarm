# Phase 6 — Auto-mode + Agent-creation (Design)

> Status: **DESIGN** — 2026-07-06
> Spec: [`PROJECT_OVERVIEW.md`](./PROJECT_OVERVIEW.md) §5.6 (permission modes / auto), §5.1 (agent creation), §7.1 (guardrails)
> Depends on: Phases 0–5a complete (dispatcher + PermissionGate, dangerous-command blocker, approvals queue, agent loader).
> Classifier model (decided): `qwen3.5:9b-fast` (local Ollama — resolves open question §11.1).

---

## 1. Goal

Two capabilities, both central to the autopilot vision:

1. **Auto-mode classifier** — when an agent runs in `permissionMode: "auto"`, each mutating tool call (especially `run_command`) is **vetted by a cheap local Ollama model** before execution. This is Claude Code's auto-mode: near-frictionless execution without a human prompt per command, but with a safety net that blocks risky commands and escalates uncertain ones. Free, offline, low-latency.

2. **Agent-creation** (`propose_agent`) — the one-time project-bootstrap capability where the Architect drafts the full agent roster to `agents/` in a `draft` state. **All drafts require explicit operator approval** before any can execute. After approval, creation is **closed** for the project. Prevents uncontrolled self-modifying swarms (§7.1).

---

## 2. Part A — Auto-mode classifier

### 2.1 The classification flow

```
run_command (or mutating tool) called by an agent in "auto" mode
  │
  ▼
1. dangerous-command blocker (deterministic, always-on, Phase 1)
   ├─ blocked → return error to agent
   └─ passes → continue
  │
  ▼
2. AutoModeClassifier vets the command via the cheap model
   ├─ "allow"   → execute
   ├─ "deny"    → return error to agent (with the model's reason)
   └─ "prompt"  → escalate to operator (ApprovalsQueue / TUI)
```

The classifier is a **second gate** layered on top of the deterministic dangerous-command blocker. The blocker handles the obvious stuff (`rm -rf /`, fork bombs); the classifier handles the *judgment* calls (e.g. `curl http://...` is suspicious, `npm install` is fine, `git push --force origin main` is risky).

### 2.2 Implementation (`src/agent/autoGate.ts`)

```ts
interface AutoModeClassifier {
  vet(toolName: string, args: Record<string, unknown>, agent: AgentDefinition): Promise<ClassifyResult>;
}
interface ClassifyResult { decision: "allow" | "deny" | "prompt"; reason: string; }
```

- Uses the existing `LLMClient` pointed at the local Ollama `qwen3.5:9b-fast`.
- Prompt: a focused system prompt that classifies a single command into exactly one of `allow` / `deny` / `prompt` + a one-line reason. Constrained to a short response (the cheap model answers in <50 tokens).
- **Caches** verdicts per command string within a run (so `npm test` called 10x is vetted once).
- Falls back to `"prompt"` if the model is unreachable / times out / returns unparseable output (safe default — escalate rather than auto-allow).

### 2.3 Gate wiring

A new `AutoPermissionGate implements PermissionGate`:
- read-only tools → allow.
- mutating tools in `plan` → deny (unchanged).
- mutating tools in `default` → prompt (route to ApprovalsQueue — unchanged from the TUI gate).
- mutating tools in `auto` → call the classifier.
- mutating tools in `accept-edits` / `full-auto` → allow (unchanged).

The gate needs the `LLMClient` + `ApprovalsQueue`. It's constructed in `buildServices` and passed to the dispatcher (which already accepts a `gate` in its constructor).

---

## 3. Part B — Agent-creation (`propose_agent`)

### 3.1 The draft → approve flow

```
Architect calls propose_agent({ name, description, systemPrompt, tools, model, ... })
  │
  ▼
1. Write a draft .md file to agents/.draft/<name>.md (a staging dir)
  │
  ▼
2. Record in the approval ledger (.sophron/agents.json): { name, status: "draft" }
  │
  ▼
3. Operator approves (TUI / CLI) → move .draft/<name>.md → agents/<name>.md (hot-reload picks it up)
   ├─ status: "approved"
   └─ once ALL drafts are approved/rejected, creation CLOSES (bootstrap done)
```

### 3.2 Implementation (`src/tools/builtin/propose_agent.ts` + `src/agent/drafts.ts`)

- `propose_agent` tool: writes the draft, records in the ledger, returns "drafted, awaiting approval".
- `src/agent/drafts.ts`: `AgentDraftStore` over `.sophron/agents.json` — track draft/approved/rejected state; `promote(name)` moves draft → live; `isBootstrapClosed()` checks if creation is closed.
- Guardrails (§5.1 / §7.1):
  - Drafts **cannot execute** (they're in `.draft/`, not `agents/`, so the registry doesn't load them).
  - **No auto-approval path** — promotion is operator-initiated.
  - Drafts can't grant themselves `full-auto` or a broader tool set than the architect has (validated on write).
  - Soft cap at 12 agents (warn, don't block — already in the registry).

### 3.3 CLI / TUI approval

- CLI: `sophron agents --drafts` lists pending drafts; `sophron agents --approve <name>` promotes.
- TUI: a Drafts page (navigable from Home) showing pending drafts with Enter to approve.

---

## 4. Build order

1. `src/agent/autoGate.ts` — the classifier + `AutoPermissionGate`.
2. Wire the gate into `buildServices` (CLI) + the dispatcher.
3. Tests for the classifier (mocked LLM) + the gate's decision matrix.
4. `src/agent/drafts.ts` — the draft store + ledger.
5. `src/tools/builtin/propose_agent.ts` — the tool.
6. CLI/TUI approval surface.
7. Tests for drafts + propose_agent.
8. Live demo: an agent in `auto` mode runs a command vetted by the classifier.

---

## 5. Testing strategy

- **Classifier**: mock the `LLMClient.complete` to return canned verdicts; assert the decision matrix + caching + fallback-to-prompt.
- **Gate**: assert every (tool, mode) → decision combination.
- **Drafts**: unit tests over a temp `.sophron/agents.json` — draft, promote, reject, bootstrap-close.
- **propose_agent**: assert it writes a draft + ledger entry and refuses to execute until promoted.
- **Regression**: all 351 existing tests unchanged.
