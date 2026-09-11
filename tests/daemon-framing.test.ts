/**
 * Unit tests for the daemon socket framing helpers (newline-delimited JSON
 * with backpressure-aware writes). Platform-independent, no sockets needed.
 */

import { describe, expect, test } from 'bun:test';
import { createLineReader, flushPending, writeAll } from '../src/daemon';

describe('createLineReader', () => {
  test('returns nothing until a frame is terminated', () => {
    const r = createLineReader();
    expect(r.push(Buffer.from('{"a":'))).toEqual([]);
    expect(r.push(Buffer.from('1}'))).toEqual([]);
    expect(r.push(Buffer.from('\n'))).toEqual(['{"a":1}']);
  });

  test('reassembles a frame split across many chunks', () => {
    const frame = JSON.stringify({ text: 'x'.repeat(200_000) });
    const bytes = Buffer.from(`${frame}\n`);
    const r = createLineReader();
    const out: string[] = [];
    for (let i = 0; i < bytes.length; i += 7919) {
      out.push(...r.push(bytes.subarray(i, i + 7919)));
    }
    expect(out).toEqual([frame]);
  });

  test('keeps multi-byte UTF-8 intact when a chunk boundary splits a character', () => {
    const frame = JSON.stringify({ s: 'äöü€😀' });
    const bytes = Buffer.from(`${frame}\n`);
    const r = createLineReader();
    // Split inside the 4-byte emoji and inside a 2-byte umlaut.
    const cut1 = bytes.indexOf(Buffer.from('ä')) + 1;
    const cut2 = bytes.indexOf(Buffer.from('😀')) + 2;
    const out = [
      ...r.push(bytes.subarray(0, cut1)),
      ...r.push(bytes.subarray(cut1, cut2)),
      ...r.push(bytes.subarray(cut2)),
    ];
    expect(out).toEqual([frame]);
    expect(JSON.parse(out[0]).s).toBe('äöü€😀');
  });

  test('yields several frames from one chunk and keeps the remainder', () => {
    const r = createLineReader();
    expect(r.push(Buffer.from('{"a":1}\n{"b":2}\n{"c"'))).toEqual([
      '{"a":1}',
      '{"b":2}',
    ]);
    expect(r.push(Buffer.from(':3}\n'))).toEqual(['{"c":3}']);
  });
});

describe('writeAll / flushPending', () => {
  /** A socket that accepts at most `limit` bytes per write call. */
  function fakeSocket(limit: number) {
    const chunks: Uint8Array[] = [];
    return {
      chunks,
      write(data: Uint8Array): number {
        const n = Math.min(limit, data.length);
        chunks.push(data.subarray(0, n));
        return n;
      },
      received(): string {
        return Buffer.concat(chunks).toString('utf8');
      },
    };
  }

  test('writes everything in one go when the socket accepts it', () => {
    const s = fakeSocket(1_000_000);
    writeAll(s, 'hello\n');
    expect(s.received()).toBe('hello\n');
    flushPending(s); // nothing pending; must be a no-op
    expect(s.received()).toBe('hello\n');
  });

  test('flushes the remainder from drain when writes are partial', () => {
    const s = fakeSocket(10);
    const text = `${'0123456789abcdef'.repeat(100)}\n`;
    writeAll(s, text);
    expect(s.received().length).toBe(10);
    // Each drain call writes until the socket refuses again (here: one 10-byte slice).
    while (s.received().length < text.length) flushPending(s);
    expect(s.received()).toBe(text);
    flushPending(s);
    expect(s.received()).toBe(text);
  });

  test('queues a second frame behind an unfinished first one, in order', () => {
    const s = fakeSocket(4);
    writeAll(s, 'first\n');
    writeAll(s, 'second\n');
    while (s.received().length < 'first\nsecond\n'.length) flushPending(s);
    expect(s.received()).toBe('first\nsecond\n');
  });
});
