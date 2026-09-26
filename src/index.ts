#!/usr/bin/env bun
/**
 * semantius - A lightweight CLI for interacting with MCP servers
 *
 * Commands:
 *   semantius                         List all servers and tools
 *   semantius info <server>            Show server details
 *   semantius info <server> <tool>     Show tool schema
 *   semantius grep <pattern>           Search tools by glob pattern
 *   semantius call <server> <tool>     Call tool (reads JSON from stdin if no args)
 *   semantius call <server> <tool> {}  Call tool with JSON args
 */

import { readFileSync } from 'node:fs';
import { version as VERSION } from '../package.json' with { type: 'json' };
import { loginCommand, logoutCommand } from './commands/auth.js';
import { callCommand } from './commands/call.js';
import { grepCommand } from './commands/grep.js';
import { hostsCommand, useCommand } from './commands/hosts.js';
import { pingCommand, whoamiCommand } from './commands/identity.js';
import { infoCommand } from './commands/info.js';
import { listCommand } from './commands/list.js';
import { markdownCommand } from './commands/markdown.js';
import {
  type AuthFlag,
  DEFAULT_CONCURRENCY,
  DEFAULT_MAX_RETRIES,
  DEFAULT_RETRY_DELAY_MS,
  DEFAULT_TIMEOUT_SECONDS,
  type LoginFlow,
  getLoginFlow,
  getMissingRequiredEnvVars,
  getUserConfigDir,
  ignoreEnvCredentials,
  isCrudMcp,
  isSessionOnlyHost,
  loadDotEnv,
  migrateUserConfigDir,
  prefixedEnvName,
  setAuthFlag,
  setCrudMcpFlag,
  setEnvPrefix,
  setHostFlag,
  setLoginFlow,
  setTokenArg,
  splitOrgPrefix,
} from './config.js';
import { runDaemonFromArgv } from './daemon.js';
import {
  ErrorCode,
  ambiguousCommandError,
  formatCliError,
  missingArgumentError,
  tooManyArgumentsError,
  unknownOptionError,
  unknownSubcommandError,
} from './errors.js';
import {
  deleteHostCache,
  getHost,
  getHostMode,
  normalizeHost,
  propagateOrg,
} from './host.js';
import {
  deleteCachedToken,
  getCachePath,
  parseApiKey,
  setJwtCacheDisabled,
} from './jwt-cache.js';
import { enableFromEnv, initLogger, recordError } from './logger.js';

interface ParsedArgs {
  command:
    | 'list'
    | 'info'
    | 'grep'
    | 'call'
    | 'help'
    | 'version'
    | 'markdown'
    | 'ping'
    | 'whoami'
    | 'login'
    | 'logout'
    | 'hosts'
    | 'use';
  server?: string;
  tool?: string;
  pattern?: string;
  args?: string;
  withDescriptions: boolean;
  withMarkdown: boolean;
  configPath?: string;
  diag: boolean;
  single: boolean;
  stream: boolean;
  envPrefix: string;
  host?: string;
  /** --token <org:jwt | ->; undefined unless the flag was given. */
  token?: string;
  tokenFile?: string;
  /** Positional argument for "use"; absent when --clear is given instead. */
  useHost?: string;
  /** --json, for "hosts" only. */
  json: boolean;
  /** --clear, for "use" only: clear the current host instead of setting one. */
  clear: boolean;
  crudMcp: boolean;
  pingCount?: number;
  disableJwtCache: boolean;
  resetCache: boolean;
  auth?: AuthFlag;
  loginFlow?: LoginFlow;
  login: boolean;
}

/**
 * Known subcommands
 */
const SUBCOMMANDS = [
  'info',
  'grep',
  'call',
  'ping',
  'whoami',
  'login',
  'logout',
  'hosts',
  'use',
] as const;

/**
 * Check if a string looks like a subcommand (not a server name)
 */
function isKnownSubcommand(arg: string): boolean {
  return SUBCOMMANDS.includes(arg as (typeof SUBCOMMANDS)[number]);
}

/**
 * Check if a string looks like it could be an unknown subcommand
 * (common aliases that users might try)
 */
function isPossibleSubcommand(arg: string): boolean {
  const aliases = [
    'run',
    'execute',
    'exec',
    'invoke',
    'list',
    'ls',
    'get',
    'show',
    'describe',
    'search',
    'find',
    'query',
  ];
  return aliases.includes(arg.toLowerCase());
}

/**
 * Parse server/tool from either "server/tool" or "server tool" format
 */
function parseServerTool(args: string[]): { server: string; tool?: string } {
  if (args.length === 0) {
    return { server: '' };
  }

  const first = args[0];

  // Check for slash format: server/tool
  if (first.includes('/')) {
    const slashIndex = first.indexOf('/');
    return {
      server: first.substring(0, slashIndex),
      tool: first.substring(slashIndex + 1) || undefined,
    };
  }

  // Space format: server tool
  return {
    server: first,
    tool: args[1],
  };
}

/**
 * Lightweight scan for --env <prefix> so the logger and env lookups can be
 * configured before the full parseArgs runs (and before it can exit on a
 * parse error). Returns the default 'SEMANTIUS' if --env isn't present or
 * its value is missing/invalid; the full parser will surface the error.
 */
function findEnvPrefix(args: string[]): string {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '--env') {
      const value = args[i + 1];
      if (value && !value.startsWith('-')) {
        return value.toUpperCase();
      }
    }
  }
  return 'SEMANTIUS';
}

/**
 * Lightweight scan for --host <value>, same pattern as findEnvPrefix, so the
 * host is known even on paths where parseArgs returns early (-h, -v) and for
 * the startup host check. The full parser validates the value.
 */
function findHostFlag(args: string[]): string | undefined {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '--host') {
      const value = args[i + 1];
      if (value && !value.startsWith('-')) return value;
    }
  }
  return undefined;
}

