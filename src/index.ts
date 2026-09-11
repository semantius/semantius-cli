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

import { version as VERSION } from '../package.json' with { type: 'json' };
import { callCommand } from './commands/call.js';
import { grepCommand } from './commands/grep.js';
import { pingCommand, whoamiCommand } from './commands/identity.js';
import { infoCommand } from './commands/info.js';
import { listCommand } from './commands/list.js';
import { markdownCommand } from './commands/markdown.js';
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_MAX_RETRIES,
  DEFAULT_RETRY_DELAY_MS,
  DEFAULT_TIMEOUT_SECONDS,
  getMissingRequiredEnvVars,
  getUserConfigDir,
  isCrudMcp,
  loadDotEnv,
  prefixedEnvName,
  setCrudMcpFlag,
  setEnvPrefix,
  setHostFlag,
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
  isCloudHost,
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
    | 'whoami';
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
  crudMcp: boolean;
  pingCount?: number;
  disableJwtCache: boolean;
  resetCache: boolean;
}

/**
 * Known subcommands
 */
const SUBCOMMANDS = ['info', 'grep', 'call', 'ping', 'whoami'] as const;

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
    crudMcp: false,
    disableJwtCache: false,
    resetCache: false,
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

Credentials (first match wins):
  1. ${jwtVar.padEnd(22)} Static token, sent as-is (no exchange, no cache)
  2. ${apiKeyVar.padEnd(22)} Exchanged for a short-lived token at the host; cached, encrypted
  Without either, commands that call the platform exit 5 ("Authentication required").

Options:
  -h, --help               Show this help message
  -v, --version            Show version number
  -d, --with-descriptions  Include tool descriptions
  -md, --markdown          Dump full documentation as markdown (README, SKILL, all tools)
  --diag                   (call) Output full JSON response instead of just response.data
                           (whoami) Also show the bearer token used for the request
  --single                 (call only) Expect exactly one row; exit 1 on 0 rows, exit 2 on 2+ rows.
                           Rejected (exit 1) for bulk calls: an array in data/body/id/table_name
  --stream                 (call crud postgrestRequest only) Pipe the PostgREST response body to stdout
                           unchanged: compact JSON, or CSV with "accept":"text/csv". Fastest for large
                           reads. Not with --single, --diag or --crud-mcp. Also: SEMANTIUS_STREAM=1
                           (applies only where --stream is valid)
  -n [count]               (ping only) Run N pings and report min/max/avg. Default: 5 when -n is given
  --env <prefix>           Env var prefix (default: SEMANTIUS). E.g. --env PROD uses PROD_API_KEY / PROD_ORG
  --host <url|hostname>    Semantius host: <org>.semantius.cloud is the managed cloud; any other host
                           (https://host[:port]) is self-hosted. Also: ${hostVar}
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

Environment Variables (all respect --env <prefix>; default prefix shown):
  ${orgVar.padEnd(28)} Organization on the managed cloud; the host defaults to
                               https://<org>.semantius.cloud. Required unless ${hostVar}
                               or --host is set (an "org:" prefix on the API key or JWT
                               also supplies it)
  ${hostVar.padEnd(28)} Host URL or hostname, same as --host. Precedence: --host, then
                               ${hostVar} (shell, project .env, global .env), then ${orgVar}
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
        `Error [MISSING_ENV_VAR]: Required environment variable not set: ${v} (set ${orgVar} or --host)`,
      );
    }
    console.error('Generate an API key at https://app.semantius.com/dashboard');
    process.exit(ErrorCode.CLIENT_ERROR);
  }
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

  // Install the exit-time logger immediately so even early-exit code paths
  // (parse errors, missing env vars) get a log entry when <PREFIX>_LOG_FILE
  // is set in the shell environment.
  initLogger();

  const args = parseArgs(argv);

  // parseArgs's value wins (it's the canonical parser) — re-apply in case
  // findEnvPrefix's lightweight scan disagrees on edge cases.
  setEnvPrefix(args.envPrefix);
  if (args.host !== undefined) setHostFlag(args.host);
  setCrudMcpFlag(args.crudMcp);

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

  // Load .env before checking required env vars (supports .env next to exe)
  await loadDotEnv();

  // .env may have defined SEMANTIUS_LOG_FILE — enable logging now that it's loaded.
  // applyDefaults=true: if LOG_LEVELS is set without LOG_FILE, default to
  // `<envDir>/semantius.log` (or stderr when no .env was loaded).
  enableFromEnv(true);

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
    if (parsed) {
      const path = getCachePath(parsed.id);
      deleteCachedToken(apiKey ?? '');
      console.error(`JWT cache reset: ${path}`);
    }
    const host = getHost();
    if (host && isCloudHost(host)) {
      console.error(`Host cache reset: ${deleteHostCache(host)}`);
    }
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
      setImmediate(() => process.exit(ErrorCode.CLIENT_ERROR));
    });
}
