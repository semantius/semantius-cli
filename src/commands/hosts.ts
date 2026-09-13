/**
 * hosts / use — the host index (src/hosts-index.ts) as CLI surface: list
 * every host this machine has logged in to (or been pointed at) alongside
 * the stored default, and switch the default explicitly.
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { getSessionExpiryFor, hasStoredSessionFor } from '../auth/session.js';
import { debug, getEnvPrefix, getUserConfigDir } from '../config.js';
import { ErrorCode } from '../errors.js';
import {
  type HostSource,
  getHost,
  getHostSource,
  isCloudHost,
  normalizeHost,
  orgFromHost,
} from '../host.js';
import {
  type HostsIndexEntry,
  getDefaultHost,
  hasHost,
  listHosts,
  markSessionsScanned,
  recordHost,
  sessionsScannedAt,
  setDefaultHost,
} from '../hosts-index.js';

export interface HostsOptions {
  json?: boolean;
}

export interface UseOptions {
  host: string;
}

interface HostRow extends HostsIndexEntry {
  host: string;
  isDefault: boolean;
  session: boolean;
  sessionExpires?: string;
}

/**
 * Facts a new hosts-index entry needs, from the host name alone: cloud
 * hosts carry their org (the first label); self-hosted ones carry none.
 */
function factsFromHostName(host: string): {
  mode: HostsIndexEntry['mode'];
  org: string | null;
} {
  return isCloudHost(host)
    ? { mode: 'cloud', org: orgFromHost(host) }
    : { mode: 'selfhosted', org: null };
}

/**
 * Reverses safeName's (storage.ts) ":" → "_" port mangling: a trailing
 * "_<digits>" is a de-munged port, since a real hostname label never
 * contains "_". Anything else is returned unchanged.
 */
function unsafeHostName(safe: string): string {
  const match = safe.match(/^(.+)_(\d+)$/);
  return match ? `${match[1]}:${match[2]}` : safe;
}

/**
 * One-time migration, run once per profile: index every host with a session
 * directory under <user config dir>/sessions/ that the hosts-index doesn't
 * already know about. A keyring-only session self-heals on its own next use
 * (see session.ts's getSessionToken), but a session that has sat unused
 * since before hosts.json existed — or that only ever lived in the file
 * fallback — would otherwise never appear in "semantius hosts".
 */
async function scanSessionsOnce(): Promise<void> {
  if (sessionsScannedAt() !== null) return;

  const prefix = getEnvPrefix();
  const sessionsDir = join(getUserConfigDir(), 'sessions');
  try {
    const entries = await readdir(sessionsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(`${prefix}_`)) {
        continue;
      }
      let host: string;
      try {
        host = normalizeHost(
          unsafeHostName(entry.name.slice(prefix.length + 1)),
        );
      } catch {
        continue; // not a recognizable host directory name; skip it
      }
      if (!hasHost(host)) recordHost(host, factsFromHostName(host));
    }
  } catch (error) {
    debug(`Sessions directory scan skipped: ${(error as Error).message}`);
  }
  markSessionsScanned();
}

const COLUMNS = ['', 'HOST', 'MODE', 'ORG', 'SESSION', 'EXPIRES'] as const;

function rowCells(row: HostRow): string[] {
  return [
    row.isDefault ? '*' : '',
    row.host,
    row.mode,
    row.org ?? '(none)',
    row.session ? 'yes' : 'no',
    row.sessionExpires ?? '-',
  ];
}

function formatTable(rows: HostRow[]): string {
  const allRows = [[...COLUMNS], ...rows.map(rowCells)];
  const widths = COLUMNS.map((_, i) =>
    Math.max(...allRows.map((r) => r[i].length)),
  );
  return allRows
    .map((cells) =>
      cells
        .map((c, i) => c.padEnd(widths[i]))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

/** The effective host in this directory, for the table's trailing "current" line. */
function currentHost(): { host: string; source: HostSource } | null {
  try {
    const host = getHost();
    return host ? { host, source: getHostSource() as HostSource } : null;
  } catch {
    // A HOST_CONFLICT or an invalid host: "hosts" stays usable to inspect
    // and fix the setup (e.g. via "use") rather than failing outright.
    return null;
  }
}

export async function hostsCommand(opts: HostsOptions): Promise<void> {
  await scanSessionsOnce();

  const defaultHost = getDefaultHost();
  const entries = listHosts();
  const rows: HostRow[] = await Promise.all(
    entries.map(async (e) => ({
      ...e,
      isDefault: e.host === defaultHost,
      session: await hasStoredSessionFor(e.host),
      sessionExpires: await getSessionExpiryFor(e.host),
    })),
  );
  const current = currentHost();

  if (opts.json) {
    console.log(JSON.stringify({ defaultHost, current, hosts: rows }, null, 2));
    return;
  }

  if (rows.length === 0) {
    console.log(
      'No hosts yet. Run "semantius login --host <host>" to sign in to one.',
    );
    return;
  }

  console.log(formatTable(rows));
  console.log(
    current ? `current: ${current.host} (${current.source})` : 'current: none',
  );
}

export async function useCommand(opts: UseOptions): Promise<void> {
  const host = normalizeHost(opts.host);

  if (!(await hasStoredSessionFor(host))) {
    console.error(
      `Error [NO_SESSION]: no session stored for ${host}. Run "semantius login --host ${host}" first`,
    );
    process.exit(ErrorCode.CLIENT_ERROR);
  }

  if (!hasHost(host)) recordHost(host, factsFromHostName(host));

  const previous = setDefaultHost(host);
  console.log(
    previous
      ? `Default host: ${host} (was ${previous})`
      : `Default host: ${host} (none before)`,
  );
}
