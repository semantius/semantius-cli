/**
 * hosts / use — the host index (src/hosts-index.ts) as CLI surface: list
 * every host this machine has logged in to (or been pointed at) alongside
 * the current one, and switch the current host explicitly. `use` is the one
 * command that changes it — logging in first, via the browser, when the
 * target host has no stored session yet.
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  getSessionExpiryFor,
  hasStoredSessionFor,
  login,
} from '../auth/session.js';
import {
  debug,
  getEnvPrefix,
  getLegacyUserSecretsDirs,
  getUserSecretsDir,
} from '../config.js';
import {
  type HostSource,
  getHost,
  getHostSource,
  isCloudHost,
  normalizeHost,
  orgFromHost,
  resolveHostFacts,
} from '../host.js';
import {
  type HostsIndexEntry,
  clearCurrentHost,
  getCurrentHost,
  hasHost,
  listHosts,
  markSessionsScanned,
  recordHost,
  sessionsScannedAt,
  setCurrentHost,
} from '../hosts-index.js';

export interface HostsOptions {
  json?: boolean;
}

/** Either a host to make current, or --clear to unset the current host entirely. */
export type UseOptions = { host: string } | { clear: true };

interface HostRow extends HostsIndexEntry {
  host: string;
  isCurrent: boolean;
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
 * directory under <user secrets dir>/sessions/ that the hosts-index doesn't
 * already know about. A keyring-only session self-heals on its own next use
 * (see session.ts's getSessionToken), but a session that has sat unused
 * since before hosts.json existed — or that only ever lived in the file
 * fallback — would otherwise never appear in "semantius hosts".
 *
 * The old location is scanned too: a session there has not been used since
 * credentials moved out of the roaming profile, so nothing has migrated it
 * yet (storage.ts does that on its next load), and it is exactly the kind of
 * long-unused session this scan exists to surface.
 */
async function scanSessionsOnce(): Promise<void> {
  if (sessionsScannedAt() !== null) return;

  const prefix = getEnvPrefix();
  const roots = [getUserSecretsDir(), ...getLegacyUserSecretsDirs()].filter(
    (root, i, all) => all.indexOf(root) === i,
  );
  for (const root of roots) {
    const sessionsDir = join(root, 'sessions');
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
  }
  markSessionsScanned();
}

const COLUMNS = ['', 'HOST', 'MODE', 'ORG', 'SESSION', 'EXPIRES'] as const;

function rowCells(row: HostRow): string[] {
  return [
    row.isCurrent ? '*' : '',
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

/** The fully-resolved host in this directory, for the table's trailing "current" line. */
function resolvedHost(): { host: string; source: HostSource } | null {
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

  const currentHost = getCurrentHost();
  const entries = listHosts();
  const rows: HostRow[] = await Promise.all(
    entries.map(async (e) => ({
      ...e,
      isCurrent: e.host === currentHost,
      session: await hasStoredSessionFor(e.host),
      sessionExpires: await getSessionExpiryFor(e.host),
    })),
  );
  const resolved = resolvedHost();

  if (opts.json) {
    console.log(
      JSON.stringify({ currentHost, current: resolved, hosts: rows }, null, 2),
    );
    return;
  }

  if (rows.length === 0) {
    console.log(
      'No hosts yet. Run "semantius use <host>" to sign in to one and make it current.',
    );
    return;
  }

  console.log(formatTable(rows));
  console.log(
    resolved
      ? `current: ${resolved.host} (${resolved.source})`
      : 'current: none',
  );
}

export async function useCommand(opts: UseOptions): Promise<void> {
  if ('clear' in opts) {
    // Only the current-host marker goes away: the hosts-index entry and any
    // stored session are untouched, so "use <host>" again needs no new login.
    const previous = getCurrentHost();
    clearCurrentHost();
    console.log(
      previous
        ? `Current host cleared (was ${previous}).`
        : 'No current host was set.',
    );
    return;
  }

  const host = normalizeHost(opts.host);

  if (await hasStoredSessionFor(host)) {
    if (!hasHost(host)) recordHost(host, factsFromHostName(host));
  } else {
    const facts = await resolveHostFacts(host);
    await login(facts);
    recordHost(
      host,
      { mode: facts.mode, org: facts.org },
      { loggedInAt: new Date().toISOString() },
    );
  }

  const previous = setCurrentHost(host);
  console.log(
    previous
      ? `Current host: ${host} (was ${previous})`
      : `Current host: ${host} (none before)`,
  );
}
