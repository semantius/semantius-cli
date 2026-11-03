/**
 * A stdio MCP server that starts the way `npx -y <package>` does on a cold
 * cache: the first start spends a while installing into a shared directory
 * (argv[2]), and a second start during that install collides with it. npm then
 * fails with ENOTEMPTY or TAR_ENTRY_ERROR; here the collision is recorded in
 * the file `collided` and ends the process, deterministically. Starts after
 * the install has finished find it done, as npx finds its cache.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const INSTALL_MS = 1500;

const dir = process.argv[2];
const installed = join(dir, 'installed');
const installing = join(dir, 'installing');

if (!existsSync(installed)) {
  try {
    mkdirSync(installing);
  } catch {
    appendFileSync(join(dir, 'collided'), `${process.pid}\n`);
    console.error('ENOTEMPTY: another install is running in this directory');
    process.exit(1);
  }
  await Bun.sleep(INSTALL_MS);
  writeFileSync(installed, '');
  rmdirSync(installing);
}

const server = new McpServer({ name: 'cold-start', version: '1.0.0' });
server.registerTool('ping', { description: 'Answers pong' }, async () => ({
  content: [{ type: 'text', text: 'pong' }],
}));
await server.connect(new StdioServerTransport());
