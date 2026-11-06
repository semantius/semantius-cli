/**
 * `semantius tools <server> <tool>` prints the description and the input
 * schema exactly as the server advertises them, compact. Checked in-process
 * for every crud and utils tool.
 */
import { describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolInfo } from '../src/client';
import type { HostFacts } from '../src/host';
import { createUtilsServer } from '../src/local-tools';
import { buildToolContext } from '../src/local-tools/crud/context';
import { createCrudServer } from '../src/local-tools/crud/registry';
import {
  formatToolDefinition,
  formatServerDetails,
  formatServerList,
  formatToolSchema,
  formatToolsSection,
  normalizeSchema,
} from '../src/output';

const CLOUD: HostFacts = {
  mode: 'cloud',
  host: 'acme.semantius.cloud',
  org: 'acme',
  tenantId: 'tenant-1',
  postgrestUrl: 'https://pg.example.com/rest/v1',
  discoveryUrl:
    'https://acme.semantius.cloud/.well-known/oauth-protected-resource',
  tokenExchange: { method: 'POST', url: 'https://acme.semantius.cloud/token' },
  clientId: 'cli-client',
  apiBaseUrl: 'https://acme.semantius.ai',
  uiBaseUrl: 'https://acme.semantius.app',
};

async function listTools(server: McpServer): Promise<ToolInfo[]> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0' }, { capabilities: {} });
  await client.connect(clientTransport);
  try {
    return (await client.listTools()).tools as ToolInfo[];
  } finally {
    await client.close();
    await server.close();
  }
}

/** What a parser written for `info` does: text from the first `{` after "Input Schema:". */
function parseSchema(output: string): unknown {
  const after = output.slice(output.indexOf('Input Schema:'));
  return JSON.parse(after.slice(after.indexOf('{')));
}

const SERVERS: Array<[string, () => Promise<ToolInfo[]>]> = [
  [
    'crud',
    () => listTools(createCrudServer(() => buildToolContext(CLOUD, 't'), CLOUD)),
  ],
  ['utils', () => listTools(createUtilsServer())],
];

describe('tools <server> <tool>', () => {
  for (const [name, load] of SERVERS) {
    test(`${name}: schema and description are unchanged for every tool`, async () => {
      const tools = await load();
      expect(tools.length).toBeGreaterThan(0);

      for (const tool of tools) {
        const out = formatToolDefinition(tool);

        expect(parseSchema(out)).toEqual(normalizeSchema(tool.inputSchema));

        // The schema is one line: no indentation, no line breaks inside it.
        const schemaLine = out.slice(out.indexOf('Input Schema:\n') + 'Input Schema:\n'.length);
        expect(schemaLine).toBe(JSON.stringify(normalizeSchema(tool.inputSchema)));

        if (tool.description) {
          const description = out.slice(
            'Description:\n'.length,
            out.indexOf('\nInput Schema:\n'),
          );
          expect(description).toBe(tool.description);
        } else {
          expect(out.startsWith('Input Schema:')).toBe(true);
        }
      }
    });
  }

  test('--pretty indents the schema and still parses to the same object', async () => {
    const [tool] = await SERVERS[1][1]();
    const out = formatToolDefinition(tool, true);
    expect(out).toContain('\n  "');
    expect(parseSchema(out)).toEqual(normalizeSchema(tool.inputSchema));
  });

  test('crud: the compact output is smaller than the old indented info output', async () => {
    const tools = await SERVERS[0][1]();
    const compact = tools.map((t) => formatToolDefinition(t)).join('\n').length;
    // What `info` printed before: the raw schema, indented.
    const info = tools
      .map((t) => `${t.description}\n${JSON.stringify(t.inputSchema, null, 2)}`)
      .join('\n').length;
    // Measured with o200k_base: 37,945 tokens against 48,381 (-22%).
    expect(compact).toBeLessThan(info * 0.85);
  });
});

const count = (value: unknown, needle: string): number =>
  JSON.stringify(value).split(needle).length - 1;

