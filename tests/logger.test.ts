/**
 * Tests for the pure argv-redaction helper in src/logger.ts. redactArgv keeps
 * a --token literal out of the JSONL log's `cli` field (process.argv), the
 * one place a --token value appears outside process memory itself.
 */

import { describe, expect, test } from 'bun:test';
import { redactArgv } from '../src/logger';

describe('redactArgv', () => {
  test('redacts the literal value after --token', () => {
    expect(redactArgv(['whoami', '--token', 'acme:eyJ.e30.sig'])).toEqual([
      'whoami',
      '--token',
      '<redacted>',
    ]);
  });

  test('leaves --token - alone: "-" names stdin, not a secret', () => {
    expect(redactArgv(['whoami', '--token', '-'])).toEqual([
      'whoami',
      '--token',
      '-',
    ]);
  });

  test('redacts the --token=value form defensively', () => {
    expect(redactArgv(['whoami', '--token=acme:eyJ.e30.sig'])).toEqual([
      'whoami',
      '--token=<redacted>',
    ]);
  });

  test('leaves --token=- alone', () => {
    expect(redactArgv(['whoami', '--token=-'])).toEqual(['whoami', '--token=-']);
  });

  test("leaves --token-file's path alone: it is not a secret", () => {
    expect(redactArgv(['whoami', '--token-file', '/tmp/token.txt'])).toEqual([
      'whoami',
      '--token-file',
      '/tmp/token.txt',
    ]);
  });

  test('leaves argv without --token untouched', () => {
    const argv = ['bun', 'src/index.ts', 'whoami', '--host', 'acme.semantius.cloud'];
    expect(redactArgv(argv)).toEqual(argv);
  });

  test('does not mutate the input array', () => {
    const argv = ['whoami', '--token', 'acme:secret'];
    const copy = [...argv];
    redactArgv(argv);
    expect(argv).toEqual(copy);
  });

  test('a trailing --token with no value is left as-is', () => {
    expect(redactArgv(['whoami', '--token'])).toEqual(['whoami', '--token']);
  });

  test('redacts every occurrence when --token appears more than once', () => {
    expect(redactArgv(['--token', 'a:one', 'whoami', '--token', 'b:two'])).toEqual([
      '--token',
      '<redacted>',
      'whoami',
      '--token',
      '<redacted>',
    ]);
  });
});
