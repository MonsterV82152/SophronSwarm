/**
 * Unified-diff applier — ported from V2's sophron_swarm/nodes/sandbox.py.
 *
 * The chain (load-bearing — see repo memory multi-agent-graph.md "Sandbox
 * patch validation"):
 *   1. Validate the payload looks like a unified diff (has '--- '/'+++ ').
 *   2. Try the TypeScript applier: handles multi-file diffs, new-file creation
 *      from /dev/null, and simple single-hunk edits. Tolerates wrong hunk
 *      line-counts that break POSIX patch.
 *   3. If that fails → write payload to a temp .patch file → `patch -p1`.
 *   4. If -p1 fails with "can't find file to patch" → retry `patch -p0`
 *      (handles bare-path diffs without a/ b/ prefixes).
 *
 * See docs/PHASE_1_DESIGN.md §2.6.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawnWithTimeout } from "./spawn.js";
import { log } from "../util/log.js";

export interface PatchResult {
  ok: boolean;
  filesChanged: number;
  /** Which method applied the patch (for telemetry). */
  method: "typescript" | "patch-p1" | "patch-p0" | "none";
  output: string;
  error?: string;
}

/** True if the payload looks like a unified diff. */
export function looksLikeUnifiedDiff(diff: string): boolean {
  return /^---\s/m.test(diff) && /^\+\+\+\s/m.test(diff);
}

/** Main entry: try the TS applier, then patch -p1, then patch -p0. */
export async function applyPatchChain(diff: string, workspaceRoot: string): Promise<PatchResult> {
  if (!diff.trim()) {
    return { ok: false, filesChanged: 0, method: "none", output: "", error: "Empty diff payload." };
  }
  if (!looksLikeUnifiedDiff(diff)) {
    return {
      ok: false,
      filesChanged: 0,
      method: "none",
      output: "",
      error:
        "Payload is not a valid unified diff (expected '--- ' and '+++ ' headers). " +
        "If you meant to write a file, use the write_file tool instead.",
    };
  }

  // ── 1. TypeScript applier ──────────────────────────────────────────────
  try {
    const tsResult = applyDiffTypeScript(diff, workspaceRoot);
    if (tsResult.ok) {
      return { ...tsResult, method: "typescript" };
    }
    log.info({ reason: tsResult.error }, "TS applier did not fully apply; trying patch utility");
  } catch (e) {
    log.info({ err: (e as Error).message }, "TS applier threw; trying patch utility");
  }

  // ── 2 & 3. POSIX patch (-p1, then -p0) ──────────────────────────────────
  return runPatchUtility(diff, workspaceRoot);
}

// ── TypeScript applier ──────────────────────────────────────────────────────

function safeTarget(root: string, relPath: string): string {
  const clean = relPath.replace(/^\/+/, "");
  const abs = resolve(root, clean);
  const rootNorm = resolve(root);
  if (abs !== rootNorm && !abs.startsWith(rootNorm + "/")) {
    throw new Error(`Patch target '${relPath}' escapes workspace root.`);
  }
  return abs;
}

function parseTargetPath(headerValue: string): string {
  // "b/src/foo.ts" → "src/foo.ts"; "/dev/null" stays; strip tabs (timestamps).
  let v = headerValue.split("\t")[0]!.trim();
  if (v.startsWith("b/") || v.startsWith("a/")) v = v.slice(2);
  return v.replace(/^\/+/, "");
}

/** Split the diff into per-file sections (each starting at a '--- ' line). */
function splitSections(lines: string[]): string[][] {
  const sections: string[][] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.startsWith("--- ")) {
      if (current.length && current.some((l) => l.startsWith("+++"))) sections.push(current);
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length && current.some((l) => l.startsWith("+++"))) sections.push(current);
  return sections;
}

function applyDiffTypeScript(diff: string, workspaceRoot: string): PatchResult {
  const sections = splitSections(diff.split(/\r?\n/));
  if (sections.length === 0) {
    return { ok: false, filesChanged: 0, method: "none", output: "", error: "No diff sections found." };
  }

  const created: string[] = [];
  const modified: string[] = [];
  const errors: string[] = [];

  for (const section of sections) {
    let sourcePath: string | null = null;
    let targetPath: string | null = null;
    let bodyStart = 0;

    for (let i = 0; i < section.length; i++) {
      const line = section[i]!;
      if (line.startsWith("--- ") && sourcePath === null) {
        sourcePath = line.slice(4);
      } else if (line.startsWith("+++ ")) {
        targetPath = parseTargetPath(line.slice(4));
        bodyStart = i + 1;
        break;
      }
    }

    if (!targetPath || targetPath === "/dev/null" || targetPath === "dev/null") {
      errors.push("Could not determine target file from +++ header.");
      continue;
    }

    let absTarget: string;
    try {
      absTarget = safeTarget(workspaceRoot, targetPath);
    } catch (e) {
      errors.push((e as Error).message);
      continue;
    }

    const isNewFile = sourcePath === "/dev/null" || sourcePath === "dev/null" || !existsSync(absTarget);
    const body = section.slice(bodyStart);

    if (isNewFile) {
      const added = body
        .filter(
          (l) =>
            l.startsWith("+") &&
            !l.startsWith("+++") &&
            !l.startsWith("@@") &&
            !l.startsWith("diff ") &&
            !l.startsWith("index ") &&
            !l.startsWith("new file"),
        )
        .map((l) => l.slice(1));
      try {
        mkdirSync(dirname(absTarget), { recursive: true });
        writeFileSync(absTarget, added.join("\n") + "\n", "utf8");
        created.push(targetPath);
      } catch (e) {
        errors.push(`Could not write '${targetPath}': ${(e as Error).message}`);
      }
    } else {
      if (applyHunkToExisting(body, absTarget)) {
        modified.push(targetPath);
      } else {
        errors.push(`Could not apply hunk to existing file '${targetPath}'.`);
      }
    }
  }

  const filesChanged = created.length + modified.length;
  if (filesChanged === 0) {
    return { ok: false, filesChanged: 0, method: "none", output: errors.join("; "), error: errors[0] };
  }

  const parts: string[] = [];
  if (created.length) parts.push(`Created ${created.length}: ${created.join(", ")}`);
  if (modified.length) parts.push(`Modified ${modified.length}: ${modified.join(", ")}`);
  let output = parts.join("; ");
  if (errors.length) output += `; Errors: ${errors.join("; ")}`;
  return { ok: true, filesChanged, method: "typescript", output };
}

