/**
 * Interactive CLI prompts — minimal readline-based helpers for the
 * `sophron add-provider` (and similar) flows.
 *
 * Keeps zero dependencies beyond Node's built-in `readline/promises`. Each
 * prompt reads one line from stdin (TTY or piped). Validation re-prompts on a
 * bad answer; an empty answer with a default is accepted.
 *
 * All helpers operate on `process.stdin`/`process.stdout`. They are designed
 * for one-shot CLI subcommands (the process exits after the command), not for
 * the Ink TUI.
 */
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

/**
 * Prompt for a single line of text. Returns the trimmed answer, or `def` if
 * the user presses Enter on an empty line and a default is provided. When
 * `required` is true and no default is set, an empty answer re-prompts.
 */
export async function prompt(question: string, opts: { default?: string; required?: boolean } = {}): Promise<string> {
  const rl = readline.createInterface({ input, output, terminal: false });
  try {
    const suffix = opts.default !== undefined ? ` [${opts.default}]` : "";
    for (;;) {
      const answer = (await rl.question(`${question}${suffix}: `)).trim();
      if (answer) return answer;
      if (opts.default !== undefined) return opts.default;
      if (!opts.required) return "";
      // required with no default → re-prompt.
      output.write(chalkRed("  A value is required.\n"));
    }
  } finally {
    rl.close();
  }
}

/**
 * Prompt for a yes/no answer. Returns true for y/yes (case-insensitive),
 * false for n/no. An empty answer resolves to `def` (default true).
 */
export async function promptConfirm(question: string, def = true): Promise<boolean> {
  const rl = readline.createInterface({ input, output, terminal: false });
  try {
    const hint = def ? " [Y/n]" : " [y/N]";
    for (;;) {
      const answer = (await rl.question(`${question}${hint}: `)).trim().toLowerCase();
      if (!answer) return def;
      if (["y", "yes"].includes(answer)) return true;
      if (["n", "no"].includes(answer)) return false;
      output.write(chalkRed("  Please answer 'y' or 'n'.\n"));
    }
  } finally {
    rl.close();
  }
}

/**
 * Prompt for one of a fixed set of options. Re-prompts on an invalid choice.
 * A `default` is accepted on an empty answer.
 */
export async function promptSelect<T extends string>(
  question: string,
  options: readonly T[],
  opts: { default?: T; labels?: Partial<Record<T, string>> } = {},
): Promise<T> {
  const rl = readline.createInterface({ input, output, terminal: false });
  try {
    const optsList = options.map((o) => opts.labels?.[o] ?? o).join(", ");
    const suffix = opts.default !== undefined ? ` [${opts.default}]` : "";
    for (;;) {
      const answer = (await rl.question(`${question} (${optsList})${suffix}: `)).trim().toLowerCase();
      if (!answer && opts.default) return opts.default;
      const match = options.find((o) => o.toLowerCase() === answer);
      if (match) return match;
      output.write(chalkRed(`  Choose one of: ${optsList}.\n`));
    }
  } finally {
    rl.close();
  }
}

/**
 * Prompt for a secret (e.g. an API key). Returns the trimmed value, `def` on an
 * empty answer, or null if neither is provided.
 *
 * NOTE: in this readline mode the typed text IS echoed (we don't control the
 * TTY echo flag portably). We therefore encourage storing an env-var reference
 * like `${OPENROUTER_API_KEY}` rather than a literal key; that reference is
 * expanded at load time by `expandEnv()` and keeps the secret out of the
 * config file. Callers should surface this hint.
 */
export async function promptSecret(question: string, opts: { default?: string } = {}): Promise<string | null> {
  const rl = readline.createInterface({ input, output, terminal: false });
  try {
    const hint = opts.default !== undefined ? ` [${opts.default}]` : "";
    const answer = (await rl.question(`${question}${hint}: `)).trim();
    if (answer) return answer;
    if (opts.default !== undefined) return opts.default;
    return null;
  } finally {
    rl.close();
  }
}

// Minimal red-color helper (avoids a chalk dependency in this util — the CLI
// layer already uses chalk, but this module stays dependency-light).
function chalkRed(s: string): string {
  return `\x1b[31m${s}\x1b[0m`;
}
