/**
 * Shared spawn-with-timeout helper used by all backends.
 *
 * Returns combined stdout+stderr, exit code, and a timedOut flag. Uses
 * AbortController (Node 22 supports `signal` on spawn) for the timeout.
 */
import { spawn } from "node:child_process";
import { log } from "../util/log.js";

export interface SpawnOpts {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  timeoutMs: number;
  /** Optional external abort signal (e.g. for cancellation). */
  signal?: AbortSignal;
}

export interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  output: string;
  timedOut: boolean;
}

export function spawnWithTimeout(opts: SpawnOpts): Promise<SpawnResult> {
  return new Promise((resolve) => {
    let timedOut = false;
    let settled = false;

    const finish = (result: Omit<SpawnResult, "timedOut">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, timedOut });
    };

    const controller = new AbortController();
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* already dead */
      }
      log.warn({ cmd: opts.command, timeoutMs: opts.timeoutMs }, "command timed out");
    }, opts.timeoutMs);

    // If an external signal fires, propagate.
    opts.signal?.addEventListener("abort", () => controller.abort(), { once: true });

    const child = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      signal: controller.signal,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });

    child.on("error", (err) => {
      // Spawn-level error (binary missing, etc). Distinguish from exit non-zero.
      const name = (err as NodeJS.ErrnoException).code ?? "SPAWN_ERROR";
      finish({
        exitCode: 127,
        stdout,
        stderr: stderr + `${name}: ${err.message}`,
        output: stdout + stderr + `${name}: ${err.message}`,
      });
    });

    child.on("close", (code) => {
      finish({ exitCode: code ?? 0, stdout, stderr, output: stdout + stderr });
    });
  });
}