/**
 * Lightweight scan for --token / --token-file, same pattern as findHostFlag.
 * Only the literal form is acted on early (to suppress missingHostWarning on
 * -h / -v paths, which return before parseArgs would see it if the flag comes
 * after -h/-v in argv) — stdin and a file are never read this early; the full
 * resolution after parseArgs handles those, and never runs for help/version.
 */
function findTokenArgs(args: string[]): {
  literal?: string;
  stdin?: boolean;
  file?: string;
} {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '--token') {
      const value = args[i + 1];
      if (value === '-') return { stdin: true };
      if (value && !value.startsWith('-')) return { literal: value };
    } else if (args[i] === '--token-file') {
      const value = args[i + 1];
      if (value && !value.startsWith('-')) return { file: value };
    }
  }
  return {};
}

/**
 * Parse command line arguments
 */
function parseArgs(args: string[]): ParsedArgs {
  const result: ParsedArgs = {
    command: 'info',
    withDescriptions: false,
    withMarkdown: false,
    diag: false,
    single: false,
    stream: false,
    envPrefix: 'SEMANTIUS',
    json: false,
    clear: false,
    crudMcp: false,
    disableJwtCache: false,
    resetCache: false,
    login: false,
  };

  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case '-h':
      case '--help':
        result.command = 'help';
        return result;

      case '-v':
      case '--version':
        result.command = 'version';
        return result;

      case '-d':
      case '--with-descriptions':
        result.withDescriptions = true;
        break;

      case '-md':
      case '--markdown':
        result.withMarkdown = true;
        break;

      case '--diag':
        result.diag = true;
        break;

      case '--json':
        result.json = true;
        break;

      case '--clear':
        result.clear = true;
        break;

      case '--single':
        result.single = true;
        break;

      case '--stream':
        result.stream = true;
        break;

      case '--disable-jwt-cache':
        result.disableJwtCache = true;
        break;

      case '--reset-cache':
      case '--reset-jwt-cache':
        result.resetCache = true;
        break;

      case '--crud-mcp':
        result.crudMcp = true;
        break;

      case '--login':
        result.login = true;
        break;

      case '--auth': {
        const source = args[++i];
        if (!source) {
          console.error(
            formatCliError(missingArgumentError('--auth', 'jwt|apikey|oauth')),
          );
          process.exit(ErrorCode.CLIENT_ERROR);
        }
        if (source !== 'jwt' && source !== 'apikey' && source !== 'oauth') {
          console.error(
            formatCliError({
              code: ErrorCode.CLIENT_ERROR,
              type: 'INVALID_OPTION',
              message: `Invalid --auth value "${source}"`,
              suggestion: 'Use --auth jwt, --auth apikey or --auth oauth',
            }),
          );
          process.exit(ErrorCode.CLIENT_ERROR);
        }
        result.auth = source;
        break;
      }

      case '--login-flow': {
        const value = args[++i];
        if (!value) {
          console.error(
            formatCliError(
              missingArgumentError('--login-flow', 'auto|browser|device'),
            ),
          );
          process.exit(ErrorCode.CLIENT_ERROR);
        }
        if (value !== 'auto' && value !== 'browser' && value !== 'device') {
          console.error(
            formatCliError({
              code: ErrorCode.CLIENT_ERROR,
              type: 'INVALID_OPTION',
              message: `Invalid --login-flow value "${value}"`,
              suggestion:
                'Use --login-flow auto, --login-flow browser or --login-flow device',
            }),
          );
          process.exit(ErrorCode.CLIENT_ERROR);
        }
        result.loginFlow = value;
        break;
      }

      case '--host': {
        const host = args[++i];
        if (!host) {
          console.error(
            formatCliError(missingArgumentError('--host', 'url or hostname')),
          );
          process.exit(ErrorCode.CLIENT_ERROR);
        }
        try {
          normalizeHost(host);
        } catch (error) {
          console.error((error as Error).message);
          process.exit(ErrorCode.CLIENT_ERROR);
        }
        result.host = host;
        break;
      }

      case '--token':
        // Validated and resolved in main(), after the full parse: the value
        // may be "-" (read stdin) or a literal, and turning it into a bound
        // credential needs async I/O this synchronous parser doesn't do.
        result.token = args[++i];
        if (!result.token) {
          console.error(
            formatCliError(missingArgumentError('--token', 'org:jwt or -')),
          );
          process.exit(ErrorCode.CLIENT_ERROR);
        }
        break;

      case '--token-file':
        result.tokenFile = args[++i];
        if (!result.tokenFile) {
          console.error(
            formatCliError(missingArgumentError('--token-file', 'path')),
          );
          process.exit(ErrorCode.CLIENT_ERROR);
        }
        break;

      case '-c':
      case '--config':
        result.configPath = args[++i];
        if (!result.configPath) {
          console.error(
            formatCliError(missingArgumentError('-c/--config', 'path')),
          );
          process.exit(ErrorCode.CLIENT_ERROR);
        }
        break;

      case '--env': {
        const prefix = args[++i];
        if (!prefix) {
          console.error(
            formatCliError(missingArgumentError('--env', 'prefix')),
          );
          process.exit(ErrorCode.CLIENT_ERROR);
        }
        result.envPrefix = prefix.toUpperCase();
        break;
      }

      case '-n': {
        // -n is optional; its argument is optional. Default count is 5.
        const next = args[i + 1];
        if (next !== undefined && /^\d+$/.test(next)) {
          const parsed = Number.parseInt(next, 10);
          if (parsed <= 0) {
            console.error(
              formatCliError(missingArgumentError('-n', 'positive integer')),
            );
            process.exit(ErrorCode.CLIENT_ERROR);
          }
          result.pingCount = parsed;
          i++;
        } else {
          result.pingCount = 5;
        }
        break;
      }

      default:
        // Single '-' is allowed (stdin indicator), but other dash-prefixed args are options
        if (arg.startsWith('-') && arg !== '-') {
          console.error(formatCliError(unknownOptionError(arg)));
          process.exit(ErrorCode.CLIENT_ERROR);
        }
        positional.push(arg);
    }
  }

  // No positional args = list all servers (or markdown dump if -md)
  if (positional.length === 0) {
    result.command = result.withMarkdown ? 'markdown' : 'list';
    return result;
  }

  const firstArg = positional[0];

  // =========================================================================
  // Explicit subcommand routing
  // =========================================================================

  if (firstArg === 'info') {
    const remaining = positional.slice(1);
    const { server, tool } = parseServerTool(remaining);

    // info without a server → markdown dump if -md, otherwise list all servers
    if (!server) {
      result.command = result.withMarkdown ? 'markdown' : 'list';
      return result;
    }

    result.command = 'info';
    result.server = server;
    result.tool = tool;
    return result;
  }

  if (firstArg === 'grep') {
    result.command = 'grep';
    result.pattern = positional[1];
    if (!result.pattern) {
      console.error(formatCliError(missingArgumentError('grep', 'pattern')));
      process.exit(ErrorCode.CLIENT_ERROR);
    }
    if (positional.length > 2) {
      console.error(
        formatCliError(tooManyArgumentsError('grep', positional.length - 1, 1)),
      );
      process.exit(ErrorCode.CLIENT_ERROR);
    }
    return result;
  }

  if (firstArg === 'ping') {
    if (positional.length > 1) {
      console.error(
        formatCliError(tooManyArgumentsError('ping', positional.length - 1, 0)),
      );
      process.exit(ErrorCode.CLIENT_ERROR);
    }
    result.command = 'ping';
    return result;
  }

  if (firstArg === 'whoami') {
    if (positional.length > 1) {
      console.error(
        formatCliError(
          tooManyArgumentsError('whoami', positional.length - 1, 0),
        ),
      );
      process.exit(ErrorCode.CLIENT_ERROR);
    }
    result.command = 'whoami';
    return result;
  }

  if (firstArg === 'login' || firstArg === 'logout') {
    if (positional.length > 1) {
      console.error(
        formatCliError(
          tooManyArgumentsError(firstArg, positional.length - 1, 0),
        ),
      );
      process.exit(ErrorCode.CLIENT_ERROR);
    }
    result.command = firstArg;
    return result;
  }

  if (firstArg === 'hosts') {
    if (positional.length > 1) {
      console.error(
        formatCliError(
          tooManyArgumentsError('hosts', positional.length - 1, 0),
        ),
      );
      process.exit(ErrorCode.CLIENT_ERROR);
    }
    result.command = 'hosts';
    return result;
  }

  if (firstArg === 'use') {
    if (result.clear) {
      if (positional.length > 1) {
        console.error(
          formatCliError({
            code: ErrorCode.CLIENT_ERROR,
            type: 'INVALID_OPTION',
            message: '--clear cannot be combined with a host argument',
            suggestion:
              'Use "semantius use --clear" on its own, or "semantius use <host>" without --clear',
          }),
        );
        process.exit(ErrorCode.CLIENT_ERROR);
      }
      result.command = 'use';
      return result;
    }
    if (positional.length > 2) {
      console.error(
        formatCliError(tooManyArgumentsError('use', positional.length - 1, 1)),
      );
      process.exit(ErrorCode.CLIENT_ERROR);
    }
    result.useHost = positional[1];
    if (!result.useHost) {
      console.error(formatCliError(missingArgumentError('use', 'host')));
      process.exit(ErrorCode.CLIENT_ERROR);
    }
    result.command = 'use';
    return result;
  }

  if (firstArg === 'call') {
    result.command = 'call';
    const remaining = positional.slice(1);

    if (remaining.length === 0) {
      console.error(
        formatCliError(missingArgumentError('call', 'server and tool')),
      );
      process.exit(ErrorCode.CLIENT_ERROR);
    }

    // Parse server/tool from remaining args
    const { server, tool } = parseServerTool(remaining);
    result.server = server;

    if (!tool) {
      // Check if it was slash format without tool
      if (remaining[0].includes('/') && !remaining[0].split('/')[1]) {
        console.error(formatCliError(missingArgumentError('call', 'tool')));
        process.exit(ErrorCode.CLIENT_ERROR);
      }
      // Space format with only server
      if (remaining.length < 2) {
        console.error(formatCliError(missingArgumentError('call', 'tool')));
        process.exit(ErrorCode.CLIENT_ERROR);
      }
    }

    result.tool = tool;

    // Determine where args start
    let argsStartIndex: number;
    if (remaining[0].includes('/')) {
      // slash format: call server/tool '{}' → args at index 1
      argsStartIndex = 1;
    } else {
      // space format: call server tool '{}' → args at index 2
      argsStartIndex = 2;
    }

    // Collect remaining args as JSON (support '-' for stdin)
    const jsonArgs = remaining.slice(argsStartIndex);
    if (jsonArgs.length > 0) {
      const argsValue = jsonArgs.join(' ');
      result.args = argsValue === '-' ? undefined : argsValue;
    }

    return result;
  }

  // =========================================================================
  // Check for unknown subcommand (common aliases)
  // =========================================================================

  if (isPossibleSubcommand(firstArg)) {
    console.error(formatCliError(unknownSubcommandError(firstArg)));
    process.exit(ErrorCode.CLIENT_ERROR);
  }

  // =========================================================================
  // Slash format without subcommand → error (require explicit subcommand)
  // =========================================================================

  if (firstArg.includes('/')) {
    const parts = firstArg.split('/');
    const serverName = parts[0];
    const toolName = parts[1] || '';
    const hasArgs = positional.length > 1;
    console.error(
      formatCliError(ambiguousCommandError(serverName, toolName, hasArgs)),
    );
    process.exit(ErrorCode.CLIENT_ERROR);
  }

  // =========================================================================
  // Ambiguous command detection: server tool without subcommand
  // =========================================================================

  if (positional.length >= 2) {
    const serverName = positional[0];
    const possibleTool = positional[1];

    // Check if second arg looks like a tool name (not JSON)
    const looksLikeJson =
      possibleTool.startsWith('{') || possibleTool.startsWith('[');
    const looksLikeToolName = /^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(possibleTool);

    if (!looksLikeJson && looksLikeToolName) {
      const hasArgs = positional.length > 2;
      console.error(
        formatCliError(
          ambiguousCommandError(serverName, possibleTool, hasArgs),
        ),
      );
      process.exit(ErrorCode.CLIENT_ERROR);
    }
  }

  // =========================================================================
  // Default: single server name → info
  // =========================================================================

  result.command = 'info';
  result.server = firstArg;
  return result;
}

