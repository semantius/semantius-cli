/**
 * The host index: `<user config dir>/hosts.json`, recording which hosts this
 * machine has ever logged in to (or been pointed at), and which one — if any
 * — is the *current* host for a given `--env` prefix: the host `semantius
 * use <host>` selected, checked right after --host in getHost()'s order.
 * Read by host.ts and by `semantius hosts` / `semantius use`; written by
 * `use`, `logout` and the self-healing scan in session.ts. `login` no longer
 * touches it — see commands/auth.ts.
 *
 * Not `config.json`: "config" already means the MCP servers file (`--config`,
 * `SEMANTIUS_CONFIG_PATH`, `config_source`).
 *
 * Deliberately separate from src/host.ts's on-disk cache (control-plane
 * records, OAuth endpoints, keyed by host and re-fetchable on a miss): this
 * file is local state — the current host and the "have I seen this host"
 * index — that nothing can re-derive, so a read failure returns empty rather
 * than refetching. Kept dependency-free of host.ts (only config.ts + node:fs)
 * so host.ts can import this module without a cycle.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { debug, getEnvPrefix, getUserConfigDir } from './config.js';

export interface HostsIndexEntry {
  mode: 'cloud' | 'selfhosted';
  org: string | null;
  /** When a session was last stored for this host (absent: self-healed / scanned entry). */
  loggedInAt?: string;
}

interface ProfileIndex {
  currentHost?: string;
  /** ISO timestamp of the one-time sessions-dir scan (see session.ts), or absent. */
  scannedSessionsAt?: string;
  hosts: Record<string, HostsIndexEntry>;
}

interface HostsIndexFile {
  version: 1;
  profiles: Record<string, ProfileIndex>;
}

function emptyIndexFile(): HostsIndexFile {
  return { version: 1, profiles: {} };
}

function emptyProfile(): ProfileIndex {
  return { hosts: {} };
}

// ============================================================================
// On-disk location and in-memory cache
// ============================================================================

let _dirOverride: string | undefined;
let _cache: HostsIndexFile | undefined;

/** Test seam: redirect the index away from the real user config dir. */
export function setHostsIndexDirForTests(dir: string | undefined): void {
  _dirOverride = dir;
  _cache = undefined;
}

export function getHostsIndexPath(): string {
  return join(_dirOverride ?? getUserConfigDir(), 'hosts.json');
}

/**
 * Read the index from disk once per process and keep it in a module
 * variable — refreshed on every write — so every lookup below stays
 * synchronous and cheap enough for getHost()'s current-host rung.
 */
function loadIndex(): HostsIndexFile {
  if (_cache) return _cache;

  const path = getHostsIndexPath();
  if (!existsSync(path)) {
    _cache = emptyIndexFile();
    return _cache;
  }

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      parsed.version !== 1 ||
      typeof parsed.profiles !== 'object' ||
      parsed.profiles === null
    ) {
      debug(`Hosts index has an unexpected shape or version: ${path}`);
      _cache = emptyIndexFile();
      return _cache;
    }
    _cache = parsed as HostsIndexFile;
  } catch (error) {
    debug(`Hosts index read failed (${path}): ${(error as Error).message}`);
    _cache = emptyIndexFile();
  }
  return _cache;
}

/** Atomic write (temp file + rename), mode 0600, same pattern as host.ts's cache. */
function writeIndex(index: HostsIndexFile): void {
  // Update the in-memory view even if the disk write below fails: the
  // caller's change (e.g. "this is now the current host") still applies for
  // the rest of this process, and the write failure is logged via debug —
  // matching how the rest of the CLI treats an unwritable config dir.
  _cache = index;

  const path = getHostsIndexPath();
  const tmpPath = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmpPath, `${JSON.stringify(index, null, 2)}\n`, {
      mode: 0o600,
    });
    renameSync(tmpPath, path);
    if (process.platform !== 'win32') chmodSync(path, 0o600);
  } catch (error) {
    debug(`Hosts index write failed (${path}): ${(error as Error).message}`);
    try {
      unlinkSync(tmpPath);
    } catch {
      // temp file may not exist
    }
  }
}

function currentProfile(): ProfileIndex {
  return loadIndex().profiles[getEnvPrefix()] ?? emptyProfile();
}

/** Read-modify-write the active profile (scoped to getEnvPrefix()). */
function updateProfile(mutate: (profile: ProfileIndex) => void): void {
  const index = loadIndex();
  const prefix = getEnvPrefix();
  const existing = index.profiles[prefix];
  const profile: ProfileIndex = existing
    ? { ...existing, hosts: { ...existing.hosts } }
    : emptyProfile();

  mutate(profile);

  writeIndex({
    ...index,
    profiles: { ...index.profiles, [prefix]: profile },
  });
}

// ============================================================================
// API — all synchronous, scoped to the active --env prefix
// ============================================================================

export function getCurrentHost(): string | null {
  return currentProfile().currentHost ?? null;
}

/** Sets the current host; returns the previous one (null if none). */
export function setCurrentHost(host: string): string | null {
  const previous = getCurrentHost();
  updateProfile((profile) => {
    profile.currentHost = host;
  });
  return previous;
}

export function clearCurrentHost(): void {
  updateProfile((profile) => {
    profile.currentHost = undefined;
  });
}

/** Upsert a host entry. Omitting loggedInAt keeps whatever was already stored. */
export function recordHost(
  host: string,
  facts: { mode: HostsIndexEntry['mode']; org: string | null },
  opts: { loggedInAt?: string } = {},
): void {
  updateProfile((profile) => {
    const existing = profile.hosts[host];
    const loggedInAt = opts.loggedInAt ?? existing?.loggedInAt;
    profile.hosts[host] = {
      mode: facts.mode,
      org: facts.org,
      ...(loggedInAt !== undefined ? { loggedInAt } : {}),
    };
  });
}

export function hasHost(host: string): boolean {
  return host in currentProfile().hosts;
}

/**
 * Deletes the entry and, if it was the current host, clears that too —
 * checked independently of whether an entry actually existed, so a
 * currentHost left dangling with no matching entry (hand-edited hosts.json,
 * say) still gets cleared rather than silently kept.
 */
export function removeHost(host: string): { wasCurrent: boolean } {
  let wasCurrent = false;
  updateProfile((profile) => {
    if (host in profile.hosts) delete profile.hosts[host];
    if (profile.currentHost === host) {
      wasCurrent = true;
      profile.currentHost = undefined;
    }
  });
  return { wasCurrent };
}

export interface HostsIndexListing extends HostsIndexEntry {
  host: string;
}

export function listHosts(): HostsIndexListing[] {
  return Object.entries(currentProfile().hosts)
    .map(([host, entry]) => ({ host, ...entry }))
    .sort((a, b) => a.host.localeCompare(b.host));
}

export function sessionsScannedAt(): string | null {
  return currentProfile().scannedSessionsAt ?? null;
}

export function markSessionsScanned(): void {
  updateProfile((profile) => {
    profile.scannedSessionsAt = new Date().toISOString();
  });
}
