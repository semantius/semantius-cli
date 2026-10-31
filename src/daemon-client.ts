/**
 * semantius Daemon Client - IPC client for communicating with daemon workers
 *
 * Handles spawning daemons, detecting stale connections, and forwarding requests.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  type ServerConfig,
  debug,
  getConfigHash,
  getDaemonStderrPath,
  getPrefixedEnv,
  getSocketDir,
  getSocketPath,
  getTimeoutMs,
} from './config.js';
import {
  DAEMON_CONFIG_ENV,
  type DaemonConfig,
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
import { getResolvedLogFilePath } from './logger.js';

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
 * How long a daemon may run without its socket before it counts as wedged
 * rather than still starting. An MCP daemon opens its socket only once the
 * server's handshake is done, which on a cold serverless host has taken over
 * 5 s.
 */
const DAEMON_STARTUP_GRACE_MS = 30_000;

/**
 * Where a server's daemon stands, for this invocation:
 * - ready: running with this config, its socket open: use it;
 * - starting: running with this config, socket not open yet: go direct and
 *   let it finish;
 * - absent: none (a stale or mismatched one has just been cleared): go
 *   direct, and start one for the next invocation;
 * - unavailable: the socket directory is not this user's alone: go direct,
 *   and start nothing.
 */
export type DaemonState =
  | { state: 'ready'; socketPath: string }
  | { state: 'starting' | 'absent' | 'unavailable' };

/**
 * Whether the socket directory is this user's alone: a real directory (not
 * a symlink), owned by this uid, with no group or other access. It is in the
 * shared /tmp under a predictable name, so another user can create it first;
 * a client would then hand its requests (with their Authorization header,
 * through a PostgREST proxy) to whatever listens there.
 */
function socketDirIsPrivate(): boolean {
  const dir = getSocketDir();
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = lstatSync(dir);
    if (
      stat.isDirectory() &&
      stat.uid === process.getuid?.() &&
      (stat.mode & 0o077) === 0
    ) {
      return true;
    }
    debug(`[daemon-client] ${dir} is not private to this user; no daemon`);
  } catch (error) {
    debug(`[daemon-client] ${dir} is unusable: ${(error as Error).message}`);
  }
  return false;
}

/**
 * Check whether a daemon for this server is running with this config, and
 * clear away one that is dead, wedged, or was started with another config.
 */
export function getDaemonState(
  serverName: string,
  config: DaemonConfig,
): DaemonState {
  if (!socketDirIsPrivate()) return { state: 'unavailable' };

  const pidInfo = readPidFile(serverName);

  // No PID file = no daemon
  if (!pidInfo) {
    debug(`[daemon-client] No PID file for ${serverName}`);
    return { state: 'absent' };
  }

  // Check if process is actually running
  if (!isProcessRunning(pidInfo.pid)) {
    debug(`[daemon-client] Process ${pidInfo.pid} not running, cleaning up`);
    removePidFile(serverName);
    removeSocketFile(serverName, pidInfo.pid);
    return { state: 'absent' };
  }

  // Check if config matches. A mismatch is routine: a refreshed bearer is
  // part of an HTTP server's config.
  if (pidInfo.configHash !== getConfigHash(config)) {
    debug(
      `[daemon-client] Config hash mismatch for ${serverName}, killing old daemon`,
    );
    killProcess(pidInfo.pid);
    removePidFile(serverName);
    removeSocketFile(serverName, pidInfo.pid);
    return { state: 'absent' };
  }

  // Check if socket exists
  const socketPath = getSocketPath(serverName, pidInfo.pid);
  if (!existsSync(socketPath)) {
    if (Date.now() - Date.parse(pidInfo.startedAt) < DAEMON_STARTUP_GRACE_MS) {
      debug(`[daemon-client] Daemon for ${serverName} is still starting`);
      return { state: 'starting' };
    }
    debug(`[daemon-client] Socket missing for ${serverName}, cleaning up`);
    killProcess(pidInfo.pid);
    removePidFile(serverName);
    return { state: 'absent' };
  }

  return { state: 'ready', socketPath };
}

/**
 * Command prefix that re-launches this program. Inside a `bun build
 * --compile` binary, Bun.main is a path in Bun's virtual bundle
 * (/$bunfs/root/…, B:\~BUN\root\… on Windows), so the binary alone is the
 * command. That path is named after the build's --outfile, not the file
 * installed: a release binary is built as semantius-linux-x64 and installed
 * as semantius, so comparing it with process.execPath's name cannot tell the
 * two modes apart. Under `bun run src/index.ts`, Bun.main is the entry
 * script and must be passed to bun explicitly. Exported for tests.
 */
