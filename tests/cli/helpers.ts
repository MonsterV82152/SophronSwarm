/**
 * Shared helper for CLI smoke tests.
 *
 * Runs `runCli(argv)` inside a temp HOME (and optionally a temp cwd),
 * captures stdout/stderr, and returns the resulting exit code.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _resetProviderCacheForTests } from "../../src/llm/providers.js";
import { runCli } from "../../src/cli.js";

export interface CliResult {
  exitCode: number | undefined;
  stdout: string;
  stderr: string;
  home: string;
}

export interface RunCliOptions {
  /** If true, chdir to a temp directory before running and restore after. */
  tempCwd?: boolean;
  /** If set, chdir to this directory before running and restore after. */
  cwd?: string;
}

export async function runCliWithHome(argv: string[], opts: RunCliOptions = {}): Promise<CliResult> {
  const tempHome = mkdtempSync(join(tmpdir(), "sophron-cli-"));
  return runCliAtHome(tempHome, argv, opts);
}

export async function runCliAtHome(home: string, argv: string[], opts: RunCliOptions = {}): Promise<CliResult> {
  const origHome = process.env.HOME;
  const origCwd = process.cwd();

  let activeCwd = process.cwd();
  let tempCwd: string | undefined;
  if (opts.cwd) {
    activeCwd = opts.cwd;
  } else if (opts.tempCwd) {
    tempCwd = mkdtempSync(join(tmpdir(), "sophron-cwd-"));
    activeCwd = tempCwd;
  }

  const origCwdFn = process.cwd;
  process.cwd = () => activeCwd;

  process.env.HOME = home;
  _resetProviderCacheForTests();

  const stdout: string[] = [];
  const stderr: string[] = [];

  const origLog = console.log;
  const origError = console.error;
  const origWarn = console.warn;

  console.log = (...args: unknown[]) => {
    stdout.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
  };
  console.error = (...args: unknown[]) => {
    stderr.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
  };
  console.warn = (...args: unknown[]) => {
    stderr.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
  };

  const prevExitCode = process.exitCode;
  process.exitCode = undefined;

  // runCli expects a process.argv-style array; prepend dummy executable/script.
  const fullArgv = argv[0] === "node" ? argv : ["node", "sophron", ...argv];
  try {
    await runCli(fullArgv);
  } catch (e) {
    stderr.push(`Unhandled error: ${(e as Error).message}`);
    if (process.exitCode === undefined) process.exitCode = 1;
  } finally {
    console.log = origLog;
    console.error = origError;
    console.warn = origWarn;

    const exitCode = process.exitCode;
    process.exitCode = prevExitCode;

    process.env.HOME = origHome;
    process.cwd = origCwdFn;

    return {
      exitCode,
      stdout: stdout.join("\n"),
      stderr: stderr.join("\n"),
      home,
    };
  }
}

/** Create an `agents/` directory in the current cwd and write a test agent file. */
export function writeTestAgent(name: string, content: string): string {
  const agentsDir = resolve(process.cwd(), "agents");
  mkdirSync(agentsDir, { recursive: true });
  const filePath = join(agentsDir, `${name}.md`);
  // Minimal valid frontmatter if not provided.
  if (!content.includes("---")) {
    content = `---\nname: ${name}\ndescription: test\nmodel: qwen3.5:9b-thinking\nprovider: ollama\n---\n\n${content}`;
  }
  writeFileSync(filePath, content, "utf8");
  return filePath;
}
