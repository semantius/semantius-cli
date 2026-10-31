/**
 * The local crud layer's PostgREST requests, through a connection daemon.
 *
 * Every CLI invocation is a new process, so on its own each one pays DNS,
 * TCP and a TLS handshake to the PostgREST host before its first request,
 * the cost a second request in the same process does not pay. A proxy daemon
 * (daemon.ts, PostgrestProxyConfig) keeps that connection open across
 * invocations: requests to its origin are sent to it over its Unix socket
 * instead, and it passes them through unchanged.
 *
 * Nothing else moves: the tools, the token, retries, error mapping and
 * recordFetchFailures all stay in this process, and the daemon holds no
 * credentials. The first invocation for an origin goes direct and starts the
 * daemon in the background; while it is not ready, or whenever its socket
 * cannot be reached, requests simply go direct.
 */

import { debug, isDaemonEnabled } from './config.js';
import { ensureDaemon } from './daemon-client.js';
import {
  PROXY_ERROR_HEADER,
  PROXY_TIMING_HEADER,
  type PostgrestProxyConfig,
  describeKeepAlive,
} from './daemon.js';

/** Proxy daemons by origin, once ready; requests to other origins go direct. */
const routes = new Map<string, string>();

let directFetch: typeof fetch | undefined;

/** The daemon's server name for one origin (its PID file, socket and stderr). */
export function proxyDaemonName(origin: string): string {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(origin);
  return `postgrest-${hasher.digest('hex').slice(0, 12)}`;
}

/**
 * Route requests to `postgrestUrl`'s origin through its proxy daemon, from
 * now on in this process, if one is ready; otherwise start one in the
 * background and leave them direct. Called again (each connection is), it
 * picks the daemon up once it is ready.
 */
export function routePostgrestThroughDaemon(postgrestUrl: string): void {
  if (!isDaemonEnabled()) return;
  const origin = new URL(postgrestUrl).origin;
  if (routes.has(origin)) return;

  const config: PostgrestProxyConfig = { postgrestProxy: origin };
  const daemon = ensureDaemon(proxyDaemonName(origin), config);
  if (daemon.state !== 'ready') {
    debug(
      `PostgREST requests to ${origin} go direct: its daemon is ${daemon.state === 'absent' ? 'starting in the background' : daemon.state}`,
    );
    return;
  }

  debug(`Routing PostgREST requests to ${origin} through its daemon`);
  routes.set(origin, daemon.socketPath);
  installFetch();
}

/** Errors that mean the socket was never reached, so nothing was sent. */
function socketUnreachable(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  return code === 'ENOENT' || code === 'ECONNREFUSED';
}

function installFetch(): void {
  if (directFetch) return;
  const direct = globalThis.fetch;
  directFetch = direct;

  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    // A Request object carries its own body and signal; leave it direct.
    if (input instanceof Request) return direct(input, init);
    const url = new URL(String(input));
    const socketPath = routes.get(url.origin);
    if (!socketPath) return direct(input, init);

    const started = Date.now();
    let response: Response;
    try {
      response = await direct(`http://localhost${url.pathname}${url.search}`, {
        ...init,
        unix: socketPath,
      } as RequestInit);
    } catch (error) {
      if (!socketUnreachable(error)) throw error;
      // The daemon went away (idle timeout, logout): direct from now on.
      debug(
        `PostgREST daemon for ${url.origin} is gone (${(error as Error).message}); going direct`,
      );
      routes.delete(url.origin);
      return direct(input, init);
    }

    const timing = response.headers.get(PROXY_TIMING_HEADER);
    debug(
      `PostgREST ${init?.method ?? 'GET'} ${url.pathname} via daemon: ${response.status} in ${Date.now() - started} ms (${timing ?? 'no timing'}${describeKeepAlive(response.headers)})`,
    );

    // The daemon reached nothing: fail as a direct request would have.
    const proxyError = response.headers.get(PROXY_ERROR_HEADER);
    if (proxyError !== null)
      throw new TypeError(decodeURIComponent(proxyError));
    if (timing === null) return response;

    // The timing is for these debug lines only: a tool such as
    // postgrestRequest returns the response headers it gets.
    const headers = new Headers(response.headers);
    headers.delete(PROXY_TIMING_HEADER);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }) as typeof fetch;
}

/** Restore the direct fetch and forget every route. For tests. */
export function resetPostgrestRoutesForTests(): void {
  routes.clear();
  if (directFetch) globalThis.fetch = directFetch;
  directFetch = undefined;
}
