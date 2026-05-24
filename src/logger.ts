/**
 * Per-invocation JSONL logger.
 *
 * Enabled by setting <PREFIX>_LOG_FILE (e.g. SEMANTIUS_LOG_FILE, or
 * PROD_LOG_FILE under `--env PROD`) to a file path:
 *   - Path with a directory component (./logs/x.jsonl, /var/log/x.jsonl,
 *     C:\logs\x.jsonl) is resolved as-is against the current working directory.
 *   - Bare filename (semantius.jsonl) is written next to the .env file that
 *     was loaded for this run; falls back to the user config dir if no .env
 *     was loaded.
 *
 * <PREFIX>_LOG_LEVELS filters which invocations actually produce a line.
 * Comma-separated subset of {all, error, slow, jwt}. Unknown/missing → defaults
 * to "all". "error" matches exit_code != 0; "slow" matches wall time > 1000ms;
 * "jwt" matches when the captured error message mentions "JWT" (and adds a
 * structured `jwt` field with the token value); any "all" token logs every
 * invocation. Multiple levels are OR-combined.
 *
 * When "jwt" is active, per-attempt retry events are also appended as their
 * own JSONL lines via logJwtRetryEvent, in addition to the exit-time entry.
 *
 * One JSON line is appended per matching invocation, containing the start
 * timestamp, total wall-clock duration, time spent in MCP requests, the exit
 * code, the full CLI invocation, and the error message on failure.
 */

