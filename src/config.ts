/**
 * semantius Configuration Types and Loader
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  ErrorCode,
  configInvalidJsonError,
  configMissingFieldError,
  configNotFoundError,
  configSearchError,
  formatCliError,
  serverNotFoundError,
} from './errors.js';

/**
 * Base server configuration with tool filtering
 *
 * Tool Filtering Rules:
 * - If allowedTools is specified, only tools matching those patterns are available
 * - If disabledTools is specified, tools matching those patterns are excluded
 * - disabledTools takes precedence over allowedTools (a tool in both lists is disabled)
 * - Patterns support glob syntax (e.g., "read_*", "*file*")
 */
export interface BaseServerConfig {
  /** Glob patterns for tools to allow (if empty/undefined, all tools are allowed) */
  allowedTools?: string[];
  /** Glob patterns for tools to exclude (takes precedence over allowedTools) */
  disabledTools?: string[];
}

/**
 * stdio server configuration (local process)
 */
export interface StdioServerConfig extends BaseServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

/**
 * HTTP server configuration (remote)
 */
export interface HttpServerConfig extends BaseServerConfig {
  url: string;
  headers?: Record<string, string>;
  timeout?: number;
}

/**
 * Built-in server configuration (in-process, ships inside the binary).
 * Injected by loadConfig — never written by users, though a bare config
 * entry under a built-in server's name may carry filter overrides.
 */
export interface BuiltinServerConfig extends BaseServerConfig {
  builtin: true;
}

export type ServerConfig =
  | StdioServerConfig
  | HttpServerConfig
  | BuiltinServerConfig;

/** Names reserved for built-in in-process servers */
export const BUILTIN_SERVER_NAMES = ['utils'] as const;

export interface McpServersConfig {
  mcpServers: Record<string, ServerConfig>;
}

// ============================================================================
// Tool Filtering
// ============================================================================

/**
 * Simple glob pattern matcher for tool names
 * Supports * (any characters) and ? (single character)
 */
function matchesPattern(name: string, pattern: string): boolean {
  // Convert glob pattern to regex
  const regexPattern = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape special regex chars
    .replace(/\*/g, '.*') // * matches any characters
    .replace(/\?/g, '.'); // ? matches single character

  return new RegExp(`^${regexPattern}$`, 'i').test(name);
}

/**
 * Check if a tool name matches any of the given patterns
 */
function matchesAnyPattern(name: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesPattern(name, pattern));
}

/**
 * Filter tools based on allowedTools and disabledTools configuration
 *
 * Rules:
 * - If allowedTools is specified, only tools matching those patterns are available
 * - If disabledTools is specified, tools matching those patterns are excluded
 * - disabledTools takes precedence over allowedTools
 *
 * @param tools - Array of tools with name property
 * @param config - Server config with optional allowedTools/disabledTools
 * @returns Filtered array of tools
 */
export function filterTools<T extends { name: string }>(
  tools: T[],
  config: ServerConfig,
): T[] {
  const { allowedTools, disabledTools } = config;

  return tools.filter((tool) => {
    // First check if tool is in disabledTools (takes precedence)
    if (disabledTools && disabledTools.length > 0) {
      if (matchesAnyPattern(tool.name, disabledTools)) {
        return false;
      }
    }

    // Then check if allowedTools is specified
    if (allowedTools && allowedTools.length > 0) {
      return matchesAnyPattern(tool.name, allowedTools);
    }

    // No filtering specified, allow all
    return true;
  });
}

/**
 * Check if a specific tool is allowed by the config
 *
 * @param toolName - Name of the tool to check
 * @param config - Server config with optional allowedTools/disabledTools
 * @returns true if tool is allowed, false otherwise
 */
export function isToolAllowed(toolName: string, config: ServerConfig): boolean {
  const { allowedTools, disabledTools } = config;

  // First check if tool is in disabledTools (takes precedence)
  if (disabledTools && disabledTools.length > 0) {
    if (matchesAnyPattern(toolName, disabledTools)) {
      return false;
    }
  }

  // Then check if allowedTools is specified
  if (allowedTools && allowedTools.length > 0) {
    return matchesAnyPattern(toolName, allowedTools);
  }

  // No filtering specified, allow all
  return true;
}