/** Apply a single-hunk edit to an existing file. Returns true on success. */
function applyHunkToExisting(body: string[], absPath: string): boolean {
  // Collect hunk: context lines (space prefix), removed (-), added (+).
  // We rebuild the file by finding the context block and replacing.
  const fileLines = readFileSync(absPath, "utf8").split(/\r?\n/);
  // Drop trailing empty from final newline for consistent indexing.
  if (fileLines.length > 0 && fileLines[fileLines.length - 1] === "") fileLines.pop();

  // Extract hunk body (skip @@ header and +++/--- lines).
  const hunkLines = body.filter(
    (l) => !l.startsWith("@@") && !l.startsWith("+++") && !l.startsWith("---") && !l.startsWith("diff ") && !l.startsWith("index "),
  );

  // Build the expected pre-image (context + removed lines) and post-image (context + added).
  const pre: string[] = [];
  const post: string[] = [];
  for (const raw of hunkLines) {
    if (raw === "") {
      pre.push("");
      post.push("");
      continue;
    }
    const mark = raw[0];
    const rest = raw.slice(1);
    if (mark === " ") {
      pre.push(rest);
      post.push(rest);
    } else if (mark === "-") {
      pre.push(rest);
    } else if (mark === "+") {
      post.push(rest);
    }
    // backslash or other meta lines are ignored
  }

  // Find pre in fileLines as a contiguous block.
  const start = findSubarray(fileLines, pre);
  if (start === -1) return false;
  const replaced = [...fileLines.slice(0, start), ...post, ...fileLines.slice(start + pre.length)];
  writeFileSync(absPath, replaced.join("\n") + "\n", "utf8");
  return true;
}

function findSubarray(hay: string[], needle: string[]): number {
  if (needle.length === 0) return 0;
  outer: for (let i = 0; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

// ── POSIX patch utility fallback ────────────────────────────────────────────

async function runPatchUtility(diff: string, workspaceRoot: string): Promise<PatchResult> {
  const tmpDir = mkdtempSync(join(tmpdir(), "sophron-patch-"));
  const patchFile = join(tmpDir, "changes.patch");
  try {
    writeFileSync(patchFile, diff, "utf8");
    for (const stripLevel of ["1", "0"] as const) {
      const res = await spawnWithTimeout({
        command: "patch",
        args: [`-p${stripLevel}`, "--forward", "--batch", "--no-backup-if-mismatch", "-i", patchFile],
        cwd: workspaceRoot,
        timeoutMs: 30_000,
      });
      if (res.exitCode === 0) {
        return {
          ok: true,
          filesChanged: countChanged(res.output),
          method: stripLevel === "1" ? "patch-p1" : "patch-p0",
          output: res.output,
        };
      }
      const combined = res.output;
      // If -p1 failed only because it couldn't find the file, retry with -p0.
      if (stripLevel === "1" && /can't find file to patch/i.test(combined)) {
        log.debug("patch -p1 couldn't find file; retrying with -p0");
        continue;
      }
      return {
        ok: false,
        filesChanged: 0,
        method: "none",
        output: combined,
        error: `patch -p${stripLevel} failed (exit ${res.exitCode}).`,
      };
    }
    return { ok: false, filesChanged: 0, method: "none", output: "", error: "patch failed at both -p1 and -p0." };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function countChanged(patchOutput: string): number {
  const matches = patchOutput.match(/^patching file /gm);
  return matches ? matches.length : 0;
}

// Helper retained for callers that want just the path-safety check.
export function isWithinWorkspace(root: string, absPath: string): boolean {
  const rootNorm = resolve(root);
  return absPath === rootNorm || absPath.startsWith(rootNorm + "/");
}

// Avoid unused-import lint for isAbsolute (kept for future path checks).
void isAbsolute;
void join;
