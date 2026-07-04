/**
 * Host backend — unsandboxed subprocess execution (gated, dangerous).
 *
 * Only used when SOPHRON_ALLOW_HOST_BACKEND=1. Mirrors V2's subprocess fallback
 * but makes the danger explicit and opt-in (V2 fell back silently, which was a
 * footgun for autopilot).
 *
 * See docs/PHASE_1_DESIGN.md §2.4.
 */
import { spawnWithTimeout } from "./spawn.js";
import { log } from "../util/log.js";
import type { BackendName, ExecOptions, ExecResult, ExecutionBackend } from "./backend.js";

export class HostBackend implements ExecutionBackend {
  readonly name: BackendName = "host";

  async exec(opts: ExecOptions): Promise<ExecResult> {
    if (process.env["SOPHRON_ALLOW_HOST_BACKEND"] !== "1") {
      throw new Error(
        "Host backend requires SOPHRON_ALLOW_HOST_BACKEND=1 (unsandboxed execution).",
      );
    }
    const timeoutMs = opts.timeoutMs ?? 120_000;
    log.warn({ cmd: opts.command }, "HOST backend exec (unsandboxed)");

    const start = Date.now();
    const res = await spawnWithTimeout({
      command: "/bin/sh",
      args: ["-c", opts.command],
      cwd: opts.workspace,
      env: opts.env,
      timeoutMs,
    });
    return {
      exitCode: res.exitCode,
      stdout: res.stdout,
      stderr: res.stderr,
      output: res.output,
      durationMs: Date.now() - start,
      backend: this.name,
      timedOut: res.timedOut,
    };
  }
}
