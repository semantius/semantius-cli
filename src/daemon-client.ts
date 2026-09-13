/**
 * semantius Daemon Client - IPC client for communicating with daemon workers
 *
 * Handles spawning daemons, detecting stale connections, and forwarding requests.
 */

import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import {
  type ServerConfig,
  debug,
  getConfigHash,
  getSocketDir,
  getSocketPath,
  getTimeoutMs,
} from './config.js';
import {
  type DaemonRequest,
  type DaemonResponse,
  createLineReader,
  flushPending,
  isProcessRunning,
  killProcess,
  readPidFile,
  removePidFile,
  removeSocketFile,
  writeAll,
} from './daemon.js';
import { getResolvedLogFilePath, logDaemonEvent } from './logger.js';

// ============================================================================
// Daemon Connection
// ============================================================================

/**
 * Represents a daemon connection for a specific server
 */
export interface DaemonConnection {
  serverName: string;
  listTools: () => Promise<unknown>;
  callTool: (
    toolName: string,
    args: Record<string, unknown>,
  ) => Promise<unknown>;
  getInstructions: () => Promise<string | undefined>;
  close: () => Promise<void>;
}

/**
 * Generate a unique request ID
 */
function generateRequestId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Send one request frame to the daemon and wait for its response frame.
 * Frames are newline-delimited JSON (see createLineReader in daemon.ts);
 * both directions may span several socket reads/writes for large payloads.
 *
 * The timeout defaults to the request timeout (<PREFIX>_TIMEOUT) so a long
 * tool call through the daemon gets the same budget as a direct one; the
 * liveness ping passes a short one for a fast fallback to direct connection.
 */
