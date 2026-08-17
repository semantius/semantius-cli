/**
 * Unit tests for output formatting
 */

import { describe, test, expect } from 'bun:test';
import {
  formatServerList,
  formatSearchResults,
  formatServerDetails,
  formatToolSchema,
  formatToolResult,
  formatJson,
  formatError,
  schemaTypeLabel,
} from '../src/output';

// Disable colors for testing
process.env.NO_COLOR = '1';

describe('output', () => {
  describe('formatServerList', () => {
    test('formats servers with tools', () => {
      const servers = [
        {
          name: 'github',
          tools: [
            { name: 'search', description: 'Search repos', inputSchema: {} },
            { name: 'clone', description: 'Clone repo', inputSchema: {} },
          ],
        },
        {
          name: 'filesystem',
          tools: [
            { name: 'read_file', description: 'Read file', inputSchema: {} },
          ],
        },
      ];

      const output = formatServerList(servers, false);
      expect(output).toContain('github');
      expect(output).toContain('search');
      expect(output).toContain('clone');
      expect(output).toContain('filesystem');
      expect(output).toContain('read_file');
    });

    test('includes descriptions when requested', () => {
      const servers = [
        {
          name: 'test',
          tools: [
            { name: 'tool1', description: 'A test tool', inputSchema: {} },
          ],
        },
      ];

      const withDesc = formatServerList(servers, true);
      expect(withDesc).toContain('A test tool');

      const withoutDesc = formatServerList(servers, false);
      expect(withoutDesc).not.toContain('A test tool');
    });
  });

  describe('formatSearchResults', () => {
    test('formats search results', () => {
      const results = [
        {
          server: 'github',
          tool: { name: 'search', description: 'Search', inputSchema: {} },
        },
        {
          server: 'fs',
          tool: { name: 'find', description: 'Find files', inputSchema: {} },
        },
      ];

      const output = formatSearchResults(results, false);
      expect(output).toContain('github');
      expect(output).toContain('search');
      expect(output).toContain('fs');
      expect(output).toContain('find');
    });

    test('always includes descriptions when available', () => {
      const results = [
        {
          server: 'test',
          tool: {
            name: 'tool',
            description: 'Tool description',
            inputSchema: {},
          },
        },
      ];

      // Descriptions are always shown in grep output (regardless of -d flag)
      const withDesc = formatSearchResults(results, true);
      expect(withDesc).toContain('Tool description');

      const withoutDesc = formatSearchResults(results, false);
      expect(withoutDesc).toContain('Tool description');
    });
  });

  describe('schemaTypeLabel', () => {
    test('passes plain type strings through', () => {
      expect(schemaTypeLabel({ type: 'string' })).toBe('string');
      expect(schemaTypeLabel({ type: 'integer', minimum: 0 })).toBe('integer');
      expect(schemaTypeLabel({ type: 'object', properties: {} })).toBe('object');
    });

    test('falls back to any for missing or unrecognised schemas', () => {
      expect(schemaTypeLabel({})).toBe('any');
      expect(schemaTypeLabel({ description: 'no type' })).toBe('any');
      expect(schemaTypeLabel(undefined)).toBe('any');
      expect(schemaTypeLabel(null)).toBe('any');
      expect(schemaTypeLabel({ type: [] })).toBe('any');
    });

    test('renders type arrays as a union', () => {
      expect(schemaTypeLabel({ type: ['string', 'null'] })).toBe('string | null');
    });

    test('renders arrays with their item type', () => {
      expect(schemaTypeLabel({ type: 'array', items: { type: 'string' } })).toBe('string[]');
      expect(schemaTypeLabel({ type: 'array' })).toBe('any[]');
      expect(
        schemaTypeLabel({ type: 'array', items: { type: 'array', items: { type: 'integer' } } }),
      ).toBe('integer[][]');
      // A union element type is parenthesised so it can't be misread.
      expect(
        schemaTypeLabel({ type: 'array', items: { type: ['string', 'null'] } }),
      ).toBe('(string | null)[]');
    });

    test('renders the crud create_* bulk shape (object or non-empty array of objects)', () => {
      // zod v4: z.union([entitySchema, z.array(entitySchema).min(1)]) → anyOf, no top-level type
      const data = {
        anyOf: [
          { type: 'object', properties: { table_name: { type: 'string' } }, required: ['table_name'] },
          {
            type: 'array',
            items: { type: 'object', properties: { table_name: { type: 'string' } } },
            minItems: 1,
          },
        ],
        description: 'Data object ... or a non-empty array of such objects',
      };
      expect(schemaTypeLabel(data)).toBe('object | object[]');
    });

    test('renders the crud update_*/delete_* bulk key shape (value or array of values)', () => {
      expect(
        schemaTypeLabel({
          anyOf: [
            { type: 'integer', minimum: -1, maximum: 1 },
            { type: 'array', items: { type: 'integer' }, minItems: 1 },
          ],
        }),
      ).toBe('integer | integer[]');
      expect(
        schemaTypeLabel({
          anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1 }],
        }),
      ).toBe('string | string[]');
    });

    test('handles oneOf, nullable-any and dedupes repeated variants', () => {
      expect(
        schemaTypeLabel({ oneOf: [{ type: 'string' }, { type: 'number' }] }),
      ).toBe('string | number');
      // zod .nullable() on z.any(): anyOf: [{}, {type:'null'}]
      expect(schemaTypeLabel({ anyOf: [{}, { type: 'null' }] })).toBe('any | null');
      expect(
        schemaTypeLabel({ anyOf: [{ type: 'string', format: 'email' }, { type: 'string' }] }),
      ).toBe('string');
    });
  });

  describe('formatServerDetails', () => {
    const config = { url: 'https://example.test/mcp' } as any;

    test('renders union parameter types instead of any', () => {
      const tools = [
        {
          name: 'create_field',
          description: 'Creates fields',
          inputSchema: {
            type: 'object',
            properties: {
              data: {
                anyOf: [
                  { type: 'object', properties: {} },
                  { type: 'array', items: { type: 'object', properties: {} }, minItems: 1 },
                ],
                description: 'One record or an array of records',
              },
              accept: { type: 'string', description: 'Accept header' },
            },
            required: ['data'],
          },
        },
        {
          name: 'delete_role',
          inputSchema: {
            type: 'object',
            properties: {
              id: {
                anyOf: [{ type: 'integer' }, { type: 'array', items: { type: 'integer' }, minItems: 1 }],
              },
            },
            required: ['id'],
          },
        },
      ];

      const output = formatServerDetails('crud', config, tools, true);
      expect(output).toContain('• data (object | object[], required) - One record or an array of records');
      expect(output).toContain('• accept (string, optional) - Accept header');
      expect(output).toContain('• id (integer | integer[], required)');
      expect(output).not.toContain('(any,');
    });

    test('still renders plain and typeless parameters as before', () => {
      const tools = [
        {
          name: 'read_entity',
          inputSchema: {
            type: 'object',
            properties: {
              filters: { type: 'string' },
              mystery: { description: 'no type at all' },
            },
          },
        },
      ];

      const output = formatServerDetails('crud', config, tools, false);
      expect(output).toContain('• filters (string, optional)');
      expect(output).toContain('• mystery (any, optional)');
    });
  });

  describe('formatToolSchema', () => {
    test('formats tool with schema', () => {
      const tool = {
        name: 'search_repos',
        description: 'Search GitHub repositories',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
          },
          required: ['query'],
        },
      };

      const output = formatToolSchema('github', tool);
      expect(output).toContain('search_repos');
      expect(output).toContain('github');
      expect(output).toContain('Search GitHub');
      expect(output).toContain('query');
    });
  });

  describe('formatToolResult', () => {
    test('extracts response.data from JSON text content', () => {
      const data = { message: 'Hello, world!' };
      const result = {
        content: [{ type: 'text', text: JSON.stringify({ response: { data } }) }],
      };

      const output = formatToolResult(result);
      expect(output).toBe(JSON.stringify(data, null, 2));
    });

    test('returns raw joined text in diag mode', () => {
      const result = {
        content: [
          { type: 'text', text: 'Part 1' },
          { type: 'text', text: 'Part 2' },
        ],
      };

      const output = formatToolResult(result, true);
      expect(output).toContain('Part 1');
      expect(output).toContain('Part 2');
    });

    test('throws when text content is not valid JSON', () => {
      const result = {
        content: [{ type: 'text', text: 'Hello, world!' }],
      };

      expect(() => formatToolResult(result)).toThrow('not valid JSON');
    });

    test('returns bare JSON when response has no envelope', () => {
      const payload = { something: 'else' };
      const result = {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
      };

      const output = formatToolResult(result);
      expect(output).toBe(JSON.stringify(payload, null, 2));
    });

    test('returns bare JSON array (crud tool shape)', () => {
      const payload = [{ id: 1, name: 'foo' }];
      const result = {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
      };

      const output = formatToolResult(result);
      expect(output).toBe(JSON.stringify(payload, null, 2));
    });

    test('falls back to JSON for non-text content', () => {
      const result = { data: [1, 2, 3] };
      const output = formatToolResult(result);
      expect(output).toContain('"data"');
      expect(output).toContain('1');
      expect(output).toContain('2');
      expect(output).toContain('3');
    });
  });

  describe('formatJson', () => {
    test('outputs valid JSON', () => {
      const data = { name: 'test', values: [1, 2, 3] };
      const output = formatJson(data);
      expect(JSON.parse(output)).toEqual(data);
    });
  });

  describe('formatError', () => {
    test('formats error message', () => {
      const output = formatError('Something went wrong');
      expect(output).toContain('Something went wrong');
    });
  });
});
