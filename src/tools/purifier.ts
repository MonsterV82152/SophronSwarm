/**
 * Output purifier — deterministic-first filter pipeline for tool results.
 *
 * Tool output is the #1 context-bloater: a noisy `cargo build`, a docs-page
 * scrape, `npm install` spam — easily 5–20k tokens of noise per call, every
 * turn, into a frontier model's context. This module compresses tool output
 * *before* it enters the agent's message history.
 *
 * Two tiers, deterministic-first (per the locked principle "spend tokens only
 * where an LLM's judgment is required" — AGENT_CONTEXT §0):
 *
 *   Tier 1 — deterministic rules (free, zero tokens, µs latency):
 *            ANSI strip, progress-bar collapse, duplicate-line collapse,
 *            blank-line collapse, head+tail truncation. Handles ~80% of noise.
 *
 *   Tier 2 — cheap local model (optional, fires only above a token threshold):
 *            extracts errors / final result / key outputs in ≤300 tokens.
 *
 * SAFETY VALVE — no information loss:
 *   Raw output is written to `<workspace>/.sophron/raw/<runId>/<seq>.txt`
 *   BEFORE purification. Only the purified version enters message history. The
 *   agent can retrieve the full raw output via the `read_raw_output` tool when
 *   a summary is ambiguous.
 *
 * This generalizes V2's "log purifier" (referenced in PROJECT_OVERVIEW §10)
 * and the MCP-only `flattenMcpResult` (src/mcp/promotion.ts) to ALL tool
 * results.
 *
 * See docs/ROADMAP.md (M1) + docs/IDEAS.md (#5).
 */
import { writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { log } from "../util/log.js";
import { approxTokens } from "../util/tokenize.js";
import { resolveModel, type ProviderName } from "../llm/providers.js";
import type { LLMClient } from "../llm/client.js";

// ── Types ───────────────────────────────────────────────────────────────────

export type PurifierMode = "default" | "aggressive" | "off";

export interface PurifyOptions {
  mode: PurifierMode;
  /** Token threshold above which Tier 2 (model compression) may fire. */
  threshold: number;
  /** Workspace root (for the raw-output store). */
  workingDir: string;
  /** Current run id (namespaces raw files). */
  runId: string;
  /** Tool call id (used in the raw-file name for traceability). */
  toolCallId: string;
  /** Which tool produced this output. */
  toolName: string;
}

export interface PurifyResult {
  /** The (possibly purified) content to enter message history. */
  content: string;
  /** Workspace-relative path to the raw output, if purification changed it. */
  rawPath?: string;
  /** True if any Tier 1 rule changed the content. */
  tier1Applied: boolean;
  /** True if the cheap model compressed the content. */
  tier2Applied: boolean;
}

/** Per-tool noisy-output profiles. Known chatty tools get aggressive truncation. */
const NOISY_TOOLS = new Set(["run_command", "npm install", "pip install", "cargo build", "yarn", "pnpm install"]);

/** The cheap local model used for Tier 2 extraction. Reuses the classifier model. */
export const PURIFIER_MODEL = "ollama:qwen3.5:9b-fast";

const DEFAULT_KEEP_LINES = 40;
const AGGRESSIVE_KEEP_LINES = 20;
const RAW_DIR = join(".sophron", "raw");
const DEFAULT_RAW_CAP_BYTES = 50 * 1024 * 1024; // 50 MB per project

/** Default token threshold above which Tier 2 (cheap-model extraction) fires. */
export const DEFAULT_PURIFIER_THRESHOLD = 1500;

// ── Tier 1: deterministic rules (pure functions, exported for testing) ──────

/** Strip ANSI escape sequences (colors, cursor moves, line clears). */
export function stripAnsi(s: string): string {
  // Covers CSI sequences incl. private-mode (?…) and SGR colors.
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
}

/**
 * Collapse carriage-return progress bars. Captured process output often
 * contains `\r` overwrites (spinners, progress bars, repeated in-place
 * updates). For each `\n`-delimited line, keep only the segment after the LAST
 * `\r` (the final visible state).
 */
export function stripProgressBars(s: string): string {
  return s
    .split("\n")
    .map((line) => {
      const idx = line.lastIndexOf("\r");
      return idx === -1 ? line : line.slice(idx + 1);
    })
    .join("\n");
}

/**
 * Collapse runs of 3+ identical consecutive lines into one + a count marker.
 * Handles build spam (repeated "Compiling foo..." lines) and test progress.
 * Lines are compared after trimming trailing whitespace.
 */
export function collapseConsecutiveDuplicates(s: string): string {
  const lines = s.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const cur = lines[i]!;
    let count = 1;
    while (i + count < lines.length && lines[i + count]!.trimEnd() === cur.trimEnd()) {
      count++;
    }
    if (count >= 3) {
      // Collapse: keep one copy + a count marker.
      out.push(cur);
      out.push(`[… ${count - 1} duplicate line(s) omitted …]`);
    } else {
      // Below threshold: keep every copy verbatim.
      for (let j = 0; j < count; j++) out.push(cur);
    }
    i += count;
  }
  return out.join("\n");
}

