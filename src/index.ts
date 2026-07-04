#!/usr/bin/env node
/**
 * SophronSwarm V3 — CLI entry point.
 *
 * Phase 0: wires the agentic loop, tools, LLM client, checkpointer, and
 * recorder behind a `sophron` command with `run`, `agents`, and `replay`
 * subcommands.
 */
import { runCli } from "./cli.js";

runCli(process.argv).catch((e) => {
  // pino handles most logging; this is the last-resort top-level guard.
  console.error(`Unhandled error: ${e?.stack ?? e}`);
  process.exit(1);
});