/**
 * Check if a server config is HTTP-based
 */
export function isHttpServer(config: ServerConfig): config is HttpServerConfig {
  return 'url' in config;
}

/**
 * Check if a server config is stdio-based
 */
export function isStdioServer(
  config: ServerConfig,
): config is StdioServerConfig {
  return 'command' in config;
}

/**
 * Check if a server config is a built-in in-process server
 */
export function isBuiltinServer(
  config: ServerConfig,
): config is BuiltinServerConfig {
  return 'builtin' in config && config.builtin === true;
}

// ============================================================================
// Env Prefix State
// ============================================================================

let _envPrefix = 'SEMANTIUS';

export function setEnvPrefix(prefix: string): void {
  _envPrefix = prefix.toUpperCase();
}

export function getEnvPrefix(): string {
  return _envPrefix;
}

export function getRequiredEnvVarNames(): string[] {
  return [`${_envPrefix}_API_KEY`, `${_envPrefix}_ORG`];
}

/**
 * Read an env var using the active prefix (default SEMANTIUS, or whatever
 * --env set). e.g. getPrefixedEnv('TIMEOUT') reads SEMANTIUS_TIMEOUT by
 * default, or PROD_TIMEOUT under `--env PROD`.
 */
export function getPrefixedEnv(name: string): string | undefined {
  return process.env[`${_envPrefix}_${name}`];
}

/**
 * Compose the full env var name for the active prefix. Useful for error
 * messages and help text that need to show the exact var the user must set.
 */
export function prefixedEnvName(name: string): string {
  return `${_envPrefix}_${name}`;
}

/**
 * Split an "org:credential" value at the FIRST colon. Safe because none of
 * the credential formats contain a colon (API keys are dash-delimited, JWTs
 * are base64url + dots) and org names are DNS labels. Returns the raw value
 * unchanged when there is no colon or either side is empty (malformed).
 */
export function splitOrgPrefix(raw: string): { org?: string; value: string } {
  const colon = raw.indexOf(':');
  if (colon <= 0 || colon === raw.length - 1) return { value: raw };
  return { org: raw.slice(0, colon), value: raw.slice(colon + 1) };
}

/**
 * The static JWT from ${PREFIX}_JWT with any "org:" prefix stripped.
 * Returns undefined when the var is unset or empty. When set, the CLI uses
 * this token directly — no get_cli_token call and no token cache I/O.
 */
export function getEnvJwt(): string | undefined {
  const raw = getPrefixedEnv('JWT');
  if (!raw) return undefined;
  return splitOrgPrefix(raw).value || undefined;
}

/**
 * Required env vars that are actually missing: ORG is always required
 * (normalizeCredentialEnv may have filled it from an "org:" prefix), and
 * API_KEY only when no static JWT is provided.
 */
export function getMissingRequiredEnvVars(): string[] {
  const missing: string[] = [];
  if (!getEnvJwt() && !process.env[`${_envPrefix}_API_KEY`]) {
    missing.push(`${_envPrefix}_API_KEY`);
  }
  if (!process.env[`${_envPrefix}_ORG`]) {
    missing.push(`${_envPrefix}_ORG`);
  }
  return missing;
}

/**
 * Normalize credential env vars in place after .env loading:
 *   - Hoist an "org:" prefix from ${PREFIX}_API_KEY / ${PREFIX}_JWT into
 *     ${PREFIX}_ORG (deliberately overwriting an existing ORG — the prefix
 *     wins). JWT is processed second so its org beats the API key's.
 *   - In JWT-only mode, backfill ${PREFIX}_API_KEY='' so the default
 *     config's ${PREFIX}_API_KEY reference substitutes cleanly under strict
 *     mode (undefined would throw; empty string is fine).
 * Idempotent: hoisted values contain no colon and the backfill only fires
 * while API_KEY is undefined, so repeated calls are no-ops.
 */