/** Collapse runs of 2+ consecutive blank lines to a single blank line. */
export function collapseBlankLines(s: string): string {
  const lines = s.split("\n");
  const out: string[] = [];
  let prevBlank = false;
  for (const line of lines) {
    const isBlank = line.trim() === "";
    if (isBlank && prevBlank) continue;
    out.push(line);
    prevBlank = isBlank;
  }
  return out.join("\n");
}

/** Result of head+tail truncation. */
export interface TruncateResult {
  text: string;
  truncated: boolean;
  /** Number of lines omitted from the middle, if truncated. */
  omitted: number;
}

/**
 * Keep the first `keep` + last `keep` lines; replace the middle with a marker
 * if the line count exceeds `keep * 2`. No-op (truncated: false) otherwise.
 */
export function headTailTruncate(s: string, keep: number): TruncateResult {
  const lines = s.split("\n");
  if (lines.length <= keep * 2) {
    return { text: s, truncated: false, omitted: 0 };
  }
  const head = lines.slice(0, keep);
  const tail = lines.slice(lines.length - keep);
  const omitted = lines.length - keep * 2;
  const text = [...head, `[… ${omitted} line(s) omitted …]`, ...tail].join("\n");
  return { text, truncated: true, omitted };
}

/**
 * Tier 1 pipeline. Applies the lossless-safe rules first (ANSI, progress,
 * duplicates, blanks), then truncation only if the result still exceeds the
 * token threshold. Returns the processed text + whether it changed.
 */
export function applyTier1(
  input: string,
  opts: { keepLines: number; aggressive: boolean },
): { text: string; changed: boolean } {
  let text = input;
  let changed = false;

  const step = (fn: (s: string) => string): void => {
    const next = fn(text);
    if (next !== text) {
      text = next;
      changed = true;
    }
  };

  // Lossless-safe cleanups (always applied).
  step(stripAnsi);
  step(stripProgressBars);
  step(collapseConsecutiveDuplicates);
  step(collapseBlankLines);

  // Truncation only if the result is still large.
  const afterClean = approxTokens(text);
  const truncThreshold = opts.aggressive ? 500 : 1000;
  if (afterClean > truncThreshold) {
    const t = headTailTruncate(text, opts.keepLines);
    if (t.truncated) {
      text = t.text;
      changed = true;
    }
  }

  return { text, changed };
}

// ── Tier 2: cheap-model extraction ──────────────────────────────────────────

const TIER2_SYSTEM_PROMPT = `You are a log/output compressor for an autonomous coding agent.
Extract from the following tool output, in under 300 tokens:
1. Any ERRORS or WARNINGS (quote the exact text).
2. The final RESULT / exit cause (success or failure + why).
3. Files changed or key outputs.
If nothing failed, begin with "SUCCEEDED" + a one-line summary.
Be terse. No prose, no restatement of the input.`;

/**
 * Run Tier 2 extraction via the cheap model. Returns null on any failure
 * (graceful degradation — caller keeps the Tier 1 result).
 */
export async function runTier2(
  llm: LLMClient,
  model: string,
  provider: ProviderName,
  input: string,
  toolName: string,
): Promise<string | null> {
  try {
    const response = await llm.complete({
      model,
      provider,
      messages: [
        { role: "system", content: TIER2_SYSTEM_PROMPT },
        { role: "user", content: `[tool: ${toolName}]\n\n${input}` },
      ],
      temperature: 0,
    });
    const compressed = (response.content ?? "").trim();
    if (!compressed) return null;
    return compressed;
  } catch (e) {
    log.warn({ err: (e as Error).message, tool: toolName }, "purifier Tier 2 failed → keeping Tier 1 result");
    return null;
  }
}

// ── Raw-output store + LRU pruner ───────────────────────────────────────────

/**
 * Write raw output to `<workspace>/.sophron/raw/<runId>/<seq>-<callId>.txt`.
 * Returns the workspace-relative path. Then prunes the raw dir if it exceeds
 * the size cap (LRU — oldest mtime first).
 */
export function writeRaw(
  content: string,
  opts: { workingDir: string; runId: string; toolCallId: string; capBytes: number },
): string {
  const runDir = join(opts.workingDir, RAW_DIR, opts.runId);
  mkdirSync(runDir, { recursive: true });
  // seq = timestamp ensures ordering + avoids collisions.
  const file = join(runDir, `${Date.now()}-${sanitizeFile(opts.toolCallId)}.txt`);
  writeFileSync(file, content, "utf8");
  pruneRaw(opts.workingDir, opts.capBytes);
  return relative(opts.workingDir, file);
}

