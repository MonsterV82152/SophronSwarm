/**
 * Auto-mode classifier — a cheap local model vets each mutating tool call
 * before execution when an agent runs in `permissionMode: "auto"`.
 *
 * Claude Code's auto-mode: near-frictionless execution without a per-command
 * human prompt, but with a safety net that blocks risky commands and escalates
 * uncertain ones. Free, offline, low-latency (local Ollama).
 *
 * This is the SECOND gate (layered on the deterministic dangerous-command
 * blocker in run_command). The blocker handles obvious stuff (rm -rf /); the
 * classifier handles judgment calls (curl, git push --force, npm install).
 *
 * See docs/PHASE_6_DESIGN.md §2.
 */
import { log } from "../util/log.js";
import type { LLMClient } from "../llm/client.js";
import { resolveModel } from "../llm/providers.js";
import type { AgentDefinition } from "../types.js";

export type ClassifyDecision = "allow" | "deny" | "prompt";

export interface ClassifyResult {
  decision: ClassifyDecision;
  /** One-line reason (from the model or the fallback path). */
  reason: string;
}

/** The cheap local model used for vetting (decided: §11.1 open question). */
export const CLASSIFIER_MODEL = "ollama:qwen3.5:9b-fast";

const CLASSIFIER_SYSTEM_PROMPT = `You are a command-safety classifier for an autonomous coding agent.
You receive a tool name + its arguments and must decide whether the agent should be ALLOWED to execute it.

Rules:
- "allow": the command is safe and routine (builds, tests, reads, standard git, installs of known packages, file edits inside the workspace).
- "deny": the command is clearly destructive or malicious (deletes outside the workspace, force-pushes to protected branches, writes to system dirs, disables security, network exfiltration, anything bypassing the sandbox).
- "prompt": you are UNSURE or the command has side effects an operator should confirm (network access to unknown hosts, large installs, destructive git operations, anything touching credentials or deployments).

Respond with EXACTLY one line in the format: DECISION|reason
Where DECISION is allow, deny, or prompt, and reason is a short clause.
Example: allow|running the project test suite
Example: deny|force-push to main rewrites shared history
Example: prompt|curl to an unknown host — possible exfiltration`;

export interface AutoModeClassifier {
  vet(toolName: string, args: Record<string, unknown>, agent: AgentDefinition): Promise<ClassifyResult>;
}

/**
 * LLM-backed classifier. Uses the cheap model. Caches verdicts per
 * (toolName + serialized args) within a run so repeated commands are vetted
 * once. Falls back to "prompt" on any error (safe default — escalate rather
 * than auto-allow).
 */
export class LlmAutoModeClassifier implements AutoModeClassifier {
  private cache = new Map<string, ClassifyResult>();
  /** Resolved concrete model id (prefix stripped). */
  private readonly resolvedModel: string;
  /** Resolved provider. */
  private readonly resolvedProvider: import("../llm/providers.js").ProviderName;

  constructor(
    private llm: LLMClient,
    /** Override the model (e.g. for tests). Defaults to CLASSIFIER_MODEL. */
    model: string = CLASSIFIER_MODEL,
  ) {
    const r = resolveModel(model);
    this.resolvedModel = r.model;
    this.resolvedProvider = r.provider;
  }

