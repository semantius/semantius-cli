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
 * Comma-separated subset of {all, error, slow}. Unknown/missing → defaults to
 * "all". "error" matches exit_code != 0; "slow" matches wall time > 1000ms;
 * any "all" token logs every invocation. Multiple levels are OR-combined.
 *
 * One JSON line is appended per matching invocation, containing the start
 * timestamp, total wall-clock duration, time spent in MCP requests, the exit
 * code, the full CLI invocation, and the error message on failure.
 */

import { appendFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { getLoadedEnvDir, getPrefixedEnv, getUserConfigDir } from './config.js';

interface LogEntry {
  ts: string;
  duration_ms: number;
  mcp_ms?: number;
  exit_code: number;
  cli: string[];
  error?: string;
}

type LogLevel = 'all' | 'error' | 'slow';
const VALID_LEVELS: readonly LogLevel[] = ['all', 'error', 'slow'];
const SLOW_THRESHOLD_MS = 1000;

let _enabled = false;
let _logFileValue: string | undefined;
let _logLevels: Set<LogLevel> = new Set(['all']);
let _startTime = 0;
let _mcpAccumMs = 0;
let _mcpInFlightStart: number | undefined;
let _errorMessage: string | undefined;
let _installed = false;

/**
 * Parse <PREFIX>_LOG_LEVELS. Comma-separated subset of {all, error, slow}.
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
 */
export function enableFromEnv(): void {
  if (_enabled) return;
  const value = getPrefixedEnv('LOG_FILE');
  if (!value) return;
  _enabled = true;
  _logFileValue = value;
  _logLevels = parseLogLevels(getPrefixedEnv('LOG_LEVELS'));
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

function writeLogEntry(exitCode: number): void {
  if (!_enabled || !_logFileValue) return;

  // Close any open MCP timer so an abrupt exit still records partial time.
  if (_mcpInFlightStart !== undefined) {
    _mcpAccumMs += Date.now() - _mcpInFlightStart;
    _mcpInFlightStart = undefined;
  }

  const durationMs = Date.now() - _startTime;
  if (!shouldEmit(exitCode, durationMs)) return;

  const entry: LogEntry = {
    ts: new Date(_startTime).toISOString(),
    duration_ms: durationMs,
    exit_code: exitCode,
    cli: process.argv,
  };
  if (_mcpAccumMs > 0) entry.mcp_ms = _mcpAccumMs;
  if (exitCode !== 0 && _errorMessage) entry.error = _errorMessage;

  try {
    appendFileSync(resolveLogPath(_logFileValue), `${JSON.stringify(entry)}\n`);
  } catch {
    // Never fail the CLI because logging failed.
  }
}
