/**
 * Tests for the host index (src/hosts-index.ts): the default host, the
 * per-host record, and the sessions-scan marker — all scoped to the active
 * --env prefix and persisted at <dir>/hosts.json.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setEnvPrefix } from '../src/config';
import {
  clearDefaultHost,
  getDefaultHost,
  getHostsIndexPath,
  hasHost,
  listHosts,
  markSessionsScanned,
  recordHost,
  removeHost,
  sessionsScannedAt,
  setDefaultHost,
  setHostsIndexDirForTests,
} from '../src/hosts-index';

describe('hosts index', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'semantius-hosts-index-'));
    setHostsIndexDirForTests(dir);
    setEnvPrefix('SEMANTIUS');
  });

  afterEach(async () => {
    setHostsIndexDirForTests(undefined);
    setEnvPrefix('SEMANTIUS');
    await rm(dir, { recursive: true, force: true });
  });

  test('empty index: no default, no hosts, no scan marker', () => {
    expect(getDefaultHost()).toBeNull();
    expect(listHosts()).toEqual([]);
    expect(hasHost('acme.semantius.cloud')).toBe(false);
    expect(sessionsScannedAt()).toBeNull();
    // Nothing was ever written.
    expect(existsSync(getHostsIndexPath())).toBe(false);
  });

  test('round trip: recordHost, setDefaultHost, listHosts, hasHost survive a reload', () => {
    recordHost(
      'acme.semantius.cloud',
      { mode: 'cloud', org: 'acme' },
      { loggedInAt: '2026-01-01T00:00:00.000Z' },
    );
    recordHost('x.example.com', { mode: 'selfhosted', org: null });
    setDefaultHost('acme.semantius.cloud');

    // Simulate a new process re-reading the same file.
    setHostsIndexDirForTests(dir);

    expect(getDefaultHost()).toBe('acme.semantius.cloud');
    expect(hasHost('acme.semantius.cloud')).toBe(true);
    expect(hasHost('x.example.com')).toBe(true);
    expect(hasHost('nope.example.com')).toBe(false);
    expect(listHosts()).toEqual([
      {
        host: 'acme.semantius.cloud',
        mode: 'cloud',
        org: 'acme',
        loggedInAt: '2026-01-01T00:00:00.000Z',
      },
      { host: 'x.example.com', mode: 'selfhosted', org: null },
    ]);
  });

  test('listHosts is sorted by host', () => {
    recordHost('zzz.example.com', { mode: 'selfhosted', org: null });
    recordHost('aaa.semantius.cloud', { mode: 'cloud', org: 'aaa' });
    expect(listHosts().map((h) => h.host)).toEqual([
      'aaa.semantius.cloud',
      'zzz.example.com',
    ]);
  });

  test('recordHost upsert keeps an existing loggedInAt when none is given', () => {
    recordHost(
      'acme.semantius.cloud',
      { mode: 'cloud', org: 'acme' },
      { loggedInAt: '2026-01-01T00:00:00.000Z' },
    );
    // A self-heal / scan record with no loggedInAt must not erase the earlier one.
    recordHost('acme.semantius.cloud', { mode: 'cloud', org: 'acme' });
    expect(listHosts()[0].loggedInAt).toBe('2026-01-01T00:00:00.000Z');
  });

  test('recordHost upsert overwrites loggedInAt when a new one is given', () => {
    recordHost(
      'acme.semantius.cloud',
      { mode: 'cloud', org: 'acme' },
      { loggedInAt: '2026-01-01T00:00:00.000Z' },
    );
    recordHost(
      'acme.semantius.cloud',
      { mode: 'cloud', org: 'acme' },
      { loggedInAt: '2026-02-02T00:00:00.000Z' },
    );
    expect(listHosts()[0].loggedInAt).toBe('2026-02-02T00:00:00.000Z');
  });

  test('setDefaultHost returns the previous default (null the first time)', () => {
    expect(setDefaultHost('a.semantius.cloud')).toBeNull();
    expect(setDefaultHost('b.semantius.cloud')).toBe('a.semantius.cloud');
    expect(getDefaultHost()).toBe('b.semantius.cloud');
  });

  test('clearDefaultHost leaves recorded hosts untouched', () => {
    recordHost('acme.semantius.cloud', { mode: 'cloud', org: 'acme' });
    setDefaultHost('acme.semantius.cloud');
    clearDefaultHost();
    expect(getDefaultHost()).toBeNull();
    expect(hasHost('acme.semantius.cloud')).toBe(true);
  });

  test('removeHost: wasDefault is true only when the removed host was the default', () => {
    recordHost('acme.semantius.cloud', { mode: 'cloud', org: 'acme' });
    recordHost('other.semantius.cloud', { mode: 'cloud', org: 'other' });
    setDefaultHost('acme.semantius.cloud');

    expect(removeHost('other.semantius.cloud')).toEqual({ wasDefault: false });
    expect(getDefaultHost()).toBe('acme.semantius.cloud');

    expect(removeHost('acme.semantius.cloud')).toEqual({ wasDefault: true });
    expect(getDefaultHost()).toBeNull();
    expect(hasHost('acme.semantius.cloud')).toBe(false);
  });

  test('removeHost on an unknown host is a no-op', () => {
    expect(removeHost('nope.example.com')).toEqual({ wasDefault: false });
  });

  test('removeHost clears a dangling default even with no matching entry', () => {
    // Not reachable through setDefaultHost's own callers (they always
    // recordHost first), but hosts.json could end up this way regardless —
    // a hand edit, or a future caller that skips recordHost — and the
    // default must not survive the host it named being "removed".
    setDefaultHost('ghost.example.com');
    expect(hasHost('ghost.example.com')).toBe(false);

    expect(removeHost('ghost.example.com')).toEqual({ wasDefault: true });
    expect(getDefaultHost()).toBeNull();
  });

  test('markSessionsScanned records an ISO timestamp; unset before that', () => {
    expect(sessionsScannedAt()).toBeNull();
    markSessionsScanned();
    expect(sessionsScannedAt()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('per-prefix isolation: PROD and SEMANTIUS keep separate defaults and hosts', () => {
    setEnvPrefix('SEMANTIUS');
    recordHost('sem.semantius.cloud', { mode: 'cloud', org: 'sem' });
    setDefaultHost('sem.semantius.cloud');

    setEnvPrefix('PROD');
    expect(getDefaultHost()).toBeNull();
    expect(hasHost('sem.semantius.cloud')).toBe(false);
    recordHost('prod.semantius.cloud', { mode: 'cloud', org: 'prod' });
    setDefaultHost('prod.semantius.cloud');

    setEnvPrefix('SEMANTIUS');
    expect(getDefaultHost()).toBe('sem.semantius.cloud');
    expect(hasHost('prod.semantius.cloud')).toBe(false);

    setEnvPrefix('PROD');
    expect(getDefaultHost()).toBe('prod.semantius.cloud');
  });

  test('corrupt file reads as empty; a later write repairs it', () => {
    writeFileSync(getHostsIndexPath(), 'not json', 'utf8');
    expect(getDefaultHost()).toBeNull();
    expect(listHosts()).toEqual([]);

    setDefaultHost('acme.semantius.cloud');
    setHostsIndexDirForTests(dir); // force a re-read from disk
    expect(getDefaultHost()).toBe('acme.semantius.cloud');
    expect(JSON.parse(readFileSync(getHostsIndexPath(), 'utf8')).version).toBe(
      1,
    );
  });

  test('an unknown version is treated as corrupt (empty, then repaired)', () => {
    writeFileSync(
      getHostsIndexPath(),
      JSON.stringify({ version: 2, profiles: { SEMANTIUS: { hosts: {} } } }),
      'utf8',
    );
    expect(getDefaultHost()).toBeNull();

    setDefaultHost('acme.semantius.cloud');
    setHostsIndexDirForTests(dir);
    expect(getDefaultHost()).toBe('acme.semantius.cloud');
  });

  test('a missing profiles object reads as empty', () => {
    writeFileSync(getHostsIndexPath(), JSON.stringify({ version: 1 }), 'utf8');
    expect(getDefaultHost()).toBeNull();
    expect(listHosts()).toEqual([]);
  });

  test('write leaves no .tmp file behind', async () => {
    setDefaultHost('acme.semantius.cloud');
    const files = await readdir(dir);
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
    expect(files).toContain('hosts.json');
  });

  test('file is written 0600 (non-Windows)', () => {
    if (process.platform === 'win32') return;
    setDefaultHost('acme.semantius.cloud');
    expect(statSync(getHostsIndexPath()).mode & 0o777).toBe(0o600);
  });

  test('hosts stored under one prefix do not leak into the raw JSON of another', () => {
    setEnvPrefix('SEMANTIUS');
    recordHost('sem.semantius.cloud', { mode: 'cloud', org: 'sem' });
    setEnvPrefix('PROD');
    recordHost('prod.semantius.cloud', { mode: 'cloud', org: 'prod' });

    const raw = JSON.parse(readFileSync(getHostsIndexPath(), 'utf8'));
    expect(Object.keys(raw.profiles).sort()).toEqual(['PROD', 'SEMANTIUS']);
    expect(Object.keys(raw.profiles.SEMANTIUS.hosts)).toEqual([
      'sem.semantius.cloud',
    ]);
    expect(Object.keys(raw.profiles.PROD.hosts)).toEqual([
      'prod.semantius.cloud',
    ]);
  });
});