import { appendFileSync, closeSync, openSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { getLoadedEnvDir, getPrefixedEnv, getUserConfigDir } from './config.js';

interface LogEntry {
  ts: string;
  log_type: 'request';
  exit_code: number;
  error?: string;
  pgrst_code?: string;
  sqlstate?: string;
  duration_ms: number;
  mcp_ms?: number;
  jwt?: string;
  cli: string[];
}

/**
 * Extract well-known structured error codes embedded in freeform error
 * messages so they can be grepped without parsing the freeform text.
 *
 * - `pgrst_code`: PostgREST error codes (e.g. `PGRST205`, `PGRST116`).
 * - `sqlstate`: Postgres SQLSTATE codes (5-char alphanumeric in parens,
 *   e.g. `(23505)` unique violation, `(42501)` permission denied).
 */
function extractErrorMeta(message: string): {
  pgrst_code?: string;
  sqlstate?: string;
} {
  const meta: { pgrst_code?: string; sqlstate?: string } = {};
  const pgrst = message.match(/\bPGRST\d{3,}\b/);
  if (pgrst) meta.pgrst_code = pgrst[0];
  const sqlstate = message.match(/\(([0-9A-Z]{5})\)/);
  if (sqlstate && !sqlstate[1].startsWith('PGRST')) {
    meta.sqlstate = sqlstate[1];
  }
  return meta;
}

type LogLevel = 'all' | 'error' | 'slow' | 'jwt';
const VALID_LEVELS: readonly LogLevel[] = ['all', 'error', 'slow', 'jwt'];
const SLOW_THRESHOLD_MS = 1000;

let _enabled = false;
let _logFileValue: string | undefined;
let _logToConsole = false;
let _logLevels: Set<LogLevel> = new Set(['all']);
let _startTime = 0;
let _mcpAccumMs = 0;
let _mcpInFlightStart: number | undefined;
let _errorMessage: string | undefined;
let _currentJwt: string | undefined;
let _installed = false;

function isJwtErrorMessage(message: string | undefined): boolean {
  return !!message && /\bjwt\b/i.test(message);
}

/**
 * Record the JWT currently being used for outbound requests so the logger can
 * include it in the exit entry (when "jwt" level is set and a JWT error
 * occurred) and in per-attempt retry events.
 */
export function recordJwt(token: string | undefined): void {
  _currentJwt = token || undefined;
}

/**
 * Return the JWT recorded for this invocation (via recordJwt), or undefined
 * if no Bearer token was used (e.g. JWT cache disabled, or stdio server).
 */
export function getRecordedJwt(): string | undefined {
  return _currentJwt;
}

/**
 * Parse <PREFIX>_LOG_LEVELS. Comma-separated subset of {all, error, slow, jwt}.
 * Empty / missing / no-valid-tokens → defaults to {all}. Tokens are case- and
 * whitespace-insensitive; unknown tokens are silently ignored.
 */
function parseLogLevels(value: string | undefined): Set<LogLevel> {
  if (!value) return new Set(['all']);
  const tokens = value
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter((t): t is LogLevel =>
      (VALID_LEVELS as readonly string[]).includes(t),
    );
  return tokens.length > 0 ? new Set(tokens) : new Set(['all']);
}

function shouldEmit(exitCode: number, durationMs: number): boolean {
  if (_logLevels.has('all')) return true;
  if (_logLevels.has('error') && exitCode !== 0) return true;
  if (_logLevels.has('slow') && durationMs > SLOW_THRESHOLD_MS) return true;
  if (
    _logLevels.has('jwt') &&
    exitCode !== 0 &&
    isJwtErrorMessage(_errorMessage)
  )
    return true;
  return false;
}

function resolveLogPath(value: string): string {
  // If the value has any path component (relative or absolute), use as-is.
  // A bare filename like "semantius.jsonl" has none, so route it to the
  // directory where the .env was loaded (matching .env discovery).
  const hasPath =
    isAbsolute(value) ||
    value.includes('/') ||
    value.includes('\\') ||
    (dirname(value) !== '.' && dirname(value) !== '');

  if (hasPath) {
    return resolve(value);
  }

  const baseDir = getLoadedEnvDir() ?? getUserConfigDir();
  return resolve(baseDir, value);
}

/**
 * Install the exit-time logger as early as possible. Reads <PREFIX>_LOG_FILE
 * from the shell environment now; if it isn't set yet (e.g. only present in
 * .env), call enableFromEnv() again after loadDotEnv. Idempotent.
 *
 * The log file path is resolved lazily at write time, so bare filenames still
 * land next to the .env even though we install before loadDotEnv runs.
 *
 * The env prefix must be set (setEnvPrefix) before calling this if you want
 * custom-prefix log files to capture early-exit paths.
 */
export function initLogger(): void {
  if (_installed) return;
  _installed = true;
  _startTime = Date.now();

  // Capture every console.error message so we don't have to thread an error
  // string through every exit path. The last message before exit becomes the
  // entry's `error` field when exit_code != 0.
  const origError = console.error.bind(console);
  console.error = (...rawArgs: unknown[]) => {
    if (_enabled) {
      const text = rawArgs
        .map((a) => (typeof a === 'string' ? a : String(a)))
        .join(' ')
        .trim();
      if (text) _errorMessage = text;
    }
    origError(...rawArgs);
  };

  process.on('exit', (code: number) => {
    writeLogEntry(code);
  });

  enableFromEnv();
}

/**
 * Re-check <PREFIX>_LOG_FILE and enable logging if it was set after initLogger
 * ran (typical when LOG_FILE is defined in .env, not the shell). Safe to call
 * multiple times.
 *
 * When `applyDefaults` is true (the post-loadDotEnv call), <PREFIX>_LOG_LEVELS
 * being set is enough to enable logging even without an explicit LOG_FILE:
 *   - if a .env was loaded → file defaults to `<envDir>/semantius.log`
 *   - else (shell-only env) → entries are written to stderr
 */
export function enableFromEnv(applyDefaults = false): void {
  if (_enabled) return;

  const explicitFile = getPrefixedEnv('LOG_FILE');
  const levels = getPrefixedEnv('LOG_LEVELS');

  if (explicitFile) {
    const resolved = resolveLogPath(explicitFile);
    try {
      const fd = openSync(resolved, 'a');
      closeSync(fd);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[semantius] LOG_FILE is not writable: ${explicitFile}\n  resolved to: ${resolved}\n  ${msg}`,
      );
      process.exit(1);
    }
    _enabled = true;
    _logFileValue = explicitFile;
    _logLevels = parseLogLevels(levels);
    return;
  }

  if (!applyDefaults || !levels) return;

  // LOG_LEVELS set without LOG_FILE: pick a sensible default destination.
  const envDir = getLoadedEnvDir();
  if (envDir) {
    const defaultName = 'semantius.log';
    const resolved = resolveLogPath(defaultName);
    try {
      const fd = openSync(resolved, 'a');
      closeSync(fd);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[semantius] default log file is not writable: ${resolved}\n  ${msg}\n  falling back to stderr`,
      );
      _enabled = true;
      _logToConsole = true;
      _logLevels = parseLogLevels(levels);
      return;
    }
    _enabled = true;
    _logFileValue = defaultName;
    _logLevels = parseLogLevels(levels);
    return;
  }

  // No .env loaded — write JSONL to stderr so the user still sees entries.
  _enabled = true;
  _logToConsole = true;
  _logLevels = parseLogLevels(levels);
}