/**
 * Print help message
 */
/**
 * Warning block for help/version when no host is configured (empty otherwise).
 */
function missingHostWarning(): string {
  if (getMissingRequiredEnvVars().length === 0) return '';
  return `
⚠  No host configured: set ${prefixedEnvName('ORG')} or --host (or ${prefixedEnvName('HOST')}).
   Set it in ${getUserConfigDir()}/.env or export it in your shell.
   Or run "semantius use <host>" to sign in (with the browser, if needed) and
   make it your current host for every directory.
   Generate an API key at https://app.semantius.com/dashboard`;
}

function printHelp(): void {
  const orgVar = prefixedEnvName('ORG');
  const hostVar = prefixedEnvName('HOST');
  const apiKeyVar = prefixedEnvName('API_KEY');
  const jwtVar = prefixedEnvName('JWT');
  const configDir = getUserConfigDir();

  console.log(`
semantius v${VERSION} - CLI for the Semantius platform

Usage:
  semantius [options]                              List all servers and tools
  semantius [options] info <server>                Show server details
  semantius [options] info <server> <tool>         Show tool schema
  semantius [options] grep <pattern>               Search tools by glob pattern
  semantius [options] call <server> <tool>         Call tool (reads JSON from stdin if no args)
  semantius [options] call <server> <tool> <json>  Call tool with JSON arguments
  semantius [options] ping [-n [count]]            Check connectivity & latency: crud/getCurrentUser, one PostgREST
                                                   round trip (the cloud MCP server with --crud-mcp)
  semantius [options] whoami                       Show current user (email, org, roles)
  semantius [options] login                        Sign in with the browser and store the session for the host
  semantius [options] logout                       Revoke and delete the stored session for the host
  semantius [options] hosts [--json]                List every host this machine has a session or is current for
  semantius use <host>                             Make <host> the current host (signs in with the browser first if needed)
  semantius use --clear                            Unset the current host (session and hosts entry untouched)

Formats (both work):
  semantius info server tool                       Space-separated
  semantius info server/tool                       Slash-separated
  semantius call server tool '{}'                  Space-separated
  semantius call server/tool '{}'                  Slash-separated

Built-in servers:
  "crud" runs the Semantius crud tools inside the CLI against your tenant's PostgREST API
  (--crud-mcp sends them to the Semantius cloud MCP server instead).
  A "utils" server with local tools (get_csvschema) is always
  available alongside configured servers, e.g. semantius call utils/get_csvschema '{"path":"data.csv"}'
  Its export_entities / export_module write entities or a whole module, schema and records, to one
  JSON file; import_entities / import_module replay it onto another host as an upsert, e.g.
    semantius --host stage.example.com call utils/export_module '{"name":"CRM","path":"crm.json"}'
    semantius --host prod.example.com call utils/import_module '{"path":"crm.json"}'

Credentials (first match wins):
  1. ${jwtVar.padEnd(22)} Static token, sent as-is (no exchange, no cache)
  2. ${apiKeyVar.padEnd(22)} Exchanged for a short-lived token at the host; cached per host
  3. ${'browser login'.padEnd(22)} The session stored for this host (kept in the OS keyring,
                            refreshed automatically)
  Without any of them, commands that call the platform exit 5 ("Authentication required").
  --auth jwt|apikey|oauth picks one source explicitly. --token/--token-file supply their
  own JWT directly (see below) and are not affected by --auth.

  With --host, or on the current host (see "hosts"/"use" below), only a stored browser
  session is used — a leftover API key / JWT / org in the environment is ignored (not
  an error). To pair a host with an API key instead, set ${hostVar} alongside
  ${apiKeyVar} (shell, or the same .env file), or use --env <prefix> for a second pair.

  An "org:" prefix on ${apiKeyVar} / ${jwtVar} binds it to that org's host. It is only
  compared against a ${hostVar} set alongside it (same shell, or the same .env file):
  naming a *different* host there is a HOST_CONFLICT error. A ${hostVar} or current host
  resolved before that credential is even reached is never compared against it — and the
  credential itself is then ignored, since it was never issued for the host actually in use.

Hosts:
  The CLI talks to one host per invocation, first match wins: --host, then --token's own
  org, then the current host ("semantius use", below), then ${hostVar} / ${orgVar} — checked
  in the shell environment, then the project's .env, then the global .env, host before org
  at each. "semantius use <host>" signs in with the browser first if there is no stored
  session yet, then makes <host> the current host, overriding ${hostVar} / ${orgVar}
  everywhere until changed; "semantius use --clear" unsets it again (the session and hosts
  entry are kept — "semantius logout" is what removes those). "semantius login" only stores
  a session for the host it resolves to — it never changes the current host. "semantius
  hosts" lists every host this machine knows about, marking the current one.

Options:
  -h, --help               Show this help message
  -v, --version            Show version number
  -d, --with-descriptions  Include tool descriptions
  -md, --markdown          Dump full documentation as markdown (README, SKILL, all tools)
  --diag                   (call) Output full JSON response instead of just response.data
                           (whoami) Also show the bearer token used for the request
  --json                   (hosts only) Machine-readable output instead of the table
  --clear                  (use only) Unset the current host instead of setting one: "semantius use --clear"
  --single                 (call only) Expect exactly one row; exit 1 on 0 rows, exit 2 on 2+ rows.
                           Rejected (exit 1) for bulk calls: an array in data/body/id/table_name
  --stream                 (call crud postgrestRequest only) Pipe the PostgREST response body to stdout
                           unchanged: compact JSON, or CSV with "accept":"text/csv". Fastest for large
                           reads. Not with --single, --diag or --crud-mcp. Also: SEMANTIUS_STREAM=1
                           (applies only where --stream is valid)
  -n [count]               (ping only) Run N pings and report min/max/avg. Default: 5 when -n is given
  --env <prefix>           Env var prefix (default: SEMANTIUS). E.g. --env PROD uses PROD_API_KEY / PROD_ORG
  --host <hostname>        Semantius host, hostname[:port] (a leading https:// is ignored):
                           <org>.semantius.cloud is the managed cloud, any other host is self-hosted.
                           Always HTTPS, except localhost / 127.x.x.x (plain HTTP). Uses only the
                           credentials stored for that host (see Credentials)
  --auth <source>          Use exactly one credential source: jwt, apikey or oauth (the stored
                           browser session). Not with --host for jwt/apikey — see Credentials
  --token <org:jwt | ->    A JWT for the invocation, binding it to <org>.semantius.cloud — wins
                           over the current host and any ${hostVar} / ${orgVar} from the
                           environment or .env. "-" reads it from stdin; a literal value is
                           visible in the shell history and process list — prefer "-" or
                           --token-file. Not with --host, --auth apikey/oauth, or --login
  --token-file <path>      Same as --token, read from a file (org:jwt, trimmed)
  --login                  Sign in with the browser first, then run the command with that session
                           (needs an interactive terminal)
  --login-flow <mode>      Which grant an interactive login uses: auto (default), browser or
                           device. auto picks the browser when this machine has one, and the
                           device code grant (RFC 8628 — a code you enter on another device) when
                           it does not and the host offers it; it refuses in CI, where nobody can
                           complete a sign-in. browser and device force one and both bypass that
                           CI check. Also: ${prefixedEnvName('LOGIN_FLOW')}
  --crud-mcp               Route the crud server through the Semantius cloud MCP server instead of the
                           local PostgREST layer (cloud only). Also: SEMANTIUS_CRUD_MCP=1
  --disable-jwt-cache      Skip the encrypted token cache (re-authenticate every request). Also: SEMANTIUS_DISABLE_JWT_CACHE=1
  --reset-cache            Delete the cached JWT for the current API key and the cached host lookup
                           before running; the next call fetches fresh ones. Alias: --reset-jwt-cache

Output:
  semantius/info/grep      Human-readable text to stdout
  call                     response.data JSON to stdout (use --diag for full response)
  call ... --stream        The PostgREST body as-is: compact JSON (jq works) or CSV
  Errors                   Always to stderr

Exit codes:
  0   Success
  1   Client error (bad args, config, JSON)  — or --single: 0 rows
  2   --single: 2+ rows
  3   Network / transport error (transient: ECONNREFUSED, ETIMEDOUT, 5xx)
  4   Server error (tool execution failed: RLS, dup key, schema errors)
  5   Auth error (missing/invalid API key, 401, 403)

Examples:
  semantius                                        # List all servers
  semantius -d                                     # List with descriptions
  semantius grep "*crud*"                          # Search for crud tools
  semantius info crud                              # Show server tools
  semantius info crud create_record                # Show tool schema
  semantius call crud create_record '{}'           # Call tool
  cat input.json | semantius call crud create_record  # Read from stdin (no '-' needed)
  semantius --env PROD info crud                   # Use PROD_API_KEY / PROD_ORG
  semantius --host semantius.example.com whoami    # Self-hosted instance
  semantius login --host acme.semantius.app        # Browser login, stored for acme.semantius.cloud
  semantius --host acme.semantius.app whoami       # Uses that stored session
  semantius use acme.semantius.cloud               # Sign in if needed, then make it the current host
  semantius hosts                                  # List every host this machine knows about
  semantius use --clear                            # Stop using a current host; fall back to env/.env
  echo acme:eyJ... | semantius --token - whoami    # A one-off token, from stdin

Environment Variables (all respect --env <prefix>; default prefix shown):
  ${orgVar.padEnd(28)} Organization on the managed cloud; the host defaults to
                               <org>.semantius.cloud. Required unless ${hostVar}, --host,
                               --token or the current host is set (an "org:" prefix on the
                               API key or JWT also supplies it, for whichever of shell,
                               project .env or global .env that variable is set in)
  ${hostVar.padEnd(28)} Hostname, same as --host. Checked before ${orgVar} in each of the
                               shell environment, the project .env and the global .env — but
                               only once --host, --token and the current host (see
                               "hosts"/"use") have all left the host unset. <org>.semantius.app
                               / .ai / .io map to <org>.semantius.cloud
  ${apiKeyVar.padEnd(28)} API key for Semantius (needed to call tools unless ${jwtVar} is set).
                               Value may be "org:key" — the org prefix overrides ${orgVar}
  ${jwtVar.padEnd(28)} Static JWT sent as "Authorization: Bearer" directly; skips
                               the token exchange and the token cache. Value may be "org:jwt"
  SEMANTIUS_CRUD_MCP=1         Same as --crud-mcp
  SEMANTIUS_SIDE_EFFECT_TIMEOUT=N  Max seconds to wait before exiting for the schema-cache
                               refresh that follows entity/field changes (default: 10)
  SEMANTIUS_DEBUG=1            Verbose debug logging to stderr
  SEMANTIUS_TIMEOUT=N          Request timeout in seconds (default: 1800)
  SEMANTIUS_CONCURRENCY=N      Max parallel server connections (default: 5)
  SEMANTIUS_MAX_RETRIES=N      Max retry attempts for transient errors (default: 3)
  SEMANTIUS_RETRY_DELAY=N      Base retry backoff in ms (default: 1000)
  SEMANTIUS_NO_DAEMON=1        Disable connection caching (force fresh connections)
  SEMANTIUS_DISABLE_JWT_CACHE=1 Disable the encrypted token cache (re-authenticate every request)
  SEMANTIUS_DAEMON_TIMEOUT=N   Daemon idle timeout in seconds (default: 300)
  SEMANTIUS_STRICT_ENV=false   Warn (don't error) on unresolved \${VAR} refs in config
  SEMANTIUS_CONFIG_PATH=<path> Path to mcp_servers.json (overrides default search)
  SEMANTIUS_LOG_FILE=<path>    Append one JSONL line per invocation to <path>.
                               Bare filename (e.g. semantius.jsonl) is written
                               next to the loaded .env (or in the user config
                               dir). Absolute or relative paths are used as-is.
                               Daemon start/stop events (daemon_start,
                               daemon_stop with reason + uptime) are also
                               logged, at any level.
  SEMANTIUS_LOG_LEVELS=<list>  Comma-separated subset of {all, error, slow,
                               jwt}. Filters which invocations are logged.
                               Default: all. "error" = exit_code != 0; "slow" =
                               wall time > 1000 ms; "jwt" = error mentions JWT
                               (also adds a structured "jwt" field with the
                               token value and emits one JSONL line per
                               JWT-retry attempt). Multiple values OR-combine
                               (e.g. error,slow logs errors AND slow runs).

Config file location:
  ${configDir}${configDir.endsWith('\\') || configDir.endsWith('/') ? '' : '/'}  (.env or mcp_servers.json)
${missingHostWarning()}`);
}

