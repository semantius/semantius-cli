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

import { mkdirSync } from 'node:fs';
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
): Storage<TokenSet> {
  const dir = join(getUserConfigDir(), 'sessions');
  let keyringUsable = true;
  let fallback: Storage<TokenSet> | undefined;

  function fileBackend(): Storage<TokenSet> {
    if (!fallback) {
      const sessionDir = join(dir, safeName(name));
      console.error(
        `[semantius] no OS keyring available; storing the session in ${sessionDir}`,
      );
      fallback = fileStorage<TokenSet>({ dir: sessionDir });
    }
    return fallback;
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
    return viaFile(fileBackend());
  }

  return {
    load: () =>
      run(
        async () => {
          const raw = await secrets.get({ service: SERVICE, name });
          if (!raw) return undefined;
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
            value: JSON.stringify(credential),
          }),
        (storage) => storage.save(credential),
      ),

    clear: () =>
      run(
        async () => {
          await secrets.delete({ service: SERVICE, name });
        },
        (storage) => storage.clear(),
      ),

    // Created lazily: nothing should touch the config dir until a refresh
    // actually needs the lock.
    lock: async () => {
      mkdirSync(dir, { recursive: true });
      return fileLock({ lockPath: join(dir, `${safeName(name)}.lock`) })();
    },
  };
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
