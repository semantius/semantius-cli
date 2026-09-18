/**
 * Entry point of the transfer tools (export_entities, export_module,
 * import_entities, import_module), loaded only when one of them is called.
 *
 * Unlike the rest of the utils server these tools talk to a host: the one
 * --host (or the usual host resolution) names, straight at its PostgREST.
 * --crud-mcp and a crud.postgrest URL override do not apply.
 */

import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
} from '@modelcontextprotocol/sdk/types.js';
import { getAccessToken } from '../../auth/token.js';
import { resolveHost } from '../../host.js';
import type { TransferContext } from './format.js';
import { PostgrestClient } from './postgrest.js';

export { exportEntities, exportModule } from './export.js';
export { importTransfer } from './import.js';

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/**
 * Progress notifications for the call: with the client's
 * resetTimeoutOnProgress the call only times out when a run stops making
 * progress. Every answer from the host is a heartbeat (no message); the
 * steps worth reading carry one.
 */
function progressOf(extra: Extra): (message?: string) => void {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) return () => {};
  let progress = 0;
  return (message) => {
    extra
      .sendNotification({
        method: 'notifications/progress',
        params: {
          progressToken,
          progress: ++progress,
          ...(message ? { message } : {}),
        },
      })
      .catch(() => {});
  };
}

/** Run a transfer against the configured host; the result as tool output. */
export async function runTransfer(
  extra: Extra,
  run: (ctx: TransferContext) => Promise<unknown>,
): Promise<CallToolResult> {
  try {
    const host = await resolveHost();
    const token = await getAccessToken(host);
    const pg = new PostgrestClient(host, token, extra.signal);
    const progress = progressOf(extra);
    pg.onActivity = () => progress();
    const result = await run({ pg, progress });
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: /^error\b/i.test(message) ? message : `Error: ${message}`,
        },
      ],
    };
  }
}
