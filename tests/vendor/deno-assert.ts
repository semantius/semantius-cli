/**
 * Minimal stand-in for Deno's std/assert, so the vendored upstream test
 * (tests/vendor/crud-bulk.test.ts, copied by scripts/sync-postgrest-mcp.ts)
 * runs unchanged under bun:test. Hand-written — not synced.
 *
 * assertEquals maps to toStrictEqual: Deno's equal() also treats a key that is
 * present-but-undefined as different from an absent key.
 */

import { expect } from 'bun:test';

export function assert(expr: unknown, msg?: string): asserts expr {
  if (!expr) throw new Error(msg ?? 'Assertion failed');
}

export function assertEquals<T>(actual: T, expected: T, msg?: string): void {
  if (msg) {
    try {
      expect(actual).toStrictEqual(expected);
    } catch (error) {
      throw new Error(`${msg}\n${(error as Error).message}`);
    }
    return;
  }
  expect(actual).toStrictEqual(expected);
}

export function assertStringIncludes(
  actual: string,
  expected: string,
  msg?: string,
): void {
  if (!actual.includes(expected)) {
    throw new Error(
      msg ?? `Expected actual: "${actual}" to contain: "${expected}"`,
    );
  }
}
