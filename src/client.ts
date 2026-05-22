/**
 * MCP Client - Connection management for MCP servers
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { version as VERSION } from '../package.json' with { type: 'json' };
import {
  type HttpServerConfig,
  type ServerConfig,
  type StdioServerConfig,
  debug,
  filterTools,
  getConcurrencyLimit,
  getLastLoadedConfig,
  getMaxRetries,
  getRetryDelayMs,
  getTimeoutMs,
  isDaemonEnabled,
  isHttpServer,
  isToolAllowed,
} from './config.js';
import {
  type DaemonConnection,
  cleanupOrphanedDaemons,
  getDaemonConnection,
} from './daemon-client.js';
import {
  type CachedToken,
  isJwtCacheDisabled,
  readCachedToken,
  writeCachedToken,
} from './jwt-cache.js';
import { timeMcp } from './logger.js';

// Re-export config utilities for convenience
export { debug, getTimeoutMs, getConcurrencyLimit };

export interface ConnectedClient {
  client: Client;
  close: () => Promise<void>;
}

/**
 * Unified connection interface that works with both daemon and direct connections
 */
export interface McpConnection {
  listTools: () => Promise<ToolInfo[]>;
  callTool: (
    toolName: string,
    args: Record<string, unknown>,
  ) => Promise<unknown>;
  getInstructions: () => Promise<string | undefined>;
  close: () => Promise<void>;
  isDaemon: boolean;
}

export interface ServerInfo {
  name: string;
  version?: string;
  protocolVersion?: string;
}

export interface ToolInfo {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Retry configuration
 */
interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  totalBudgetMs: number;
}

/**
 * Get retry config respecting SEMANTIUS_TIMEOUT budget
 */
function getRetryConfig(): RetryConfig {
  const totalBudgetMs = getTimeoutMs();
  const maxRetries = getMaxRetries();
  const baseDelayMs = getRetryDelayMs();

  // Reserve at least 5s for the final attempt
  const retryBudgetMs = Math.max(0, totalBudgetMs - 5000);

  return {
    maxRetries,
    baseDelayMs,
    maxDelayMs: Math.min(10000, retryBudgetMs / 2),
    totalBudgetMs,
  };
}

/**
 * Check if an error is transient and worth retrying
 * Uses error codes when available, falls back to message matching
 */
export function isTransientError(error: Error): boolean {
  // Check error code first (more reliable than message matching)
  const nodeError = error as NodeJS.ErrnoException;
  if (nodeError.code) {
    const transientCodes = [
      'ECONNREFUSED',
      'ECONNRESET',
      'ETIMEDOUT',
      'ENOTFOUND',
      'EPIPE',
      'ENETUNREACH',
      'EHOSTUNREACH',
      'EAI_AGAIN',
    ];
    if (transientCodes.includes(nodeError.code)) {
      return true;
    }
  }

  // Fallback to message matching for errors without codes
  const message = error.message;

  // HTTP transient errors - require status code at start or with HTTP context
  // Pattern: "502", "502 Bad Gateway", "HTTP 502", "status 502", "status code 502"
  if (/^(502|503|504|429)\b/.test(message)) return true;
  if (/\b(http|status(\s+code)?)\s*(502|503|504|429)\b/i.test(message))
    return true;
  if (
    /\b(502|503|504|429)\s+(bad gateway|service unavailable|gateway timeout|too many requests)/i.test(
      message,
    )
  )
    return true;

  // Generic network terms - more specific patterns
  if (/network\s*(error|fail|unavailable|timeout)/i.test(message)) return true;
  if (/connection\s*(reset|refused|timeout)/i.test(message)) return true;
  if (/\btimeout\b/i.test(message)) return true;

  return false;
}

/**
 * Calculate delay with exponential backoff and jitter
 */
