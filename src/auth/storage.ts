/**
 * Where an OAuth session is persisted: the OS keyring (Bun.secrets — Keychain,
 * Windows Credential Manager, libsecret) with cli-auth's 0600 file storage as
 * the fallback for machines without one (headless Linux).
 *
 * One entry per (env prefix, host), so a session obtained for one host is
 * never offered to another. Refreshes are serialized across processes with
 * cli-auth's file lock: two concurrent CLI invocations must not both spend the
 * refresh token.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { type Storage, type TokenSet, fileLock, fileStorage } from 'cli-auth';
import { debug, getEnvPrefix, getUserConfigDir } from '../config.js';

/** Service name under which every session is stored in the OS keyring. */
const SERVICE = 'semantius';

/** The part of Bun.secrets this module uses; tests inject a fake. */
export interface SecretsApi {
  get(options: { service: string; name: string }): Promise<string | null>;
  set(options: {
    service: string;
    name: string;
    value: string;
  }): Promise<void>;
  delete(options: { service: string; name: string }): Promise<boolean>;
}

let _secretsForTests: SecretsApi | undefined;

/**
 * Test seam: use a fake keyring instead of Bun.secrets. The real store is
 * never written by tests (the CI runners have one).
 */
export function setSecretsForTests(secrets: SecretsApi | undefined): void {
  _secretsForTests = secrets;
}

/** Storage name for a host: "<env prefix>:<host>", e.g. SEMANTIUS:acme.semantius.cloud. */
export function sessionName(host: string): string {
  return `${getEnvPrefix()}:${host}`;
}

/** File-system-safe form of a session name (":" is invalid on Windows). */
function safeName(name: string): string {
  return name.replace(/[:/\\]/g, '_');
}

/**
 * A cli-auth Storage over Bun.secrets, falling back to an 0600 file once the
 * keyring turns out to be unusable. The fallback is per session name, so each
 * host keeps its own credentials.json.
 */
export function createSecretStorage(
  name: string,
  secrets: SecretsApi = _secretsForTests ??
    (Bun.secrets as unknown as SecretsApi),
  opts: { quiet?: boolean } = {},
): Storage<TokenSet> {
  const dir = join(getUserConfigDir(), 'sessions');
  const sessionDir = join(dir, safeName(name));
  let keyringUsable = true;
  let fallback: Storage<TokenSet> | undefined;
  let announced = false;

  function fileBackend(announce = false): Storage<TokenSet> {
    if (!fallback) fallback = fileStorage<TokenSet>({ dir: sessionDir });
    if (announce && !announced) {
      announced = true;
      // "semantius hosts" opens one of these per indexed host to probe for a
      // session (see hasStoredSessionFor / getSessionExpiryFor): without
      // `quiet` that would print this line once per host on a keyring-less
      // machine, for a fact the table already conveys per-row.
      if (!opts.quiet) {
        console.error(
          `[semantius] no OS keyring available; storing the session in ${sessionDir}`,
        );
      }
    }
    return fallback;
  }

  /** Whether a session was ever written to the file fallback. */
  function hasFile(): boolean {
    return existsSync(join(sessionDir, 'credentials.json'));
  }

  /**
   * Run `viaKeyring`; if the keyring itself is unavailable, switch to the file
   * backend for good and run `viaFile` instead. Errors from the file backend
   * are never swallowed — a session that cannot be saved must not look saved.
   */
  async function run<T>(
    viaKeyring: () => Promise<T>,
    viaFile: (storage: Storage<TokenSet>) => Promise<T>,
  ): Promise<T> {
    if (keyringUsable) {
      try {
        return await viaKeyring();
      } catch (error) {
        debug(
          `OS keyring unavailable (${(error as Error).message}); using file storage`,
        );
        keyringUsable = false;
      }
    }
    return viaFile(fileBackend(true));
  }

  return {
    load: () =>
      run(
        async () => {
          const raw = await secrets.get({ service: SERVICE, name });
          if (!raw) {
            // An earlier run may have fallen back to a file; that session is
            // still the user's.
            return hasFile() ? fileBackend().load() : undefined;
          }
          try {
            return JSON.parse(raw) as TokenSet;
          } catch {
            // A corrupt entry is not a keyring failure: treat it as "no
            // session" so the next login overwrites it.
            debug(`Stored session for ${name} is not valid JSON; ignoring it`);
            return undefined;
          }
        },
        (storage) => storage.load(),
      ),

    save: (credential) =>
      run(
        () =>
          secrets.set({
            service: SERVICE,
            name,
            value: JSON.stringify(prune(credential)),
          }),
        (storage) => storage.save(prune(credential)),
      ),

    // Log out means log out: clear both places a session can live.
    clear: async () => {
      if (hasFile()) await fileBackend().clear();
      return run(
        async () => {
          await secrets.delete({ service: SERVICE, name });
        },
        () => Promise.resolve(),
      );
    },

    // Created lazily: nothing should touch the config dir until a refresh
    // actually needs the lock.
    lock: async () => {
      mkdirSync(dir, { recursive: true });
      return fileLock({ lockPath: join(dir, `${safeName(name)}.lock`) })();
    },
  };
}

/**
 * What actually goes into the store: the refresh token and the access tokens
 * still in date. The `id_token` is dropped — nothing reads it (identity comes
 * from the server) and it is ~600 bytes of a budget that is not generous:
 * Windows Credential Manager rejects a credential over 2560 bytes, which a
 * set with an id_token and two access tokens exceeds, and the whole session
 * would then land in the file fallback.
 */
function prune(credential: TokenSet): TokenSet {
  const now = Date.now();
  const tokens = Object.fromEntries(
    Object.entries(credential.tokens ?? {}).filter(
      ([, token]) => (token.expires_at ?? 0) > now,
    ),
  );
  return credential.refresh_token
    ? { refresh_token: credential.refresh_token, tokens }
    : { tokens };
}

/**
 * Mark every cached access token in the stored set as expired, so the next
 * getToken() spends the refresh token instead of serving the cached one.
 * cli-auth has no forceRefresh; clearing would drop the refresh token too.
 */
export async function expireStoredAccessTokens(
  storage: Storage<TokenSet>,
): Promise<void> {
  const stored = await storage.load();
  if (!stored?.tokens) return;
  for (const token of Object.values(stored.tokens)) {
    token.expires_at = 0;
  }
  await storage.save(stored);
}
