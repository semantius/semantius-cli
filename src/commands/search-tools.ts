/**
 * search_tools command - Find tools by name or description
 *
 * Unlike `grep` (a glob on tool names only), a tool matches when at least one
 * word of the query appears as a plain, case-insensitive substring of its name
 * or description. Glob characters are literal here. Tools are ranked by how
 * many of the words they contain.
 */

import {
  type McpConnection,
  type ToolInfo,
  debug,
  getConcurrencyLimit,
  getConnection,
  safeClose,
} from '../client.js';
import {
  type McpServersConfig,
  getServerConfig,
  isLocalServer,
  listServerNames,
  loadConfig,
} from '../config.js';
import { ErrorCode } from '../errors.js';
import { processWithConcurrency } from './grep.js';

export interface SearchToolsOptions {
  query: string;
  /** Also search remote servers (--all). Default: only the local crud and utils. */
  all?: boolean;
  /** --json: print an array of {server, tool, description, matched, score}. */
  json?: boolean;
  configPath?: string;
}

/** Where a match was found: the name if any word is in it, else the description. */
export type MatchedField = 'name' | 'description';

export interface ToolMatch {
  server: string;
  tool: string;
  description: string;
  matched: MatchedField;
  /** How many of the distinct query words the name or description contains. */
  score: number;
}

/** Split a query into distinct lowercase words. */
export function queryWords(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))];
}

/**
 * How a tool matches the words, or null when none of them is found. The score
 * is the number of words found in the name or description together.
 */
export function matchTool(
  tool: { name: string; description?: string },
  words: string[],
): { matched: MatchedField; score: number } | null {
  const name = tool.name.toLowerCase();
  const text = `${name}\n${(tool.description ?? '').toLowerCase()}`;
  const score = words.filter((w) => text.includes(w)).length;
  if (score === 0) return null;
  const inName = words.some((w) => name.includes(w));
  return { matched: inName ? 'name' : 'description', score };
}

/**
 * Rank: most words matched first, then a name match before a description-only
 * match; ties by server, then tool name.
 */
export function compareMatches(a: ToolMatch, b: ToolMatch): number {
  return (
    b.score - a.score ||
    (a.matched === b.matched ? 0 : a.matched === 'name' ? -1 : 1) ||
    a.server.localeCompare(b.server) ||
    a.tool.localeCompare(b.tool)
  );
}

function firstLine(text: string | undefined): string {
  return (text ?? '').split(/\r?\n/, 1)[0].trim();
}

async function searchServer(
  serverName: string,
  config: McpServersConfig,
  words: string[],
): Promise<{ serverName: string; matches: ToolMatch[]; error?: string }> {
  let connection: McpConnection | null = null;
  try {
    connection = await getConnection(
      serverName,
      getServerConfig(config, serverName),
    );
    const tools: ToolInfo[] = await connection.listTools();
    const matches: ToolMatch[] = [];
    for (const tool of tools) {
      const hit = matchTool(tool, words);
      if (hit) {
        matches.push({
          server: serverName,
          tool: tool.name,
          description: tool.description ?? '',
          ...hit,
        });
      }
    }
    debug(`${serverName}: found ${matches.length} matches`);
    return { serverName, matches };
  } catch (error) {
    const msg = (error as Error).message;
    debug(`${serverName}: connection failed - ${msg}`);
    return { serverName, matches: [], error: msg };
  } finally {
    if (connection) {
      await safeClose(connection.close);
    }
  }
}

/** The `-d` listing format, grouped under each server. */
export function formatMatches(matches: ToolMatch[]): string {
  const bySever = new Map<string, ToolMatch[]>();
  for (const m of matches) {
    const list = bySever.get(m.server) ?? [];
    list.push(m);
    bySever.set(m.server, list);
  }
  const lines: string[] = [];
  for (const [server, list] of bySever) {
    lines.push(server);
    for (const m of list) {
      const desc = firstLine(m.description);
      lines.push(desc ? `  • ${m.tool} - ${desc}` : `  • ${m.tool}`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

export async function searchToolsCommand(
  options: SearchToolsOptions,
): Promise<void> {
  let config: McpServersConfig;
  try {
    config = await loadConfig(options.configPath);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(ErrorCode.CLIENT_ERROR);
  }

  const words = queryWords(options.query);
  const allNames = listServerNames(config);
  const skipped = options.all
    ? []
    : allNames.filter((name) => !isLocalServer(config.mcpServers[name]));
  const serverNames = allNames.filter((name) => !skipped.includes(name));

  // Said after the results, so a miss is not read as "no such tool".
  // Kept off stdout in --json mode so the output stays parseable.
  const skippedNote = () => {
    if (skipped.length > 0 && !options.json) {
      console.log(
        `Not searched: ${skipped.join(', ')} (remote; use --all to include)`,
      );
    }
  };

  if (serverNames.length === 0) {
    console.error(
      'Warning: No servers configured. Add servers to mcp_servers.json',
    );
    return;
  }

  const serverResults = await processWithConcurrency(
    serverNames,
    (serverName) => searchServer(serverName, config, words),
    getConcurrencyLimit(),
  );

  const failed = serverResults.filter((r) => r.error);
  if (failed.length > 0) {
    console.error(
      `Warning: ${failed.length} server(s) failed to connect: ${failed.map((r) => r.serverName).join(', ')}`,
    );
    for (const r of failed) {
      console.error(`  ${r.serverName}: ${r.error}`);
    }
  }

  const matches = serverResults.flatMap((r) => r.matches).sort(compareMatches);

  if (options.json) {
    console.log(JSON.stringify(matches));
    return;
  }

  if (matches.length === 0) {
    console.log(`No tools found matching "${options.query}"`);
    console.log('  Tip: Tool names and descriptions were searched');
    console.log('  Tip: A tool matches if it contains any of the words');
    console.log(`  Tip: Run 'semantius' to list all available tools`);
    skippedNote();
    return;
  }

  console.log(formatMatches(matches));
  skippedNote();
}