/**
 * Check at startup that a host is resolvable (${PREFIX}_ORG, --host or
 * ${PREFIX}_HOST). Credentials are not checked here: a command that needs
 * them fails with exit 5 when it authenticates.
 */
function checkRequiredEnvVars(): void {
  const missing = getMissingRequiredEnvVars();

  if (missing.length > 0) {
    const orgVar = prefixedEnvName('ORG');
    for (const v of missing) {
      console.error(
        `Error [MISSING_ENV_VAR]: Required environment variable not set: ${v} (set ${orgVar} or --host, or run "semantius use <host>")`,
      );
    }
    console.error('Generate an API key at https://app.semantius.com/dashboard');
    process.exit(ErrorCode.CLIENT_ERROR);
  }
}

/**
 * Resolve --token / --token-file into a validated org-bound JWT (setTokenArg).
 * literal / stdin ('-') / file are mutually exclusive by construction (parseArgs
 * only sets one of args.token / args.tokenFile, and '-' is a token value, not a
 * file value). Only the literal form warns — it is the only one that puts the
 * token on the command line.
 */
async function resolveTokenArg(
  token: string | undefined,
  tokenFile: string | undefined,
): Promise<void> {
  let literal: string;

  if (tokenFile !== undefined) {
    let content: string;
    try {
      content = readFileSync(tokenFile, 'utf8');
    } catch (error) {
      console.error(
        formatCliError({
          code: ErrorCode.CLIENT_ERROR,
          type: 'TOKEN_FILE_UNREADABLE',
          message: `Could not read --token-file ${tokenFile}: ${(error as Error).message}`,
          suggestion: 'Check the path and that the file is readable',
        }),
      );
      process.exit(ErrorCode.CLIENT_ERROR);
    }
    literal = content.trim();
    if (!literal) {
      console.error(
        formatCliError({
          code: ErrorCode.CLIENT_ERROR,
          type: 'TOKEN_FILE_UNREADABLE',
          message: `--token-file ${tokenFile} is empty`,
          suggestion: 'The file must contain org:jwt',
        }),
      );
      process.exit(ErrorCode.CLIENT_ERROR);
    }
  } else if (token === '-') {
    literal = (await new Response(Bun.stdin).text()).trim();
  } else {
    literal = token as string;
    process.stderr.write(
      '[semantius] Warning: --token puts the token on the command line, visible to other processes and the shell history; prefer --token - or --token-file.\n',
    );
  }

  const { org, value: jwt } = splitOrgPrefix(literal);
  if (!org) {
    console.error(
      formatCliError({
        code: ErrorCode.CLIENT_ERROR,
        type: 'INVALID_TOKEN',
        message: '--token requires the form org:jwt',
        suggestion:
          'Prefix the token with its organization, e.g. acme:eyJ…; SEMANTIUS_JWT also accepts a bare token',
      }),
    );
    process.exit(ErrorCode.CLIENT_ERROR);
  }

  try {
    normalizeHost(`${org}.semantius.cloud`);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(ErrorCode.CLIENT_ERROR);
  }

  setTokenArg({ org, jwt });
}

