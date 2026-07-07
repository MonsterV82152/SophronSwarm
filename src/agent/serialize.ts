/**
 * Agent-definition serialization (shared by `propose_agent` + `propose_roster`).
 *
 * Converts a draft's fields into a `.md` file with YAML frontmatter followed by
 * the system-prompt body. The frontmatter matches what `AgentRegistry.parse()`
 * expects (see `src/agent/loader.ts`).
 *
 * Extracted from `propose_agent.ts` so the batch `propose_roster` tool can reuse
 * the exact same serialization logic (M6).
 */

export interface DraftFields {
  name: string;
  description: string;
  systemPrompt: string;
  tools?: unknown;
  model?: unknown;
  permissionMode: string;
  delegateAllowlist?: unknown;
  mcpServers?: unknown;
  maxTurns?: unknown;
}

/** Serialize the draft fields into a `.md` + YAML frontmatter string. */
export function serializeDraft(f: DraftFields): string {
  const fm: string[] = ["---"];
  fm.push(`name: ${yamlString(f.name)}`);
  fm.push(`description: ${yamlString(f.description)}`);
  if (Array.isArray(f.tools) && f.tools.length > 0) {
    fm.push("tools:");
    for (const t of f.tools) fm.push(`  - ${yamlString(String(t))}`);
  }
  if (typeof f.model === "string") fm.push(`model: ${yamlString(f.model)}`);
  else fm.push("model: inherit");
  fm.push(`permissionMode: ${yamlString(f.permissionMode)}`);
  if (Array.isArray(f.delegateAllowlist) && f.delegateAllowlist.length > 0) {
    fm.push("delegateAllowlist:");
    for (const t of f.delegateAllowlist) fm.push(`  - ${yamlString(String(t))}`);
  }
  if (Array.isArray(f.mcpServers) && f.mcpServers.length > 0) {
    fm.push("mcpServers:");
    for (const t of f.mcpServers) fm.push(`  - ${yamlString(String(t))}`);
  }
  if (typeof f.maxTurns === "number") fm.push(`maxTurns: ${f.maxTurns}`);
  fm.push("---");
  fm.push("");
  fm.push(f.systemPrompt.trim());
  return fm.join("\n") + "\n";
}

/** Minimal YAML string scalar (quotes if it contains special chars). */
export function yamlString(s: string): string {
  if (/[:#\[\]{}&*!|>'"%@`,"]/.test(s) || s.includes("\n")) {
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return s;
}
