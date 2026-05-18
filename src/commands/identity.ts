/**
 * ping / whoami commands — both call crud/getCurrentUser and surface
 * either a connectivity check or basic identity info.
 */

import { type McpConnection, getConnection, safeClose } from '../client.js';
import {
  type McpServersConfig,
  type ServerConfig,
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
import { McpToolError } from '../output.js';

const SERVER = 'crud';
const TOOL = 'getCurrentUser';

export interface IdentityOptions {
  configPath?: string;
}

interface CurrentUser {
  email?: string | null;
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
 */
export async function pingCommand(options: IdentityOptions): Promise<void> {
  try {
    const { elapsedMs } = await fetchCurrentUser(options.configPath);
    console.log(`OK — server responded in ${elapsedMs} ms`);
  } catch (error) {
    const err = error as Error & { exitCode?: number };
    console.error(`FAIL — ${SERVER}/${TOOL} unreachable`);
    console.error(err.message);
    process.exit(err.exitCode ?? ErrorCode.CLIENT_ERROR);
  }
}

/**
 * whoami — calls crud/getCurrentUser and prints the key identity fields.
 */
export async function whoamiCommand(options: IdentityOptions): Promise<void> {
  let user: CurrentUser;
  try {
    ({ user } = await fetchCurrentUser(options.configPath));
  } catch (error) {
    const err = error as Error & { exitCode?: number };
    console.error(err.message);
    process.exit(err.exitCode ?? ErrorCode.CLIENT_ERROR);
  }

  const rows: Array<[string, string]> = [
    ['email', user.email ?? '(none)'],
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

  const width = Math.max(...rows.map(([k]) => k.length));
  for (const [k, v] of rows) {
    console.log(`${k.padEnd(width)}  ${v}`);
  }
}