function calculateDelay(attempt: number, config: RetryConfig): number {
  const exponentialDelay = config.baseDelayMs * 2 ** attempt;
  const cappedDelay = Math.min(exponentialDelay, config.maxDelayMs);
  // Add jitter (±25%)
  const jitter = cappedDelay * 0.25 * (Math.random() * 2 - 1);
  return Math.round(cappedDelay + jitter);
}

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute a function with retry logic for transient failures
 * Respects overall timeout budget from SEMANTIUS_TIMEOUT
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  operationName: string,
  config: RetryConfig = getRetryConfig(),
): Promise<T> {
  let lastError: Error | undefined;
  const startTime = Date.now();

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    // Check if we've exceeded the total timeout budget
    const elapsed = Date.now() - startTime;
    if (elapsed >= config.totalBudgetMs) {
      debug(`${operationName}: timeout budget exhausted after ${elapsed}ms`);
      break;
    }

    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      const remainingBudget = config.totalBudgetMs - (Date.now() - startTime);
      const shouldRetry =
        attempt < config.maxRetries &&
        isTransientError(lastError) &&
        remainingBudget > 1000; // At least 1s remaining

      if (shouldRetry) {
        const delay = Math.min(
          calculateDelay(attempt, config),
          remainingBudget - 1000,
        );
        debug(
          `${operationName} failed (attempt ${attempt + 1}/${config.maxRetries + 1}): ${lastError.message}. Retrying in ${delay}ms...`,
        );
        await sleep(delay);
      } else {
        throw lastError;
      }
    }
  }

  throw lastError;
}

/**
 * Safely close a connection, logging but not throwing on error
 */
export async function safeClose(close: () => Promise<void>): Promise<void> {
  try {
    await close();
  } catch (err) {
    debug(`Failed to close connection: ${(err as Error).message}`);
  }
}

/**
 * Connect to an MCP server with retry logic
 * Captures stderr from stdio servers to include in error messages
 */
export async function connectToServer(
  serverName: string,
  config: ServerConfig,
): Promise<ConnectedClient> {
  // Collect stderr for better error messages
  const stderrChunks: string[] = [];

  return withRetry(async () => {
    const client = new Client(
      {
        name: 'semantius',
        version: VERSION,
      },
      {
        capabilities: {},
      },
    );

    let transport: StdioClientTransport | StreamableHTTPClientTransport;

    if (isHttpServer(config)) {
      transport = createHttpTransport(config);
    } else {
      transport = createStdioTransport(config);

      // Capture stderr for debugging - attach BEFORE connect
      // Always stream stderr immediately so auth prompts are visible
      const stderrStream = transport.stderr;
      if (stderrStream) {
        stderrStream.on('data', (chunk: Buffer) => {
          const text = chunk.toString();
          stderrChunks.push(text);
          // Always stream stderr immediately so users can see auth prompts
          process.stderr.write(`[${serverName}] ${text}`);
        });
      }
    }

    try {
      await client.connect(transport);
    } catch (error) {
      const err = error as Error;
      // Enhance HTTP errors with the target URL
      if (isHttpServer(config)) {
        err.message = `${err.message} (url: ${config.url})`;
      }
      // Enhance error with captured stderr
      const stderrOutput = stderrChunks.join('').trim();
      if (stderrOutput) {
        err.message = `${err.message}\n\nServer stderr:\n${stderrOutput}`;
      }
      throw error;
    }

    // For successful connections, forward stderr to console
    if (!isHttpServer(config)) {
      const stderrStream = (transport as StdioClientTransport).stderr;
      if (stderrStream) {
        stderrStream.on('data', (chunk: Buffer) => {
          process.stderr.write(chunk);
        });
      }
    }

    return {
      client,
      close: async () => {
        await client.close();
      },
    };
  }, `connect to ${serverName}`);
}

/**
 * Create HTTP transport for remote servers
 */
function createHttpTransport(
  config: HttpServerConfig,
): StreamableHTTPClientTransport {
  const url = new URL(config.url);

  return new StreamableHTTPClientTransport(url, {
    requestInit: {
      headers: config.headers,
    },
  });
}

/**
 * Create stdio transport for local servers
 * Uses stderr: 'pipe' to capture server output for debugging
 */
function createStdioTransport(config: StdioServerConfig): StdioClientTransport {
  // Merge process.env with config.env, filtering out undefined values
  const mergedEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      mergedEnv[key] = value;
    }
  }
  if (config.env) {
    Object.assign(mergedEnv, config.env);
  }

  return new StdioClientTransport({
    command: config.command,
    args: config.args,
    env: mergedEnv,
    cwd: config.cwd,
    stderr: 'pipe', // Capture stderr for better error messages
  });
}

/**
 * List all tools from a connected client with retry logic
 */
export async function listTools(client: Client): Promise<ToolInfo[]> {
  return withRetry(async () => {
    const result = await client.listTools();
    return result.tools.map((tool: Tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as Record<string, unknown>,
    }));
  }, 'list tools');
}

/**
 * Get a specific tool by name
 */
