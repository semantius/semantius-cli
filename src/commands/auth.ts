/**
 * login / logout — the browser (PKCE) session for one host. Both act on the
 * host the invocation resolves to: --host, ${PREFIX}_HOST, or the org's
 * default cloud host.
 */

import { login, logout } from '../auth/session.js';
import { resolveHost } from '../host.js';

/** Run the browser login and store the session for the resolved host. */
export async function loginCommand(): Promise<void> {
  const host = await resolveHost();
  await login(host);
  console.log(
    `Logged in to ${host.host}. The session is stored for this host.`,
  );
}

/** Revoke and delete the stored session for the resolved host. */
export async function logoutCommand(): Promise<void> {
  const host = await resolveHost();
  const hadSession = await logout(host);
  console.log(
    hadSession
      ? `Logged out of ${host.host}.`
      : `No session was stored for ${host.host}.`,
  );
}