export function normalizeCredentialEnv(): void {
  const apiKeyName = `${_envPrefix}_API_KEY`;
  const jwtName = `${_envPrefix}_JWT`;
  const orgName = `${_envPrefix}_ORG`;

  const hoist = (name: string): void => {
    const raw = process.env[name];
    if (!raw?.includes(':')) return;
    const { org, value } = splitOrgPrefix(raw);
    if (!org) return;
    process.env[name] = value;
    process.env[orgName] = org;
  };

  hoist(apiKeyName);
  hoist(jwtName);

  if (process.env[jwtName] && process.env[apiKeyName] === undefined) {
    process.env[apiKeyName] = '';
  }
}

// ============================================================================
// User Config Directory
// ============================================================================

/**
 * Returns the platform-appropriate user config directory for semantius.
 * Windows: %APPDATA%\semantius
 * Linux/macOS: ~/.config/semantius
 */
export function getUserConfigDir(): string {
  const home = homedir();
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming');
    return join(appData, 'semantius');
  }
  return join(home, '.config', 'semantius');
}

// ============================================================================
// .env File Loading
// ============================================================================

/**
 * Parse a .env file and return key/value pairs.
 * Supports:
 *   - KEY=value
 *   - KEY="quoted value"
 *   - KEY='single quoted'
 *   - # comments and blank lines
 */
function parseDotEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();

    // Skip comments and blank lines
    if (!line || line.startsWith('#')) continue;

    const eqIndex = line.indexOf('=');
    if (eqIndex === -1) continue;

    const key = line.slice(0, eqIndex).trim();
    if (!key) continue;

    let value = line.slice(eqIndex + 1).trim();

    // Strip inline comments (only outside quotes)
    // Remove surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      // Strip trailing inline comment for unquoted values
      const commentIdx = value.indexOf(' #');
      if (commentIdx !== -1) {
        value = value.slice(0, commentIdx).trim();
      }
    }

    result[key] = value;
  }

  return result;
}

/**
 * Load a single .env file into process.env.
 * Shell environment takes precedence — existing vars are never overwritten.
 * Returns true if the file was found and read.
 */
async function loadEnvFile(envPath: string): Promise<boolean> {
  if (!existsSync(envPath)) return false;

  const content = await Bun.file(envPath).text();
  const vars = parseDotEnv(content);

  let loaded = 0;
  for (const [key, value] of Object.entries(vars)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
      loaded++;
    }
  }

  debug(`Loaded ${loaded} variable(s) from ${envPath}`);
  return true;
}

// Directory of the first .env file that was actually loaded. Used by the
// logger to resolve bare SEMANTIUS_LOG_FILE filenames next to the project's .env.
let _loadedEnvDir: string | undefined;

export function getLoadedEnvDir(): string | undefined {
  return _loadedEnvDir;
}

/**
 * Load .env files and populate process.env.
 * Shell environment takes precedence — existing vars are never overwritten.
 *
 * Search order (first local .env found wins; user config dir always checked as fallback):
 *   1. Current working directory
 *   2. searchDir (config file's directory or user-specified)
 *   3. Executable directory (for installs where binary lives next to .env)
 *   4. User config dir (~/.config/semantius on Linux/macOS, %APPDATA%\semantius on Windows)
 */
export async function loadDotEnv(searchDir?: string): Promise<void> {
  const execDir = dirname(process.execPath);
  const localDirs = [process.cwd(), searchDir, execDir].filter(
    Boolean,
  ) as string[];
  const seen = new Set<string>();

  // Load the first local .env found (project/install-specific takes precedence)
  for (const dir of localDirs) {
    const envPath = join(dir, '.env');
    if (seen.has(envPath)) continue;
    seen.add(envPath);
    if (await loadEnvFile(envPath)) {
      if (!_loadedEnvDir) _loadedEnvDir = dir;
      break;
    }
  }

  // Always try user config dir as global fallback for any unset vars
  const userConfigDir = getUserConfigDir();
  const userConfigEnvPath = join(userConfigDir, '.env');
  if (!seen.has(userConfigEnvPath)) {
    const loaded = await loadEnvFile(userConfigEnvPath);
    if (loaded && !_loadedEnvDir) _loadedEnvDir = userConfigDir;
  }

  // Hoist "org:" credential prefixes and backfill for JWT-only mode. Runs on
  // every loadDotEnv call (main + loadConfig) — idempotent by design.
  normalizeCredentialEnv();
}

