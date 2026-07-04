/**
 * Dangerous-command classifier — the safety gate for `run_command`.
 *
 * mycannybird-style: every command is classified before execution. Two layers:
 *   1. BLOCKLIST — hard blocks that never run, in any permission mode.
 *   2. HEURISTIC — suspicious patterns flagged for review. Behavior depends on
 *      permission mode (default/accept-edits: allow+warn; full-auto: block).
 *
 * Ported conceptually from V2's sandbox safety intent, expanded with the
 * explicit blocklist the operator spec'd. See docs/PHASE_1_DESIGN.md §2.5.
 */

export type Severity = "block" | "heuristic" | "ok";

export interface ClassifyResult {
  severity: Severity;
  /** Which rule matched (for telemetry / model-facing message). */
  rule?: string;
  /** Human-readable reason. */
  reason?: string;
}

/** Convenience predicate. */
export function isBlocked(cmd: string): boolean {
  return classifyCommand(cmd).severity === "block";
}

/**
 * Classify a shell command. Runs both layers; the most severe result wins
 * (block > heuristic > ok).
 */
export function classifyCommand(cmd: string): ClassifyResult {
  const c = cmd.trim();

  // ── Layer 1: hard blocklist ──────────────────────────────────────────────
  const block = matchBlocklist(c);
  if (block) return { severity: "block", rule: block.rule, reason: block.reason };

  // ── Layer 2: heuristics ─────────────────────────────────────────────────
  const heuristic = matchHeuristics(c);
  if (heuristic) return { severity: "heuristic", rule: heuristic.rule, reason: heuristic.reason };

  return { severity: "ok" };
}

// ── Blocklist rules ────────────────────────────────────────────────────────
// Each rule is (ruleId, reason, matcher). Matcher is a predicate function for
// clarity and correctness on path edge cases. Evaluated in order; first match wins.

interface Rule {
  rule: string;
  reason: string;
  match: (cmd: string) => boolean;
}

