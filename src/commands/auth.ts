/**
 * login / logout — the browser (PKCE) session for one host. Both act on the
 * host the invocation resolves to (see host.ts's resolveHostValue).
 */

import {
  isTransientFailure,
  login,
  logout,
  newLoginReach,
} from '../auth/session.js';
import { stopAllDaemons } from '../daemon-client.js';
import { ErrorCode } from '../errors.js';
import { resolveHost } from '../host.js';
import { recordHost, removeHost } from '../hosts-index.js';

/**
 * The network's or a server's trouble — not the host name's (1), not the
 * session's (5): exit 3, so a script knows that trying again can work. The
 * same rule `semantius use` applies (commands/hosts.ts).
 */
function markTransient(error: unknown): never {
  if (isTransientFailure(error)) {
    (error as Error & { exitCode?: number }).exitCode = ErrorCode.NETWORK_ERROR;
  }
  throw error;
}

/**
 * Run the browser login and store the session for the resolved host.
 * Stores only the session and the hosts-index entry — it never sets or
 * changes the current host; `semantius use <host>` is the one command that
 * does that (see commands/hosts.ts), for first-time users too.
 * `openUrl` is passed through to login() so tests never open a real browser.
 */
export async function loginCommand(
  opts: { openUrl?: (url: string) => void } = {},
): Promise<void> {
  // One reach for the whole login, so the control-plane request is announced
  // and given the login's limit too (see src/auth/reach.ts).
  const reach = newLoginReach();
  const host = await resolveHost({ reach }).catch(markTransient);
  await login(host, { ...opts, reach }).catch(markTransient);
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
  const host = await resolveHost().catch(markTransient);
  const hadSession = await logout(host).catch(markTransient);
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
