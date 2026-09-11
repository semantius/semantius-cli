/**
 * semantius Daemon - Background worker that maintains persistent MCP connections
 *
 * This is spawned as a detached process and manages a Unix socket for IPC.
 * It maintains the MCP server connection and forwards requests from CLI invocations.
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
 * Write PID file with config hash for stale detection
 */
export function writePidFile(serverName: string, configHash: string): void {
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

  writeFileSync(pidPath, JSON.stringify(content), { mode: 0o600 });
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
 * Remove socket file
 */
export function removeSocketFile(serverName: string): void {
  const socketPath = getSocketPath(serverName);
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
// Daemon Worker
// ============================================================================

/**
 * Main daemon entry point - run as detached background process
 */
export async function runDaemon(
  serverName: string,
  config: ServerConfig,
): Promise<void> {
  const socketPath = getSocketPath(serverName);
  const configHash = getConfigHash(config);
  const timeoutMs = getDaemonTimeoutMs();
  const startedAtMs = Date.now();

  // Pick up the resolved log path the spawning CLI placed in our environment
  // so daemon_stop events land in the same log file as everything else.
  enableFromEnv();

  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let mcpClient: ConnectedClient | null = null;
  let server: ReturnType<typeof Bun.listen> | null = null;
  let ready = false;
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
        server.stop();
      } catch {
        // Ignore
      }
      server = null;
    }

    // Clean up files
    removeSocketFile(serverName);
    removePidFile(serverName);

    debug(`[daemon:${serverName}] Cleanup complete`);
  };

  // Reset idle timer
  const resetIdleTimer = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
    }
    idleTimer = setTimeout(async () => {
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

  // Remove stale socket if exists
  removeSocketFile(serverName);

  // Write PID file
  writePidFile(serverName, configHash);

  // Connect to MCP server
  try {
    debug(`[daemon:${serverName}] Connecting to MCP server...`);
    mcpClient = await connectToServer(serverName, config);
    debug(`[daemon:${serverName}] Connected to MCP server`);
  } catch (error) {
    console.error(
      `[daemon:${serverName}] Failed to connect:`,
      (error as Error).message,
    );
    await cleanup('startup_failed');
    process.exit(1);
  }

  // Handle one complete request frame (see createLineReader)
  const handleRequest = async (line: string): Promise<DaemonResponse> => {
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
  };

  // Start Unix socket server
  try {
    // Per-connection frame reassembly: a request may span several reads.
    const inbound = new Map<unknown, LineReader>();
    server = Bun.listen({
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

    debug(`[daemon:${serverName}] Listening on ${socketPath}`);

    // Start idle timer
    resetIdleTimer();

    // Signal readiness by writing to stdout (parent will read this)
    ready = true;
    console.log('DAEMON_READY');
  } catch (error) {
    console.error(
      `[daemon:${serverName}] Failed to start socket server:`,
      (error as Error).message,
    );
    await cleanup('startup_failed');
    process.exit(1);
  }
}

// ============================================================================
// Entry point
// ============================================================================

/**
 * Handle `--daemon <serverName> <configJson>` when this program is launched
 * as a daemon (see getSelfCommand in daemon-client.ts). Called by index.ts
 * before normal argument parsing — which would otherwise reject `--daemon`
 * as an unknown option and exit, killing the daemon. Returns false when the
 * arguments are not a daemon launch; never returns on a daemon launch.
 */
export function runDaemonFromArgv(argv: string[]): boolean {
  if (argv[0] !== '--daemon') return false;

  const serverName = argv[1];
  const configJson = argv[2];

  if (!serverName || !configJson) {
    console.error('Usage: semantius --daemon <serverName> <configJson>');
    process.exit(1);
  }

  let config: ServerConfig;
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
