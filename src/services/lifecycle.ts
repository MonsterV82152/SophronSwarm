/**
 * SharedServices lifecycle — build, teardown, switch.
 *
 * Extracted from cli.ts so the TUI can rebuild services when switching
 * projects (M3). A services instance binds to a single working directory
 * (checkpointer DB path, memory stores, MCP pool); switching projects means
 * tearing down the old instance and building a new one.
 *
 * Teardown is always safe — every component has a close()/closeAll()/stopWatch():
 *   - Checkpointer.close()        (better-sqlite3, WAL)
 *   - McpConnectionPool.closeAll() (stdio subprocesses / HTTP sessions)
 *   - AgentRegistry.stopWatch()    (chokidar file watcher)
 *
 * See docs/ROADMAP.md (M3).
 */
import { resolve } from "node:path";
import { log } from "../util/log.js";
import { LLMClient } from "../llm/client.js";
import { ToolRegistry } from "../tools/registry.js";
import { ToolDispatcher } from "../tools/dispatcher.js";
import { BUILTIN_TOOLS } from "../tools/builtin/index.js";
import { Purifier } from "../tools/purifier.js";
import { Checkpointer } from "../state/checkpointer.js";
import { AgentRegistry } from "../agent/registry.js";
import { SharedMemoryStore, SHARED_DIR_NAME } from "../memory/sharedStore.js";
import { AgentMemoryStore, AGENT_MEMORY_DIR_NAME } from "../memory/agentStore.js";
import { loadGlobalConfig } from "../mcp/config.js";
import { McpConnectionPool } from "../mcp/pool.js";
import { McpToolCatalog } from "../mcp/catalog.js";
import { TokenCostMeter } from "../mcp/costMeter.js";
import { ApprovalsQueue } from "../tui/approvals.js";
import { LlmAutoModeClassifier, AutoPermissionGate } from "../agent/autoGate.js";
import type { SharedServices } from "../tools/schema.js";

/**
 * Build a fresh SharedServices instance bound to `workingDir`.
 * The caller is responsible for calling closeServices() when done (or before
 * rebuilding on a project switch).
 */
export function buildServices(workingDir: string, registry: AgentRegistry, approvals?: ApprovalsQueue): SharedServices {
  const toolRegistry = new ToolRegistry();
  for (const t of BUILTIN_TOOLS) toolRegistry.register(t);
  const llm = new LLMClient();
  const approvalsQueue = approvals ?? new ApprovalsQueue();
  const classifier = new LlmAutoModeClassifier(llm);
  const dispatcher = new ToolDispatcher(toolRegistry, new AutoPermissionGate(classifier, approvalsQueue));
  const checkpointer = new Checkpointer(resolve(workingDir, ".sophron", "checkpoint.db"));
  const sharedMemoryStore = new SharedMemoryStore(resolve(workingDir, SHARED_DIR_NAME));
  const agentMemoryStore = new AgentMemoryStore(resolve(workingDir, AGENT_MEMORY_DIR_NAME));

  // MCP: load global config + register every server's config with the pool.
  // Per-agent scoping happens at run time (the agent's mcpServers frontmatter
  // is resolved against the pool's configured servers).
  const mcpConfig = loadGlobalConfig(workingDir);
  const mcpPool = new McpConnectionPool(mcpConfig.servers);
  const mcpCatalog = new McpToolCatalog(mcpPool);
  const mcpCostMeter = new TokenCostMeter();
  const purifier = new Purifier({ llm });

  return {
    llm,
    agentRegistry: registry,
    toolRegistry,
    dispatcher,
    checkpointer,
    sharedMemoryStore,
    agentMemoryStore,
    mcpPool,
    mcpCatalog,
    mcpCostMeter,
    approvals: approvalsQueue,
    purifier,
  };
}

/**
 * Tear down a SharedServices instance: close the DB, MCP connections, and the
 * file watcher. Safe to call on a partially-constructed instance (each close
 * is individually guarded). Never throws.
 */
export async function closeServices(services: SharedServices, registry?: AgentRegistry): Promise<void> {
  await services.mcpPool.closeAll().catch((e) => log.warn({ err: e }, "error closing MCP pool during teardown"));
  services.checkpointer.close();
  if (registry) await registry.stopWatch().catch((e) => log.warn({ err: e }, "error stopping watcher during teardown"));
}

/**
 * Switch to a new project: tear down the old services and build fresh ones
 * bound to the new working directory. Returns the new services + registry.
 *
 * The registry is rebuilt (not reused) because it watches a different agents/
 * directory per project.
 */
export async function switchServices(
  oldServices: SharedServices,
  oldRegistry: AgentRegistry,
  newWorkingDir: string,
): Promise<{ services: SharedServices; registry: AgentRegistry }> {
  await closeServices(oldServices, oldRegistry);
  const registry = new AgentRegistry(newWorkingDir);
  registry.scan();
  registry.startWatch();
  const services = buildServices(newWorkingDir, registry);
  log.info({ dir: newWorkingDir }, "switched project services");
  return { services, registry };
}
