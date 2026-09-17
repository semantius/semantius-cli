/**
 * Where an OAuth session is persisted: ciphertext in an 0600 file, and the key
 * that opens it in the OS keyring (Bun.secrets — Windows DPAPI, macOS
 * Keychain, Linux libsecret). See envelope.ts for why the credential itself
 * never touches the disk in the clear.
 *
 * Both halves are per (env prefix, host), under one name, so a session
 * obtained for one host is never offered to another. Refreshes are serialized
 * across processes with cli-auth's file lock: two concurrent CLI invocations
 * must not both spend the refresh token.
 *
 * One name, one meaning, one place. The previous design stored the token set
 * *in* the keyring and kept the file as a fallback for machines without one —
 * which let the payload's size decide where it landed. Windows Credential
 * Manager refuses a blob over 2560 bytes and an Entra session is ~3.4 KB, so
 * on Windows every such login silently took the fallback, wrote the refresh
 * token to disk in the clear, and left whatever the keyring already held in
 * place. Loads still preferred the keyring, so the CLI went on presenting a
 * stale session from an earlier login and never read the one it had just
 * stored. The keyring now holds ~60 bytes whatever the session's size, so the
 * two stores cannot disagree: the file is always the payload, the keyring
 * entry is always its key, and "no OS keyring available" once again means what
 * it says.
 */

import { existsSync, mkdirSync, rmdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type Storage, type TokenSet, fileLock, fileStorage } from 'cli-auth';
import {
  debug,
  getEnvPrefix,
  getLegacyUserSecretsDirs,
  getUserSecretsDir,
} from '../config.js';
import {
  type Envelope,
  envelopeAad,
  isEnvelope,
  keyFromRecord,
  keyRecord,
  newKey,
  open,
  seal,
} from './envelope.js';

/** Service name under which every session key is stored in the OS keyring. */
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
 * What the file may hold: the envelope, or — on a machine with no keyring, and
 * in anything written before the envelope existed — a plaintext token set.
 */
type StoredFile = Envelope | TokenSet;

/**
 * A cli-auth Storage that seals the session under a key held in the OS
 * keyring. Where there is no keyring at all (headless Linux) the file is
 * written in the clear, as it always was, and the CLI says so.
 */
