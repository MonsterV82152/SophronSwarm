/**
 * Agent loader — parses .md + YAML frontmatter into AgentDefinition.
 *
 * Ports Claude Code's subagent format. Frontmatter holds config; the markdown
 * body is the system prompt. Validation via zod. Model tier → concrete id
 * resolution delegated to llm/providers.ts.
 *
 * See docs/PHASE_0_DESIGN.md §3.
 */
import { readFileSync, writeFileSync } from "node:fs";
import matter from "gray-matter";
import { z } from "zod";
import { resolveModel } from "../llm/providers.js";
import { log } from "../util/log.js";
import type { AgentDefinition, PermissionMode } from "../types.js";

const PERMISSION_MODES = ["default", "accept-edits", "auto", "plan", "full-auto"] as const;

const FrontmatterSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  tools: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
  model: z.string().min(1),               // concrete model id (required, no tiers)
  provider: z.string().min(1),             // provider instance name (required)
  permissionMode: z.enum(PERMISSION_MODES).default("default"),
  mcpServers: z.array(z.union([z.string(), z.record(z.unknown())])).optional(),
  memoryScopes: z.array(z.enum(["per-agent", "shared", "task"])).optional(),
  /** Disable ALL memory injection for this agent (M7 — global orchestrator). */
  noMemory: z.boolean().optional(),
  delegateAllowlist: z.array(z.string()).optional(),
  maxTurns: z.number().int().positive().optional(),
  outputPurifier: z.enum(["default", "aggressive", "off"]).optional(),
  outputPurifierThreshold: z.number().int().positive().optional(),
});

export type AgentSource = "project" | "user" | "builtin";

export interface LoadOptions {
  source: AgentSource;
  /** Absolute path to the .md file. */
  filePath: string;
}

export interface LoadAgentResult {
  ok: true;
  agent: AgentDefinition;
}

export interface LoadAgentError {
  ok: false;
  filePath: string;
  error: string;
}

/**
 * Load and validate one agent definition file.
 * Returns a discriminated union so callers can collect errors per-file
 * without crashing the whole registry.
 */
export function loadAgentFile(opts: LoadOptions): LoadAgentResult | LoadAgentError {
  const { source, filePath } = opts;
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (e) {
    return { ok: false, filePath, error: `Could not read file: ${(e as Error).message}` };
  }

  let parsed;
  try {
    // Pass an options object to disable gray-matter's content-keyed cache so
    // repeated parses (and callers that mutate parsed.data) stay isolated.
    parsed = matter(raw, {});
  } catch (e) {
    return { ok: false, filePath, error: `Invalid frontmatter: ${(e as Error).message}` };
  }

  const fmResult = FrontmatterSchema.safeParse(parsed.data);
  if (!fmResult.success) {
    return { ok: false, filePath, error: `Schema: ${fmResult.error.issues.map((i) => i.path.join(".") + ": " + i.message).join("; ")}` };
  }

  const fm = fmResult.data;
  const systemPrompt = (parsed.content ?? "").trim();
  if (!systemPrompt) {
    return { ok: false, filePath, error: "System prompt (markdown body) is empty" };
  }

  // Resolve model + provider (done ONCE at load time). V3.1.0: both are required
  // frontmatter fields. No tiers, no fallback — model is a concrete id.
  let model: string;
  let provider;
  try {
    const resolved = resolveModel(fm.model, fm.provider);
    model = resolved.model;
    provider = resolved.provider;
  } catch (e) {
    return { ok: false, filePath, error: `Model resolution: ${(e as Error).message}` };
  }

  const agent: AgentDefinition = {
    name: fm.name,
    description: fm.description,
    systemPrompt,
    tools: fm.tools,
    disallowedTools: fm.disallowedTools,
    model,
    provider,
    permissionMode: fm.permissionMode as PermissionMode,
    mcpServers: fm.mcpServers,
    memoryScopes: fm.memoryScopes,
    noMemory: fm.noMemory,
    delegateAllowlist: fm.delegateAllowlist,
    maxTurns: fm.maxTurns,
    outputPurifier: fm.outputPurifier,
    outputPurifierThreshold: fm.outputPurifierThreshold,
    source,
    filePath,
  };

  log.debug({ name: agent.name, source, model }, "loaded agent");
  return { ok: true, agent };
}

/**
 * Patch an agent definition's frontmatter on disk.
 *
 * Performs a targeted read-modify-write: only the keys present in `patch`
 * are updated; the markdown body and all other frontmatter fields are
 * preserved. Throws on missing file or invalid frontmatter.
 */
export function updateAgentFrontmatter(
  filePath: string,
  patch: { model?: string; provider?: string },
): void {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (e) {
    throw new Error(`Could not read agent file '${filePath}': ${(e as Error).message}`);
  }

  let parsed;
  try {
    // Pass an options object to disable gray-matter's content-keyed cache so
    // repeated parses (and callers that mutate parsed.data) stay isolated.
    parsed = matter(raw, {});
  } catch (e) {
    throw new Error(`Invalid frontmatter in '${filePath}': ${(e as Error).message}`);
  }

  if (patch.model !== undefined) parsed.data.model = patch.model;
  if (patch.provider !== undefined) parsed.data.provider = patch.provider;

  const updated = matter.stringify(parsed.content, parsed.data);
  writeFileSync(filePath, updated, "utf8");
}