// ============================================================================
// Environment Variables & Runtime Configuration
// ============================================================================

/**
 * Default configuration values - centralized to avoid inline magic numbers
 */
export const DEFAULT_TIMEOUT_SECONDS = 1800; // 30 minutes
export const DEFAULT_TIMEOUT_MS = DEFAULT_TIMEOUT_SECONDS * 1000;
// Ceiling on a single HTTP connect attempt. Deliberately generous — an HTTP
// MCP server answers `initialize` in well under a second, so this only ever
// fires on a server that is reachable but stalled. Applies to HTTP transports
// only: stdio servers legitimately take much longer to become ready (npx cold
// start, interactive auth prompts) and are left unbounded.
export const DEFAULT_CONNECT_TIMEOUT_SECONDS = 60;
export const DEFAULT_CONNECT_TIMEOUT_MS =
  DEFAULT_CONNECT_TIMEOUT_SECONDS * 1000;
export const DEFAULT_CONCURRENCY = 5;
export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_RETRY_DELAY_MS = 1000; // 1 second base delay
export const DEFAULT_DAEMON_TIMEOUT_SECONDS = 300; // 5 minutes idle timeout
// How long to wait for the FIRST byte of piped stdin before concluding that no
// input is coming. Guards against a hang when the CLI inherits an open-but-idle
// stdin pipe from a long-lived parent (e.g. a persistent PowerShell host), where
// stdin is not a TTY yet never reaches EOF. Once the first byte arrives, the full
// request timeout applies to reading the rest.
export const DEFAULT_STDIN_GRACE_MS = 500;

/**
 * Debug logging utility - only logs when <PREFIX>_DEBUG is set
 */
export function debug(message: string): void {
  if (getPrefixedEnv('DEBUG')) {
    console.error(`[semantius] ${message}`);
  }
}

/**
 * Get configured timeout in milliseconds
 * @env <PREFIX>_TIMEOUT - timeout in seconds (default: 1800 = 30 minutes)
 */
export function getTimeoutMs(): number {
  const envTimeout = getPrefixedEnv('TIMEOUT');
  if (envTimeout) {
    const seconds = Number.parseInt(envTimeout, 10);
    if (!Number.isNaN(seconds) && seconds > 0) {
      return seconds * 1000;
    }
  }
  return DEFAULT_TIMEOUT_MS;
}

/**
 * Get the ceiling on a single HTTP connect attempt, in milliseconds.
 * Separate from <PREFIX>_TIMEOUT, which is the budget for a whole operation
 * including retries: without a per-attempt bound a reachable-but-stalled
 * server hangs the CLI indefinitely, since client.connect() never settles.
 * @env <PREFIX>_CONNECT_TIMEOUT - seconds (default: 60, use 0 to disable)
 */
export function getConnectTimeoutMs(): number {
  const envTimeout = getPrefixedEnv('CONNECT_TIMEOUT');
  if (envTimeout) {
    const seconds = Number.parseInt(envTimeout, 10);
    if (!Number.isNaN(seconds) && seconds >= 0) {
      return seconds * 1000;
    }
  }
  return DEFAULT_CONNECT_TIMEOUT_MS;
}

/**
 * Get the first-byte grace period for reading piped stdin, in milliseconds.
 * This is a short detection window (separate from the request timeout) that
 * answers "is anything actually being piped in?". If neither a byte nor EOF
 * arrives within it, there is no piped input and we proceed with empty args
 * instead of hanging on an inherited, open-but-idle stdin pipe.
 * @env <PREFIX>_STDIN_GRACE_MS - grace period in ms (default: 500)
 */
export function getStdinGraceMs(): number {
  const envGrace = getPrefixedEnv('STDIN_GRACE_MS');
  if (envGrace) {
    const ms = Number.parseInt(envGrace, 10);
    if (!Number.isNaN(ms) && ms >= 0) {
      return ms;
    }
  }
  return DEFAULT_STDIN_GRACE_MS;
}

/**
 * Get concurrency limit for parallel server connections
 * @env <PREFIX>_CONCURRENCY - max parallel connections (default: 5)
 */
