/**
 * Tests for the host index (src/hosts-index.ts): the current host, the
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
  clearCurrentHost,
  getCurrentHost,
  getHostsIndexPath,
  hasHost,
  listHosts,
  markSessionsScanned,
  recordHost,
  removeHost,
  sessionsScannedAt,
  setCurrentHost,
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

  test('empty index: no current host, no hosts, no scan marker', () => {
    expect(getCurrentHost()).toBeNull();
    expect(listHosts()).toEqual([]);
    expect(hasHost('acme.semantius.cloud')).toBe(false);
    expect(sessionsScannedAt()).toBeNull();
    // Nothing was ever written.
    expect(existsSync(getHostsIndexPath())).toBe(false);
  });

  test('round trip: recordHost, setCurrentHost, listHosts, hasHost survive a reload', () => {
    recordHost(
      'acme.semantius.cloud',
      { mode: 'cloud', org: 'acme' },
      { loggedInAt: '2026-01-01T00:00:00.000Z' },
    );
    recordHost('x.example.com', { mode: 'selfhosted', org: null });
    setCurrentHost('acme.semantius.cloud');

    // Simulate a new process re-reading the same file.
    setHostsIndexDirForTests(dir);

    expect(getCurrentHost()).toBe('acme.semantius.cloud');
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

  test('setCurrentHost returns the previous current host (null the first time)', () => {
    expect(setCurrentHost('a.semantius.cloud')).toBeNull();
    expect(setCurrentHost('b.semantius.cloud')).toBe('a.semantius.cloud');
    expect(getCurrentHost()).toBe('b.semantius.cloud');
  });

  test('clearCurrentHost leaves recorded hosts untouched', () => {
    recordHost('acme.semantius.cloud', { mode: 'cloud', org: 'acme' });
    setCurrentHost('acme.semantius.cloud');
    clearCurrentHost();
    expect(getCurrentHost()).toBeNull();
    expect(hasHost('acme.semantius.cloud')).toBe(true);
  });

  test('removeHost: wasCurrent is true only when the removed host was current', () => {
    recordHost('acme.semantius.cloud', { mode: 'cloud', org: 'acme' });
    recordHost('other.semantius.cloud', { mode: 'cloud', org: 'other' });
    setCurrentHost('acme.semantius.cloud');

    expect(removeHost('other.semantius.cloud')).toEqual({ wasCurrent: false });
    expect(getCurrentHost()).toBe('acme.semantius.cloud');

    expect(removeHost('acme.semantius.cloud')).toEqual({ wasCurrent: true });
    expect(getCurrentHost()).toBeNull();
    expect(hasHost('acme.semantius.cloud')).toBe(false);
  });

  test('removeHost on an unknown host is a no-op', () => {
    expect(removeHost('nope.example.com')).toEqual({ wasCurrent: false });
  });

  test('removeHost clears a dangling current host even with no matching entry', () => {
    // Not reachable through setCurrentHost's own callers (they always
    // recordHost first), but hosts.json could end up this way regardless —
    // a hand edit, or a future caller that skips recordHost — and the
    // current host must not survive the host it named being "removed".
    setCurrentHost('ghost.example.com');
    expect(hasHost('ghost.example.com')).toBe(false);

    expect(removeHost('ghost.example.com')).toEqual({ wasCurrent: true });
    expect(getCurrentHost()).toBeNull();
  });

  test('markSessionsScanned records an ISO timestamp; unset before that', () => {
    expect(sessionsScannedAt()).toBeNull();
    markSessionsScanned();
    expect(sessionsScannedAt()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('per-prefix isolation: PROD and SEMANTIUS keep separate current hosts and hosts', () => {
    setEnvPrefix('SEMANTIUS');
    recordHost('sem.semantius.cloud', { mode: 'cloud', org: 'sem' });
    setCurrentHost('sem.semantius.cloud');

    setEnvPrefix('PROD');
    expect(getCurrentHost()).toBeNull();
    expect(hasHost('sem.semantius.cloud')).toBe(false);
    recordHost('prod.semantius.cloud', { mode: 'cloud', org: 'prod' });
    setCurrentHost('prod.semantius.cloud');

    setEnvPrefix('SEMANTIUS');
    expect(getCurrentHost()).toBe('sem.semantius.cloud');
    expect(hasHost('prod.semantius.cloud')).toBe(false);

    setEnvPrefix('PROD');
    expect(getCurrentHost()).toBe('prod.semantius.cloud');
  });

  test('corrupt file reads as empty; a later write repairs it', () => {
    writeFileSync(getHostsIndexPath(), 'not json', 'utf8');
    expect(getCurrentHost()).toBeNull();
    expect(listHosts()).toEqual([]);

    setCurrentHost('acme.semantius.cloud');
    setHostsIndexDirForTests(dir); // force a re-read from disk
    expect(getCurrentHost()).toBe('acme.semantius.cloud');
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
    expect(getCurrentHost()).toBeNull();

    setCurrentHost('acme.semantius.cloud');
    setHostsIndexDirForTests(dir);
    expect(getCurrentHost()).toBe('acme.semantius.cloud');
  });

  test('a missing profiles object reads as empty', () => {
    writeFileSync(getHostsIndexPath(), JSON.stringify({ version: 1 }), 'utf8');
    expect(getCurrentHost()).toBeNull();
    expect(listHosts()).toEqual([]);
  });

  test('write leaves no .tmp file behind', async () => {
    setCurrentHost('acme.semantius.cloud');
    const files = await readdir(dir);
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
    expect(files).toContain('hosts.json');
  });

  test('file is written 0600 (non-Windows)', () => {
    if (process.platform === 'win32') return;
    setCurrentHost('acme.semantius.cloud');
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