  async vet(toolName: string, args: Record<string, unknown>, agent: AgentDefinition): Promise<ClassifyResult> {
    const key = `${toolName}::${stableStringify(args)}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const userPrompt = buildUserPrompt(toolName, args, agent);
    let result: ClassifyResult;
    try {
      const response = await this.llm.complete({
        model: this.resolvedModel,
        provider: this.resolvedProvider,
        messages: [
          { role: "system", content: CLASSIFIER_SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        temperature: 0,
      });
      result = parseVerdict(response.content ?? "");
    } catch (e) {
      log.warn({ err: (e as Error).message, tool: toolName }, "auto-mode classifier failed → prompt fallback");
      result = { decision: "prompt", reason: "classifier unavailable — operator review required" };
    }

    this.cache.set(key, result);
    log.info({ tool: toolName, decision: result.decision, reason: result.reason }, "auto-mode vetted");
    return result;
  }
}

/** Build the user-facing prompt describing the tool call to vet. */
function buildUserPrompt(toolName: string, args: Record<string, unknown>, agent: AgentDefinition): string {
  return [
    `Agent: ${agent.name} (permissionMode: auto)`,
    `Tool: ${toolName}`,
    `Arguments: ${stableStringify(args)}`,
    ``,
    `Decide: allow, deny, or prompt.`,
  ].join("\n");
}

/**
 * Parse the model's "DECISION|reason" response. Tolerant of stray whitespace
 * or extra text; falls back to "prompt" if unparseable (safe default).
 */
export function parseVerdict(raw: string): ClassifyResult {
  const trimmed = raw.trim().toLowerCase();
  // Find the first occurrence of a known decision keyword.
  for (const decision of ["deny", "prompt", "allow"] as const) {
    const idx = trimmed.indexOf(decision);
    if (idx !== -1) {
      // Reason is everything after the decision + an optional delimiter.
      const after = trimmed.slice(idx + decision.length);
      const reason = after.replace(/^[|:\-\s]+/, "").replace(/\s+/g, " ").trim();
      return {
        decision,
        reason: reason || defaultReason(decision),
      };
    }
  }
  return { decision: "prompt", reason: "classifier returned an unparseable verdict" };
}

function defaultReason(decision: ClassifyDecision): string {
  switch (decision) {
    case "allow":
      return "command is safe and routine";
    case "deny":
      return "command is destructive or unsafe";
    case "prompt":
      return "operator review required";
  }
}

/** Deterministic JSON stringify (sorted keys) for stable cache keys. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

// ── AutoPermissionGate ──────────────────────────────────────────────────────

import type { PermissionGate, PermissionDecision } from "../tools/dispatcher.js";
import type { ApprovalsQueue } from "../tui/approvals.js";
import type { AgentRunState } from "../types.js";

/** Tools that mutate the filesystem or execute shell. */
const MUTATING_TOOLS = new Set(["write_file", "apply_patch", "run_command"]);
/** Read-only tools — always allowed. */
const READONLY_TOOLS = new Set(["echo", "read_file", "list_dir"]);

/**
 * The full permission gate, mode-aware. Extends the Phase-1 DefaultPermissionGate
 * with `auto` mode (classifier vetting) and `default` mode (prompt → ApprovalsQueue).
 *
 * Decision matrix:
 *   - read-only tools: always allow.
 *   - mutating in `plan`: deny.
 *   - mutating in `default`: enqueue + return "prompt" (TUI resolves).
 *   - mutating in `auto`: classifier → allow / deny / prompt.
 *   - mutating in `accept-edits` / `full-auto`: allow.
 *
 * Constructed in buildServices with the LLMClient + ApprovalsQueue. Batch runs
 * that don't pass an approvals queue use the simpler DefaultPermissionGate.
 */
export class AutoPermissionGate implements PermissionGate {
  constructor(
    private classifier: AutoModeClassifier,
    private approvals: ApprovalsQueue,
  ) {}

  async check(
    toolName: string,
    args: unknown,
    agent: AgentDefinition,
    state?: AgentRunState,
  ): Promise<PermissionDecision> {
    if (READONLY_TOOLS.has(toolName)) return "allow";
    if (!MUTATING_TOOLS.has(toolName)) return "allow"; // delegate/remember/etc.

    // Mutating tool — mode-aware routing.
    if (agent.permissionMode === "plan") {
      log.info({ tool: toolName, agent: agent.name }, "denied: plan mode is read-only");
      return "deny";
    }
    if (agent.permissionMode === "auto") {
      const result = await this.classifier.vet(toolName, args as Record<string, unknown>, agent);
      if (result.decision === "prompt" && state) {
        this.approvals.enqueue({
          agent: agent.name,
          tool: toolName,
          args: args as Record<string, unknown>,
          runId: state.runId,
        });
      }
      log.info({ tool: toolName, decision: result.decision, reason: result.reason }, "auto-mode gate");
      return result.decision;
    }
    if (agent.permissionMode === "default" && state) {
      // Prompt → route to the approvals queue.
      this.approvals.enqueue({
        agent: agent.name,
        tool: toolName,
        args: args as Record<string, unknown>,
        runId: state.runId,
      });
      return "prompt";
    }
    // accept-edits / full-auto → allow
    return "allow";
  }
}
