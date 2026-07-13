/**
 * Bubblewrap backend — Linux namespace isolation (primary).
 *
 * `bwrap` runs the command in a new mount/user/PID/IPC namespace:
 *   - The workspace is bind-mounted read-write at its own path (so paths
 *     inside match the host).
 *   - System dirs (/usr, /lib, /bin, /sbin) are read-only.
 *   - /tmp is a private tmpfs.
 *   - Network is unshared by default (opt-in via opts.network).
 *
 * See docs/PHASE_1_DESIGN.md §2.2.
 */
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { spawnWithTimeout } from "./spawn.js";
import { log } from "../util/log.js";
import type { BackendName, ExecOptions, ExecResult, ExecutionBackend } from "./backend.js";

export class BubblewrapBackend implements ExecutionBackend {
  readonly name: BackendName = "bubblewrap";

  async exec(opts: ExecOptions): Promise<ExecResult> {
    const args = this.buildArgs(opts);
    const timeoutMs = opts.timeoutMs ?? 120_000;
    log.debug({ cmd: opts.command, network: opts.network ?? false, timeoutMs }, "bwrap exec");

    const start = Date.now();
    const res = await spawnWithTimeout({
      command: "bwrap",
      args,
      cwd: opts.workspace,
      // Pass a PATH that includes the operator's toolchains (node, cargo, etc.
      // often live in ~/.local/bin or /usr/local/bin, which the system ro-binds
      // don't always cover).
      env: { PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin", ...opts.env },
      timeoutMs,
      signal: opts.signal,
    });
    const durationMs = Date.now() - start;

    return {
      exitCode: res.exitCode,
      stdout: res.stdout,
      stderr: res.stderr,
      output: res.output,
      durationMs,
      backend: this.name,
      timedOut: res.timedOut,
    };
  }

  /** Build the bwrap argv. */
  private buildArgs(opts: ExecOptions): string[] {
    const { workspace, network } = opts;
    const args: string[] = [
      "--die-with-parent",
      "--unshare-user",
      "--unshare-pid",
      "--unshare-ipc",
      "--unshare-cgroup-try",
    ];

    if (!network) args.push("--unshare-net");

    // Standard mounts.
    // NOTE: `--tmpfs /tmp` is skipped when the workspace itself lives under
    // /tmp (otherwise the tmpfs would shadow the workspace bind). In that case
    // we bind the host /tmp read-write so the workspace subpath is writable
    // AND compilers/tools still get a working /tmp.
    if (workspace.startsWith("/tmp/")) {
      args.push("--proc", "/proc", "--dev", "/dev", "--bind-try", "/tmp", "/tmp");
    } else {
      args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp");
    }

    // Read-only system dirs. Use --ro-bind-try so missing paths don't error.
    // /usr, /lib, /lib64, /bin, /sbin cover all the binaries and shared libs.
    for (const dir of ["/usr", "/lib", "/lib64", "/bin", "/sbin"]) {
      if (existsSync(dir)) args.push("--ro-bind-try", dir, dir);
    }

    // /etc: bind read-only (safe — agents rarely need to write here).
    if (existsSync("/etc")) {
      args.push("--ro-bind-try", "/etc", "/etc");
    }

    // Operator toolchains: node/cargo/go/rust often live under $HOME (e.g.
    // ~/.local/bin, ~/.cargo/bin) when installed without root. Bind the whole
    // home dir read-only so those paths resolve. The workspace bind (later,
    // read-write) takes precedence for the workspace subpath.
    const home = homedir();
    if (home && home !== "/" && existsSync(home)) {
      args.push("--ro-bind-try", home, home);
    }
    // /usr/local is a common install prefix too.
    if (existsSync("/usr/local")) {
      args.push("--ro-bind-try", "/usr/local", "/usr/local");
    }

    // Workspace's parent: bind read-only FIRST so that the workspace's own
    // read-write bind (added next) layers on top and wins for its subpath.
    // bwrap applies mounts in declaration order; later mounts shadow earlier
    // ones, so the order here is load-bearing.
    //
    // SKIP when the parent is already covered by an earlier mount (e.g. when
    // the workspace is under /tmp and we bound /tmp read-write above) — a
    // later read-only parent bind would shadow the writable one.
    const parent = dirname(workspace);
    const parentAlreadyMounted =
      workspace.startsWith("/tmp/") ||
      ["/usr", "/lib", "/lib64", "/bin", "/sbin", "/etc"].some((d) => workspace.startsWith(d + "/"));
    if (
      !parentAlreadyMounted &&
      parent !== "/" &&
      parent !== workspace &&
      existsSync(parent)
    ) {
      args.push("--ro-bind-try", parent, parent);
    }

    // Workspace: read-write, bind at its own path so paths match the host.
    // For /tmp/<ws> workspaces the earlier /tmp bind already makes this
    // writable, but a dedicated bind is harmless and keeps path semantics
    // identical across host and sandbox.
    if (!workspace.startsWith("/tmp/")) {
      args.push("--bind", workspace, workspace);
    }

    // Finally, the shell command.
    args.push("--chdir", workspace, "--", "/bin/sh", "-c", opts.command);
    return args;
  }
}
