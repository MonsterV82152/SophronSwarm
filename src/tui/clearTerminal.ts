/**
 * TTY buffer clear helper used by the TUI App when switching surfaces/projects.
 *
 * Keeps the ANSI escape sequence in one place and makes the guard testable in
 * isolation (the Ink test renderer supplies a fake stdout that is not a TTY).
 */
export function clearTerminal(stdout?: NodeJS.WriteStream) {
  const target = stdout ?? process.stdout;
  if (!target || typeof target.write !== "function") return;
  if ((target as unknown as { isTTY?: boolean }).isTTY !== true) return;
  // Erase display + scrollback buffer, then home cursor. This prevents earlier
  // TUI frames from remaining visible above or below the current render.
  target.write("\x1b[2J\x1b[3J\x1b[H");
}
