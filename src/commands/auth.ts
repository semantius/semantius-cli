/**
 * login / logout — the browser (PKCE) session for one host. Both act on the
 * host the invocation resolves to: --host, a bound credential, ${PREFIX}_HOST,
 * the org's default cloud host, or the stored default host.
 */

import { login, logout } from '../auth/session.js';
import { getSnapshotEnvHost } from '../config.js';
import { stopAllDaemons } from '../daemon-client.js';
import { resolveHost } from '../host.js';
import {
  getDefaultHost,
  recordHost,
  removeHost,
  setDefaultHost,
} from '../hosts-index.js';

/**
 * Whether a fresh login to `loginHost` should become the stored default,
 * merely hint that it could, or leave an existing default alone. Pure so the
 * three outcomes are easy to test directly.
 *
 * `envHost` is what the environment alone (no --host, no stored default —
 * see config.ts's snapshotEnvHost) resolves to: `login` without --host
 * already targets it, so setting the default there is redundant, not wrong,
 * but a login the user pointed at a DIFFERENT host than their environment's
 * (via --host) should not silently become the default underneath them.
 */
export type DefaultAfterLogin = 'set' | 'hint' | 'keep';

export function decideDefaultAfterLogin(
  loginHost: string,
  envHost: string | null,
  currentDefault: string | null,
): DefaultAfterLogin {
  if (currentDefault !== null) return 'keep';
  return envHost === null || envHost === loginHost ? 'set' : 'hint';
}

/** Run the browser login and store the session for the resolved host. */
export async function loginCommand(): Promise<void> {
  const host = await resolveHost();
  await login(host);
  recordHost(
    host.host,
    { mode: host.mode, org: host.org },
    { loggedInAt: new Date().toISOString() },
  );
  console.log(
    `Logged in to ${host.host}. The session is stored for this host.`,
  );

  const decision = decideDefaultAfterLogin(
    host.host,
    getSnapshotEnvHost() ?? null,
    getDefaultHost(),
  );
  if (decision === 'set') {
    setDefaultHost(host.host);
    console.log(`${host.host} is now the default host.`);
  } else if (decision === 'hint') {
    console.log(
      `${host.host} is not the default host; run "semantius use ${host.host}" to make it one.`,
    );
  }
}

/** Revoke and delete the stored session for the resolved host. */
export async function logoutCommand(): Promise<void> {
  const host = await resolveHost();
  const hadSession = await logout(host);
  const { wasDefault } = removeHost(host.host);
  console.log(
    hadSession
      ? `Logged out of ${host.host}.`
      : `No session was stored for ${host.host}.`,
  );
  if (wasDefault) {
    console.error(
      `${host.host} was the default host; run "semantius use <host>" to choose another`,
    );
  }
  // The revoked bearer may still be live in a daemon's HTTP config (its PID
  // file cannot name which one — see stopAllDaemons); stop them all so it
  // dies now instead of lingering until the daemon's idle timeout.
  await stopAllDaemons();
}