export async function getTool(
  client: Client,
  toolName: string,
): Promise<ToolInfo | undefined> {
  const tools = await listTools(client);
  return tools.find((t) => t.name === toolName);
}

/**
 * Call a tool with arguments and retry logic
 */
export async function callTool(
  client: Client,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  return withRetry(async () => {
    const result = await client.callTool(
      {
        name: toolName,
        arguments: args,
      },
      undefined,
      { timeout: getTimeoutMs() },
    );
    return result;
  }, `call tool ${toolName}`);
}

// ============================================================================
// JWT Auth Transform
// ============================================================================

const API_KEY_HEADER = 'x-api-key';
const TOKEN_TOOL = 'get_cli_token';

/**
 * In-memory dedupe of JWT fetches inside a single CLI invocation. Without
 * this, parallel `getConnection` calls (e.g. `list` connecting to every
 * server) would each trigger their own get_cli_token round trip.
 */
const _jwtFetches = new Map<string, Promise<CachedToken | null>>();

/**
 * Extract the get_cli_token payload from a tool-call result. The crud server
 * may return the JSON directly or wrapped in the postgrestRequest envelope
 * `{ request, response: { data } }`.
 */
function parseTokenResult(result: unknown): CachedToken | null {
  const r = result as {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
  if (r.isError) return null;

  const text =
    r.content
      ?.filter((c) => c.type === 'text' && c.text)
      .map((c) => c.text as string)
      .join('') ?? '';

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  let token: unknown = parsed;
  if (
    parsed &&
    typeof parsed === 'object' &&
    'response' in parsed &&
    typeof (parsed as Record<string, unknown>).response === 'object' &&
    (parsed as Record<string, unknown>).response !== null
  ) {
    const resp = (parsed as Record<string, unknown>).response as Record<
      string,
      unknown
    >;
    if ('data' in resp) token = resp.data;
  }

  if (!token || typeof token !== 'object') return null;
  const t = token as Record<string, unknown>;
  if (typeof t.jwt !== 'string' || typeof t.expires !== 'string') return null;
  return { jwt: t.jwt, expires: t.expires };
}

/**
 * Find an HTTP server in the loaded config that carries the same API key
 * (so we know where to call get_cli_token). Prefers a server named "crud"
 * — the canonical token issuer — but falls back to any matching server.
 */
function findJwtIssuer(
  apiKey: string,
): { name: string; config: HttpServerConfig } | null {
  const loaded = getLastLoadedConfig();
  if (!loaded) return null;

  const candidates: Array<{ name: string; config: HttpServerConfig }> = [];
  for (const [name, cfg] of Object.entries(loaded.mcpServers)) {
    if (isHttpServer(cfg) && cfg.headers?.[API_KEY_HEADER] === apiKey) {
      candidates.push({ name, config: cfg });
    }
  }
  if (candidates.length === 0) return null;
  const crud = candidates.find((c) => c.name === 'crud');
  return crud ?? candidates[0];
}

/**
 * Return a valid JWT for this API key. Disk-cache first, then fetch via
 * `get_cli_token` over a direct (no-daemon, no-transform) connection.
 * Returns null if no token could be obtained — callers fall back to
 * sending the API key directly.
 */
async function resolveJwt(
  apiKey: string,
  fallbackIssuer: { name: string; config: HttpServerConfig },
): Promise<CachedToken | null> {
  const existing = _jwtFetches.get(apiKey);
  if (existing) return existing;

  const promise = (async (): Promise<CachedToken | null> => {
    const cached = await readCachedToken(apiKey);
    if (cached) return cached;

    const issuer = findJwtIssuer(apiKey) ?? fallbackIssuer;
    debug(
      `JWT cache miss; fetching via ${issuer.name}/${TOKEN_TOOL} (${issuer.config.url})`,
    );

    let client: ConnectedClient | null = null;
    try {
      client = await connectToServer(issuer.name, issuer.config);
      const result = await callTool(client.client, TOKEN_TOOL, {});
      const token = parseTokenResult(result);
      if (!token) {
        debug('get_cli_token returned no usable token');
        return null;
      }
      await writeCachedToken(apiKey, token);
      return token;
    } catch (err) {
      debug(`get_cli_token failed: ${(err as Error).message}`);
      return null;
    } finally {
      if (client) await safeClose(client.close);
    }
  })();

  _jwtFetches.set(apiKey, promise);
  return promise;
}

/**
 * If JWT caching is enabled and the server uses x-api-key, swap that header
 * for `Authorization: Bearer <jwt>`. Falls through to the original config
 * on any failure so a broken cache layer never blocks the actual command.
 */
async function transformConfigWithJwt(
  serverName: string,
  config: ServerConfig,
): Promise<ServerConfig> {
  if (isJwtCacheDisabled()) return config;
  if (!isHttpServer(config)) return config;
  const apiKey = config.headers?.[API_KEY_HEADER];
  if (!apiKey) return config;

  const token = await resolveJwt(apiKey, { name: serverName, config });
  if (!token) return config;

  const newHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(config.headers ?? {})) {
    if (k.toLowerCase() !== API_KEY_HEADER) newHeaders[k] = v;
  }
  newHeaders.Authorization = `Bearer ${token.jwt}`;
  return { ...config, headers: newHeaders };
}

