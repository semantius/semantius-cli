/**
 * In-process McpConnection for the local crud layer.
 *
 * Like the built-in "utils" connection (../connection.ts) — a real McpServer
 * wired to the CLI's Client over InMemoryTransport, so every command, exit
 * code, --single, --diag and skill sees the same envelopes as from the remote
 * crud server — plus what running the vendored postgrest-mcp tools in-process
 * needs: a bearer token and request context, the stdout/env shims, the local
 * retry loop, and result post-processing.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { version as VERSION } from '../../../package.json' with {
  type: 'json',
};
import { getAccessToken, getCredentialSource } from '../../auth/token.js';
import type { McpConnection, ToolInfo } from '../../client.js';
import {
  type ServerConfig,
  filterTools,
  getPrefixedEnv,
  getTimeoutMs,
  isToolAllowed,
} from '../../config.js';
import type { HostFacts } from '../../host.js';
import { recordJwt, recordUrl, timeMcp } from '../../logger.js';
import {
  buildToolContext,
  getCurrentContext,
  setCurrentContext,
} from './context.js';
import {
  type HttpFailure,
  describeFailure,
  recordFetchFailures,
  unexplainedFailure,
} from './http-errors.js';
import { isolateVendoredCall } from './isolate.js';
import { createCrudServer } from './registry.js';
import { withLocalRetries } from './retry.js';

interface ToolResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

/**
 * Tools whose success text is the makePostgrestRequest envelope
 * { request: { method, url, headers, body }, response }.
 */
const ENVELOPE_TOOLS = new Set(['postgrestRequest', 'getCurrentUser']);

/**
 * Drop the echoed `authorization` request header from the envelope, and on
 * self-hosted replace the cloud-derived getCurrentUser fields: api_baseurl is
 * <host>/api, semantius_org does not exist, ui_baseurl is the host.
 */
export function postProcessResult(
  toolName: string,
  result: unknown,
  host: HostFacts,
): unknown {
  const r = result as ToolResult;
  if (!ENVELOPE_TOOLS.has(toolName) || r?.isError) return result;
  const text = r?.content?.length === 1 ? r.content[0].text : undefined;
  if (r.content?.[0]?.type !== 'text' || typeof text !== 'string') {
    return result;
  }

  let envelope: {
    request?: { headers?: Record<string, unknown> };
    response?: { data?: unknown };
  };
  try {
    envelope = JSON.parse(text);
  } catch {
    return result;
  }
  if (envelope?.request?.headers) {
    const { authorization: _bearer, ...headers } = envelope.request.headers;
    envelope.request.headers = headers;
  }

  const data = envelope?.response?.data;
  if (
    toolName === 'getCurrentUser' &&
    host.mode === 'selfhosted' &&
    data &&
    typeof data === 'object'
  ) {
    Object.assign(data, {
      api_baseurl: host.apiBaseUrl,
      semantius_org: null,
      ui_baseurl: host.uiBaseUrl,
    });
  }

  return {
    ...r,
    content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
  };
}

export async function createCrudConnection(
  _serverName: string,
  config: ServerConfig,
  host: HostFacts,
): Promise<McpConnection> {
  const apiKey =
    getCredentialSource() === 'apikey' ? getPrefixedEnv('API_KEY') : undefined;
  const token = await getAccessToken(host);
  recordUrl(host.postgrestUrl);
  recordJwt(token);
  let context = buildToolContext(host, token, apiKey);

  const server = createCrudServer(getCurrentContext, host);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client(
    { name: 'semantius', version: VERSION },
    { capabilities: {} },
  );
  await client.connect(clientTransport);

  const callOnce = (
    toolName: string,
    args: Record<string, unknown>,
    failures: HttpFailure[],
  ) => {
    setCurrentContext(host, context);
    return isolateVendoredCall(() =>
      recordFetchFailures(failures, () =>
        // The SDK's default request timeout (60 s) is too short for bulk calls.
        client.callTool({ name: toolName, arguments: args }, undefined, {
          timeout: getTimeoutMs(),
        }),
      ),
    );
  };

  const refresh = async () => {
    const fresh = await getAccessToken(host, { forceRefresh: true });
    recordJwt(fresh);
    context = buildToolContext(host, fresh, apiKey);
  };

  return {
    async listTools(): Promise<ToolInfo[]> {
      const result = await client.listTools();
      const tools = result.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as Record<string, unknown>,
      }));
      return filterTools(tools, config);
    },
    async callTool(
      toolName: string,
      args: Record<string, unknown>,
    ): Promise<unknown> {
      if (!isToolAllowed(toolName, config)) {
        throw new Error(`Tool "${toolName}" is disabled by configuration`);
      }
      const failures: HttpFailure[] = [];
      let result: unknown;
      try {
        result = await timeMcp(() =>
          withLocalRetries(() => callOnce(toolName, args, failures), {
            refresh,
          }),
        );
      } catch (error) {
        // Retries exhausted: name the request if PostgREST did not.
        const failure = unexplainedFailure(failures, host);
        if (failure)
          throw new Error(`Error: ${describeFailure(failure, host)}`);
        throw error;
      }
      return postProcessResult(toolName, explainFailure(result), host);

      /** Replace the text of an error result PostgREST did not explain. */
      function explainFailure(r: unknown): unknown {
        const failure = unexplainedFailure(failures, host);
        if (!failure || !(r as ToolResult)?.isError) return r;
        return {
          ...(r as ToolResult),
          content: [
            { type: 'text', text: `Error: ${describeFailure(failure, host)}` },
          ],
        };
      }
    },
    async getInstructions(): Promise<string | undefined> {
      return client.getInstructions();
    },
    async close(): Promise<void> {
      await client.close();
      await server.close();
    },
    isDaemon: false,
  };
}