/** Delete oldest files across the whole project raw dir until under cap. */
function pruneRaw(workingDir: string, capBytes: number): void {
  const root = join(workingDir, RAW_DIR);
  if (!existsSync(root)) return;
  let entries: string[];
  try {
    entries = collectFiles(root);
  } catch {
    return;
  }
  if (entries.length === 0) return;

  const sized = entries.map((p) => {
    let size = 0;
    let mtime = 0;
    try {
      const st = statSync(p);
      size = st.size;
      mtime = st.mtimeMs;
    } catch {
      /* ignore broken entries */
    }
    return { path: p, size, mtime };
  });
  const total = sized.reduce((a, b) => a + b.size, 0);
  if (total <= capBytes) return;

  // Oldest mtime first; delete until under cap.
  sized.sort((a, b) => a.mtime - b.mtime);
  let remaining = total;
  for (const e of sized) {
    if (remaining <= capBytes) break;
    try {
      unlinkSync(e.path);
      remaining -= e.size;
    } catch {
      /* ignore */
    }
  }
  log.info({ remaining, cap: capBytes }, "purifier raw store pruned");
}

/** Recursively collect all file paths under `dir`. */
function collectFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    try {
      if (statSync(full).isDirectory()) {
        out.push(...collectFiles(full));
      } else {
        out.push(full);
      }
    } catch {
      /* ignore */
    }
  }
  return out;
}

/** Make a string safe for use as a filename component. */
function sanitizeFile(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "out";
}

// ── Purifier class ──────────────────────────────────────────────────────────

/**
 * Should this tool's output be purified at all? Default mode purifies only
 * known-noisy tools (`run_command`, promoted MCP tools); `"aggressive"`
 * purifies everything; `"off"` purifies nothing.
 */
export function shouldPurify(toolName: string, mode: PurifierMode): boolean {
  if (mode === "off") return false;
  if (mode === "aggressive") return true;
  // default: noisy shell output + external MCP tool output.
  return toolName === "run_command" || toolName.startsWith("mcp__");
}

export class Purifier {
  private readonly llm?: LLMClient;
  private readonly resolvedModel?: string;
  private readonly resolvedProvider?: ProviderName;
  private readonly keepLines: number;
  private readonly rawCapBytes: number;

  constructor(opts?: {
    llm?: LLMClient;
    /** Override the Tier 2 model. Defaults to PURIFIER_MODEL. */
    model?: string;
    keepLines?: number;
    rawCapBytes?: number;
  }) {
    this.llm = opts?.llm;
    this.keepLines = opts?.keepLines ?? DEFAULT_KEEP_LINES;
    this.rawCapBytes = opts?.rawCapBytes ?? DEFAULT_RAW_CAP_BYTES;
    // Resolve the Tier 2 model eagerly (like autoGate does). If unresolvable
    // (e.g. no providers configured), Tier 2 silently stays disabled.
    try {
      const r = resolveModel(opts?.model ?? PURIFIER_MODEL);
      this.resolvedModel = r.model;
      this.resolvedProvider = r.provider;
    } catch {
      log.info("purifier Tier 2 model unresolvable — deterministic-only mode");
    }
  }

  /**
   * Purify a tool result. Never throws — on any internal error, returns the
   * original content unchanged (the tool result must still reach the model).
   */
  async purify(input: string, opts: PurifyOptions): Promise<PurifyResult> {
    // Off / non-noisy tools: pass through untouched.
    if (!shouldPurify(opts.toolName, opts.mode)) {
      return { content: input, tier1Applied: false, tier2Applied: false };
    }

    // Short outputs: nothing to do.
    if (approxTokens(input) <= 0) {
      return { content: input, tier1Applied: false, tier2Applied: false };
    }

    let rawPath: string | undefined;
    let working = input;

    try {
      // ── Tier 1 (always) ──────────────────────────────────────────────────
      const aggressive = opts.mode === "aggressive";
      const keep = aggressive ? AGGRESSIVE_KEEP_LINES : this.keepLines;
      const t1 = applyTier1(working, { keepLines: keep, aggressive });
      const tier1Changed = t1.changed;
      working = t1.text;

      // If Tier 1 changed anything, persist the raw output for the escape hatch.
      if (tier1Changed) {
        rawPath = writeRaw(input, {
          workingDir: opts.workingDir,
          runId: opts.runId,
          toolCallId: opts.toolCallId,
          capBytes: this.rawCapBytes,
        });
      }

      // ── Tier 2 (optional, only above threshold) ──────────────────────────
      let tier2Applied = false;
      if (aggressive || approxTokens(working) > opts.threshold) {
        if (this.llm && this.resolvedModel && this.resolvedProvider) {
          const compressed = await runTier2(
            this.llm,
            this.resolvedModel,
            this.resolvedProvider,
            working,
            opts.toolName,
          );
          if (compressed && approxTokens(compressed) < approxTokens(working)) {
            working = compressed;
            tier2Applied = true;
          }
        }
      }

      // If we changed anything but the agent didn't already have a rawPath note,
      // append a pointer so the agent knows the full output is recoverable.
      if ((tier1Changed || tier2Applied) && rawPath && !working.includes(rawPath)) {
        working = `${working}\n\n[output purified — full raw output saved at: ${rawPath}]`;
      }

      return { content: working, rawPath, tier1Applied: tier1Changed, tier2Applied };
    } catch (e) {
      log.warn({ err: (e as Error).message, tool: opts.toolName }, "purifier failed → returning raw content");
      return { content: input, tier1Applied: false, tier2Applied: false };
    }
  }
}
