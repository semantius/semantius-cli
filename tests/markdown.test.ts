/**
 * Unit tests for the `-md` markdown dump's tool/parameter rendering
 */

import { describe, test, expect } from 'bun:test';
import { formatServersMarkdown } from '../src/commands/markdown';

describe('formatServersMarkdown', () => {
  test('renders union parameter types with escaped pipes in the table', () => {
    const md = formatServersMarkdown([
      {
        name: 'crud',
        instructions: 'Server instructions here',
        tools: [
          {
            name: 'create_field',
            description: 'Creates one or many fields',
            inputSchema: {
              type: 'object',
              properties: {
                data: {
                  anyOf: [
                    { type: 'object', properties: {} },
                    { type: 'array', items: { type: 'object', properties: {} }, minItems: 1 },
                  ],
                  description: 'One record or a non-empty array of records',
                },
                accept: { type: 'string', description: 'Accept header (e.g. text/csv)' },
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
                  anyOf: [
                    { type: 'integer' },
                    { type: 'array', items: { type: 'integer' }, minItems: 1 },
                  ],
                  description: 'ID or array of IDs',
                },
              },
              required: ['id'],
            },
          },
        ],
      },
    ]);

    expect(md).toContain('## crud');
    expect(md).toContain('Server instructions here');
    expect(md).toContain('#### create_field');
    // The `|` inside the type label must be escaped so the GFM table keeps 4 columns.
    expect(md).toContain(
      '| `data` | object \\| object[] | yes | One record or a non-empty array of records |',
    );
    expect(md).toContain('| `accept` | string | no | Accept header (e.g. text/csv) |');
    expect(md).toContain('| `id` | integer \\| integer[] | yes | ID or array of IDs |');
    expect(md).not.toContain('| any |');
  });

  test('escapes pipes in descriptions and keeps plain types unchanged', () => {
    const md = formatServersMarkdown([
      {
        name: 'crud',
        tools: [
          {
            name: 'read_entity',
            inputSchema: {
              type: 'object',
              properties: {
                filters: { type: 'string', description: 'a=eq.1|b=eq.2 style' },
                mystery: { description: 'no type' },
              },
            },
          },
        ],
      },
    ]);

    expect(md).toContain('| `filters` | string | no | a=eq.1\\|b=eq.2 style |');
    expect(md).toContain('| `mystery` | any | no | no type |');
  });

  test('reports connection errors and empty tool lists', () => {
    const md = formatServersMarkdown([
      { name: 'broken', tools: [], error: 'ECONNREFUSED' },
      { name: 'empty', tools: [] },
    ]);
    expect(md).toContain('> ⚠ Connection error: ECONNREFUSED');
    expect(md).toContain('_No tools available_');
  });
});