export function getConcurrencyLimit(): number {
  const envConcurrency = getPrefixedEnv('CONCURRENCY');
  if (envConcurrency) {
    const limit = Number.parseInt(envConcurrency, 10);
    if (!Number.isNaN(limit) && limit > 0) {
      return limit;
    }
  }
  return DEFAULT_CONCURRENCY;
}

/**
 * Get max retry attempts for transient failures
 * @env <PREFIX>_MAX_RETRIES - max retry attempts (default: 3, use 0 to disable retries)
 */
export function getMaxRetries(): number {
  const envRetries = getPrefixedEnv('MAX_RETRIES');
  if (envRetries) {
    const retries = Number.parseInt(envRetries, 10);
    if (!Number.isNaN(retries) && retries >= 0) {
      return retries;
    }
  }
  return DEFAULT_MAX_RETRIES;
}

/**
 * Get base delay for retry backoff in milliseconds
 * @env <PREFIX>_RETRY_DELAY - base delay in milliseconds (default: 1000)
 */
export function getRetryDelayMs(): number {
  const envDelay = getPrefixedEnv('RETRY_DELAY');
  if (envDelay) {
    const delay = Number.parseInt(envDelay, 10);
    if (!Number.isNaN(delay) && delay > 0) {
      return delay;
    }
  }
  return DEFAULT_RETRY_DELAY_MS;
}

// ============================================================================
// Daemon Configuration
// ============================================================================

/**
 * Check if daemon mode is enabled
 * @env <PREFIX>_NO_DAEMON - set to "1" to disable daemon, force fresh connections
 *
 * Windows is never daemon-eligible: the implementation relies on POSIX Unix
 * domain sockets at /tmp/semantius-<uid>/<server>.sock and process.getuid(),
 * neither of which exists on Windows. Attempting to spawn would just fail
 * after a ~5s timeout and fall back to direct connections anyway, so we
 * skip the spawn churn and go direct immediately.
 */
export function isDaemonEnabled(): boolean {
  if (process.platform === 'win32') return false;
  return getPrefixedEnv('NO_DAEMON') !== '1';
}

/**
 * Get daemon idle timeout in milliseconds
 * @env <PREFIX>_DAEMON_TIMEOUT - timeout in seconds (default: 300)
 */
export function getDaemonTimeoutMs(): number {
  const envTimeout = getPrefixedEnv('DAEMON_TIMEOUT');
  if (envTimeout) {
    const seconds = Number.parseInt(envTimeout, 10);
    if (!Number.isNaN(seconds) && seconds > 0) {
      return seconds * 1000;
    }
  }
  return DEFAULT_DAEMON_TIMEOUT_SECONDS * 1000;
}

/**
 * Get the socket directory for daemon connections
 * Uses platform-appropriate temp directory
 */
export function getSocketDir(): string {
  const uid = process.getuid?.() ?? 'unknown';
  // macOS uses /var/folders which is auto-cleaned, Linux uses /tmp
  const base = process.platform === 'darwin' ? '/tmp' : '/tmp';
  return join(base, `semantius-${uid}`);
}

/**
 * Get socket path for a specific server
 */
export function getSocketPath(serverName: string): string {
  return join(getSocketDir(), `${serverName}.sock`);
}

/**
 * Get PID file path for a specific server daemon
 */
export function getPidPath(serverName: string): string {
  return join(getSocketDir(), `${serverName}.pid`);
}

/**
 * Generate a hash of server config for stale detection
 * Returns consistent hash for identical configs
 */
export function getConfigHash(config: ServerConfig): string {
  const str = JSON.stringify(config, Object.keys(config).sort());
  // Simple hash using Bun's native hashing
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(str);
  return hasher.digest('hex').slice(0, 16); // First 16 chars is enough
}

/**
 * Check if strict environment variable mode is enabled
 * @env <PREFIX>_STRICT_ENV - set to "false" to warn instead of error (default: true)
 */
function isStrictEnvMode(): boolean {
  const value = getPrefixedEnv('STRICT_ENV')?.toLowerCase();
  return value !== 'false' && value !== '0';
}

