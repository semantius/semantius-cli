/**
 * A login's network requests, made so that the person signing in can follow
 * them.
 *
 * An agent's sandbox may hold an outbound request until somebody approves the
 * host it goes to. Before this, a held request looked exactly like a working
 * one — silence — until it died after 60 s as "could not reach <url>: The
 * operation timed out.", which reads like the host is down. So, during a
 * login:
 *
 *  - the first request to each host is announced ("Contacting <host>...");
 *  - a request still unanswered after NUDGE says so once, and asks the person
 *    to approve it if a sandbox or agent is asking;
 *  - every request may take up to LIMIT, long enough for that approval,
 *    unless <PREFIX>_CONNECT_TIMEOUT is set, which still decides;
 *  - a failure names the host to allow.
 *
 * The approval prompts land on the first request to each host — the control
 * plane and discovery — not on the device code request, whose endpoint is
 * bound to an origin discovery has already reached (provider.ts). That is why
 * every request a login makes before the code is shown comes through here.
 *
 * Imports nothing from host.ts, which uses it.
 */

import { getConnectTimeoutOverrideMs } from '../config.js';

const DEFAULT_NUDGE_MS = 15_000;
const DEFAULT_LIMIT_MS = 3 * 60_000;

interface Timings {
  nudgeMs: number;
  /** Ceiling on one request, body included; 0 means none. */
  limitMs: number;
  /** The device flow's approval window (session.ts owns the default). */
  approvalMs: number;
}

let _timingsForTests: Partial<Timings> = {};

/** Test seam: shorten the waits to milliseconds. Pass nothing to reset. */
export function setLoginReachTimingsForTests(
  timings: Partial<Timings> = {},
): void {
  _timingsForTests = timings;
}

/** The device approval window a test has set, if any. */
export function approvalMsForTests(): number | undefined {
  return _timingsForTests.approvalMs;
}

/** The sentence for a failure before any code or link was shown. */
export const SIGN_IN_NOT_STARTED =
  'The sign-in had not started yet, so no code or sign-in link was shown.';

/** "3 minutes", "15 s", "50 ms" — for the waits named in messages. */
export function describeDuration(ms: number): string {
  if (ms >= 60_000 && ms % 60_000 === 0) {
    const minutes = ms / 60_000;
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }
  if (ms >= 1000 && ms % 1000 === 0) return `${ms / 1000} s`;
  return `${ms} ms`;
}

/** The host[:port] of a URL, as a person would allow it. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * What to do about a host that did not answer. A blocked request is the
 * likeliest cause by far, so it comes first; a timeout is all but certainly
 * one, while an immediate failure may also be a wrong host name.
 */
export function blockedHint(host: string, timedOut: boolean): string {
  return timedOut
    ? `This usually means outbound network access is blocked (a sandbox or agent that gates network requests, a proxy, a firewall), not that the host is down. Allow HTTPS to ${host}, or approve the pending request, then run the command again.`
    : `If a sandbox or agent gates network requests, or a proxy or firewall is in the way, allow HTTPS to ${host} and run the command again; otherwise check the host name and your network.`;
}

/** The hedged hint for a 403 / 407, which a refusing proxy also answers. */
export function refusedHint(host: string): string {
  return `A sandbox or proxy may have refused it: if one gates network requests, allow HTTPS to ${host}, then run the command again.`;
}

/**
 * The response with its body already read, so that a stall in the middle of
 * the body falls inside the caller's time limit instead of surfacing later as
 * a parse error — which, on the platform document, would read as "no
 * document" and silently switch discovery chains.
 */
export async function bufferResponse(response: Response): Promise<Response> {
  const body = await response.arrayBuffer();
  // These statuses may not carry a body, not even an empty one.
  const bodyless = [101, 204, 205, 304].includes(response.status);
  return new Response(bodyless ? null : body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/** A login request that got no answer: none in time, or none at all. */
export class LoginReachError extends Error {
  constructor(
    readonly url: string,
    readonly timedOut: boolean,
    readonly limitMs: number,
    cause: unknown,
  ) {
    super(
      timedOut
        ? `no answer from ${url} within ${describeDuration(limitMs)}`
        : `could not reach ${url}: ${(cause as Error)?.message ?? cause}`,
      { cause },
    );
    this.name = 'LoginReachError';
  }

  /** The first line of the failure, with the URL described as `label`. */
  describe(label: string): string {
    return this.timedOut
      ? `no answer from ${label} within ${describeDuration(this.limitMs)}`
      : `could not reach ${label}: ${(this.cause as Error)?.message ?? this.cause}`;
  }
}

/** One per login command: the hosts it has contacted, and where it prints. */
export class LoginReach {
  private readonly contacted = new Set<string>();
  private readonly nudged = new Set<string>();

  constructor(private readonly write: (line: string) => void) {}

  /**
   * fetch, announced, nudged and limited. `announce` replaces the
   * "Contacting <host>..." line, for a step worth naming on its own.
   * Resolves to a response whose body is already read (bufferResponse).
   */
  async fetch(
    url: string,
    init: RequestInit = {},
    opts: { announce?: string } = {},
  ): Promise<Response> {
    const host = hostOf(url);
    if (opts.announce) this.write(opts.announce);
    else if (!this.contacted.has(host)) this.write(`Contacting ${host}...`);
    this.contacted.add(host);

    const limitMs =
      _timingsForTests.limitMs ??
      getConnectTimeoutOverrideMs() ??
      DEFAULT_LIMIT_MS;
    const nudgeMs = _timingsForTests.nudgeMs ?? DEFAULT_NUDGE_MS;
    const timeout = limitMs > 0 ? AbortSignal.timeout(limitMs) : undefined;
    const signal =
      timeout && init.signal
        ? AbortSignal.any([timeout, init.signal])
        : (timeout ?? init.signal ?? undefined);

    let nudge: ReturnType<typeof setTimeout> | undefined;
    if (!this.nudged.has(host) && (limitMs === 0 || nudgeMs < limitMs)) {
      nudge = setTimeout(() => {
        this.nudged.add(host);
        this.write(
          `Still waiting for ${host} (${describeDuration(nudgeMs)}). If a sandbox or agent is asking you to allow network access to it, approve it now.`,
        );
      }, nudgeMs);
      nudge.unref?.();
    }

    try {
      // Looked up at call time, so a test's stub of globalThis.fetch applies.
      const response = await globalThis.fetch(url, { ...init, signal });
      clearTimeout(nudge);
      return await bufferResponse(response);
    } catch (cause) {
      throw new LoginReachError(url, timeout?.aborted === true, limitMs, cause);
    } finally {
      clearTimeout(nudge);
    }
  }
}
