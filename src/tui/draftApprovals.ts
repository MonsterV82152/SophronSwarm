/**
 * Global agent-draft approvals — operator-facing helpers for the TUI.
 *
 * While `AgentDraftStore` is per-project, the TUI needs a cross-project view
 * so the operator can approve/reject drafts from the global Home surface
 * without changing directories.
 *
 * Pure (reads/writes only). Never throws — errors are surfaced to the caller.
 */
import { resolve } from "node:path";
import { AgentDraftStore, type DraftEntry } from "../agent/drafts.js";
import { listProjects, type ProjectEntry } from "../project/registry.js";

/** A pending draft with the project it belongs to. */
export interface PendingDraftRef {
  projectName: string;
  projectPath: string;
  name: string;
  createdAt: string;
}

/** List every pending agent draft across all registered projects. */
export function listPendingDrafts(): PendingDraftRef[] {
  const out: PendingDraftRef[] = [];
  for (const project of listProjects()) {
    const store = new AgentDraftStore(project.path);
    for (const draft of store.pendingDrafts()) {
      out.push({
        projectName: project.name,
        projectPath: project.path,
        name: draft.name,
        createdAt: draft.createdAt,
      });
    }
  }
  return out;
}

/** Map project path → number of pending drafts. */
export function pendingDraftCountByProject(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const project of listProjects()) {
    const store = new AgentDraftStore(project.path);
    const pending = store.pendingDrafts().length;
    if (pending > 0) counts.set(project.path, pending);
  }
  return counts;
}

/** Resolve a project reference (name or absolute path) to a registered entry, if known. */
export function findProjectByNameOrPath(ref: string): ProjectEntry | undefined {
  const projects = listProjects();
  const byName = projects.find((p) => p.name === ref);
  if (byName) return byName;
  const abs = resolve(ref);
  return projects.find((p) => p.path === abs);
}

/** Approve a single draft by project + agent name. */
export function approveAgentDraft(projectPath: string, name: string): DraftEntry {
  return new AgentDraftStore(projectPath).approve(name);
}

/** Reject a single draft by project + agent name. */
export function rejectAgentDraft(projectPath: string, name: string): DraftEntry {
  return new AgentDraftStore(projectPath).reject(name);
}

export interface DraftResolutionBatch {
  projectName: string;
  projectPath: string;
  entries: DraftEntry[];
}

/** Approve all pending drafts, optionally scoped to one project. */
export function approveAllAgentDrafts(projectRef?: string): DraftResolutionBatch[] {
  return resolveAll((store) => store.approveAll(), projectRef);
}

/** Reject all pending drafts, optionally scoped to one project. */
export function rejectAllAgentDrafts(projectRef?: string): DraftResolutionBatch[] {
  return resolveAll((store) => store.rejectAll(), projectRef);
}

function resolveAll(
  resolveStore: (store: AgentDraftStore) => DraftEntry[],
  projectRef?: string,
): DraftResolutionBatch[] {
  if (projectRef) {
    const project = findProjectByNameOrPath(projectRef);
    const path = project?.path ?? resolve(projectRef);
    const store = new AgentDraftStore(path);
    const entries = resolveStore(store);
    return entries.length > 0 ? [{ projectName: project?.name ?? path, projectPath: path, entries }] : [];
  }

  const out: DraftResolutionBatch[] = [];
  for (const project of listProjects()) {
    const store = new AgentDraftStore(project.path);
    const entries = resolveStore(store);
    if (entries.length > 0) {
      out.push({ projectName: project.name, projectPath: project.path, entries });
    }
  }
  return out;
}
