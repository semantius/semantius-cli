/**
 * Retries for local crud calls: the same classification, schedule and retry
 * log events as client.ts withRetries, without its MCP reconnect.
 *
 *   - 'jwt'       — rejected/expired token: refresh() fetches a fresh one
 *                   (and updates the context holder), then the call re-runs.
 *   - 'transient' — capacity backpressure (429, pool exhaustion): re-run.
 *
 * A static ${PREFIX}_JWT cannot be refreshed, so a JWT error fails at once.
 */

import { NoCredentialsError } from '../../auth/token.js';
import {
  JWT_RETRY_DELAYS_MS,
  type RetryKind,
  TRANSIENT_RETRY_DELAYS_MS,
  classifyRetry,
  jitter,
  retryableErrorFromResult,
} from '../../client.js';
import { getEnvJwt } from '../../config.js';
import { logRetryEvent } from '../../logger.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The retry kind for an error, or null when it must propagate as-is. */
function retryKind(err: unknown): RetryKind | null {
  if (err instanceof NoCredentialsError) return null;
  const kind = classifyRetry(err);
  if (kind === 'jwt' && getEnvJwt()) return null;
  return kind;
}

export async function withLocalRetries<T>(
  op: () => Promise<T>,
  opts: { refresh: () => Promise<void> },
): Promise<T> {
  // Tool failures arrive as isError results; surface the retryable ones as
  // thrown errors so they drive the loop. Others pass through untouched.
  const runOp = async (): Promise<T> => {
    const result = await op();
    const asError = retryableErrorFromResult(result);
    if (asError) throw asError;
    return result;
  };

  let kind: RetryKind;
  let lastError: Error;
  try {
    return await runOp();
  } catch (err) {
    const k = retryKind(err);
    if (!k) throw err;
    kind = k;
    lastError = err instanceof Error ? err : new Error(String(err));
  }

  // The schedule length is fixed by the first failure's kind; the recovery
  // action follows the current error's kind.
  const delays =
    kind === 'jwt' ? JWT_RETRY_DELAYS_MS : TRANSIENT_RETRY_DELAYS_MS;

  for (let i = 0; i < delays.length; i++) {
    const waitedMs = jitter(delays[i]);
    await sleep(waitedMs);

    const event = kind === 'jwt' ? 'retry_fresh_token' : 'retry_transient';
    try {
      if (kind === 'jwt') await opts.refresh();
      const result = await runOp();
      logRetryEvent({ event, outcome: 'success', attempt: i + 1, waitedMs });
      return result;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      logRetryEvent({
        event,
        outcome: 'failure',
        attempt: i + 1,
        waitedMs,
        error: lastError.message,
      });
      const nextKind = retryKind(err);
      if (!nextKind) throw lastError;
      kind = nextKind;
    }
  }

  throw lastError;
}
