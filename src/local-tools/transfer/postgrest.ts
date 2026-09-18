/**
 * The transfer tools' PostgREST client: plain fetch against the host's
 * PostgREST, with the retries a long export or import needs.
 *
 * Not makePostgrestRequest: that one console.logs every request, and the
 * tools' stdout is the CLI's result. Retries are decided by HTTP status and
 * PostgREST error code, never by message text (classifyRetry): a message
 * quoting a URL such as `…id=gt.403…` would read as an auth failure.
 *
 * Every read is paged; there is no unpaged GET. A read returns every matching
 * row whatever the server's db-max-rows, because a page shorter than `limit`
 * does not end it — PostgREST may cap a page below `limit` — only an empty
 * page does (or holding every key the read asked for).
 */

import { getAccessToken, getUsedCredentialSource } from '../../auth/token.js';
import { TRANSIENT_RETRY_DELAYS_MS, jitter } from '../../client.js';
import type { HostFacts } from '../../host.js';
import { recordJwt, recordUrl } from '../../logger.js';
import { describeFailure } from '../crud/http-errors.js';
import type { Row } from './format.js';

/** Each request's own limit; the tool call's timeout only fires on silence. */
const REQUEST_TIMEOUT_MS = 5 * 60_000;
/** How long a request waits for a schema-cache reload (PGRST204 / PGRST205). */
const SCHEMA_WAIT_MS = 15_000;
/** Longest URL the client builds; in.() lists are chunked to fit. */
const URL_BUDGET = 6_000;
const DEFAULT_PAGE_SIZE = 1000;

/** Answers that mean the request did not get through: try it again. */
const TRANSIENT_STATUS = new Set([429, 502, 503, 504]);
/** Of those, the ones that prove the request never ran. */
const NEVER_RAN_STATUS = new Set([429, 503]);
/**
 * Platform errors that ask to be retried: 90232, a table held locked by
 * another writer past fix_id_sequence's 2 s lock_timeout.
 */
const RETRY_CODES = new Set(['90232']);

/** A failed request: PostgREST's error code when it gave one. */
export class PostgrestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'PostgrestError';
  }
}

/**
 * - replay: sending it twice is harmless (GET, upsert, PATCH, RPC), so it is
 *   retried on 429/502/503/504 and on network errors;
 * - insert: a plain POST, resent only when it never ran (429, 503).
 */
export type RetryMode = 'replay' | 'insert';

export interface RequestOptions {
  body?: unknown;
  prefer?: string;
  retry?: RetryMode;
  /**
   * Wait out a stale schema cache: PGRST204 / PGRST205 right after the
   * import created a table or a column.
   */
  schemaWait?: boolean;
}

export interface ReadOptions {
  /** Columns to select; `*` when absent. The key must be among them. */
  select?: readonly string[];
  /** Filters, already encoded (see eq / inList). */
  filters?: readonly string[];
  /** The primary key: rows are ordered by it and paged after its last value. */
  key: string;
  pageSize?: number;
  /** At most this many rows can match (distinct keys asked for). */
  expected?: number;
  schemaWait?: boolean;
}

/** A value in PostgREST filter syntax, double-quoted when it needs it. */
function quote(value: unknown): string {
  const s = String(value);
  return /^[A-Za-z0-9_$.\-:@]+$/.test(s)
    ? s
    : `"${s.replace(/[\\"]/g, '\\$&')}"`;
}

/** `column=eq.value`, encoded. */
export function eq(column: string, value: unknown): string {
  return `${column}=eq.${encodeURIComponent(String(value))}`;
}

/** `column=in.(a,b)`, quoted and encoded. */
export function inList(column: string, values: readonly unknown[]): string {
  return `${column}=in.(${values.map((v) => encodeURIComponent(quote(v))).join(',')})`;
}

/** A column list for select= / columns=. */
export function columnList(columns: readonly string[]): string {
  return columns.map((c) => encodeURIComponent(quote(c))).join(',');
}