/**
 * Build target string from server and tool
 */
function buildTarget(server?: string, tool?: string): string {
  if (!server) return '';
  if (!tool) return server;
  return `${server}/${tool}`;
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // Resolve --env first so the logger and every env lookup below uses the
  // right prefix — including for early-exit paths like parse errors.
  setEnvPrefix(findEnvPrefix(argv));
  setHostFlag(findHostFlag(argv));

  // Best-effort early --token literal, so a host it would supply doesn't
  // trigger missingHostWarning on -h / -v paths that return before the full
  // parseArgs below would see it (see findTokenArgs). The authoritative,
  // validated resolution — stdin, a file, or this same literal — happens
  // after parseArgs and never runs for help/version.
  const earlyToken = findTokenArgs(argv);
  if (earlyToken.literal) {
    const { org, value } = splitOrgPrefix(earlyToken.literal);
    if (org) setTokenArg({ org, jwt: value });
  }

  // Install the exit-time logger immediately so even early-exit code paths
  // (parse errors, missing env vars) get a log entry when <PREFIX>_LOG_FILE
  // is set in the shell environment.
  initLogger();

  // Before anything reads hosts.json, the host cache or a stored session: move
  // what an older version left directly in the vendor directory into this
  // product's own. One stat when there is nothing to move.
  migrateUserConfigDir();

  const args = parseArgs(argv);

  // parseArgs's value wins (it's the canonical parser) — re-apply in case
  // findEnvPrefix's lightweight scan disagrees on edge cases.
  setEnvPrefix(args.envPrefix);
  if (args.host !== undefined) setHostFlag(args.host);
  setCrudMcpFlag(args.crudMcp);

  const tokenFlagLabel =
    args.tokenFile !== undefined ? '--token-file' : '--token';

  if (args.token !== undefined && args.tokenFile !== undefined) {
    console.error(
      formatCliError({
        code: ErrorCode.CLIENT_ERROR,
        type: 'INVALID_OPTION',
        message: '--token cannot be combined with --token-file',
        suggestion:
          'Use --token (literal or -) or --token-file <path>, not both',
      }),
    );
    process.exit(ErrorCode.CLIENT_ERROR);
  }

  // --token's value names its own organization (and so its own host);
  // --host would either restate that or contradict it, so the two are
  // never combined — unlike --host, --token is never session-only, so
  // "relax and let --host pick the mode" isn't an option here either.
  if (
    args.host !== undefined &&
    (args.token !== undefined || args.tokenFile !== undefined)
  ) {
    console.error(
      formatCliError({
        code: ErrorCode.CLIENT_ERROR,
        type: 'INVALID_OPTION',
        message: `--host cannot be combined with ${tokenFlagLabel}`,
        suggestion: `${tokenFlagLabel} already names its own host via the token's organization; drop --host`,
      }),
    );
    process.exit(ErrorCode.CLIENT_ERROR);
  }

  // --token / --token-file already supply a JWT: --auth would only be
  // picking among credentials that no longer apply.
  if (
    (args.token !== undefined || args.tokenFile !== undefined) &&
    (args.auth === 'apikey' || args.auth === 'oauth')
  ) {
    console.error(
      formatCliError({
        code: ErrorCode.CLIENT_ERROR,
        type: 'INVALID_OPTION',
        message: `${tokenFlagLabel} cannot be combined with --auth ${args.auth}`,
        suggestion: `${tokenFlagLabel} supplies its own JWT; drop --auth, or use --auth jwt`,
      }),
    );
    process.exit(ErrorCode.CLIENT_ERROR);
  }

  if (
    (args.token !== undefined || args.tokenFile !== undefined) &&
    args.login
  ) {
    console.error(
      formatCliError({
        code: ErrorCode.CLIENT_ERROR,
        type: 'INVALID_OPTION',
        message: `${tokenFlagLabel} cannot be combined with --login`,
        suggestion: `${tokenFlagLabel} already supplies a credential; drop --login, or drop ${tokenFlagLabel}`,
      }),
    );
    process.exit(ErrorCode.CLIENT_ERROR);
  }

  // Both would read stdin for different things (the token, the call args).
  if (
    args.token === '-' &&
    args.command === 'call' &&
    args.args === undefined
  ) {
    console.error(
      formatCliError({
        code: ErrorCode.CLIENT_ERROR,
        type: 'INVALID_OPTION',
        message: '--token - and call without inline JSON both read stdin',
        suggestion:
          'Pass the JSON inline, or use --token-file / SEMANTIUS_JWT instead of --token -',
      }),
    );
    process.exit(ErrorCode.CLIENT_ERROR);
  }

  // --login runs the browser flow now and uses that session for this
  // invocation, even when a JWT / API key is configured.
  if (args.login && args.auth && args.auth !== 'oauth') {
    console.error(
      formatCliError({
        code: ErrorCode.CLIENT_ERROR,
        type: 'INVALID_OPTION',
        message: `--login cannot be combined with --auth ${args.auth}`,
        suggestion: '--login always uses the session it just obtained',
      }),
    );
    process.exit(ErrorCode.CLIENT_ERROR);
  }

  // hosts / use dispatch before the pre-flight login below (see there), so
  // --login would otherwise be silently dropped rather than honored or
  // rejected — for "use" it is also ambiguous which host --login would even
  // sign in to, since that is unrelated to the host named on the command line.
  if (args.login && (args.command === 'hosts' || args.command === 'use')) {
    console.error(
      formatCliError({
        code: ErrorCode.CLIENT_ERROR,
        type: 'INVALID_OPTION',
        message: `--login cannot be combined with "${args.command}"`,
        suggestion: `Run "semantius login" first, then "semantius ${args.command}"`,
      }),
    );
    process.exit(ErrorCode.CLIENT_ERROR);
  }

  // With --host only credentials stored for that host apply, so --auth can
  // only pick among those — never the environment's key or token (--token /
  // --token-file cannot reach here at all: they were already rejected above
  // for combining with --host).
  if (
    args.host !== undefined &&
    (args.auth === 'jwt' || args.auth === 'apikey')
  ) {
    console.error(
      formatCliError({
        code: ErrorCode.CLIENT_ERROR,
        type: 'INVALID_OPTION',
        message: `--auth ${args.auth} cannot be combined with --host`,
        suggestion: `With --host only the credentials stored for that host are used. Run "semantius login --host ${args.host}", or set ${prefixedEnvName('HOST')} to pair a host with ${prefixedEnvName('API_KEY')}.`,
      }),
    );
    process.exit(ErrorCode.CLIENT_ERROR);
  }

  setAuthFlag(args.login ? 'oauth' : args.auth);
  setLoginFlow(args.loginFlow);

  if (args.disableJwtCache) {
    setJwtCacheDisabled(true);
  }

  if (args.command === 'help') {
    // Load .env early so help can reflect actual missing vars
    await loadDotEnv();
    printHelp();
    return;
  }

  if (args.command === 'version') {
    await loadDotEnv();
    console.log(`semantius v${VERSION}`);
    const warning = missingHostWarning();
    if (warning) console.log(warning);
    return;
  }

  // --token / --token-file, resolved and validated for real: never for
  // help/version above, which only ever see the best-effort early literal.
  if (args.token !== undefined || args.tokenFile !== undefined) {
    await resolveTokenArg(args.token, args.tokenFile);
  }

  // Load .env before checking required env vars (supports .env next to exe)
  await loadDotEnv();

  // .env may have defined SEMANTIUS_LOG_FILE — enable logging now that it's loaded.
  // applyDefaults=true: if LOG_LEVELS is set without LOG_FILE, default to
  // `<envDir>/semantius.log` (or stderr when no .env was loaded).
  enableFromEnv(true);

  // hosts / use dispatch before the host gate below: a machine with no host
  // configured at all (or a conflicting one) must still be able to list what
  // it knows about and pick one, rather than being locked out by the same
  // check these commands exist to help recover from.
  if (args.command === 'hosts') {
    await hostsCommand({ json: args.json });
    return;
  }
  if (args.command === 'use') {
    await useCommand(
      args.clear ? { clear: true } : { host: args.useHost as string },
    );
    return;
  }

  // Resolve the host before anything else touches the credential env vars: a
  // HOST_CONFLICT between an org-bound credential and ${PREFIX}_HOST (or a
  // bare ${PREFIX}_ORG) *at the same layer* is reported inside
  // isSessionOnlyHost()'s own getHostSource() call (host.ts's
  // resolveHostValue); a credential whose layer is never reached is
  // suppressed there too, so it cannot leak into the credential lookups
  // below either way.
  //
  // With --host, or the current host (`semantius use`), only a stored
  // browser session applies — never the API key / JWT / org from the
  // environment. --token does not count as session-only: it is itself the
  // credential for this invocation (see getCredentialSource()), not a host
  // that only a session can authenticate against.
  try {
    if (isSessionOnlyHost()) {
      ignoreEnvCredentials();
    }
  } catch (error) {
    console.error((error as Error).message);
    process.exit(ErrorCode.CLIENT_ERROR);
  }

  // On a cloud host the host's org becomes ${PREFIX}_ORG (the host wins over
  // an ORG from .env). Also surfaces an invalid ${PREFIX}_HOST early.
  try {
    propagateOrg();
  } catch (error) {
    console.error((error as Error).message);
    process.exit(ErrorCode.CLIENT_ERROR);
  }

  // Validate that a host is configured before running any data command
  checkRequiredEnvVars();

  if (isCrudMcp() && getHostMode() === 'selfhosted') {
    console.error(
      'Error [NOT_AVAILABLE]: --crud-mcp needs the Semantius cloud MCP server; self-hosted instances have none',
    );
    process.exit(ErrorCode.CLIENT_ERROR);
  }

  if (args.resetCache) {
    const apiKey = process.env[`${args.envPrefix}_API_KEY`];
    const parsed = parseApiKey(apiKey);
    const host = getHost();
    if (parsed) {
      // The MCP path's entry (per API key) and the local layer's (per host).
      deleteCachedToken(apiKey ?? '');
      console.error(`JWT cache reset: ${getCachePath(parsed.id)}`);
      if (host) {
        deleteCachedToken(apiKey ?? '', host);
        console.error(`JWT cache reset: ${getCachePath(parsed.id, host)}`);
      }
    }
    // Self-hosted hosts have a cache entry too (their discovered OAuth
    // endpoints), so --reset-cache must clear theirs as well.
    if (host) {
      console.error(`Host cache reset: ${deleteHostCache(host)}`);
    }
  }

  // A browser login before the actual command: never implicit, always an
  // interactive terminal (there is nobody to complete the flow otherwise).
  if (args.login && args.command !== 'login') {
    // stdin is a rough proxy for "a human is here", kept because the browser
    // flow has no better one. An explicit --login-flow overrides it: the
    // device grant needs no stdin at all (the code is typed into a browser on
    // another device), so this check would otherwise refuse the one path that
    // works on a headless box. Bare `semantius login` is not gated here at
    // all — login() itself chooses the grant, once discovery has answered.
    if (!process.stdin.isTTY && !getLoginFlow()) {
      console.error(
        'Error [LOGIN_FAILED]: --login needs an interactive terminal (or an explicit --login-flow)',
      );
      process.exit(ErrorCode.CLIENT_ERROR);
    }
    await loginCommand();
  }

  switch (args.command) {
    case 'list':
      await listCommand({
        withDescriptions: args.withDescriptions,
        configPath: args.configPath,
      });
      break;

    case 'markdown':
      await markdownCommand({
        configPath: args.configPath,
      });
      break;

    case 'info':
      // info always has a server (validated in parseArgs)
      await infoCommand({
        target: buildTarget(args.server, args.tool),
        withDescriptions: args.withDescriptions,
        configPath: args.configPath,
      });
      break;

    case 'grep':
      await grepCommand({
        pattern: args.pattern ?? '',
        withDescriptions: args.withDescriptions,
        configPath: args.configPath,
      });
      break;

    case 'call':
      await callCommand({
        target: buildTarget(args.server, args.tool),
        args: args.args,
        configPath: args.configPath,
        diag: args.diag,
        single: args.single,
        stream: args.stream,
      });
      break;

    case 'ping':
      await pingCommand({
        configPath: args.configPath,
        count: args.pingCount,
      });
      break;

    case 'whoami':
      await whoamiCommand({ configPath: args.configPath, diag: args.diag });
      break;

    case 'login':
      await loginCommand();
      break;

    case 'logout':
      await logoutCommand();
      break;
  }
}

// Daemon launch (`semantius --daemon <server> <configJson>`, spawned by
// daemon-client.ts) must be handled before parseArgs, which rejects --daemon
// as an unknown option, and without the CLI's own signal handlers, which
// would exit before the daemon's cleanup (socket/pid removal, daemon_stop
// log) can run.
if (!runDaemonFromArgv(process.argv.slice(2))) {
  // Handle graceful shutdown on SIGINT/SIGTERM
  process.on('SIGINT', () => {
    process.exit(130); // 128 + SIGINT(2)
  });
  process.on('SIGTERM', () => {
    process.exit(143); // 128 + SIGTERM(15)
  });

  // Run
  main()
    .then(() => {
      // Use setImmediate to let stdout flush before exiting
      setImmediate(() => process.exit(0));
    })
    .catch((error) => {
      // Error message already formatted by command handlers
      console.error(error.message);
      recordError(error.message);
      // An error may name its own exit code, the same `exitCode` convention
      // the identity commands already use locally — an auth failure has to
      // reach the shell as 5, not as the generic client error.
      const code = (error as { exitCode?: number })?.exitCode;
      setImmediate(() =>
        process.exit(typeof code === 'number' ? code : ErrorCode.CLIENT_ERROR),
      );
    });
}
