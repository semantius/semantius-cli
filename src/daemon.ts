/**
 * semantius Daemon - Background worker that keeps a connection open across
 * CLI invocations
 *
 * This is spawned as a detached process and manages a Unix socket for IPC.
 * It runs in one of two modes, chosen by its config:
 * - an MCP server config: it holds the MCP session and forwards listTools /
 *   callTool frames from CLI invocations to it;
 * - a PostgrestProxyConfig: it is an HTTP pass-through to one PostgREST
 *   origin, so the local crud layer's requests reuse its open TLS connection
 *   (see postgrest-proxy.ts). It holds no credentials: each request brings
 *   its own Authorization header.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import {
  type ConnectedClient,
  callTool,
  connectToServer,
  listTools,
} from './client.js';
import {
  type ServerConfig,
  debug,
  getConfigHash,
  getDaemonTimeoutMs,
  getPidPath,
  getSocketDir,
  getSocketPath,
} from './config.js';
import { enableFromEnv, logDaemonEvent } from './logger.js';

// ============================================================================
// Types
// ============================================================================

/** A daemon that passes HTTP requests through to one PostgREST origin. */
export interface PostgrestProxyConfig {
  postgrestProxy: string;
}

export type DaemonConfig = ServerConfig | PostgrestProxyConfig;

export function isPostgrestProxyConfig(
  config: DaemonConfig,
): config is PostgrestProxyConfig {
  return 'postgrestProxy' in config;
}

/**
 * The environment variable that hands a spawned daemon its config. Not argv:
 * an HTTP server's config carries its bearer, and any user on the machine can
 * read another's command line (/proc/<pid>/cmdline), but not its environment.
 */
export const DAEMON_CONFIG_ENV = 'SEMANTIUS_DAEMON_CONFIG';

/**
 * Set on the 502 a proxy daemon answers when the upstream request itself
 * failed (DNS, TLS, connection refused), carrying the URI-encoded error
 * message: the client rethrows it, so the failure reads as the network error
 * it is rather than as an HTTP status from the server.
 */
export const PROXY_ERROR_HEADER = 'x-semantius-proxy-error';

export interface DaemonRequest {
  id: string;
  type: 'listTools' | 'callTool' | 'ping' | 'close' | 'getInstructions';
  toolName?: string;
  args?: Record<string, unknown>;
}

