/**
 * MCP connection pool — one long-lived Client per configured server.
 *
 * SwarmClaw's key MCP optimization: keep one connection per server alive across
 * turns instead of spawning a fresh subprocess / opening a fresh HTTP session
 * per turn (saves 100–500 ms × servers × turns). Connections are lazy — the
 * first `getOrConnect(name)` call spawns the process / opens the session.
 *
 * Wraps the official `@modelcontextprotocol/sdk` Client + transports (v1.x).
 *
 * See docs/PHASE_4_DESIGN.md §3.2.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { log } from "../util/log.js";
import type { McpServerConfig } from "./config.js";

const CLIENT_INFO = { name: "sophronswarm", version: "0.1.0" };
const CLIENT_CAPABILITIES = {};

export interface ConnectedServer {
  config: McpServerConfig;
  client: Client;
}

/**
 * A pool of MCP server connections, keyed by server name. Lazy-connects on first
 * use; caches the connected Client for the process lifetime. Safe to call
 * `getOrConnect` repeatedly for the same server.
 */
export class McpConnectionPool {
  private connections = new Map<string, ConnectedServer>();
  private connecting = new Map<string, Promise<ConnectedServer>>();
  /** Servers this pool is permitted to connect to (the agent-scoped config). */
  private allowed = new Map<string, McpServerConfig>();

  constructor(servers: McpServerConfig[] = []) {
    for (const s of servers) this.allowed.set(s.name, s);
  }

  /** Add (or replace) a server config the pool may connect to. */
  registerServer(config: McpServerConfig): void {
    this.allowed.set(config.name, config);
  }

  /** All server configs the pool currently knows about. */
  configuredServers(): McpServerConfig[] {
    return [...this.allowed.values()];
  }

  /** Is `name` a registered server config? */
  canConnect(name: string): boolean {
    return this.allowed.has(name);
  }

  /**
   * Get (lazily connecting) the Client for a named server. Concurrent calls for
   * the same server share a single in-flight connect promise. Throws on failure
   * (caller surfaces to the agent as an isError tool result).
   */
  async getOrConnect(name: string): Promise<ConnectedServer> {
    const existing = this.connections.get(name);
    if (existing) return existing;

    const inflight = this.connecting.get(name);
    if (inflight) return inflight;

    const cfg = this.allowed.get(name);
    if (!cfg) {
      throw new Error(`MCP server '${name}' is not configured for this agent`);
    }

    const p = this.doConnect(cfg)
      .then((conn) => {
        this.connections.set(name, conn);
        this.connecting.delete(name);
        log.info({ server: name, transport: cfg.transport }, "mcp connected");
        return conn;
      })
      .catch((e) => {
        this.connecting.delete(name);
        throw e;
      });
    this.connecting.set(name, p);
    return p;
  }

  /** Build the transport + initialize the Client for a server config. */
  private async doConnect(cfg: McpServerConfig): Promise<ConnectedServer> {
    const transport =
      cfg.transport === "stdio"
        ? new StdioClientTransport({
            command: cfg.command!,
            args: cfg.args ?? [],
            env: cfg.env as Record<string, string> | undefined,
            cwd: cfg.cwd,
          })
        : new StreamableHTTPClientTransport(new URL(cfg.url!), {
            requestInit: cfg.headers ? { headers: cfg.headers } : undefined,
          });

    const client = new Client(CLIENT_INFO, CLIENT_CAPABILITIES);
    await client.connect(transport);
    return { config: cfg, client };
  }

  /** Close a single server connection (if any). */
  async close(name: string): Promise<void> {
    const conn = this.connections.get(name);
    if (!conn) return;
    this.connections.delete(name);
    await this.safeClose(conn);
  }

  /** Close all open connections. Call on process exit. */
  async closeAll(): Promise<void> {
    const conns = [...this.connections.values()];
    this.connections.clear();
    await Promise.all(conns.map((c) => this.safeClose(c)));
  }

  private async safeClose(conn: ConnectedServer): Promise<void> {
    try {
      await conn.client.close();
    } catch (e) {
      log.warn({ server: conn.config.name, err: (e as Error).message }, "mcp close failed");
    }
  }

  /** Number of currently-open connections (for diagnostics / cost meter). */
  get openCount(): number {
    return this.connections.size;
  }
}
