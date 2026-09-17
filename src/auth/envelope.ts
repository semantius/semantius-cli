/**
 * Authenticated encryption for a stored session.
 *
 * A session is a standing credential: whoever holds the refresh token can mint
 * access tokens for as long as the chain lives, from any machine, with nothing
 * to prove but possession. Entra publishes no revocation endpoint — its
 * discovery document names only `end_session_endpoint`, a browser
 * front-channel logout — so a copy that gets away cannot be called back. The
 * only remedy is revoking sign-in sessions at the IdP, which the CLI cannot do
 * and the user has no reason to suspect is needed.
 *
 * So the file on disk is not the credential. It holds ciphertext, and the key
 * lives in the OS keyring, which is machine- and user-bound and does not
 * travel: DPAPI on Windows, the Keychain on macOS, libsecret on Linux. A
 * credentials.json that reaches a backup set, a roaming profile or a support
 * bundle is inert without it. Deleting the key — what logout does — makes
 * every copy of the file that ever escaped permanently unreadable, which is
 * the closest thing to revocation this CLI controls.
 *
 * What it does not defend against is code running as the user on this machine:
 * that can ask the keyring for the key, or simply run the CLI. Nothing at this
 * layer changes that.
 *
 * AES-256-GCM with a fresh random 96-bit IV per write (never derived, never
 * reused — GCM fails catastrophically when one key sees an IV twice), a
 * 128-bit tag, and the session's storage name as additional authenticated data
 * so an envelope only opens in the slot it was written for.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { debug } from '../config.js';

/** AES-256. */
const KEY_BYTES = 32;
/** 96 bits, GCM's native nonce width. */
const IV_BYTES = 12;

/** What the file holds. `v` is the envelope format, not the payload's. */
export interface Envelope {
  v: 1;
  alg: 'A256GCM';
  iv: string;
  ct: string;
  tag: string;
}

/**
 * What the keyring holds. Deliberately shaped so it cannot be confused with
 * the token set that older versions stored under the same name: that has
 * `tokens`, this has `k`. One entry per session either way, so a machine
 * upgrading never ends up holding two things that both look like a session.
 */
export interface KeyRecord {
  v: 1;
  k: string;
}

/** A new session key from the platform CSPRNG. */
export function newKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

export function keyRecord(key: Buffer): KeyRecord {
  return { v: 1, k: key.toString('base64') };
}

/** The key in a stored keyring value, or null if it holds something else. */
export function keyFromRecord(value: unknown): Buffer | null {
  if (typeof value !== 'object' || value === null) return null;
  const { v, k } = value as Partial<KeyRecord>;
  if (v !== 1 || typeof k !== 'string') return null;
  const key = Buffer.from(k, 'base64');
  return key.length === KEY_BYTES ? key : null;
}

export function isEnvelope(value: unknown): value is Envelope {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Partial<Envelope>;
  return (
    e.v === 1 &&
    e.alg === 'A256GCM' &&
    typeof e.iv === 'string' &&
    typeof e.ct === 'string' &&
    typeof e.tag === 'string'
  );
}

/**
 * The additional data an envelope is bound to: its storage name. A
 * credentials.json copied out of another host's directory — or restored from a
 * backup into the wrong slot — then fails to open rather than quietly
 * decrypting into a session it was never issued for.
 */
export function envelopeAad(name: string): string {
  return `semantius|${name}|v1`;
}

export function seal(plaintext: string, key: Buffer, aad: string): Envelope {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([
    cipher.update(Buffer.from(plaintext, 'utf8')),
    cipher.final(),
  ]);
  return {
    v: 1,
    alg: 'A256GCM',
    iv: iv.toString('base64'),
    ct: ct.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

/**
 * The plaintext, or null when the envelope does not open under this key.
 *
 * Null rather than a throw because every way it can fail — the wrong key, a
 * key regenerated since, a truncated or edited file, an envelope from another
 * slot — means the same thing to the one caller: there is no session here, so
 * sign in again. Only a *reason* worth a developer's attention is logged.
 */
export function open(
  envelope: Envelope,
  key: Buffer,
  aad: string,
): string | null {
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(envelope.iv, 'base64'),
    );
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ct, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch (error) {
    debug(`Stored session did not decrypt: ${(error as Error).message}`);
    return null;
  }
}