export function createSecretStorage(
  name: string,
  secrets: SecretsApi = _secretsForTests ??
    (Bun.secrets as unknown as SecretsApi),
  opts: { quiet?: boolean } = {},
): Storage<TokenSet> {
  const dir = join(getUserSecretsDir(), 'sessions');
  const sessionDir = join(dir, safeName(name));
  const legacyDirs = getLegacyUserSecretsDirs().map((root) =>
    join(root, 'sessions', safeName(name)),
  );
  const aad = envelopeAad(name);

  let keyringUsable = true;
  let keyringError = '';
  let announced = false;
  let backend: Storage<StoredFile> | undefined;

  function file(): Storage<StoredFile> {
    if (!backend) backend = fileStorage<StoredFile>({ dir: sessionDir });
    return backend;
  }

  /**
   * Said once per storage, and only when a session is actually written
   * unencrypted — "semantius hosts" opens one of these per indexed host to
   * probe for a session, and must not narrate a machine's keyring once per
   * row for a fact no row depends on.
   */
  function announcePlaintext(): void {
    if (announced || opts.quiet) return;
    announced = true;
    console.error(
      `[semantius] no OS keyring available (${keyringError}); the session is stored unencrypted in ${sessionDir}`,
    );
  }

  /** The keyring is out for the rest of this process; remember why. */
  function unusable(error: unknown): void {
    keyringError = (error as Error).message;
    keyringUsable = false;
    debug(`OS keyring unavailable (${keyringError})`);
  }

  /** Whatever the keyring holds under this name, parsed; undefined if nothing usable. */
  async function readKeyring(): Promise<unknown> {
    if (!keyringUsable) return undefined;
    try {
      const raw = await secrets.get({ service: SERVICE, name });
      if (!raw) return undefined;
      const parsed = parseJson(raw);
      if (parsed === undefined) {
        // A corrupt entry is not a keyring failure: treat it as "nothing
        // stored" so the next login overwrites it.
        debug(
          `Stored keyring entry for ${name} is not valid JSON; ignoring it`,
        );
      }
      return parsed;
    } catch (error) {
      unusable(error);
      return undefined;
    }
  }

  /**
   * The key to seal with: the stored one, or a new one stored now. Null only
   * when this machine has no usable keyring.
   *
   * Writing the key is also what retires the old layout — an entry still
   * holding a whole token set is replaced here, so no machine is left keeping
   * two things that both look like a session.
   *
   * Deliberately unlocked. cli-auth calls load() — and so, on an upgrade,
   * migrateLegacy and this — from inside the storage lock it takes around a
   * refresh, so taking it again would deadlock on a lock that is not
   * reentrant. The race that leaves is two first saves at once each minting a
   * key: the last one written wins and the other's file then reads as no
   * session. That costs a login, never a token from the wrong key.
   */
  async function sessionKey(): Promise<Buffer | null> {
    const existing = keyFromRecord(await readKeyring());
    if (existing) return existing;
    if (!keyringUsable) return null;
    const key = newKey();
    try {
      await secrets.set({
        service: SERVICE,
        name,
        value: JSON.stringify(keyRecord(key)),
      });
      return key;
    } catch (error) {
      unusable(error);
      return null;
    }
  }

  /** A stored file as a token set: opened if sealed, taken as-is if not. */
  async function decode(stored: StoredFile): Promise<TokenSet | undefined> {
    if (!isEnvelope(stored)) return asTokenSet(stored);
    const key = keyFromRecord(await readKeyring());
    if (!key) {
      debug(
        `The session stored for ${name} is sealed, but the keyring holds no key for it; treating it as no session`,
      );
      return undefined;
    }
    const plaintext = open(stored, key, aad);
    return plaintext === null ? undefined : asTokenSet(parseJson(plaintext));
  }

  /**
   * Move a session written by a version that kept credentials somewhere else —
   * in the roaming profile, or directly in the vendor directory rather than
   * this product's (see getLegacyUserSecretsDirs). Done on load because that
   * is the first thing any command does, and it must leave nothing behind:
   * what it supersedes may be the plaintext file this whole change exists to
   * be rid of.
   *
   * A legacy file that does not decode is left where it is rather than
   * deleted — the keyring may simply be unreachable this run, and a later one
   * can still recover it.
   */
  async function migrateLegacy(): Promise<TokenSet | undefined> {
    for (const legacyDir of legacyDirs) {
      if (!existsSync(join(legacyDir, 'credentials.json'))) {
        tidy(legacyDir);
        continue;
      }
      const legacy = fileStorage<StoredFile>({ dir: legacyDir });
      const stored = await legacy.load();
      const session = stored ? await decode(stored) : undefined;
      if (!session) continue;
      await save(session);
      await legacy.clear();
      tidy(legacyDir);
      debug(`Moved the session stored for ${name} to ${sessionDir}`);
      return session;
    }
    return undefined;
  }

  /**
   * Remove an emptied directory from an older layout, and the `sessions`
   * directory above it once it holds nothing either.
   *
   * Not housekeeping for its own sake: a session directory is what the hosts
   * scan reads as "a host was logged in here" (commands/hosts.ts), so one left
   * behind outlives the session it held — and a profile that still shows the
   * old layout after an upgrade invites someone to wonder which copy is live.
   */
  function tidy(legacyDir: string): void {
    for (const dir of [legacyDir, dirname(legacyDir)]) {
      try {
        rmdirSync(dir);
      } catch (error) {
        // Already gone: keep going, because the level above can still be an
        // empty leftover — the last host to move out of it takes it with them,
        // and the hosts that follow find nothing at their own level. Anything
        // else (not empty, in use) means this is as far as it goes.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return;
      }
    }
  }

  async function save(credential: TokenSet): Promise<void> {
    const pruned = prune(credential);
    const key = await sessionKey();
    if (!key) {
      announcePlaintext();
      await file().save(pruned);
      return;
    }
    await file().save(seal(JSON.stringify(pruned), key, aad));
  }

  return {
    load: async () => {
      const stored = await file().load();
      if (stored) return decode(stored);

      const migrated = await migrateLegacy();
      if (migrated) return migrated;

      // No file at all: a session from a version that kept the token set in
      // the keyring itself. Honour it — the next save seals it into the file
      // and replaces the entry with a key.
      return asTokenSet(await readKeyring());
    },

    save,

    // Log out means log out. The key goes too, and deleting it is the part
    // that reaches copies of the file this process cannot: a credentials.json
    // that had already escaped into a backup or a roaming profile becomes
    // permanently unreadable once its key is gone.
    clear: async () => {
      await file().clear();
      for (const legacyDir of legacyDirs) {
        await fileStorage<StoredFile>({ dir: legacyDir }).clear();
      }
      if (!keyringUsable) return;
      try {
        await secrets.delete({ service: SERVICE, name });
      } catch (error) {
        unusable(error);
      }
    },

    // Created lazily: nothing should touch the secrets dir until a refresh
    // actually needs the lock.
    lock: async () => {
      mkdirSync(dir, { recursive: true });
      return fileLock({ lockPath: join(dir, `${safeName(name)}.lock`) })();
    },
  };
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/** A stored value as a token set, or undefined when it is something else. */
function asTokenSet(value: unknown): TokenSet | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const set = value as TokenSet;
  return typeof set.tokens === 'object' && set.tokens !== null
    ? set
    : undefined;
}

/**
 * What actually goes into the store: the refresh token and the access tokens
 * still in date. The `id_token` is dropped — nothing reads it (identity comes
 * from the server), and a credential nothing reads should not be kept at all.
 * Size is no longer a reason: the keyring only ever sees a 32-byte key, so the
 * session itself may be any length.
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
