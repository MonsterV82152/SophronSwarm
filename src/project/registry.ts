/**
 * Project registry — tracks known SophronSwarm projects.
 *
 * A TUI session holds an `activeProject` and can switch between multiple
 * projects. This module persists the list of known projects to
 * `~/.sophron/projects.json` so they survive across sessions.
 *
 * Each entry: { name, path, lastOpened, pinned }. Auto-populated whenever
 * `sophron` runs in a directory (first-seen). `name` is an operator-chosen
 * alias (defaults to the directory basename). Entries are editable.
 *
 * See docs/IDEAS.md (#2) + docs/ROADMAP.md (M3).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { log } from "../util/log.js";

/** A registered project. */
export interface ProjectEntry {
  /** Operator-chosen alias (defaults to directory basename). */
  name: string;
  /** Absolute path to the project root. */
  path: string;
  /** Unix ms timestamp of last open (for recency sorting). */
  lastOpened: number;
  /** Pinned projects appear at the top of the list. */
  pinned?: boolean;
}

interface ProjectRegistryFile {
  projects: ProjectEntry[];
  /** Schema version for future migrations. */
  version: 1;
}

/** Where the registry lives on disk. */
export function registryPath(): string {
  return join(homedir(), ".sophron", "projects.json");
}

/**
 * Load the project registry. Returns an empty list if the file doesn't exist
 * or is unreadable (degrades gracefully — never throws).
 */
export function loadRegistry(): ProjectEntry[] {
  const path = registryPath();
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as ProjectRegistryFile | ProjectEntry[];
    // Tolerate both {projects:[]} and bare [] shapes.
    if (Array.isArray(raw)) return raw;
    return raw.projects ?? [];
  } catch (e) {
    log.warn({ err: e, path }, "could not parse project registry; ignoring");
    return [];
  }
}

/** Save the registry to disk (atomic via rename). Creates the dir if needed. */
export function saveRegistry(projects: ProjectEntry[]): void {
  const path = registryPath();
  const dir = join(homedir(), ".sophron");
  mkdirSync(dir, { recursive: true });
  const data: ProjectRegistryFile = { projects, version: 1 };
  // Atomic write: temp file + rename to avoid partial writes on crash.
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  renameSync(tmp, path);
}

/**
 * Register a project (first-seen) or update its lastOpened timestamp
 * (subsequent opens). If a project with the same `path` exists, it's updated;
 * otherwise a new entry is added. Returns the resulting entry.
 *
 * `name` is optional — defaults to the basename of `absPath`. If a name
 * collision occurs (different path, same name), a numeric suffix is appended.
 */
export function registerProject(absPath: string, name?: string): ProjectEntry {
  const projects = loadRegistry();
  const existing = projects.find((p) => p.path === absPath);
  const now = Date.now();

  if (existing) {
    existing.lastOpened = now;
    if (name) existing.name = name;
    saveRegistry(projects);
    log.debug({ project: existing.name, path: absPath }, "project re-opened");
    return existing;
  }

  // New project — derive a unique name.
  const finalName = name ?? uniqueName(basename(absPath) || absPath, projects);
  const entry: ProjectEntry = { name: finalName, path: absPath, lastOpened: now };
  projects.push(entry);
  saveRegistry(projects);
  log.info({ project: finalName, path: absPath }, "project registered");
  return entry;
}

/**
 * Rename a project's alias. Throws if the project (by path) isn't registered
 * or if the new name collides with an existing entry.
 */
export function renameProject(absPath: string, newName: string): ProjectEntry {
  const projects = loadRegistry();
  const entry = projects.find((p) => p.path === absPath);
  if (!entry) throw new Error(`Project not registered: ${absPath}`);
  const collision = projects.find((p) => p.name === newName && p.path !== absPath);
  if (collision) throw new Error(`Name '${newName}' is already used by another project (${collision.path})`);
  entry.name = newName;
  saveRegistry(projects);
  return entry;
}

/** Remove a project from the registry (by path). No-op if not found. */
export function removeProject(absPath: string): boolean {
  const projects = loadRegistry();
  const before = projects.length;
  const filtered = projects.filter((p) => p.path !== absPath);
  if (filtered.length === before) return false;
  saveRegistry(filtered);
  return true;
}

/** Toggle a project's pinned status. */
export function togglePin(absPath: string): ProjectEntry | undefined {
  const projects = loadRegistry();
  const entry = projects.find((p) => p.path === absPath);
  if (!entry) return undefined;
  entry.pinned = !entry.pinned;
  saveRegistry(projects);
  return entry;
}

/**
 * List projects sorted for display: pinned first, then by lastOpened descending.
 */
export function listProjects(): ProjectEntry[] {
  const projects = loadRegistry();
  return projects.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.lastOpened - a.lastOpened;
  });
}

/** Find a project by name (case-insensitive). */
export function findByName(name: string): ProjectEntry | undefined {
  return loadRegistry().find((p) => p.name.toLowerCase() === name.toLowerCase());
}

/** Derive a name that doesn't collide with existing entries. */
function uniqueName(base: string, existing: ProjectEntry[]): string {
  const taken = new Set(existing.map((p) => p.name));
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}
