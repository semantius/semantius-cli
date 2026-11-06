/**
 * Unit tests for search_tools - matching, ranking and output format
 */

import { describe, test, expect } from 'bun:test';
import {
  compareMatches,
  formatMatches,
  matchTool,
  queryWords,
  type ToolMatch,
} from '../src/commands/search-tools';

const spec = {
  name: 'generate_spec',
  description: 'Generates the semantic spec document',
};
const diagram = {
  name: 'generate_module_diagram',
  description: 'Draws the entity relationship diagram of a module',
};

describe('queryWords', () => {
  test('lowercases, splits on whitespace and drops duplicates', () => {
    expect(queryWords('  Entity  entity RELATIONSHIP ')).toEqual([
      'entity',
      'relationship',
    ]);
  });
});

describe('matchTool', () => {
  test('finds a word in the description', () => {
    expect(matchTool(spec, queryWords('document'))).toEqual({
      matched: 'description',
      score: 1,
    });
  });

  test('finds a word in the name', () => {
    expect(matchTool(diagram, queryWords('diagram'))?.matched).toBe('name');
  });

  test('one matching word is enough; the score counts the words found', () => {
    expect(matchTool(diagram, queryWords('entity nonsense'))?.score).toBe(1);
    expect(matchTool(diagram, queryWords('entity relationship'))?.score).toBe(
      2,
    );
    expect(matchTool(diagram, queryWords('nonsense other'))).toBeNull();
  });

  test('words may be split between name and description', () => {
    const hit = matchTool(diagram, queryWords('module relationship'));
    expect(hit).toEqual({ matched: 'name', score: 2 });
  });

  test('is case-insensitive', () => {
    expect(matchTool(diagram, queryWords('DIAGRAM'))).toEqual(
      matchTool(diagram, queryWords('diagram')),
    );
  });

  test('glob characters are literal', () => {
    expect(matchTool(spec, queryWords('*doc*'))).toBeNull();
    expect(matchTool(spec, queryWords('doc?ment'))).toBeNull();
  });

  test('empty query matches nothing', () => {
    expect(matchTool(spec, queryWords('   '))).toBeNull();
  });
});

describe('compareMatches', () => {
  const m = (
    server: string,
    tool: string,
    matched: ToolMatch['matched'],
    score: number,
  ): ToolMatch => ({ server, tool, description: '', matched, score });

  test('ranks by score, then name before description, then server and tool', () => {
    const sorted = [
      m('crud', 'b', 'description', 1),
      m('utils', 'a', 'name', 1),
      m('crud', 'z', 'description', 2),
      m('crud', 'c', 'name', 1),
      m('crud', 'a', 'description', 1),
    ].sort(compareMatches);
    expect(sorted.map((x) => `${x.server}/${x.tool}`)).toEqual([
      'crud/z',
      'crud/c',
      'utils/a',
      'crud/a',
      'crud/b',
    ]);
  });
});

describe('formatMatches', () => {
  test('groups under the server with the first description line', () => {
    const out = formatMatches([
      {
        server: 'crud',
        tool: 'generate_spec',
        description: 'Line one\nLine two',
        matched: 'description',
        score: 1,
      },
    ]);
    expect(out).toBe('crud\n  • generate_spec - Line one');
  });
});
