/**
 * Built-in tools: echo, read_file, write_file, list_dir, run_command,
 * apply_patch, delegate, remember, advance_checkpoint, mcp_tool_search, propose_agent.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, relative, join } from "node:path";
import type { ToolSpec } from "../schema.js";
import { safeResolve } from "./paths.js";
import { run_command } from "./run_command.js";
import { apply_patch } from "./apply_patch.js";
import { delegate } from "./delegate.js";
import { remember } from "./remember.js";
import { advance_checkpoint } from "./advance_checkpoint.js";
import { mcp_tool_search } from "./mcp_tool_search.js";
import { propose_agent } from "./propose_agent.js";

function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string") throw new Error(`Missing or non-string argument '${key}'`);
  return v;
}

export const echo: ToolSpec = {
  name: "echo",
  description: "Echo back the provided text. Useful for testing the tool loop end-to-end.",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "The text to echo back." },
    },
    required: ["text"],
  },
  handler: ({ args }) => requireString(args, "text"),
};

export const read_file: ToolSpec = {
  name: "read_file",
  description: "Read a file's contents from the workspace. Path is workspace-relative.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative file path." },
    },
    required: ["path"],
  },
  handler: ({ args, state }) => {
    const abs = safeResolve(state.workingDir, requireString(args, "path"));
    if (!existsSync(abs)) return "(file does not exist on disk)";
    const content = readFileSync(abs, "utf8");
    return content;
  },
};

export const write_file: ToolSpec = {
  name: "write_file",
  description: "Write text to a workspace-relative file. Creates parent directories.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative file path." },
      content: { type: "string", description: "Full file content to write." },
    },
    required: ["path", "content"],
  },
  handler: ({ args, state }) => {
    const abs = safeResolve(state.workingDir, requireString(args, "path"));
    const content = requireString(args, "content");
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
    return `Wrote ${content.length} chars to ${relative(state.workingDir, abs) || "."}`;
  },
};

export const list_dir: ToolSpec = {
  name: "list_dir",
  description: "List entries in a workspace-relative directory. Returns name + type per entry.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative directory (default: workspace root)." },
    },
    required: [],
  },
  handler: ({ args, state }) => {
    const rel = typeof args["path"] === "string" ? args["path"] : ".";
    const abs = safeResolve(state.workingDir, rel);
    if (!existsSync(abs)) return "(directory does not exist on disk)";
    const entries = readdirSync(abs).map((name) => {
      const full = join(abs, name);
      let kind = "file";
      try {
        kind = statSync(full).isDirectory() ? "directory" : "file";
      } catch {
        /* broken symlink etc — keep 'file' */
      }
      return { name, kind };
    });
    return JSON.stringify(entries, null, 2);
  },
};

export const BUILTIN_TOOLS: ToolSpec[] = [echo, read_file, write_file, list_dir, run_command, apply_patch, delegate, remember, advance_checkpoint, mcp_tool_search, propose_agent];
