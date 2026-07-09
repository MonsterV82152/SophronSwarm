/**
 * File attachments for operator prompts.
 *
 * Supports `@path/to/file.md` references in any task string. The parser resolves
 * each reference against a base directory (the current project/workspace) and
 * an allowed-root list, reads the file, and renders the contents as an
 * `<attachment>` block that is injected into the agent prompt.
 *
 * This works for both the TUI and the CLI, and it works for agents that do not
 * have file tools (e.g. the global orchestrator) because the file contents are
 * embedded before the agent loop starts.
 */
import { readFileSync } from "node:fs";
import { isAbsolute, basename } from "node:path";
import { safeResolve, safeResolveAllowed } from "../tools/builtin/paths.js";

export interface Attachment {
  /** Absolute filesystem path of the attached file. */
  path: string;
  /** Filename (no directory). */
  name: string;
  /** File contents. */
  content: string;
  /** Original @-reference as typed by the operator. */
  ref: string;
}

const ATTACHMENT_REF_RE = /@(\S+)/g;

/** Find every `@path` reference in a prompt string. */
export function parseAttachmentRefs(text: string): string[] {
  const refs = new Set<string>();
  for (const match of text.matchAll(ATTACHMENT_REF_RE)) {
    const ref = match[1];
    if (ref) refs.add(ref);
  }
  return Array.from(refs);
}

/** Resolve a list of references to absolute, allowed paths. */
export function resolveAttachmentPaths(
  refs: string[],
  baseDir: string,
  allowedRoots: string[],
): Map<string, string> {
  const resolved = new Map<string, string>();
  for (const ref of refs) {
    const abs = isAbsolute(ref)
      ? safeResolveAllowed(ref, allowedRoots)
      : safeResolve(baseDir, ref);
    resolved.set(ref, abs);
  }
  return resolved;
}

/** Read the resolved files into Attachment objects. */
export function loadAttachments(resolved: Map<string, string>): Attachment[] {
  const attachments: Attachment[] = [];
  for (const [ref, abs] of resolved) {
    try {
      const content = readFileSync(abs, "utf8");
      attachments.push({ path: abs, name: basename(abs), content, ref });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      attachments.push({ path: abs, name: basename(abs), content: `(error reading file: ${msg})`, ref });
    }
  }
  return attachments;
}

/** Render attachments as a single markdown/XML block for the prompt. */
export function renderAttachments(attachments: Attachment[]): string {
  if (attachments.length === 0) return "";
  const blocks = attachments.map((a) => {
    const header = `<attachment path="${a.path}" name="${a.name}">`;
    const footer = "</attachment>";
    return `${header}\n${a.content}\n${footer}`;
  });
  return `ATTACHMENTS:\n${blocks.join("\n\n")}`;
}

/**
 * Expand a task string by stripping `@path` references and prepending the
 * rendered attachment contents. Returns the expanded task and the loaded
 * attachments for callers that want to render them separately.
 */
export function expandTaskWithAttachments(
  task: string,
  baseDir: string,
  allowedRoots: string[],
): { task: string; attachments: Attachment[] } {
  const refs = parseAttachmentRefs(task);
  if (refs.length === 0) return { task, attachments: [] };

  const resolved = resolveAttachmentPaths(refs, baseDir, allowedRoots);
  const attachments = loadAttachments(resolved);
  const rendered = renderAttachments(attachments);

  // Remove the @-references from the task so the agent sees a clean prompt.
  let cleanTask = task;
  for (const ref of refs) {
    cleanTask = cleanTask.replace(new RegExp(`@${escapeRegExp(ref)}\\b`, "g"), "");
  }
  // Collapse any leftover double spaces or empty lines created by removing refs.
  cleanTask = cleanTask.replace(/[ \t]+/g, " ").replace(/\n[ \t]*\n[ \t]*\n/g, "\n\n").trim();

  return { task: `${rendered}\n\nTASK:\n${cleanTask}`, attachments };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Convenience: just the attachment block for callers that already resolved files. */
export function attachmentBlock(path: string, content: string): string {
  return `<attachment path="${path}" name="${basename(path)}">\n${content}\n</attachment>`;
}