/** The body of a PostgREST error as one line: `(code) message (details) hint`. */
function formatPostgrestError(error: {
  code?: string;
  message?: string;
  details?: unknown;
  hint?: unknown;
}): string {
  let text = error.code
    ? `(${error.code}) ${error.message}`
    : `${error.message}`;
  if (error.details) text += ` (${error.details})`;
  if (error.hint) text += ` Hint: ${error.hint}`;
  return text;
}

function parseErrorBody(
  text: string,
):
  | { code?: string; message: string; details?: unknown; hint?: unknown }
  | undefined {
  try {
    const json = JSON.parse(text);
    return json && typeof json === 'object' && 'message' in json
      ? json
      : undefined;
  } catch {
    return undefined;
  }
}

/** Resolves after `ms`, or rejects as soon as `signal` aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(cancelled());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancelled());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function cancelled(): Error {
  return new Error('the call was cancelled');
}

export class PostgrestClient {
  /**
   * Called when a schemaWait request meets a stale schema cache; the import
   * uses it to ask a cloud host to reload.
   */
  onSchemaMiss?: () => Promise<void>;
  /**
   * Called after every answer: each one is progress, which keeps the tool
   * call's timeout from firing on a long but moving run.
   */
  onActivity?: () => void;
  private refreshing?: Promise<void>;

  constructor(
    readonly host: HostFacts,
    private currentToken: string,
    private readonly signal?: AbortSignal,
  ) {
    recordUrl(host.postgrestUrl);
    recordJwt(currentToken);
  }

  get token(): string {
    return this.currentToken;
  }

  /**
   * Send one request and return its parsed body (undefined when empty).
   * Throws PostgrestError once the retries are spent.
   */
  async request(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<unknown> {
    const url = `${this.host.postgrestUrl}${path}`;
    const retry = options.retry ?? 'replay';
    const body =
      options.body === undefined ? undefined : JSON.stringify(options.body);
    let refreshed = false;
    let transient = 0;
    let schemaSince: number | undefined;
    let schemaAttempt = 0;

    for (;;) {
      if (this.signal?.aborted) throw cancelled();
      const headers: Record<string, string> = {
        accept: 'application/json',
        authorization: `Bearer ${this.currentToken}`,
      };
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (options.prefer) headers.prefer = options.prefer;
      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const signal = this.signal
        ? AbortSignal.any([timeout, this.signal])
        : timeout;

      let status: number;
      let statusText: string;
      let text: string;
      try {
        const response = await fetch(url, { method, headers, body, signal });
        status = response.status;
        statusText = response.statusText;
        text = await response.text();
        this.onActivity?.();
      } catch (error) {
        if (this.signal?.aborted) throw cancelled();
        if (
          retry === 'replay' &&
          transient < TRANSIENT_RETRY_DELAYS_MS.length
        ) {
          await this.backoff(transient++);
          continue;
        }
        const reason = timeout.aborted
          ? `no answer within ${REQUEST_TIMEOUT_MS / 1000} s`
          : (error as Error).message;
        throw new PostgrestError(
          describeFailure({ method, url, error: reason }, this.host),
        );
      }

      if (status >= 200 && status < 300) {
        return text ? JSON.parse(text) : undefined;
      }

      const error = parseErrorBody(text);
      if (status === 401 && !refreshed && this.canRefresh()) {
        refreshed = true;
        await this.refreshToken();
        continue;
      }
      const retryable =
        (TRANSIENT_STATUS.has(status) &&
          (retry === 'replay' || NEVER_RAN_STATUS.has(status))) ||
        (retry === 'replay' && RETRY_CODES.has(error?.code ?? ''));
      if (retryable && transient < TRANSIENT_RETRY_DELAYS_MS.length) {
        await this.backoff(transient++);
        continue;
      }
      if (
        options.schemaWait &&
        (error?.code === 'PGRST204' || error?.code === 'PGRST205')
      ) {
        schemaSince ??= Date.now();
        if (Date.now() - schemaSince < SCHEMA_WAIT_MS) {
          await this.onSchemaMiss?.();
          await sleep(Math.min(250 * 2 ** schemaAttempt++, 4000), this.signal);
          continue;
        }
      }
      throw new PostgrestError(
        error
          ? formatPostgrestError(error)
          : describeFailure({ method, url, status, statusText }, this.host),
        status,
        error?.code,
      );
    }
  }

  /** Call an RPC: POST /rpc/<name>. Replay-safe. */
  rpc(name: string, body: Row): Promise<unknown> {
    return this.request('POST', `/rpc/${name}`, { body });
  }

  /**
   * The rows of `table` matching the filters, a page at a time, ordered by
   * the key. The next page is requested before this one is handed over.
   */
  async *pages(table: string, options: ReadOptions): AsyncGenerator<Row[]> {
    const { key } = options;
    const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    const base = [
      `select=${options.select ? columnList(options.select) : '*'}`,
      ...(options.filters ?? []),
      `order=${encodeURIComponent(quote(key))}.asc`,
      `limit=${pageSize}`,
    ].join('&');
    const fetchPage = async (after: unknown): Promise<Row[]> => {
      const query =
        after === undefined
          ? base
          : `${base}&${key}=gt.${encodeURIComponent(String(after))}`;
      const rows = await this.request('GET', `/${table}?${query}`, {
        schemaWait: options.schemaWait,
      });
      if (!Array.isArray(rows)) {
        throw new PostgrestError(
          `GET /${table} answered with something other than a list`,
        );
      }
      return rows as Row[];
    };

    let seen = 0;
    let pending: Promise<Row[]> = fetchPage(undefined);
    for (;;) {
      const rows = await pending;
      if (!rows.length) return;
      seen += rows.length;
      const done = options.expected !== undefined && seen >= options.expected;
      if (!done) {
        const last = rows[rows.length - 1][key];
        if (last === undefined || last === null) {
          throw new PostgrestError(
            `GET /${table}: the rows carry no ${key} to page by`,
          );
        }
        pending = fetchPage(last);
        // Handled when awaited; this stops an early exit from leaving it unhandled.
        pending.catch(() => {});
      }
      yield rows;
      if (done) return;
    }
  }

  /** Every row of `table` matching the filters. */
  async readAll(table: string, options: ReadOptions): Promise<Row[]> {
    const out: Row[] = [];
    for await (const rows of this.pages(table, options)) out.push(...rows);
    return out;
  }

  /**
   * Every row whose `column` is one of `values`: one read per chunk of the
   * list, each URL under the budget. `column` should be unique for the
   * `expected` shortcut; pass `unique: false` otherwise.
   */
  async readIn(
    table: string,
    column: string,
    values: readonly unknown[],
    options: ReadOptions & { unique?: boolean },
  ): Promise<Row[]> {
    const distinct = [...new Set(values)];
    if (!distinct.length) return [];
    const fixed =
      this.host.postgrestUrl.length +
      table.length +
      (options.select ? columnList(options.select).length : 1) +
      (options.filters ?? []).join('&').length +
      column.length +
      200;
    const budget = Math.max(500, URL_BUDGET - fixed);
    const out: Row[] = [];
    let chunk: unknown[] = [];
    let length = 0;
    const flush = async () => {
      if (!chunk.length) return;
      out.push(
        ...(await this.readAll(table, {
          ...options,
          filters: [...(options.filters ?? []), inList(column, chunk)],
          expected: options.unique === false ? undefined : chunk.length,
        })),
      );
      chunk = [];
      length = 0;
    };
    for (const value of distinct) {
      const encoded = encodeURIComponent(quote(value)).length + 1;
      if (chunk.length && length + encoded > budget) await flush();
      chunk.push(value);
      length += encoded;
    }
    await flush();
    return out;
  }

  private backoff(attempt: number): Promise<void> {
    return sleep(jitter(TRANSIENT_RETRY_DELAYS_MS[attempt]), this.signal);
  }

  /** A static ${PREFIX}_JWT (or --token) cannot be refreshed. */
  private canRefresh(): boolean {
    return getUsedCredentialSource() !== 'jwt';
  }

  /** One refresh for every request that met the same expired token. */
  private refreshToken(): Promise<void> {
    this.refreshing ??= getAccessToken(this.host, { forceRefresh: true })
      .then((token) => {
        this.currentToken = token;
        recordJwt(token);
      })
      .finally(() => {
        this.refreshing = undefined;
      });
    return this.refreshing;
  }
}