export function startMcpRequest(): void {
  if (!_enabled) return;
  if (_mcpInFlightStart !== undefined) return; // ignore nested
  _mcpInFlightStart = Date.now();
}

export function endMcpRequest(): void {
  if (!_enabled || _mcpInFlightStart === undefined) return;
  _mcpAccumMs += Date.now() - _mcpInFlightStart;
  _mcpInFlightStart = undefined;
}

/**
 * Time an MCP-bound async operation. Accumulates into mcp_ms regardless of
 * success or failure.
 */
export async function timeMcp<T>(fn: () => Promise<T>): Promise<T> {
  if (!_enabled) return fn();
  startMcpRequest();
  try {
    return await fn();
  } finally {
    endMcpRequest();
  }
}

export function recordError(message: string): void {
  if (!_enabled) return;
  _errorMessage = message;
}

/**
 * Append one JSONL line to the active destination. File mode writes via
 * appendFileSync; console mode writes to stderr. Failures are surfaced to
 * stderr but never thrown — logging must never break the actual command.
 */
function appendLogLine(line: string): void {
  if (_logToConsole) {
    try {
      process.stderr.write(line);
    } catch {
      // best effort
    }
    return;
  }
  if (!_logFileValue) return;
  try {
    appendFileSync(resolveLogPath(_logFileValue), line);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[semantius] Failed to write log entry: ${msg}\n`);
  }
}

function writeLogEntry(exitCode: number): void {
  if (!_enabled) return;
  if (!_logFileValue && !_logToConsole) return;

  // Close any open MCP timer so an abrupt exit still records partial time.
  if (_mcpInFlightStart !== undefined) {
    _mcpAccumMs += Date.now() - _mcpInFlightStart;
    _mcpInFlightStart = undefined;
  }

  const durationMs = Date.now() - _startTime;
  if (!shouldEmit(exitCode, durationMs)) return;

  const meta =
    exitCode !== 0 && _errorMessage
      ? extractErrorMeta(_errorMessage)
      : undefined;

  // If a JWT was used this invocation, always include it on the log entry.
  // Logging is opt-in via LOG_LEVELS/LOG_FILE; gating the token on top of
  // that just makes "all" not actually mean all.
  const includeJwt = !!_currentJwt;

  const entry: LogEntry = {
    ts: new Date(_startTime).toISOString(),
    log_type: 'request',
    exit_code: exitCode,
    ...(exitCode !== 0 && _errorMessage ? { error: _errorMessage } : {}),
    ...(meta?.pgrst_code ? { pgrst_code: meta.pgrst_code } : {}),
    ...(meta?.sqlstate ? { sqlstate: meta.sqlstate } : {}),
    duration_ms: durationMs,
    ...(_mcpAccumMs > 0 ? { mcp_ms: _mcpAccumMs } : {}),
    ...(includeJwt ? { jwt: _currentJwt } : {}),
    cli: process.argv,
  };

  appendLogLine(`${JSON.stringify(entry)}\n`);
}

/**
 * Append a structured JSONL line describing a JWT retry attempt. No-op unless
 * logging is enabled AND "jwt" is in <PREFIX>_LOG_LEVELS. Emitted immediately
 * (not deferred to exit) so each attempt is visible even if the process keeps
 * running after a successful retry.
 */
export function logJwtRetryEvent(event: {
  event: 'retry_token' | 'retry_fresh_token';
  outcome: 'success' | 'failure';
  error?: string;
}): void {
  if (!_enabled) return;
  if (!_logFileValue && !_logToConsole) return;

  const entry = {
    ts: new Date().toISOString(),
    log_type: 'event',
    event: event.event,
    outcome: event.outcome,
    ...(event.error ? { error: event.error } : {}),
    ...(_currentJwt ? { jwt: _currentJwt } : {}),
  };

  appendLogLine(`${JSON.stringify(entry)}\n`);
}
