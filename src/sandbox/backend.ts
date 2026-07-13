/**
 * Execution-backend contract + factory.
 *
 * Three backends:
 *   - bubblewrap (default): Linux namespace isolation, fast, no daemon.
 *   - docker (opt-in):      full container isolation for untrusted/heavy work.
 *   - host (gated):         unsandboxed; only when SOPHRON_ALLOW_HOST_BACKEND=1.
 *
 * See docs/PHASE_1_DESIGN.md §2.1.
 */
import { BubblewrapBackend } from "./bubblewrap.js";
import { DockerBackend } from "./docker.js";
import { HostBackend } from "./host.js";
import { log } from "../util/log.js";

export type BackendName = "bubblewrap" | "docker" | "host";

export interface ExecOptions {
  /** Shell command string to execute. */
  command: string;
  /** Absolute path the command runs in (bind-mounted as read-write). */
  workspace: string;
  /** Allow network access (default false → unshare-net). */
  network?: boolean;
  /** Timeout in milliseconds (default 120_000). */
  timeoutMs?: number;
  /** Extra environment variables merged into the child's env. */
  env?: Record<string, string>;
  /** Optional external abort signal for cancellation. */
  signal?: AbortSignal;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Combined stdout+stderr (V2-compatible shape). */
  output: string;
  durationMs: number;
  backend: BackendName;
  timedOut: boolean;
}

export interface ExecutionBackend {
  readonly name: BackendName;
  exec(opts: ExecOptions): Promise<ExecResult>;
}

const DEFAULT_TIMEOUT_MS = 120_000;

const singletons = new Map<BackendName, ExecutionBackend>();

/**
 * Get a backend by name. `bubblewrap` is the default if name is omitted.
 * `host` is refused unless `SOPHRON_ALLOW_HOST_BACKEND=1` — this makes the
 * danger explicit and opt-in (V2's silent fallback was a footgun).
 */
export function getBackend(name?: BackendName): ExecutionBackend {
  const resolved: BackendName = name ?? "bubblewrap";

  if (resolved === "host" && process.env["SOPHRON_ALLOW_HOST_BACKEND"] !== "1") {
    throw new Error(
      "Host backend is gated. Set SOPHRON_ALLOW_HOST_BACKEND=1 to permit unsandboxed execution.",
    );
  }

  const cached = singletons.get(resolved);
  if (cached) return cached;

  let backend: ExecutionBackend;
  switch (resolved) {
    case "bubblewrap":
      backend = new BubblewrapBackend();
      break;
    case "docker":
      backend = new DockerBackend();
      break;
    case "host":
      backend = new HostBackend();
      break;
  }
  singletons.set(resolved, backend);
  log.debug({ backend: resolved }, "execution backend created");
  return backend;
}

export const DEFAULT_TIMEOUT = DEFAULT_TIMEOUT_MS;