async function sendRequest(
  socketPath: string,
  request: DaemonRequest,
  timeoutMs: number = getTimeoutMs(),
): Promise<DaemonResponse> {
  return new Promise((resolve, reject) => {
    const reader = createLineReader();
    let settled = false;
    const settle = (fn: (v: never) => void, value: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value as never);
    };
    const timer = setTimeout(() => {
      settle(reject, new Error(`Daemon request timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    Bun.connect({
      unix: socketPath,
      socket: {
        open(socket) {
          writeAll(socket, `${JSON.stringify(request)}\n`);
        },
        drain(socket) {
          flushPending(socket);
        },
        data(socket, data) {
          const [line] = reader.push(data);
          if (line === undefined) return; // frame not complete yet
          // Settle BEFORE end(): Bun runs the close handler synchronously
          // inside end(), and its rejection must not win over the response.
          try {
            settle(resolve, JSON.parse(line));
          } catch {
            settle(reject, new Error('Invalid response from daemon'));
          }
          socket.end();
        },
        error(_socket, error) {
          settle(reject, error);
        },
        close() {
          settle(
            reject,
            new Error('Daemon closed the connection before responding'),
          );
        },
        connectError(_socket, error) {
          settle(reject, error);
        },
      },
    }).catch((error) => settle(reject, error));
  });
}

/** Liveness check budget: a stale or wedged daemon must fail fast so the CLI falls back to a direct connection. */
const DAEMON_PING_TIMEOUT_MS = 5000;

/**
 * Check if daemon is running and has matching config
 */
function isDaemonValid(serverName: string, config: ServerConfig): boolean {
  const socketPath = getSocketPath(serverName);
  const pidInfo = readPidFile(serverName);

  // No PID file = no daemon
  if (!pidInfo) {
    debug(`[daemon-client] No PID file for ${serverName}`);
    return false;
  }

  // Check if process is actually running
  if (!isProcessRunning(pidInfo.pid)) {
    debug(`[daemon-client] Process ${pidInfo.pid} not running, cleaning up`);
    removePidFile(serverName);
    removeSocketFile(serverName);
    return false;
  }

  // Check if config matches
  const currentHash = getConfigHash(config);
  if (pidInfo.configHash !== currentHash) {
    debug(
      `[daemon-client] Config hash mismatch for ${serverName}, killing old daemon`,
    );
    killProcess(pidInfo.pid);
    removePidFile(serverName);
    removeSocketFile(serverName);
    return false;
  }

  // Check if socket exists
  if (!existsSync(socketPath)) {
    debug(`[daemon-client] Socket missing for ${serverName}, cleaning up`);
    killProcess(pidInfo.pid);
    removePidFile(serverName);
    return false;
  }

  return true;
}

/**
 * Command prefix that re-launches this program. Inside a `bun build
 * --compile` binary, Bun.main is the virtual path of the binary itself
 * (its basename equals the executable's), so the binary alone is the
 * command. Under `bun run src/index.ts`, Bun.main is the entry script and
 * must be passed to bun explicitly. Exported for tests.
 */
export function getSelfCommand(): string[] {
  const isCompiled = basename(Bun.main) === basename(process.execPath);
  return isCompiled ? [process.execPath] : [process.execPath, Bun.main];
}

/**
 * Spawn a new daemon process for a server
 */
async function spawnDaemon(
  serverName: string,
  config: ServerConfig,
): Promise<boolean> {
  debug(`[daemon-client] Spawning daemon for ${serverName}`);

  const configJson = JSON.stringify(config);

  // Hand the daemon the exact resolved log destination so its stop events
  // land in the same file (see getResolvedLogFilePath for why it cannot
  // re-derive the path itself).
  const logPath = getResolvedLogFilePath();

  // Spawn the daemon as a second instance of THIS program. In a compiled
  // binary the sources live in Bun's virtual bundle (/$bunfs/root), not on
  // disk, so `bun run <import.meta.dir>/daemon.ts` can never work there —
  // and `bun` itself need not be installed. process.execPath is the binary
  // (compiled) or bun (dev mode, where Bun.main is the entry script).
  // index.ts routes `--daemon` to runDaemon before normal arg parsing.
  const proc = Bun.spawn({
    cmd: [...getSelfCommand(), '--daemon', serverName, configJson],
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      ...(logPath ? { SEMANTIUS_LOG_FILE: logPath } : {}),
    },
  });

  // Wait for daemon to signal readiness or fail
  return new Promise((resolve) => {
    let resolved = false;

    const reader = proc.stdout.getReader();

    const checkReady = async () => {
      try {
        const { value, done } = await reader.read();
        if (done) {
          if (!resolved) {
            resolved = true;
            resolve(false);
          }
          return;
        }

        const text = new TextDecoder().decode(value);
        if (text.includes('DAEMON_READY')) {
          if (!resolved) {
            resolved = true;
            logDaemonEvent({
              event: 'daemon_start',
              server: serverName,
              pid: proc.pid,
            });
            // Don't await the process, let it run detached
            proc.unref();
            resolve(true);
          }
        } else {
          // Keep reading
          checkReady();
        }
      } catch {
        if (!resolved) {
          resolved = true;
          resolve(false);
        }
      }
    };

    checkReady();

    // Timeout after 5 seconds (fast fallback to direct connection)
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        debug(`[daemon-client] Daemon spawn timeout for ${serverName}`);
        resolve(false);
      }
    }, 5000);

    // Check for early exit
    proc.exited.then((code) => {
      if (!resolved && code !== 0) {
        resolved = true;
        debug(`[daemon-client] Daemon exited with code ${code}`);
        resolve(false);
      }
    });
  });
}

/**
 * Get or create a daemon connection for a server
 * Returns null if daemon mode fails (caller should fallback to direct connection)
 */
export async function getDaemonConnection(
  serverName: string,
  config: ServerConfig,
): Promise<DaemonConnection | null> {
  const socketPath = getSocketPath(serverName);

  // Check if valid daemon exists
  if (!isDaemonValid(serverName, config)) {
    // Spawn new daemon
    const spawned = await spawnDaemon(serverName, config);
    if (!spawned) {
      debug(`[daemon-client] Failed to spawn daemon for ${serverName}`);
      return null;
    }

    // Wait a bit for socket to be ready
    await new Promise((r) => setTimeout(r, 100));
  }

  // Verify socket exists
  if (!existsSync(socketPath)) {
    debug(`[daemon-client] Socket not found after spawn for ${serverName}`);
    return null;
  }

  // Test connection with ping
  try {
    const pingResponse = await sendRequest(
      socketPath,
      { id: generateRequestId(), type: 'ping' },
      DAEMON_PING_TIMEOUT_MS,
    );

    if (!pingResponse.success) {
      debug(`[daemon-client] Ping failed for ${serverName}`);
      return null;
    }
  } catch (error) {
    debug(
      `[daemon-client] Connection test failed for ${serverName}: ${(error as Error).message}`,
    );
    return null;
  }

  debug(`[daemon-client] Connected to daemon for ${serverName}`);

  // Return connection interface
  return {
    serverName,

    async listTools(): Promise<unknown> {
      const response = await sendRequest(socketPath, {
        id: generateRequestId(),
        type: 'listTools',
      });

      if (!response.success) {
        throw new Error(response.error?.message ?? 'listTools failed');
      }

      return response.data;
    },

    async callTool(
      toolName: string,
      args: Record<string, unknown>,
    ): Promise<unknown> {
      const response = await sendRequest(socketPath, {
        id: generateRequestId(),
        type: 'callTool',
        toolName,
        args,
      });

      if (!response.success) {
        throw new Error(response.error?.message ?? 'callTool failed');
      }

      return response.data;
    },

    async getInstructions(): Promise<string | undefined> {
      const response = await sendRequest(socketPath, {
        id: generateRequestId(),
        type: 'getInstructions',
      });

      if (!response.success) {
        throw new Error(response.error?.message ?? 'getInstructions failed');
      }

      return response.data as string | undefined;
    },

    async close(): Promise<void> {
      // Just disconnect, don't tell daemon to close (let it idle timeout)
      debug(`[daemon-client] Disconnecting from ${serverName} daemon`);
    },
  };
}

/**
 * Clean up any orphaned daemon processes and sockets
 * Call this on CLI startup
 */
export async function cleanupOrphanedDaemons(): Promise<void> {
  const socketDir = getSocketDir();

  if (!existsSync(socketDir)) {
    return;
  }

  try {
    const files = await Array.fromAsync(new Bun.Glob('*.pid').scan(socketDir));

    for (const file of files) {
      const serverName = file.replace('.pid', '');
      const pidInfo = readPidFile(serverName);

      if (pidInfo && !isProcessRunning(pidInfo.pid)) {
        debug(`[daemon-client] Cleaning up orphaned daemon: ${serverName}`);
        removePidFile(serverName);
        removeSocketFile(serverName);
      }
    }
  } catch {
    // Ignore errors during cleanup scan
  }
}

/**
 * Stop every running daemon (all servers, not just one host's). Called after
 * `logout`: an HTTP daemon's PID file holds only an opaque config hash — for
 * an HTTP server, hashed from its URL and headers, bearer included
 * (getConfigHash) — so the daemon serving the just-revoked bearer cannot be
 * identified and killed individually. Daemons respawn on demand, so this
 * only costs the next command a fresh connection.
 *
 * No-op on Windows: isDaemonEnabled() is always false there (no Unix domain
 * sockets, no process.getuid), so no daemon can exist to stop.
 */
export async function stopAllDaemons(): Promise<void> {
  if (process.platform === 'win32') return;

  const socketDir = getSocketDir();
  if (!existsSync(socketDir)) return;

  try {
    const files = await Array.fromAsync(new Bun.Glob('*.pid').scan(socketDir));

    for (const file of files) {
      const serverName = file.replace('.pid', '');
      const pidInfo = readPidFile(serverName);
      if (pidInfo) killProcess(pidInfo.pid);
      removePidFile(serverName);
      removeSocketFile(serverName);
    }
  } catch (error) {
    debug(`[daemon-client] stopAllDaemons failed: ${(error as Error).message}`);
  }
}