export interface DaemonResponse {
  id: string;
  success: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

interface PidFileContent {
  pid: number;
  configHash: string;
  startedAt: string;
}

// ============================================================================
// PID File Management
// ============================================================================

/**
 * Claim the server's PID file for this process, with the config hash for
 * stale detection. The file is created exclusively, so of two daemons started
 * at once for the same server only one runs; the other gets false and exits.
 * A file left by a process that is no longer running is taken over.
 */
export function claimPidFile(serverName: string, configHash: string): boolean {
  const pidPath = getPidPath(serverName);
  const dir = dirname(pidPath);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const content: PidFileContent = {
    pid: process.pid,
    configHash,
    startedAt: new Date().toISOString(),
  };
  const text = JSON.stringify(content);

  try {
    writeFileSync(pidPath, text, { mode: 0o600, flag: 'wx' });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const holder = readPidFile(serverName);
  if (holder && holder.pid !== process.pid && isProcessRunning(holder.pid)) {
    return false;
  }
  writeFileSync(pidPath, text, { mode: 0o600 });
  return true;
}

/**
 * Read PID file content
 */
export function readPidFile(serverName: string): PidFileContent | null {
  const pidPath = getPidPath(serverName);

  if (!existsSync(pidPath)) {
    return null;
  }

  try {
    const content = readFileSync(pidPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Remove PID file
 */
export function removePidFile(serverName: string): void {
  const pidPath = getPidPath(serverName);
  try {
    if (existsSync(pidPath)) {
      unlinkSync(pidPath);
    }
  } catch {
    // Ignore errors during cleanup
  }
}

/**
 * Remove one daemon's socket file
 */
export function removeSocketFile(serverName: string, pid: number): void {
  const socketPath = getSocketPath(serverName, pid);
  try {
    if (existsSync(socketPath)) {
      unlinkSync(socketPath);
    }
  } catch {
    // Ignore errors during cleanup
  }
}

/**
 * Check if a process is running
 */
export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Kill a process by PID
 */
export function killProcess(pid: number): boolean {
  try {
    process.kill(pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Socket framing
// ============================================================================

/**
 * The daemon socket carries newline-delimited JSON: one document per frame,
 * terminated by '\n'. JSON.stringify never emits a raw newline (it escapes
 * them), so byte 0x0A is an unambiguous terminator, and scanning bytes rather
 * than decoded text keeps multi-byte UTF-8 sequences intact when a frame
 * spans several socket reads. Without this, any request or response larger
 * than a single read (~64 KB) was parsed chunk-by-chunk and failed.
 */
export interface LineReader {
  /** Feed one socket chunk; returns every complete frame it finished. */
  push(chunk: Uint8Array): string[];
}

export function createLineReader(): LineReader {
  let pending: Uint8Array[] = [];
  return {
    push(chunk) {
      const lines: string[] = [];
      let start = 0;
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] !== 0x0a) continue;
        pending.push(chunk.subarray(start, i));
        lines.push(Buffer.concat(pending).toString('utf8'));
        pending = [];
        start = i + 1;
      }
      if (start < chunk.length) pending.push(chunk.subarray(start));
      return lines;
    },
  };
}

interface WritableSocket {
  write(data: Uint8Array): number;
}

// Bytes the kernel buffer did not accept yet, per socket; flushed on drain.
const outbound = new WeakMap<WritableSocket, Uint8Array[]>();

/**
 * Write a frame honoring backpressure. Bun's socket.write returns how many
 * bytes were accepted; a large frame (hundreds of KB) is routinely accepted
 * only partially, and the remainder must go out from the drain handler.
 */
export function writeAll(socket: WritableSocket, text: string): void {
  const buf = Buffer.from(text, 'utf8');
  const queue = outbound.get(socket);
  if (queue && queue.length > 0) {
    queue.push(buf);
    return;
  }
  const written = socket.write(buf);
  if (written < buf.length) outbound.set(socket, [buf.subarray(written)]);
}

/** Drain handler: continue writing whatever writeAll could not send yet. */
export function flushPending(socket: WritableSocket): void {
  const queue = outbound.get(socket);
  if (!queue) return;
  while (queue.length > 0) {
    const written = socket.write(queue[0]);
    if (written < queue[0].length) {
      queue[0] = queue[0].subarray(written);
      return;
    }
    queue.shift();
  }
  outbound.delete(socket);
}

// ============================================================================
// PostgREST pass-through
// ============================================================================

/**
 * Forward one request to `upstream` (an origin) and hand back the response
 * as it came: the body still compressed (decompress: false), so the client's
 * own fetch decodes it exactly as it would a direct response, and redirects
 * unfollowed, so the client follows them as it would. A request that never
 * got an answer comes back as a 502 marked with PROXY_ERROR_HEADER.
 */
export async function proxyRequest(
  upstream: string,
  req: Request,
): Promise<Response> {
  const url = new URL(req.url);
  const headers = new Headers(req.headers);
  headers.delete('host');
  try {
    const response = await fetch(`${upstream}${url.pathname}${url.search}`, {
      method: req.method,
      headers,
      body: req.body,
      signal: req.signal,
      redirect: 'manual',
      decompress: false,
    } as RequestInit);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (error) {
    return new Response(null, {
      status: 502,
      headers: {
        [PROXY_ERROR_HEADER]: encodeURIComponent((error as Error).message),
      },
    });
  }
}

// ============================================================================
// Daemon Worker
// ============================================================================

/**
 * Main daemon entry point - run as detached background process
 */
export async function runDaemon(
  serverName: string,
  config: DaemonConfig,
): Promise<void> {
  const socketPath = getSocketPath(serverName, process.pid);
  const configHash = getConfigHash(config);
  const timeoutMs = getDaemonTimeoutMs();
  const startedAtMs = Date.now();

  // Pick up the resolved log path the spawning CLI placed in our environment
  // so daemon_start/daemon_stop events land in the same log file as
  // everything else.
  enableFromEnv();

  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let mcpClient: ConnectedClient | null = null;
  let server: { stop: (closeActiveConnections?: boolean) => unknown } | null =
    null;
  let ready = false;
  // Proxied requests still running; the daemon is not idle while any are.
  let inFlight = 0;
  const activeConnections = new Set<unknown>();

  // Cleanup function
  const cleanup = async (reason: string) => {
    debug(`[daemon:${serverName}] Shutting down...`);

    // Log first (synchronous append): only for daemons that reached ready
    // state, so a failed startup never produces a stop without a start.
    if (ready) {
      ready = false;
      logDaemonEvent({
        event: 'daemon_stop',
        server: serverName,
        pid: process.pid,
        reason,
        uptimeMs: Date.now() - startedAtMs,
      });
    }

    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }

    // Close all active socket connections
    for (const conn of activeConnections) {
      try {
        (conn as { end: () => void }).end();
      } catch {
        // Ignore
      }
    }
    activeConnections.clear();

    // Close MCP connection
    if (mcpClient) {
      try {
        await mcpClient.close();
      } catch {
        // Ignore
      }
      mcpClient = null;
    }

    // Close socket server
    if (server) {
      try {
        server.stop(true);
      } catch {
        // Ignore
      }
      server = null;
    }

    // Clean up files: our own socket, and the PID file only while it is
    // still ours — a client that replaced this daemon may have let a
    // successor claim it already.
    removeSocketFile(serverName, process.pid);
    if (readPidFile(serverName)?.pid === process.pid) {
      removePidFile(serverName);
    }

    debug(`[daemon:${serverName}] Cleanup complete`);
  };

  // Reset idle timer
  const resetIdleTimer = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
    }
    idleTimer = setTimeout(async () => {
      // A request still running is not idle: look again a period later.
      if (inFlight > 0) {
        resetIdleTimer();
        return;
      }
      debug(`[daemon:${serverName}] Idle timeout reached, shutting down`);
      await cleanup('idle_timeout');
      process.exit(0);
    }, timeoutMs);
  };

  // Handle signals
  process.on('SIGTERM', async () => {
    await cleanup('sigterm');
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    await cleanup('sigint');
    process.exit(0);
  });

  // Ensure socket dir exists
  const socketDir = getSocketDir();
  if (!existsSync(socketDir)) {
    mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  }

  // Two CLI invocations may each have started a daemon for this server: the
  // one that claims the PID file runs, the other has nothing to do.
  if (!claimPidFile(serverName, configHash)) {
    debug(`[daemon:${serverName}] Another daemon already runs, exiting`);
    process.exit(0);
  }

  try {
    server = isPostgrestProxyConfig(config)
      ? listenAsProxy(config.postgrestProxy)
      : await listenAsMcp(config);
  } catch (error) {
    console.error(
      `[daemon:${serverName}] Failed to start:`,
      (error as Error).message,
    );
    await cleanup('startup_failed');
    process.exit(1);
  }

  debug(`[daemon:${serverName}] Listening on ${socketPath}`);

  // Start idle timer
  resetIdleTimer();

  // Written here, not by the CLI that spawned this daemon: it does not wait
  // to see whether the start succeeded.
  ready = true;
  logDaemonEvent({
    event: 'daemon_start',
    server: serverName,
    pid: process.pid,
  });

  // ------------------------------------------------------------------------

  function listenAsProxy(upstream: string) {
    const proxy = Bun.serve({
      unix: socketPath,
      // A slow query sends nothing for a while; the client's own timeout
      // governs it, as on a direct connection. Without this, Bun resets a
      // request after 10 s of silence. Its types reject idleTimeout next to
      // `unix`, but the option applies there all the same (and
      // server.timeout(req, 0) does not), hence the cast.
      ...({ idleTimeout: 0 } as object),
      maxRequestBodySize: Number.MAX_SAFE_INTEGER,
      fetch: async (req: Request) => {
        inFlight++;
        resetIdleTimer();
        try {
          return await proxyRequest(upstream, req);
        } finally {
          inFlight--;
          resetIdleTimer();
        }
      },
    });
    // Open the upstream connection now, so the first request through this
    // daemon already finds it. Any answer will do; none is needed.
    fetch(upstream, { method: 'HEAD' }).catch(() => {});
    return proxy;
  }

  async function listenAsMcp(mcpConfig: ServerConfig) {
    debug(`[daemon:${serverName}] Connecting to MCP server...`);
    mcpClient = await connectToServer(serverName, mcpConfig);
    debug(`[daemon:${serverName}] Connected to MCP server`);

    // Per-connection frame reassembly: a request may span several reads.
    const inbound = new Map<unknown, LineReader>();
    return Bun.listen({
      unix: socketPath,
      socket: {
        open(socket) {
          activeConnections.add(socket);
          inbound.set(socket, createLineReader());
          debug(`[daemon:${serverName}] Client connected`);
        },
        async data(socket, data) {
          const reader = inbound.get(socket);
          if (!reader) return;
          for (const line of reader.push(data)) {
            const response = await handleRequest(line);
            writeAll(socket, `${JSON.stringify(response)}\n`);
          }
        },
        drain(socket) {
          flushPending(socket);
        },
        close(socket) {
          activeConnections.delete(socket);
          inbound.delete(socket);
          debug(`[daemon:${serverName}] Client disconnected`);
        },
        error(socket, error) {
          debug(`[daemon:${serverName}] Socket error: ${error.message}`);
          activeConnections.delete(socket);
          inbound.delete(socket);
        },
      },
    });
  }

  // Handle one complete request frame (see createLineReader)
  async function handleRequest(line: string): Promise<DaemonResponse> {
    resetIdleTimer();

    let request: DaemonRequest;
    try {
      request = JSON.parse(line);
    } catch {
      return {
        id: 'unknown',
        success: false,
        error: { code: 'INVALID_REQUEST', message: 'Invalid JSON' },
      };
    }

    debug(`[daemon:${serverName}] Request: ${request.type} (${request.id})`);

    if (!mcpClient) {
      return {
        id: request.id,
        success: false,
        error: { code: 'NOT_CONNECTED', message: 'MCP client not connected' },
      };
    }

    try {
      switch (request.type) {
        case 'ping':
          return { id: request.id, success: true, data: 'pong' };

        case 'listTools': {
          const tools = await listTools(mcpClient.client);
          return { id: request.id, success: true, data: tools };
        }

        case 'callTool': {
          if (!request.toolName) {
            return {
              id: request.id,
              success: false,
              error: { code: 'MISSING_TOOL', message: 'toolName required' },
            };
          }
          const result = await callTool(
            mcpClient.client,
            request.toolName,
            request.args ?? {},
          );
          return { id: request.id, success: true, data: result };
        }

        case 'getInstructions': {
          const instructions = mcpClient.client.getInstructions();
          return { id: request.id, success: true, data: instructions };
        }

        case 'close':
          // Graceful shutdown requested
          setTimeout(async () => {
            await cleanup('close_request');
            process.exit(0);
          }, 100);
          return { id: request.id, success: true, data: 'closing' };

        default:
          return {
            id: request.id,
            success: false,
            error: {
              code: 'UNKNOWN_TYPE',
              message: `Unknown request type: ${request.type}`,
            },
          };
      }
    } catch (error) {
      const err = error as Error;
      return {
        id: request.id,
        success: false,
        error: { code: 'EXECUTION_ERROR', message: err.message },
      };
    }
  }
}

// ============================================================================
// Entry point
// ============================================================================

/**
 * Handle `--daemon <serverName>` when this program is launched as a daemon
 * (see spawnDaemon in daemon-client.ts), with its config in
 * DAEMON_CONFIG_ENV. Called by index.ts before normal argument parsing —
 * which would otherwise reject `--daemon` as an unknown option and exit,
 * killing the daemon. Returns false when the arguments are not a daemon
 * launch; never returns on a daemon launch.
 */
export function runDaemonFromArgv(argv: string[]): boolean {
  if (argv[0] !== '--daemon') return false;

  const serverName = argv[1];
  const configJson = process.env[DAEMON_CONFIG_ENV];
  // Not passed on to anything this daemon starts (a stdio MCP server).
  delete process.env[DAEMON_CONFIG_ENV];

  if (!serverName || !configJson) {
    console.error(
      `Usage: ${DAEMON_CONFIG_ENV}=<configJson> semantius --daemon <serverName>`,
    );
    process.exit(1);
  }

  let config: DaemonConfig;
  try {
    config = JSON.parse(configJson);
  } catch {
    console.error('Invalid config JSON');
    process.exit(1);
  }

  runDaemon(serverName, config).catch((error) => {
    console.error('Daemon failed:', error);
    process.exit(1);
  });
  return true;
}
