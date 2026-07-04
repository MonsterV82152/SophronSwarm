/**
 * Docker backend — full container isolation (opt-in).
 *
 * Reuses V2's approach: throwaway container, workspace mounted at /workspace,
 * command run with /workspace as cwd. Auto-pulls missing images.
 *
 * See docs/PHASE_1_DESIGN.md §2.3.
 */
import { spawn } from "node:child_process";
import { log } from "../util/log.js";
import { spawnWithTimeout } from "./spawn.js";
import type { BackendName, ExecOptions, ExecResult, ExecutionBackend } from "./backend.js";

interface ImageSpec {
  image: string;
  /** Shell used to run the command (default: sh -c). */
  shell?: string;
}

/** Pick a Docker image for a command by quick heuristics. Callers can override. */
export function pickImage(command: string, override?: string): ImageSpec {
  if (override) return { image: override };
  if (/\bnpm\b|\bnode\b|\bnpx\b|\byarn\b|\bpnpm\b/.test(command)) {
    return { image: "node:22-slim" };
  }
  if (/\bcargo\b|\brustc\b/.test(command)) return { image: "rust:1-slim" };
  if (/\bgo\b\s+(build|test|run|mod)/.test(command)) return { image: "golang:1-alpine" };
  if (/\bpython\b|\bpip\b|\bpytest\b/.test(command)) return { image: "python:3.12-slim" };
  return { image: "ubuntu:24.04" };
}

/** Check (once) whether the docker daemon is reachable. */
let dockerAvailable: boolean | null = null;
export async function isDockerAvailable(): Promise<boolean> {
  if (dockerAvailable !== null) return dockerAvailable;
  dockerAvailable = await new Promise<boolean>((resolve) => {
    const child = spawn("docker", ["version", "--format", "{{.Server.Version}}"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
  return dockerAvailable;
}

export class DockerBackend implements ExecutionBackend {
  readonly name: BackendName = "docker";

  async exec(opts: ExecOptions): Promise<ExecResult> {
    const timeoutMs = opts.timeoutMs ?? 120_000;
    const spec = pickImage(opts.command);

    // Try to run; if image missing, pull and retry once.
    const start = Date.now();
    let res = await this.runContainer(spec.image, opts, timeoutMs);
    if (res.exitCode === 127 && /Unable to find image|manifest unknown|no such image/i.test(res.output)) {
      log.info({ image: spec.image }, "docker image missing; pulling");
      const pullOk = await this.pullImage(spec.image);
      if (pullOk) res = await this.runContainer(spec.image, opts, timeoutMs);
    }

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

  private async runContainer(image: string, opts: ExecOptions, timeoutMs: number) {
    return spawnWithTimeout({
      command: "docker",
      args: [
        "run", "--rm",
        ...(opts.network ? [] : ["--network", "none"]),
        "-v", `${opts.workspace}:/workspace`,
        "-w", "/workspace",
        "--", image, "/bin/sh", "-c", opts.command,
      ],
      cwd: opts.workspace,
      env: opts.env,
      timeoutMs,
    });
  }

  private async pullImage(image: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const child = spawn("docker", ["pull", image], { stdio: ["ignore", "pipe", "pipe"] });
      child.on("error", () => resolve(false));
      child.on("close", (code) => resolve(code === 0));
    });
  }
}