describe('normalizeSchema', () => {
  test('crud: removes the static keywords from every tool', async () => {
    const tools = await SERVERS[0][1]();
    for (const tool of tools) {
      const text = JSON.stringify(normalizeSchema(tool.inputSchema));
      expect(text).not.toContain('"$schema"');
      expect(text).not.toContain('9007199254740991');
      expect(text).not.toContain('"additionalProperties":{}');
      expect(text).not.toContain('"propertyNames":{"type":"string"}');
    }
  });

  test('crud: keeps every real rule', async () => {
    const tools = await SERVERS[0][1]();
    const before = tools.map((t) => t.inputSchema);
    const after = before.map((s) => normalizeSchema(s));
    for (const needle of [
      '"exclusiveMinimum"',
      '"minItems"',
      '"minLength"',
      '"pattern"',
      '"format"',
      '"enum"',
      '"required"',
      '"anyOf"',
      '"description"',
      '"minimum":0',
      '"maximum":18',
    ]) {
      expect(count(after, needle)).toBe(count(before, needle));
    }

    // precision 0..18 on create_field and update_field
    for (const name of ['create_field', 'update_field']) {
      const tool = tools.find((t) => t.name === name);
      const text = JSON.stringify(normalizeSchema(tool?.inputSchema));
      expect(text).toContain('"minimum":0');
      expect(text).toContain('"maximum":18');
    }
  });

  test('only the safe-integer bound is removed, not other bounds', () => {
    const schema = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: -9007199254740991, maximum: 9007199254740991 },
        only_max: { type: 'integer', exclusiveMinimum: 0, maximum: 9007199254740991 },
        precision: { type: 'integer', minimum: 0, maximum: 18 },
        big: { type: 'integer', maximum: 9007199254740990 },
      },
      additionalProperties: {},
    };
    expect(normalizeSchema<unknown>(schema)).toEqual({
      type: 'object',
      properties: {
        id: { type: 'integer' },
        only_max: { type: 'integer', exclusiveMinimum: 0 },
        precision: { type: 'integer', minimum: 0, maximum: 18 },
        big: { type: 'integer', maximum: 9007199254740990 },
      },
    });
  });

  test('a property named like a keyword is kept, and the input is not changed', () => {
    const schema = {
      type: 'object',
      properties: {
        $schema: { type: 'string' },
        minimum: { type: 'integer', minimum: -9007199254740991 },
        propertyNames: { type: 'string' },
      },
      additionalProperties: { type: 'string' },
    };
    const copy = JSON.parse(JSON.stringify(schema));
    expect(normalizeSchema<unknown>(schema)).toEqual({
      type: 'object',
      properties: {
        $schema: { type: 'string' },
        minimum: { type: 'integer' },
        propertyNames: { type: 'string' },
      },
      additionalProperties: { type: 'string' },
    });
    expect(schema).toEqual(copy);
  });

  test('keeps the key order', () => {
    const out = normalizeSchema({ type: 'object', required: ['a'], properties: { b: {}, a: {} } });
    expect(Object.keys(out)).toEqual(['type', 'required', 'properties']);
    expect(Object.keys((out as { properties: object }).properties)).toEqual(['b', 'a']);
  });
});

describe('info and tools differ only by the intro', () => {
  test('tool level: info is "Tool:/Server:" lines, a blank line, then the tools output', async () => {
    for (const [name, load] of SERVERS) {
      for (const tool of await load()) {
        for (const pretty of [false, true]) {
          expect(formatToolSchema(name, tool, pretty)).toBe(
            `Tool: ${tool.name}
Server: ${name}

${formatToolDefinition(tool, pretty)}`,
          );
        }
      }
    }
  });

  test('no server: the same list, the intro line is the only difference', async () => {
    const tools = await SERVERS[1][1]();
    const servers = [{ name: 'utils', tools, instructions: 'First line\nMore' }];
    const withIntro = formatServerList(servers, false, true);
    const without = formatServerList(servers, false, false);
    expect(withIntro).toContain('Instructions: First line...');
    expect(withIntro.replace(/ {2}Instructions: [^\n]*\n/, '')).toBe(without);
  });

  test('server level: info ends with exactly what tools prints', async () => {
    const tools = await SERVERS[1][1]();
    const config = { builtin: true } as never;
    const info = formatServerDetails('utils', config, tools, false, 'Some instructions');
    expect(info.endsWith(formatToolsSection(tools))).toBe(true);
    expect(info).toContain('Instructions:');
    expect(formatToolsSection(tools)).not.toContain('Instructions:');
  });
});