// ============================================================================
// Unified Connection Interface (Daemon + Direct)
// ============================================================================

/**
 * Get a unified connection to an MCP server
 *
 * If daemon mode is enabled (default), tries to use a cached daemon connection.
 * Falls back to direct connection if daemon fails or is disabled.
 *
 * @param serverName - Name of the server from config
 * @param config - Server configuration
 * @returns McpConnection with listTools, callTool, and close methods
 */
export async function getConnection(
  serverName: string,
  config: ServerConfig,
): Promise<McpConnection> {
  // Clean up any orphaned daemons on first call
  await cleanupOrphanedDaemons();

  // Swap x-api-key for a Bearer JWT if the cache layer can provide one.
  // No-op if caching is disabled, the server isn't HTTP, or no API key is set.
  const resolvedConfig = await transformConfigWithJwt(serverName, config);

  // Extract JWT for error annotation (temporary — to aid regression analysis).
  const authHeader =
    isHttpServer(resolvedConfig) && resolvedConfig.headers?.Authorization;
  const usedJwt =
    typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
      ? authHeader.slice('Bearer '.length)
      : null;

  // If an error message already mentions "JWT", append the actual token so
  // callers can inspect it. TODO: remove once the regression is resolved.
  function annotateJwtError(err: unknown): never {
    if (usedJwt && err instanceof Error && /\bjwt\b/i.test(err.message)) {
      err.message = `${err.message}\n  JWT: ${usedJwt}`;
    }
    throw err;
  }

  // Try daemon connection if enabled
  if (isDaemonEnabled()) {
    try {
      const daemonConn = await getDaemonConnection(serverName, resolvedConfig);
      if (daemonConn) {
        debug(`Using daemon connection for ${serverName}`);
        return {
          async listTools(): Promise<ToolInfo[]> {
            const data = await timeMcp(() =>
              daemonConn.listTools().catch(annotateJwtError),
            );
            const tools = data as ToolInfo[];
            // Apply tool filtering from config
            return filterTools(tools, config);
          },
          async callTool(
            toolName: string,
            args: Record<string, unknown>,
          ): Promise<unknown> {
            // Check if tool is allowed before calling
            if (!isToolAllowed(toolName, config)) {
              throw new Error(
                `Tool "${toolName}" is disabled by configuration`,
              );
            }
            return timeMcp(() =>
              daemonConn.callTool(toolName, args).catch(annotateJwtError),
            );
          },
          async getInstructions(): Promise<string | undefined> {
            return daemonConn.getInstructions();
          },
          async close(): Promise<void> {
            await daemonConn.close();
          },
          isDaemon: true,
        };
      }
    } catch (err) {
      debug(
        `Daemon connection failed for ${serverName}: ${(err as Error).message}, falling back to direct`,
      );
    }
  }

  // Fall back to direct connection
  debug(`Using direct connection for ${serverName}`);
  const { client, close } = await connectToServer(serverName, resolvedConfig);

  return {
    async listTools(): Promise<ToolInfo[]> {
      const tools = await timeMcp(() =>
        listTools(client).catch(annotateJwtError),
      );
      // Apply tool filtering from config
      return filterTools(tools, config);
    },
    async callTool(
      toolName: string,
      args: Record<string, unknown>,
    ): Promise<unknown> {
      // Check if tool is allowed before calling
      if (!isToolAllowed(toolName, config)) {
        throw new Error(`Tool "${toolName}" is disabled by configuration`);
      }
      return timeMcp(() => callTool(client, toolName, args).catch(annotateJwtError));
    },
    async getInstructions(): Promise<string | undefined> {
      return client.getInstructions();
    },
    async close(): Promise<void> {
      await close();
    },
    isDaemon: false,
  };
}