/** True if a dangerous-target token (`/`, `/*`, `~`, `$HOME`) appears as its own arg. */
function hasDangerousTarget(cmd: string): boolean {
  // Match the token standalone (bounded by start/space/quote/= and end/space/quote/;|&).
  return /(^|[\s"'=])(\/|\/\*|~|\$HOME|\$\{HOME\})(?=$|[\s"'|;&])/.test(cmd);
}

/** True if `rm`/`chmod`/`chown` carries a recursive flag (-r, -R, -fr, -rf, --recursive). */
function hasRecursiveFlag(cmd: string): boolean {
  return /(^|[\s])-[a-zA-Z]*[rR][a-zA-Z]*\b/.test(cmd) || /--recursive\b/.test(cmd);
}

const BLOCKLIST: Rule[] = [
  // ── Filesystem destruction ──────────────────────────────────────────────
  {
    rule: "rm-no-preserve-root",
    reason: "rm with --no-preserve-root is forbidden.",
    match: (c) => /\brm\b[^|;&]*--no-preserve-root/.test(c),
  },
  {
    rule: "rm-rf-root",
    reason: "Recursive delete targeting root or home directory.",
    match: (c) => /\brm\b/.test(c) && hasRecursiveFlag(c) && hasDangerousTarget(c),
  },
  {
    rule: "fork-bomb",
    reason: "Fork bomb pattern detected.",
    match: (c) => /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(c),
  },
  {
    rule: "dd-to-device",
    reason: "dd writing to a block device.",
    match: (c) => /\bdd\b[^|;&]*\bof\s*=\s*\/dev\/(?:sd|nvme|hd|vd|disk)/i.test(c),
  },
  {
    rule: "mkfs",
    reason: "Filesystem formatting command.",
    match: (c) => /\b(?:mkfs|fdisk|shred)\b[^|;&]*(?:\/dev\/|--)/i.test(c),
  },
  {
    rule: "chmod-777-root",
    reason: "Recursive chmod/chown targeting root or home.",
    match: (c) => /\b(?:chmod|chown)\b/.test(c) && hasRecursiveFlag(c) && hasDangerousTarget(c),
  },
  {
    rule: "write-to-system-dir",
    reason: "Write/redirect to a system directory outside the workspace.",
    match: (c) => /(?:>\s*|>>\s*)(?:\/etc\/|\/usr\/|\/var\/|\/boot\/|\/sys\/|\/proc\/)/.test(c),
  },

  // ── Shell-injection-via-network (curl|sh) ───────────────────────────────
  {
    rule: "curl-pipe-shell",
    reason: "Piping remote content into a shell (remote code execution risk).",
    match: (c) => /\b(?:curl|wget|fetch)\b[^|;&]*\|\s*(?:sh|bash|zsh|dash|ksh|python|python3|perl|ruby)\b/.test(c),
  },
  {
    rule: "curl-pipe-shell-variant",
    reason: "Piping remote content into a shell (remote code execution risk).",
    match: (c) => /\b(?:sh|bash|zsh)\b[^|;&]*<\s*(?:\(\s*curl|\(\s*wget)/.test(c),
  },

  // ── SSH / auth tampering ────────────────────────────────────────────────
  {
    rule: "ssh-authorized-keys",
    reason: "Writing to SSH authorized_keys is forbidden.",
    match: (c) => /(?:>\s*|>>\s*)(?:~\/\.ssh\/authorized_keys|\$HOME\/\.ssh\/authorized_keys)/.test(c),
  },

  // ── Process / system ────────────────────────────────────────────────────
  {
    rule: "kill-all",
    reason: "kill targeting all processes.",
    match: (c) => /\bkill\b[^|;&]*-9?\s+-\s*1\b/.test(c),
  },
  {
    rule: "shutdown-reboot",
    reason: "System power control is forbidden.",
    match: (c) => /\b(?:shutdown|reboot|poweroff|halt|init\s+0|telinit)\b/.test(c),
  },

  // ── Git force-push to protected branches ────────────────────────────────
  {
    rule: "git-force-push-protected",
    reason: "Force-pushing to a protected branch (main/master/prod/release/trunk).",
    match: (c) => /git\s+push[^|;&]*(?:--force|--force-with-lease|\s-f\b)[^|;&]*(?:main|master|prod|release|trunk)\b/.test(c),
  },
];

// ── Heuristic rules ────────────────────────────────────────────────────────
const HEURISTICS: Rule[] = [
  {
    rule: "sudo",
    reason: "Privilege escalation via sudo.",
    match: (c) => /\bsudo\b/.test(c),
  },
  {
    rule: "global-install",
    reason: "Global package install pollutes the host environment.",
    match: (c) =>
      /\b(?:npm|pnpm)\s+(?:install|i|add)\s+(?:[^|;&]*\s)?(?:--global|-g)\b/.test(c) ||
      /\byarn\s+(?:global\s+add|add\s+[^|;&]*--global)\b/.test(c),
  },
  {
    rule: "pip-global-uninstall",
    reason: "Removing system packages.",
    match: (c) => /\b(?:pip|pip3)\s+uninstall\b/.test(c) || /\b(?:apt|apt-get|snap)\s+(?:remove|purge)\b/.test(c),
  },
  {
    rule: "recursive-broad-op",
    reason: "Recursive operation on a broad target — review before running.",
    match: (c) =>
      /(^|[\s])(?:rm|chmod|chown)\s+[^|;&]*-[a-zA-Z]*[rR][a-zA-Z]*\b/.test(c) &&
      /(?:\s|^)(?:\*(?:\.[a-zA-Z0-9]+)?|\.\*|\.(?:\s|$)|\$HOME|~)/.test(c),
  },
  {
    rule: "redirect-outside-workspace",
    reason: "Output redirect to an absolute path that may be outside the workspace.",
    match: (c) => /(?:>\s*|>>\s*)\/(?:home|Users|tmp|root|opt|var|mnt|media)\//.test(c),
  },
  {
    rule: "command-substitution",
    reason: "Nested command substitution — possible injection vector.",
    match: (c) => /`[^`]*`/.test(c) || /\$\([^)]*\)/.test(c),
  },
];

function matchBlocklist(cmd: string): { rule: string; reason: string } | null {
  for (const r of BLOCKLIST) {
    if (r.match(cmd)) return { rule: r.rule, reason: r.reason };
  }
  return null;
}

function matchHeuristics(cmd: string): { rule: string; reason: string } | null {
  for (const r of HEURISTICS) {
    if (r.match(cmd)) return { rule: r.rule, reason: r.reason };
  }
  return null;
}
