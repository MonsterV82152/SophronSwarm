/**
 * TUI launcher — bridges the CLI (a .ts file, no JSX) to the Ink App (.tsx).
 *
 * Keeping JSX in a .tsx module avoids the NodeNext/JSX resolution quirk where
 * a .ts file can't contain JSX. The CLI calls this; it renders the App and
 * waits for exit.
 */
import React from "react";
import { render } from "ink";
import { App } from "./app.js";
import type { SharedServices } from "../tools/schema.js";
import type { AgentRegistry } from "../agent/registry.js";

export interface LaunchOptions {
  services: SharedServices;
  workspaceDir: string;
  /** The registry bound to the current project (for teardown on switch). */
  registry: AgentRegistry;
}

export async function launchTui(opts: LaunchOptions): Promise<void> {
  // Use the approvals queue constructed in buildServices so the gate + TUI share state.
  const { waitUntilExit } = render(
    <App
      services={opts.services}
      workspaceDir={opts.workspaceDir}
      approvals={opts.services.approvals}
      registry={opts.registry}
    />,
  );
  await waitUntilExit();
}
