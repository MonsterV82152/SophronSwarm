# Phase 1 — Live Tools + Sandbox (Technical Design)

> Goal: turn the Phase 0 skeleton into something that can **actually build code**. Agents gain `run_command` (executed under bubblewrap isolation with a dangerous-command blocker) and `apply_patch` (V2's robust unified-diff applier, ported). After Phase 1 an agent can scaffold a project, edit files, run builds/tests, read errors, and iterate — the core autonomous-coding loop, with zero new LLM-token cost for execution.

Stack: TypeScript. V2 (`sophron_swarm/nodes/sandbox.py`) is the reference spec.

**Environment confirmed on this host:** `bwrap` 0.11.1 ✓, unprivileged userns ✓, GNU `patch` 2.8 ✓, `docker` 29.1.3 ✓ (opt-in backend). Landlock securityfs not mounted → bubblewrap (namespace-based) is the primary backend, as planned.

---

## 0. Acceptance Criteria

1. `run_command` tool executes arbitrary shell bound to a workspace, under **bubblewrap** isolation: writes confined to the workspace, network off by default (allowlist opt-in).
2. A **dangerous-command blocker** gates every `run_command`: blocklist (`rm -rf /`, fork bomb, `dd of=/dev/`, `mkfs`, force-push to protected branches, recursive deletes outside workspace, writes to dot-config dirs) + pattern heuristics. Blocked commands return an error to the agent; never execute.
3. `apply_patch` tool applies a unified diff to the workspace via the V2 chain: **Python-style applier → `patch -p1` → `patch -p0`**, validating the payload looks like a diff first.
4. Permission modes are honored: `plan` denies `run_command`/`apply_patch` outright; `default`/`accept-edits` route through the blocker; `full-auto` runs sandboxed without prompts.
5. A Docker backend is selectable per-command for stronger isolation (opt-in).
6. Live demo: an agent scaffolds a tiny project (`npm init`, write `index.js`, `node index.js`), reads the output, and reports success — all under bubblewrap.
7. Every `run_command` invocation (command, exit code, truncated output) is recorded to JSONL; the dangerous-command blocker logs every block.
8. All Phase 0 tests still pass; new tests cover the blocker, the patch applier, and the sandbox wrapper.

**Not in scope for Phase 1:** delegation, MCP, memory, TUI, auto-mode classifier, agent-creation. Those are later phases.

---

## 1. New / Changed Files

```
src/
├── tools/
│   └── builtin/
│       ├── run_command.ts       # NEW — shell exec under sandbox
│       └── apply_patch.ts       # NEW — unified-diff applier
├── sandbox/
│   ├── backend.ts               # NEW — ExecutionBackend interface + factory
│   ├── bubblewrap.ts            # NEW — bwrap namespace isolation
│   ├── docker.ts                # NEW — Docker backend (opt-in)
│   ├── host.ts                  # NEW — unsandboxed fallback (dangerous; gated)
│   ├── dangerousCommands.ts     # NEW — blocklist + heuristics classifier
│   └── patchApplier.ts          # NEW — ported V2 patch chain
└── tools/
    └── dispatcher.ts            # EDIT — permission gate routes run_command/apply_patch
```

No changes to the agentic loop, the agent loader, the checkpointer, or the recorder — Phase 1 only adds tools and the sandbox subsystem they call.

---

## 2. The Sandbox Subsystem (`src/sandbox/`)

### 2.1 `backend.ts` — the execution-backend contract

```typescript
export interface ExecOptions {
  command: string;              // shell command string
  workspace: string;            // absolute path the command runs in (bind-mounted)
  network?: boolean;            // default false → --unshare-net
  timeoutMs?: number;           // default 120_000
  env?: Record<string, string>; // extra env (PATH etc.)
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Combined stdout+stderr, like V2. */
  output: string;
  durationMs: number;
  backend: "bubblewrap" | "docker" | "host";
  timedOut: boolean;
}

export interface ExecutionBackend {
  readonly name: "bubblewrap" | "docker" | "host";
  exec(opts: ExecOptions): Promise<ExecResult>;
}

/** Pick a backend by name, with safe defaults. */
export function getBackend(name?: "bubblewrap" | "docker" | "host"): ExecutionBackend;
```

### 2.2 `bubblewrap.ts` — primary backend

The command runs in a new mount/user/PID namespace. The workspace is bind-mounted read-write at the same path (so paths inside match the host); everything else is the host's read-only system tree. Network is unshared by default.

```typescript
// Sketch — actual arg construction in the file.
function bwrapArgs(opts: ExecOptions): string[] {
  const args = [
    "--die-with-parent",
    "--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-cgroup",
    opts.network ? "" : "--unshare-net",
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    "--ro-bind", "/usr", "/usr",
    "--ro-bind", "/lib", "/lib",
    "--ro-bind", "/lib64", "/lib64",      // if exists
    "--ro-bind", "/bin", "/bin",
    "--ro-bind", "/sbin", "/sbin",
    "--ro-bind-try", "/etc/resolv.conf", "/etc/resolv.conf", // only if network on
    "--bind", opts.workspace, opts.workspace,   // workspace: rw
    "--chdir", opts.workspace,
    "--", "/bin/sh", "-c", opts.command,
  ].filter(Boolean);
  return args;
}
```

Executed via `child_process.spawn("bwrap", args, …)` with the timeout enforced by `AbortController` (Node 22 supports `signal` on `spawn`). `bwrap` returning non-zero because of sandbox setup is distinguished from the inner command's exit code.

### 2.3 `docker.ts` — opt-in backend

Reuses V2's approach: `docker run --rm -v <workspace>:/workspace -w /workspace <image> sh -c "<cmd>"`. Auto-pulls missing images. Selected when the agent/command asks for it (e.g. untrusted toolchain, specific language image).

### 2.4 `host.ts` — unsandboxed fallback (gated)

Runs `subprocess` directly on the host. **Only used when `SOPHRON_ALLOW_HOST_BACKEND=1`** is set AND the permission mode is `full-auto` or the operator explicitly opts in. Default: refused with a clear error. This mirrors V2's fallback but makes the danger explicit and opt-in rather than silent.

### 2.5 `dangerousCommands.ts` — the blocker

This is the mycannybird-style safety gate. Two layers:

```typescript
export interface BlockResult {
  blocked: boolean;
  reason?: string;
  rule?: string;       // which rule matched (for telemetry)
}

export function classifyCommand(cmd: string): BlockResult;
```

**Layer 1 — blocklist (exact patterns, case-insensitive):**
- `rm -rf /`, `rm -rf /*`, `rm -rf ~`, `rm -rf $HOME`, recursive deletes targeting root/home
- fork bomb `:(){ :|:& };:`
- `dd of=/dev/` (write to block devices), `mkfs`, `fdisk`, `shred /`
- `chmod -R 777 /`, `chown -R` on `/` or `$HOME`
- writes to dot-config: `> ~/.ssh/authorized_keys`, `>> ~/.bashrc` with `curl|sh` patterns, `.git/config` rewrites
- force-push to protected branches: `git push --force` / `-f` to `main`/`master` (configurable)
- `curl ... | sh` / `curl ... | bash` / `wget ... | sh` (network-to-shell pipes)
- `npm install -g` (global installs), `pip uninstall`, `apt remove`, `snap remove`
- `:(){`, fork patterns, `kill -9 -1`
- writes outside workspace detected by path resolution (`/etc/`, `/usr/`, `/var/`, `/boot/`)

**Layer 2 — heuristics (regex patterns flagged for review):**
- `sudo` (any privilege escalation)
- `>` or `>>` redirects to absolute paths outside the workspace
- recursive operations (`-r`/`-R`) combined with delete (`rm`, `chmod`, `chown`) on broad globs
- backticks/`$()` invoking shell from within args (command-injection shape)

**Behavior on block:**
- Returns `{ blocked: true, reason, rule }` to the `run_command` handler.
- The handler returns an `isError` result to the model: `"Blocked by safety policy: <reason>. Rule: <rule>."` — the model can then adapt (e.g. pick a safer command).
- The block is recorded to JSONL (command + rule + reason).

**Behavior on heuristic flag (not hard block):**
- In `default`/`accept-edits`: still runs, but logged at warn + surfaced in the result preview.
- In `full-auto`: treated as a block (conservative under autopilot).

### 2.6 `patchApplier.ts` — ported from V2

The exact chain V2 fought hard to get right (see repo memory `multi-agent-graph.md`):

```
1. Validate payload looks like a unified diff (has '--- ' and '+++ ' headers)
   → if not, return error (don't feed prose to patch).
2. Try the Python-style applier (handles multi-file diffs, new-file from /dev/null,
   without depending on patch's strict hunk line-counts).
3. If that fails → write payload to a temp .patch file → `patch -p1 --forward --batch`.
4. If -p1 fails with "can't find file to patch" → retry `patch -p0`.
5. Return (exitCode, output).
```

The Python-style applier is ported to TS as a focused implementation: parse `diff --git`/`--- `/`+++ `/`@@ `blocks, create parent dirs, write new files, apply hunks line-by-line. It only needs to handle the cases the model commonly emits (new-file creation + simple modifications); the `patch` fallback covers the rest.

---

## 3. The Tools (`src/tools/builtin/`)

### 3.1 `run_command`

```typescript
export const run_command: ToolSpec = {
  name: "run_command",
  description: "Run a shell command in the workspace under sandbox isolation. " +
               "Use for builds, tests, installs, git, and any shell work. " +
               "Dangerous commands are blocked; ask for approval if unsure.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The shell command to run." },
      network: { type: "boolean", description: "Allow network access (default false)." },
      backend: { type: "string", enum: ["bubblewrap", "docker", "host"], description: "Optional. Defaults to bubblewrap." },
      timeoutMs: { type: "integer", description: "Optional timeout in ms (default 120000)." },
    },
    required: ["command"],
  },
  handler: async ({ args, agent, state }) => {
    const command = requireString(args, "command");
    // 1. Permission mode gate (plan → deny)
    if (agent.permissionMode === "plan")
      return `Blocked: run_command is not allowed in plan mode`;
    // 2. Dangerous-command blocker
    const block = classifyCommand(command);
    if (block.blocked) {
      recorder.record({ type: "tool_call_result", ..., isError: true, ... }); // via dispatcher
      return `Blocked by safety policy: ${block.reason} (rule: ${block.rule})`;
    }
    // 3. Pick backend (agent-permission gate refuses 'host' unless allowed)
    const backend = resolveBackend(args["backend"], agent);
    // 4. Execute
    const result = await backend.exec({ command, workspace: state.workingDir, ... });
    // 5. Return truncated output (large logs bloat context)
    return formatExecResult(result);
  },
};
```

**Output truncation (context discipline):** stdout+stderr capped at ~8 KB; if longer, keep the **first 2 KB + last 4 KB** with a `[…N bytes truncated…]` marker — this is where build errors usually live (compiler errors at the end, command echo at the start). Mirrors V2's `log_purifier` intent (full purification lands when we add language-specific extractors later).

### 3.2 `apply_patch`

```typescript
export const apply_patch: ToolSpec = {
  name: "apply_patch",
  description: "Apply a unified diff to the workspace. Use for modifying existing " +
               "files or creating new ones. Payload must be a valid unified diff " +
               "(--- /+++ /@@@ headers).",
  parameters: {
    type: "object",
    properties: {
      diff: { type: "string", description: "The full unified diff to apply." },
    },
    required: ["diff"],
  },
  handler: async ({ args, state }) => {
    const diff = requireString(args, "diff");
    const result = applyPatchChain(diff, state.workingDir); // §2.6
    return result.ok
      ? `Patch applied (${result.filesChanged} file(s) changed).`
      : `Patch failed: ${result.error}`;
  },
};
```

---

## 4. Permission Routing (`src/tools/dispatcher.ts` edit)

The dispatcher's permission gate already exists (Phase 0 stub). Phase 1 makes it tool-aware:

| Tool \ Mode | `default` | `accept-edits` | `auto` | `plan` | `full-auto` |
|---|---|---|---|---|---|
| read-only (`read_file`, `list_dir`, `echo`) | allow | allow | allow | allow | allow |
| `write_file` | prompt (Phase 0: allow+log) | allow | allow | **deny** | allow |
| `apply_patch` | prompt (Phase 0: allow+log) | allow | allow | **deny** | allow |
| `run_command` (passes blocker) | prompt (Phase 0: allow+log) | prompt | classifier (Phase 6) | **deny** | allow (sandboxed) |
| `run_command` (heuristic flag) | allow+warn | allow+warn | classifier | **deny** | **block** |
| `run_command` (blocklist) | **block** | **block** | **block** | **block** | **block** |

The dangerous-command blocker runs **inside the `run_command` handler** (not the dispatcher) so it always applies regardless of permission mode, and so its block reason reaches the model as a normal tool result.

---

## 5. Output Discipline & Telemetry

- **JSONL:** every `run_command` records `{ command, backend, exitCode, timedOut, durationMs, outputPreview }`. Every block records `{ command, rule, reason }`.
- **Token budget:** `run_command` output is truncated (§3.1). `apply_patch` returns a one-line summary, not the diff.
- **Workspace isolation:** the sandbox binds `state.workingDir` as the writable root. The path-traversal guard from Phase 0's `safeResolve` is reused for `write_file`/`read_file` (already in place).

---

## 6. Build Order (Phase 1)

1. **`sandbox/dangerousCommands.ts`** + tests — pure function, no deps. Highest-value safety primitive; build first.
2. **`sandbox/backend.ts`** — interface + factory.
3. **`sandbox/bubblewrap.ts`** + integration test (run `echo hi`, assert output + that `/etc/passwd` write is refused).
4. **`sandbox/host.ts`** — gated fallback + tests.
5. **`sandbox/docker.ts`** — opt-in backend + smoke test (skip if daemon down).
6. **`sandbox/patchApplier.ts`** + tests — port V2's chain (validation → TS applier → `patch -p1` → `patch -p0`).
7. **`tools/builtin/run_command.ts`** + `apply_patch.ts` — wire to backends/blocker.
8. **`tools/builtin/index.ts`** — register the two new tools.
9. **Dispatcher permission routing** — tool-aware gate per §4.
10. **Live demo agent** — `agents/builder.md` scaffolds a Node project and runs it under bubblewrap.
11. **Full test suite + typecheck** — Phase 0 must still pass.

---

## 7. What Phase 1 Explicitly Defers

| Feature | Phase |
|---|---|
| Delegation (`delegate` tool, policy, concurrency) | **Phase 2** |
| Per-agent + shared memory, handoff packets | Phase 3 |
| MCP lazy-loading, `mcp_tool_search` | Phase 4 |
| TUI (Ink) + web UI (Next.js) + rewind | Phase 5 |
| Auto-mode classifier (real `auto` permission) + agent-creation | Phase 6 |
| Language-specific log purification (full `log_purifier` port) | Phase 1.5 (after observing real build outputs) |
| Specialization kits | Phase 7 |

---

## 8. Risks & Open Points

1. **bubblewrap on read-only system trees.** Some Ubuntu setups have `/usr` merged or symlinks (`/bin → /usr/bin`). The `bwrap` arg construction must `--ro-bind-try` the symlinks gracefully. The integration test (step 3) will catch this immediately.
2. **Global installs policy.** `npm install -g` is blocked, but `npm install` (local) is allowed and is usually what agents want. Confirm this is the right line — I think yes (global installs pollute the host; local are workspace-scoped).
3. **Docker daemon latency.** Cold container starts add seconds. Default stays bubblewrap; Docker only when the agent opts in for a specific reason (untrusted image, language toolchain).
4. **Network allowlist.** Phase 1 ships network **off** by default (simplest safe default). A domain allowlist is a Phase 1.5 refinement once we see what agents actually need (probably `npm registry`, `pypi`, `github`).
