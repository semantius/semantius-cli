/**
 * login / logout — the browser (PKCE) session for one host. Both act on the
 * host the invocation resolves to (see host.ts's resolveHostValue).
 */

import { login, logout } from '../auth/session.js';
import { stopAllDaemons } from '../daemon-client.js';
import { resolveHost } from '../host.js';
import { recordHost, removeHost } from '../hosts-index.js';

/**
 * Run the browser login and store the session for the resolved host.
 * Stores only the session and the hosts-index entry — it never sets or
 * changes the current host; `semantius use <host>` is the one command that
 * does that (see commands/hosts.ts), for first-time users too.
 */
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
}

/** Revoke and delete the stored session for the resolved host. */
export async function logoutCommand(): Promise<void> {
  const host = await resolveHost();
  const hadSession = await logout(host);
  const { wasCurrent } = removeHost(host.host);
  console.log(
    hadSession
      ? `Logged out of ${host.host}.`
      : `No session was stored for ${host.host}.`,
  );
  if (wasCurrent) {
    console.error(
      `${host.host} was the current host; run "semantius use <host>" to choose another`,
    );
  }
  // The revoked bearer may still be live in a daemon's HTTP config (its PID
  // file cannot name which one — see stopAllDaemons); stop them all so it
  // dies now instead of lingering until the daemon's idle timeout.
  await stopAllDaemons();
}