/**
 * Substitute environment variables in a string
 * Supports ${VAR_NAME} syntax
 *
 * By default (strict mode), throws an error when referenced env var is not set.
 * Set <PREFIX>_STRICT_ENV=false to warn instead of error.
 */
function substituteEnvVars(value: string): string {
  const missingVars: string[] = [];

  const result = value.replace(/\$\{([^}]+)\}/g, (match, varName) => {
    const envValue = process.env[varName];
    if (envValue === undefined) {
      missingVars.push(varName);
      return '';
    }
    return envValue;
  });

  if (missingVars.length > 0) {
    const varList = missingVars.map((v) => `\${${v}}`).join(', ');
    const message = `Missing environment variable${missingVars.length > 1 ? 's' : ''}: ${varList}`;

    if (isStrictEnvMode()) {
      throw new Error(
        formatCliError({
          code: ErrorCode.CLIENT_ERROR,
          type: 'MISSING_ENV_VAR',
          message: message,
          details: 'Referenced in config but not set in environment',
          suggestion: `Set the variable(s) before running: export ${missingVars[0]}="value" or set SEMANTIUS_STRICT_ENV=false to use empty values`,
        }),
      );
    }
    // Non-strict mode: warn but continue
    console.error(`[semantius] Warning: ${message}`);
  }

  return result;
}

/**
 * Recursively substitute environment variables in an object
 */
function substituteEnvVarsInObject<T>(obj: T): T {
  if (typeof obj === 'string') {
    return substituteEnvVars(obj) as T;
  }
  if (Array.isArray(obj)) {
    return obj.map(substituteEnvVarsInObject) as T;
  }
  if (obj && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = substituteEnvVarsInObject(value);
    }
    return result as T;
  }
  return obj;
}

/**
 * Built-in default configuration used when no mcp_servers.json is found.
 * References env vars based on the current env prefix (default: SEMANTIUS).
 */
export function getDefaultConfig(): McpServersConfig {
  const prefix = _envPrefix;
  return {
    mcpServers: {
      crud: {
        url: `https://\${${prefix}_ORG}.semantius.ai/mcp`,
        headers: {
          'x-api-key': `\${${prefix}_API_KEY}`,
        },
      } as HttpServerConfig,
      cube: {
        url: `https://\${${prefix}_ORG}.semantius.io/mcp`,
        headers: {
          'x-api-key': `\${${prefix}_API_KEY}`,
        },
      } as HttpServerConfig,
    },
  };
}

/**
 * Get default config search paths
 */
function getDefaultConfigPaths(): string[] {
  const paths: string[] = [];
  const home = homedir();

  // Current directory
  paths.push(resolve('./mcp_servers.json'));

  // Home directory variants
  paths.push(join(home, '.mcp_servers.json'));
  paths.push(join(home, '.config', 'mcp', 'mcp_servers.json'));

  return paths;
}

// Most recently loaded config. Used by the JWT-cache layer in client.ts to
// locate a server (typically "crud") that can issue tokens via get_cli_token
// when the cache misses, without threading the whole config object through
// every command handler.
let _lastLoadedConfig: McpServersConfig | undefined;

export function getLastLoadedConfig(): McpServersConfig | undefined {
  return _lastLoadedConfig;
}

/**
 * Merge built-in in-process servers into a loaded config.
 *
 * Collision policy: a user entry with "command" or "url" under a built-in
 * name is a real server and wins (with a warning). A bare user entry
 * (neither key) carries only filter overrides and is merged onto the
 * built-in marker.
 */
function injectBuiltinServers(config: McpServersConfig): McpServersConfig {
  for (const name of BUILTIN_SERVER_NAMES) {
    const existing = config.mcpServers[name];
    if (existing && ('command' in existing || 'url' in existing)) {
      console.error(
        `[semantius] Warning: config entry "${name}" shadows the built-in ${name} server`,
      );
      continue;
    }
    config.mcpServers[name] = { ...existing, builtin: true };
  }
  return config;
}

/**
 * Load and parse MCP servers configuration
 */
