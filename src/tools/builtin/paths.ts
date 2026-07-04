/**
 * Shared path-safety helpers for built-in file tools.
 *
 * Ports V2's WorkspaceManager._safe_resolve lesson (see repo memory:
 * multi-agent-graph.md — "Path normalization"): models often emit leading-slash
 * paths; Python/Node's `root / "/abs"` resolves to the filesystem root, NOT
 * `<root>/abs`. Always strip the leading slash and verify the resolved path
 * stays under the workspace root.
 */
import { resolve } from "node:path";

/** Resolve a relative path inside a root, rejecting escapes. Returns absolute. */
export function safeResolve(root: string, relPath: string): string {
  const clean = relPath.replace(/^\/+/, "");
  const candidate = resolve(root, clean);
  // Ensure candidate is root or inside root.
  const rootNorm = resolve(root);
  if (candidate !== rootNorm && !candidate.startsWith(rootNorm + "/")) {
    throw new Error(`Path '${relPath}' escapes workspace root ${rootNorm}`);
  }
  return candidate;
}
