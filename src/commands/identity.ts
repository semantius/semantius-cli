/**
 * ping / whoami commands — both call crud/getCurrentUser and surface
 * either a connectivity check or basic identity info.
 */

import { type McpConnection, getConnection, safeClose } from '../client.js';
import {
  type McpServersConfig,
  type ServerConfig,
  getLoadedEnvDir,
  getServerConfig,
  loadConfig,
} from '../config.js';
import {
  ErrorCode,
  formatCliError,
  isAuthErrorMessage,
  serverConnectionError,
  toolExecutionError,
} from '../errors.js';
import { getRecordedJwt } from '../logger.js';
import { McpToolError } from '../output.js';

const SERVER = 'crud';
const TOOL = 'getCurrentUser';

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function localTimestamp(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function localTimeOfDay(d: Date = new Date()): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(3)} s`;
}

export interface IdentityOptions {
  configPath?: string;
}

export interface WhoamiOptions extends IdentityOptions {
  diag?: boolean;
}

export interface PingOptions extends IdentityOptions {
  count?: number;
}

interface CurrentUser {
  email?: string | null;
  display_name?: string | null;
  user_id?: number | string | null;
  external_id?: string | null;
  semantius_org?: string | null;
  api_baseurl?: string | null;
  roles?: Array<{ role_name?: string }>;
  permissions?: string[];
}

/**
 * Connect to crud, call getCurrentUser, and return the parsed user object.
 * Throws Error with a pre-formatted CLI message on failure.
 */
async function fetchCurrentUser(
  configPath: string | undefined,
): Promise<{ user: CurrentUser; elapsedMs: number }> {
  let config: McpServersConfig;
  try {
    config = await loadConfig(configPath);
  } catch (error) {
    throw new Error((error as Error).message);
  }

  let serverConfig: ServerConfig;
  try {
    serverConfig = getServerConfig(config, SERVER);
  } catch (error) {
    throw new Error((error as Error).message);
  }

  const start = Date.now();
  let connection: McpConnection;
  try {
    connection = await getConnection(SERVER, serverConfig);
  } catch (error) {
    const message = (error as Error).message;
    const err = new Error(
      formatCliError(serverConnectionError(SERVER, message)),
    );
    (err as Error & { exitCode?: number }).exitCode = isAuthErrorMessage(
      message,
    )
      ? ErrorCode.AUTH_ERROR
      : ErrorCode.NETWORK_ERROR;
    throw err;
  }

  let result: unknown;
  try {
    result = await connection.callTool(TOOL, {});
  } catch (error) {
    const errMsg = (error as Error).message;
    const wrapped = new Error(
      formatCliError(toolExecutionError(TOOL, SERVER, errMsg)),
    );
    (wrapped as Error & { exitCode?: number }).exitCode = isAuthErrorMessage(
      errMsg,
    )
      ? ErrorCode.AUTH_ERROR
      : ErrorCode.SERVER_ERROR;
    await safeClose(connection.close);
    throw wrapped;
  }
  const elapsedMs = Date.now() - start;

  await safeClose(connection.close);

  // Parse the MCP tool result envelope: { content: [{ type: 'text', text: '...' }], isError? }
  const r = result as {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };

  const text =
    r.content
      ?.filter((c) => c.type === 'text' && c.text)
      .map((c) => c.text as string)
      .join('\n') ?? '';

  if (r.isError) {
    const wrapped = new Error(
      formatCliError(toolExecutionError(TOOL, SERVER, text || 'unknown error')),
    );
    (wrapped as Error & { exitCode?: number }).exitCode = isAuthErrorMessage(
      text,
    )
      ? ErrorCode.AUTH_ERROR
      : ErrorCode.SERVER_ERROR;
    throw wrapped;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new McpToolError(
      `Unexpected response from ${SERVER}/${TOOL}: not valid JSON.\n${text}`,
      result,
    );
  }

  // Unwrap the postgrestRequest envelope: { request, response: { data, ... } }
  let user: unknown = parsed;
  if (
    parsed !== null &&
    typeof parsed === 'object' &&
    'response' in parsed &&
    typeof (parsed as Record<string, unknown>).response === 'object' &&
    (parsed as Record<string, unknown>).response !== null &&
    'data' in
      ((parsed as Record<string, unknown>).response as Record<string, unknown>)
  ) {
    user = (
      (parsed as Record<string, unknown>).response as Record<string, unknown>
    ).data;
  }

  return { user: user as CurrentUser, elapsedMs };
}

/**
 * ping — calls crud/getCurrentUser, measures wall clock time, prints
 * either a one-line success message or formatted error details.
 *
 * With -n > 1, runs the call N times sequentially, prints per-request
 * latency, and appends min/max/avg over successful requests. Exits non-zero
 * if any request failed.
 */
export async function pingCommand(options: PingOptions): Promise<void> {
  const count = options.count && options.count > 0 ? options.count : 1;

  if (count === 1) {
    try {
      const { elapsedMs } = await fetchCurrentUser(options.configPath);
      console.log(
        `[${localTimeOfDay()}] OK — server responded in ${formatSeconds(elapsedMs)}`,
      );
    } catch (error) {
      const err = error as Error & { exitCode?: number };
      console.error(
        `[${localTimeOfDay()}] FAIL — ${SERVER}/${TOOL} unreachable`,
      );
      console.error(err.message);
      process.exit(err.exitCode ?? ErrorCode.CLIENT_ERROR);
    }
    return;
  }

  const successes: number[] = [];
  let lastFailExitCode: number | undefined;
  const indexWidth = String(count).length;

  for (let i = 1; i <= count; i++) {
    const label = `${String(i).padStart(indexWidth, ' ')}/${count}`;
    try {
      const { elapsedMs } = await fetchCurrentUser(options.configPath);
      successes.push(elapsedMs);
      console.log(
        `[${localTimeOfDay()}] ${label}  OK   ${formatSeconds(elapsedMs)}`,
      );
    } catch (error) {
      const err = error as Error & { exitCode?: number };
      lastFailExitCode = err.exitCode ?? ErrorCode.CLIENT_ERROR;
      const firstLine = err.message.split('\n')[0];
      console.log(`[${localTimeOfDay()}] ${label}  FAIL ${firstLine}`);
    }
  }

  const failed = count - successes.length;
  const successPct = Math.round((successes.length / count) * 100);
  console.log('');
  console.log(
    `    Requests: Sent = ${count}, OK = ${successes.length}, Failed = ${failed} (${successPct}% success),`,
  );

  if (successes.length === 0) {
    process.exit(lastFailExitCode ?? ErrorCode.CLIENT_ERROR);
  }

  const min = Math.min(...successes);
  const max = Math.max(...successes);
  const avg = successes.reduce((a, b) => a + b, 0) / successes.length;
  console.log('Approximate round trip times in seconds:');
  console.log(
    `    Minimum = ${formatSeconds(min)}, Maximum = ${formatSeconds(max)}, Average = ${formatSeconds(avg)}`,
  );

  // Match unix/Windows ping convention: exit 0 if any request succeeded.
  // Success rate above tells the caller how clean the run actually was.
}

/**
 * whoami — prints the local config source first (so it's visible even when
 * the remote call fails), then calls crud/getCurrentUser and prints the
 * key identity fields.
 */
export async function whoamiCommand(options: WhoamiOptions): Promise<void> {
  const envDir = getLoadedEnvDir();
  const configSource = envDir ?? 'shell environment';
  console.log(`${localTimestamp()}  config_source  ${configSource}`);

  let user: CurrentUser;
  try {
    ({ user } = await fetchCurrentUser(options.configPath));
  } catch (error) {
    const err = error as Error & { exitCode?: number };
    console.error(err.message);
    // Even on failure, surface the bearer token under --diag — it's exactly
    // the case (audience mismatch, expired, wrong key) where the user needs
    // to see what was actually sent.
    if (options.diag) {
      console.error(`bearer_token  ${getRecordedJwt() ?? '(none)'}`);
    }
    process.exit(err.exitCode ?? ErrorCode.CLIENT_ERROR);
  }

  const rows: Array<[string, string]> = [
    ['email', user.email ?? '(none)'],
    ['display_name', user.display_name ?? '(none)'],
    ['org', user.semantius_org ?? '(unknown)'],
    ['user_id', user.user_id != null ? String(user.user_id) : '(unknown)'],
    [
      'roles',
      user.roles?.length
        ? user.roles
            .map((r) => r.role_name)
            .filter(Boolean)
            .join(', ')
        : '(none)',
    ],
    ['api_baseurl', user.api_baseurl ?? '(unknown)'],
  ];

  if (options.diag) {
    rows.push(['bearer_token', getRecordedJwt() ?? '(none)']);
  }

  const width = Math.max(...rows.map(([k]) => k.length));
  for (const [k, v] of rows) {
    console.log(`${k.padEnd(width)}  ${v}`);
  }
}
