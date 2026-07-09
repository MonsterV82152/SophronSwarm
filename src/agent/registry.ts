/**
 * Agent registry — indexed collection of loaded AgentDefinitions with
 * hot-reload via chokidar.
 *
 * Scope precedence (highest first): project (agents/) > user (~/.sophron/agents/).
 * Same-name agent in a higher scope overrides lower.
 *
 * See docs/PHASE_0_DESIGN.md §3.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { log } from "../util/log.js";
import { loadAgentFile, type LoadAgentError } from "./loader.js";
import type { AgentDefinition } from "../types.js";

const SOFT_CAP = 12; // see §9.4 of PROJECT_OVERVIEW.md — warn (not block) above this

/** Agents that live in the user/global scope and should not appear in per-project rosters. */
export const GLOBAL_AGENT_NAMES = new Set(["global-orchestrator", "architect"]);

export interface ScanResult {
  agents: AgentDefinition[];
  errors: LoadAgentError[];
  /** True if the number of successfully loaded agents exceeds the soft cap. */
  overCap: boolean;
}

export class AgentRegistry {
  private byName = new Map<string, AgentDefinition>();
  private errors: LoadAgentError[] = [];
  private watcher?: FSWatcher;

  constructor(private readonly projectRoot: string = process.cwd()) {}

  /** Scan both scopes and index agents. Returns the result + errors. */
  scan(): ScanResult {
    this.byName.clear();
    this.errors = [];

    const dirs = this.scopeDirs();
    // Scan lowest priority first so higher scopes override.
    for (let i = dirs.length - 1; i >= 0; i--) {
      const { source, path } = dirs[i]!;
      if (!existsSync(path)) continue;
      this.scanDir(path, source);
    }

    const agents = [...this.byName.values()];
    const overCap = agents.length > SOFT_CAP;
    if (overCap) {
      log.warn({ count: agents.length, cap: SOFT_CAP }, `agent roster exceeds soft cap`);
    }
    return { agents, errors: this.errors, overCap };
  }

  /** All loaded agents. */
  list(): AgentDefinition[] {
    return [...this.byName.values()];
  }

  /** All loaded agents except user/global agents (for project-scoped views). */
  listProjectAgents(): AgentDefinition[] {
    return this.list().filter((a) => !(a.source === "user" && GLOBAL_AGENT_NAMES.has(a.name)));
  }

  get(name: string): AgentDefinition | undefined {
    return this.byName.get(name);
  }

  /** Directories to scan, highest priority first. */
  private scopeDirs(): { source: "project" | "user"; path: string }[] {
    return [
      { source: "project", path: join(this.projectRoot, "agents") },
      { source: "user", path: join(homedir(), ".sophron", "agents") },
    ];
  }

  private scanDir(dir: string, source: "project" | "user"): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const filePath = join(dir, entry);
      if (!statSync(filePath).isFile()) continue;
      const result = loadAgentFile({ source, filePath });
      if (result.ok) {
        // Only set if not already present (higher scope already won).
        if (!this.byName.has(result.agent.name)) {
          this.byName.set(result.agent.name, result.agent);
        }
      } else {
        this.errors.push(result);
        log.warn({ file: basename(filePath), error: result.error }, "agent load failed");
      }
    }
  }

  /**
   * Watch both scopes for changes and re-scan. Idempotent.
   * NOTE: chokidar only watches directories that exist when start() is called;
   * creating a scope's first agent in a brand-new agents/ dir needs a restart.
   */
  startWatch(): void {
    if (this.watcher) return;
    const paths = this.scopeDirs().map((d) => d.path).filter((p) => existsSync(p));
    if (paths.length === 0) return;

    this.watcher = chokidar.watch(paths, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    });
    const rescan = (label: string) => {
      log.info({ label }, "agent files changed; re-scanning");
      this.scan();
    };
    this.watcher.on("add", () => rescan("add"));
    this.watcher.on("change", () => rescan("change"));
    this.watcher.on("unlink", () => rescan("unlink"));
  }

  async stopWatch(): Promise<void> {
    if (this.watcher) await this.watcher.close();
    this.watcher = undefined;
  }
}
