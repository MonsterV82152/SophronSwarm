/**
 * Persist a model change to an agent's markdown definition file.
 *
 * Parses the YAML frontmatter, updates `model` and `provider`, and rewrites
 * the file. The agent registry's file watcher will pick up the change and
 * reload the agent on the next scan.
 */
import { readFileSync, writeFileSync } from "node:fs";
import matter from "gray-matter";
import type { ModelResolution } from "../llm/providers.js";

export function updateAgentModelFile(filePath: string, resolution: ModelResolution): void {
  const raw = readFileSync(filePath, "utf8");
  const parsed = matter(raw);
  parsed.data.model = resolution.model;
  if (resolution.provider) {
    parsed.data.provider = resolution.provider;
  } else {
    delete parsed.data.provider;
  }
  writeFileSync(filePath, matter.stringify(parsed.content, parsed.data), "utf8");
}
