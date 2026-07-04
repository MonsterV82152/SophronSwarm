/**
 * Tool registry — indexed collection of ToolSpecs.
 *
 * Built-in tools register here; later phases add MCP-sourced tools (Phase 4)
 * and plugin tools. The registry is the single source of truth for "what
 * tools exist"; per-agent allow/deny filtering happens in the dispatcher.
 */
import { log } from "../util/log.js";
import type { ToolDefinition } from "../types.js";
import { type ToolSpec } from "./schema.js";

export class ToolRegistry {
  private tools = new Map<string, ToolSpec>();

  register(spec: ToolSpec): void {
    if (this.tools.has(spec.name)) {
      log.warn({ name: spec.name }, "tool already registered; replacing");
    }
    this.tools.set(spec.name, spec);
  }

  get(name: string): ToolSpec | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): ToolSpec[] {
    return [...this.tools.values()];
  }

  /** LLM-facing definitions for a given agent (after allow/deny filtering). */
  definitionsFor(opts: {
    allow?: string[];
    deny?: string[];
  }): ToolDefinition[] {
    return this.list()
      .filter((t) => !(opts.deny ?? []).includes(t.name))
      .filter((t) => (opts.allow ? opts.allow.includes(t.name) : true))
      .map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
  }
}