export function getSelfCommand(main: string = Bun.main): string[] {
  const isCompiled = /^(\/\$bunfs\/|[A-Za-z]:[\\/]~BUN[\\/])/.test(main);
  return isCompiled ? [process.execPath] : [process.execPath, main];
}

/**
 * Start a daemon for a server in the background, without waiting for it:
 * this invocation goes direct either way, and the next one finds the daemon
 * ready (getDaemonState). Waiting would put the daemon's whole startup, for
 * an MCP server the handshake with a possibly cold serverless host, in front
 * of this command.
 *
 * The daemon runs detached, in its own session, so a Ctrl-C at the terminal
 * does not reach it. Its stderr goes to getDaemonStderrPath, which the next
 * invocation shows under <PREFIX>_DEBUG when no daemon came up.
 */
function spawnDaemon(serverName: string, config: DaemonConfig): void {
  debug(`[daemon-client] Spawning daemon for ${serverName} in the background`);

  // Hand the daemon the exact resolved log destination so its start and stop
  // events land in the same file (see getResolvedLogFilePath for why it
  // cannot re-derive the path itself).
  const logPath = getResolvedLogFilePath();

  // Spawn the daemon as a second instance of THIS program. In a compiled
  // binary the sources live in Bun's virtual bundle (/$bunfs/root), not on
  // disk, so `bun run <import.meta.dir>/daemon.ts` can never work there —
  // and `bun` itself need not be installed. process.execPath is the binary
  // (compiled) or bun (dev mode, where Bun.main is the entry script).
  // index.ts routes `--daemon` to runDaemon before normal arg parsing.
  try {
    const proc = Bun.spawn({
      cmd: [...getSelfCommand(), '--daemon', serverName],
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: Bun.file(getDaemonStderrPath(serverName)),
      detached: true,
      env: {
        ...process.env,
        [DAEMON_CONFIG_ENV]: JSON.stringify(config),
        ...(logPath ? { SEMANTIUS_LOG_FILE: logPath } : {}),
      },
    });
    proc.unref();
  } catch (error) {
    debug(
      `[daemon-client] Could not spawn a daemon for ${serverName}: ${(error as Error).message}`,
    );
  }
}

/**
 * Under <PREFIX>_DEBUG, show the end of what the last daemon for a server
 * wrote to stderr, when none is running now: why it failed to start, as a
 * rule.
 */
function reportDaemonStderr(serverName: string): void {
  if (!getPrefixedEnv('DEBUG')) return;
  try {
    const text = readFileSync(getDaemonStderrPath(serverName), 'utf8')
      .trimEnd()
      .split('\n')
      .slice(-20)
      .join('\n');
    if (text) {
      debug(
        `[daemon-client] The last daemon for ${serverName} wrote to stderr:\n${text}`,
      );
    }
  } catch {
    // No daemon has run for this server yet
  }
}

/**
 * The daemon's state (getDaemonState), after starting one in the background
 * when there is none: the caller goes direct unless it is ready.
 */
export function ensureDaemon(
  serverName: string,
  config: DaemonConfig,
): DaemonState {
  const daemon = getDaemonState(serverName, config);
  if (daemon.state === 'absent') {
    reportDaemonStderr(serverName);
    spawnDaemon(serverName, config);
  }
  return daemon;
}

/**
 * Get a connection to a server's MCP daemon, or null when this invocation
 * must connect directly: none was ready (one is then started for the next
 * invocation), or it did not answer.
 */
export async function getDaemonConnection(
  serverName: string,
  config: ServerConfig,
): Promise<DaemonConnection | null> {
  const daemon = ensureDaemon(serverName, config);
  if (daemon.state !== 'ready') return null;
  const { socketPath } = daemon;

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
        removeSocketFile(serverName, pidInfo.pid);
      }
    }

    // A daemon killed outright (SIGKILL, a crash) leaves its socket behind,
    // and its PID file may since name a successor: go by the PID in the name.
    const sockets = await Array.fromAsync(
      new Bun.Glob('*-*.sock').scan(socketDir),
    );
    for (const file of sockets) {
      const pid = Number(/-(\d+)\.sock$/.exec(file)?.[1]);
      if (pid && !isProcessRunning(pid)) unlinkSync(join(socketDir, file));
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
      if (pidInfo) {
        killProcess(pidInfo.pid);
        removeSocketFile(serverName, pidInfo.pid);
      }
      removePidFile(serverName);
    }
  } catch (error) {
    debug(`[daemon-client] stopAllDaemons failed: ${(error as Error).message}`);
  }
}
