/**
 * JWT token cache — encrypted, per-API-key, atomic, AEAD.
 *
 * Stores `get_cli_token` responses on disk so subsequent CLI invocations can
 * authenticate with a short-lived JWT Bearer header instead of sending the
 * long-lived API key on every request.
 *
 * Security model:
 *   - File encrypted with AES-256-GCM
 *   - Key derived from the API key secret via HKDF-SHA256 (info: "semantius api")
 *   - Random 12-byte nonce per write, authenticated 16-byte tag
 *   - A cache file alone, without the original API key, cannot be decrypted
 *
 * Race safety:
 *   - Writes go to a unique temp path then are atomically renamed onto target
 *   - Last writer wins; readers either see the old or new content, never partial
 */

import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug, getPrefixedEnv } from './config.js';

export interface ParsedApiKey {
  /** e.g. "sk-seed001002" — used to name the cache file (visible on disk) */
  id: string;
  /** e.g. "ab12cd340123456789abcdef01234567" — the cryptographic secret */
  secret: string;
}

export interface CachedToken {
  jwt: string;
  /** ISO timestamp */
  expires: string;
}

const HKDF_INFO = Buffer.from('semantius api', 'utf8');
const HKDF_SALT = Buffer.alloc(0);
const KEY_LENGTH = 32;
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;
// Treat tokens expiring within this window as already expired so we don't
// hand out a JWT that will fail mid-request.
const EXPIRY_BUFFER_MS = 60_000;

let _runtimeDisabled = false;

export function setJwtCacheDisabled(disabled: boolean): void {
  _runtimeDisabled = disabled;
}

export function isJwtCacheDisabled(): boolean {
  if (_runtimeDisabled) return true;
  const env = getPrefixedEnv('DISABLE_JWT_CACHE');
  if (env === '1' || env?.toLowerCase() === 'true') return true;
  return false;
}

/**
 * Parse an API key of the form "<id>-<secret>" where <id> may itself contain
 * dashes (e.g. "sk-seed001002"). The secret is everything after the LAST dash.
 *   sk-seed001002-ab12cd340123456789abcdef01234567
 *   └────── id ──────┘ └───────── secret ─────────┘
 */
export function parseApiKey(
  apiKey: string | undefined | null,
): ParsedApiKey | null {
  if (!apiKey) return null;
  const lastDash = apiKey.lastIndexOf('-');
  if (lastDash <= 0 || lastDash === apiKey.length - 1) return null;
  const id = apiKey.slice(0, lastDash);
  const secret = apiKey.slice(lastDash + 1);
  if (!id || !secret) return null;
  return { id, secret };
}

/**
 * tmpdir() is per-user on Windows (%TEMP%) and macOS (/var/folders/...),
 * shared on Linux (/tmp). We rely on the encryption — not on file
 * permissions — for confidentiality across users. File mode 600 is set on
 * POSIX as defense-in-depth.
 */
export function getCachePath(keyId: string): string {
  const safe = keyId.replace(/[^a-zA-Z0-9._-]/g, '_');
  return join(tmpdir(), `semantius-jwt-${safe}.bin`);
}

function deriveKey(secret: string): Buffer {
  const ikm = Buffer.from(secret, 'utf8');
  const okm = hkdfSync('sha256', ikm, HKDF_SALT, HKDF_INFO, KEY_LENGTH);
  return Buffer.from(okm);
}

/**
 * Read and decrypt the cached token for this API key. Returns null on any
 * failure (missing file, corrupt ciphertext, wrong key, expired token).
 */
export async function readCachedToken(
  apiKey: string,
): Promise<CachedToken | null> {
  const parsed = parseApiKey(apiKey);
  if (!parsed) return null;

  const path = getCachePath(parsed.id);
  if (!existsSync(path)) return null;

  try {
    const buf = await readFile(path);
    if (buf.length < NONCE_LENGTH + TAG_LENGTH + 1) {
      debug(`JWT cache file too short: ${path}`);
      return null;
    }

    const nonce = buf.subarray(0, NONCE_LENGTH);
    const tag = buf.subarray(NONCE_LENGTH, NONCE_LENGTH + TAG_LENGTH);
    const ciphertext = buf.subarray(NONCE_LENGTH + TAG_LENGTH);

    const key = deriveKey(parsed.secret);
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(tag);

    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    const token = JSON.parse(plaintext.toString('utf8')) as CachedToken;

    if (typeof token.jwt !== 'string' || typeof token.expires !== 'string') {
      debug(`JWT cache file has invalid shape: ${path}`);
      return null;
    }

    const expiresMs = Date.parse(token.expires);
    if (Number.isNaN(expiresMs) || expiresMs - Date.now() < EXPIRY_BUFFER_MS) {
      debug(`JWT cache expired or unparsable expires: ${path}`);
      return null;
    }

    return token;
  } catch (err) {
    debug(`JWT cache read failed (${path}): ${(err as Error).message}`);
    return null;
  }
}

/**
 * Encrypt and atomically persist the token. Two concurrent writers either
 * race and the last rename wins, or one fails silently — either way the
 * file on disk is always a complete, valid ciphertext.
 */
export async function writeCachedToken(
  apiKey: string,
  token: CachedToken,
): Promise<void> {
  const parsed = parseApiKey(apiKey);
  if (!parsed) return;

  const path = getCachePath(parsed.id);
  const tmpPath = `${path}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;

  try {
    const key = deriveKey(parsed.secret);
    const nonce = randomBytes(NONCE_LENGTH);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    const plaintext = Buffer.from(JSON.stringify(token), 'utf8');
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    const payload = Buffer.concat([nonce, tag, ciphertext]);

    await writeFile(tmpPath, payload, { mode: 0o600 });
    await rename(tmpPath, path);
    if (process.platform !== 'win32') {
      try {
        chmodSync(path, 0o600);
      } catch {
        // mode already set by writeFile; ignore
      }
    }
  } catch (err) {
    debug(`JWT cache write failed (${path}): ${(err as Error).message}`);
    try {
      unlinkSync(tmpPath);
    } catch {
      // tmp file may not exist; ignore
    }
  }
}

export function deleteCachedToken(apiKey: string): void {
  const parsed = parseApiKey(apiKey);
  if (!parsed) return;
  try {
    unlinkSync(getCachePath(parsed.id));
  } catch {
    // not present; ignore
  }
}
