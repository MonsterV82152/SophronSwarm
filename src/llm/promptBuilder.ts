/**
 * Prompt builder — assembles messages in volatility order for maximum
 * provider prefix-cache efficiency.
 *
 * Ported from V2's sophron_swarm/prompt_builder.py. Block ordering (ascending
 * volatility — stable prefix first):
 *
 *   [Position 0] system  ── base platform rules + agent.systemPrompt   (stable)
 *   [Position 1] user    ── immutable task                             (stable per task)
 *   [Position 2+]       ── assistant/tool tool-call pairs              (accumulates)
 *
 * Positions 0–1 are byte-identical across turns → provider prefix-cache
 * matches. Only the tail grows as the conversation proceeds.
 *
 * See docs/PHASE_0_DESIGN.md §7.
 */
import type { AgentDefinition, LLMMessage } from "../types.js";

const BASE_SYSTEM_RULES = `You are an agent operating inside the SophronSwarm multi-agent platform.

OPERATING RULES:
- You have access to tools. To use one, emit a tool_call with the tool's name and a JSON arguments object.
- After a tool call you will receive its result in the next message; act on it.
- When your task is complete, respond with a final text message and NO tool calls.
- Be concise. Prefer one tool call at a time when the action depends on its result.
- If a tool returns an error, diagnose and adapt — do not repeat the identical failing call.
`;

export interface BuildContext {
  /** Absolute path the agent is working in (surfaced for orientation). */
  workingDir: string;
  /** Shared-memory blocks to inject (Phase 3). Keys = section titles. */
  sharedMemory?: Map<string, string>;
  /** Per-agent memory text to inject (Phase 3). First ~200 lines of MEMORY.md. */
  agentMemory?: string;
}

export class PromptBuilder {
  build(agent: AgentDefinition, task: string, ctx: BuildContext): LLMMessage[] {
    const messages: LLMMessage[] = [];

    // ── Position 0: stable system prompt ─────────────────────────────────
    let system = BASE_SYSTEM_RULES;

    // Per-agent memory injected BEFORE shared context (it's this agent's own
    // lessons — high signal, low volume). Stable within a session.
    if (ctx.agentMemory && ctx.agentMemory.trim()) {
      system += "\nYOUR PAST MEMORY (lessons you recorded previously):\n";
      system += `${ctx.agentMemory.trim()}\n`;
    }

    if (ctx.sharedMemory && ctx.sharedMemory.size > 0) {
      // Shared memory injected here (stable within a checkpoint) — Phase 3.
      system += "\nSHARED PROJECT CONTEXT:\n";
      for (const [title, body] of ctx.sharedMemory) {
        system += `\n## ${title}\n${body}\n`;
      }
    }
    system += `\nAGENT IDENTITY:\n${agent.systemPrompt}\n`;
    if (agent.name) system += `\nYour agent name is "${agent.name}".\n`;
    messages.push({ role: "system", content: system });

    // ── Position 1: immutable task ───────────────────────────────────────
    messages.push({
      role: "user",
      content: `Working directory: ${ctx.workingDir}\n\nTASK:\n${task}`,
    });

    return messages;
  }

  /**
   * Append a fresh user message to an existing conversation (used for
   * follow-ups / mid-run operator injection in later phases).
   */
  appendUser(messages: LLMMessage[], text: string): LLMMessage[] {
    return [...messages, { role: "user", content: text }];
  }
}