export async function loadConfig(
  explicitPath?: string,
): Promise<McpServersConfig> {
  let configPath: string | undefined;

  // Check explicit path from argument or environment
  const envConfigPath = getPrefixedEnv('CONFIG_PATH');
  if (explicitPath) {
    configPath = resolve(explicitPath);
  } else if (envConfigPath) {
    configPath = resolve(envConfigPath);
  }

  // If explicit path provided, it must exist
  if (configPath) {
    if (!existsSync(configPath)) {
      throw new Error(formatCliError(configNotFoundError(configPath)));
    }
  } else {
    // Search default paths
    const searchPaths = getDefaultConfigPaths();
    for (const path of searchPaths) {
      if (existsSync(path)) {
        configPath = path;
        break;
      }
    }

    if (!configPath) {
      // No config file found — use built-in default config
      debug('No config file found; using built-in default config');
      await loadDotEnv();
      const defaults = injectBuiltinServers(
        substituteEnvVarsInObject(getDefaultConfig()),
      );
      _lastLoadedConfig = defaults;
      return defaults;
    }
  }

  // Load .env from the config file's directory (before env var substitution)
  await loadDotEnv(join(configPath, '..'));

  // Read and parse config
  const file = Bun.file(configPath);
  const content = await file.text();

  let config: McpServersConfig;
  try {
    config = JSON.parse(content);
  } catch (e) {
    throw new Error(
      formatCliError(configInvalidJsonError(configPath, (e as Error).message)),
    );
  }

  // Validate structure
  if (!config.mcpServers || typeof config.mcpServers !== 'object') {
    throw new Error(formatCliError(configMissingFieldError(configPath)));
  }

  // Warn if no servers are configured
  if (Object.keys(config.mcpServers).length === 0) {
    console.error(
      '[semantius] Warning: No servers configured in mcpServers. Add server configurations to use MCP tools.',
    );
  }

  // Validate individual server configs
  for (const [serverName, serverConfig] of Object.entries(config.mcpServers)) {
    if (!serverConfig || typeof serverConfig !== 'object') {
      throw new Error(
        formatCliError({
          code: ErrorCode.CLIENT_ERROR,
          type: 'CONFIG_INVALID_SERVER',
          message: `Invalid server configuration for "${serverName}"`,
          details: 'Server config must be an object',
          suggestion: `Use { "command": "..." } for stdio or { "url": "..." } for HTTP`,
        }),
      );
    }

    const hasCommand = 'command' in serverConfig;
    const hasUrl = 'url' in serverConfig;

    if (!hasCommand && !hasUrl) {
      // A bare entry under a built-in server's name carries only filter
      // overrides (allowedTools/disabledTools) for that built-in server.
      if ((BUILTIN_SERVER_NAMES as readonly string[]).includes(serverName)) {
        continue;
      }
      throw new Error(
        formatCliError({
          code: ErrorCode.CLIENT_ERROR,
          type: 'CONFIG_INVALID_SERVER',
          message: `Server "${serverName}" missing required field`,
          details: `Must have either "command" (for stdio) or "url" (for HTTP)`,
          suggestion: `Add "command": "npx ..." for local servers or "url": "https://..." for remote servers`,
        }),
      );
    }

    if (hasCommand && hasUrl) {
      throw new Error(
        formatCliError({
          code: ErrorCode.CLIENT_ERROR,
          type: 'CONFIG_INVALID_SERVER',
          message: `Server "${serverName}" has both "command" and "url"`,
          details:
            'A server must be either stdio (command) or HTTP (url), not both',
          suggestion: `Remove one of "command" or "url"`,
        }),
      );
    }
  }

  // Substitute environment variables
  config = injectBuiltinServers(substituteEnvVarsInObject(config));

  _lastLoadedConfig = config;
  return config;
}

/**
 * Get a specific server config by name
 */
export function getServerConfig(
  config: McpServersConfig,
  serverName: string,
): ServerConfig {
  const server = config.mcpServers[serverName];
  if (!server) {
    const available = Object.keys(config.mcpServers);
    throw new Error(formatCliError(serverNotFoundError(serverName, available)));
  }
  return server;
}

/**
 * List all server names
 */
export function listServerNames(config: McpServersConfig): string[] {
  return Object.keys(config.mcpServers);
}
