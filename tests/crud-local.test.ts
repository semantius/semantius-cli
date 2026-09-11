/**
 * Tests for the local crud layer (src/local-tools/crud/ and the vendored
 * resetSchemaCache replacement): registry, request context per mode, the
 * stdout / env shims, result post-processing, the schema-cache side effect
 * and its drain, the SDK timeout option, and the local retry loop.
 *
 * fetch is stubbed and routed by host: the tenant PostgREST, the token
 * endpoint, and a minimal fake of the remote crud MCP server (Streamable
 * HTTP, JSON responses) for refresh_schema_cache.
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ApiKeyRejectedError, NoCredentialsError } from '../src/auth/token';
import { type ServerConfig, setEnvPrefix } from '../src/config';
import type { HostFacts } from '../src/host';
import { deleteCachedToken } from '../src/jwt-cache';
import { createCrudConnection } from '../src/local-tools/crud/connection';
import {
  buildToolContext,
  clearCurrentContext,
  setCurrentContext,
} from '../src/local-tools/crud/context';
import {
  CLOUD_ONLY_TOOLS,
  createCrudServer,
  crudInstructions,
} from '../src/local-tools/crud/registry';
import { withLocalRetries } from '../src/local-tools/crud/retry';
import { tools as vendoredTools } from '../src/vendor/postgrest-mcp/registry';
import { instructions } from '../src/vendor/postgrest-mcp/src/generated/instructions';
import {
  drainPendingSideEffects,
  pendingSideEffectCount,
  resetSchemaCache,
} from '../src/vendor/postgrest-mcp/src/utils/resetSchemaCache';

const CLOUD: HostFacts = {
  mode: 'cloud',
  host: 'acme.semantius.cloud',
  org: 'acme',
  tenantId: 'tenant-1',
  postgrestUrl: 'https://pg.example.com/rest/v1',
  discoveryUrl: 'https://acme.semantius.cloud/.well-known/openid-configuration',
  tokenExchange: { method: 'POST', url: 'https://acme.semantius.cloud/token' },
  clientId: 'cli-client',
  apiBaseUrl: 'https://acme.semantius.ai',
  uiBaseUrl: 'https://acme.semantius.app',
};

const SELF_HOSTED: HostFacts = {
  mode: 'selfhosted',
  host: 'x.example.com',
  org: null,
  tenantId: null,
  postgrestUrl: 'https://x.example.com/rest',
  discoveryUrl: 'https://x.example.com/.well-known/openid-configuration',
  tokenExchange: { method: 'GET', url: 'https://x.example.com/api/auth/token' },
  clientId: null,
  apiBaseUrl: 'https://x.example.com/api',
  uiBaseUrl: 'https://x.example.com',
};

const CRUD_CONFIG: ServerConfig = { postgrest: 'https://pg.example.com/rest/v1' };

function makeJwt(marker: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return `${b64({ alg: 'none' })}.${b64({ exp, marker })}.sig`;
}

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

type Handler = (req: Captured) => Response | Promise<Response>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/**
 * Minimal remote crud MCP server over Streamable HTTP (JSON responses):
 * initialize, the initialized notification (202), GET SSE probe (405) and
 * tools/call answered by `onToolCall`.
 */
function fakeRemoteMcp(
  onToolCall: (params: { name: string }) => unknown | Promise<unknown>,
): Handler {
  return async (req) => {
    if (req.method === 'GET') return new Response(null, { status: 405 });
    if (req.method === 'DELETE') return new Response(null, { status: 200 });
    const message = JSON.parse(req.body ?? '{}');
    if (message.id === undefined) return new Response(null, { status: 202 });
    const result =
      message.method === 'initialize'
        ? {
            protocolVersion: message.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'fake-crud', version: '0' },
          }
        : message.method === 'tools/call'
          ? await onToolCall(message.params)
          : {};
    return json({ jsonrpc: '2.0', id: message.id, result });
  };
}

describe('local crud layer', () => {
  const VARS = [
    'SEMANTIUS_JWT',
    'SEMANTIUS_API_KEY',
    'SEMANTIUS_ORG',
    'SEMANTIUS_DEBUG',
    'SEMANTIUS_TIMEOUT',
    'SEMANTIUS_MAX_RETRIES',
    'API_KEY',
    'SUPABASE_ANON_KEY',
    'API_BASE_URL',
    'SUPABASE_URL',
  ];
  let saved: Record<string, string | undefined>;
  let originalFetch: typeof fetch;
  let requests: Captured[];
  let routes: Record<string, Handler>;
  const openConnections: Array<{ close: () => Promise<void> }> = [];

  function route(hostname: string, handler: Handler): void {
    routes[hostname] = handler;
  }

  const requestsTo = (hostname: string) =>
    requests.filter((r) => new URL(r.url).hostname === hostname);

  async function connect(host: HostFacts, config: ServerConfig = CRUD_CONFIG) {
    const conn = await createCrudConnection('crud', { ...config }, host);
    openConnections.push(conn);
    return conn;
  }

  const textOf = (result: unknown) =>
    (result as { content: Array<{ text: string }> }).content[0].text;

  beforeEach(() => {
    setEnvPrefix('SEMANTIUS');
    saved = {};
    for (const v of VARS) {
      saved[v] = process.env[v];
      delete process.env[v];
    }
    process.env.SEMANTIUS_JWT = makeJwt('static');
    process.env.SEMANTIUS_ORG = 'acme';
    process.env.SEMANTIUS_API_KEY = '';
    process.env.SEMANTIUS_MAX_RETRIES = '0';

    requests = [];
    routes = {};
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: URL | Request | string, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, key) => {
        headers[key] = value;
      });
      const req: Captured = {
        url: String(input),
        method: init?.method ?? 'GET',
        headers,
        body: typeof init?.body === 'string' ? init.body : undefined,
      };
      requests.push(req);
      const handler = routes[new URL(req.url).hostname];
      if (!handler) throw new Error(`unexpected fetch to ${req.url}`);
      return handler(req);
    }) as typeof fetch;
  });

  afterEach(async () => {
    await drainPendingSideEffects(5000);
    for (const conn of openConnections.splice(0)) await conn.close();
    globalThis.fetch = originalFetch;
    clearCurrentContext();
    for (const v of VARS) {
      if (saved[v] !== undefined) process.env[v] = saved[v];
      else delete process.env[v];
    }
  });

  // --------------------------------------------------------------- registry

  describe('registry', () => {
    async function listed(host: HostFacts): Promise<string[]> {
      const server = createCrudServer(() => buildToolContext(host, 't'), host);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client({ name: 'test', version: '0' }, { capabilities: {} });
      await client.connect(clientTransport);
      try {
        return (await client.listTools()).tools.map((t) => t.name);
      } finally {
        await client.close();
        await server.close();
      }
    }

    test('cloud registers all 53 vendored tools, in upstream order', async () => {
      const names = await listed(CLOUD);
      expect(names.length).toBe(53);
      expect(names).toEqual(
        (vendoredTools as Array<{ name: string }>).map((t) => t.name),
      );
      expect(names.slice(0, 2)).toEqual(['getCurrentUser', 'postgrestRequest']);
      expect(names).not.toContain('echo');
      // sqlToRest is MCP-only: its WASM parser does not survive bun build --compile.
      expect(names).not.toContain('sqlToRest');
      for (const name of CLOUD_ONLY_TOOLS) expect(names).toContain(name);
    });

    test('self-hosted leaves out sendEmail, get_cli_token and get_cli_config', async () => {
      const names = await listed(SELF_HOSTED);
      expect(names.length).toBe(50);
      for (const name of ['sendEmail', 'get_cli_token', 'get_cli_config']) {
        expect(names).not.toContain(name);
      }
    });

    test('instructions are the vendored SKILL.md (no ${slug} placeholder today)', () => {
      expect(crudInstructions('acme')).toBe(instructions);
      expect(crudInstructions(null)).toBe(instructions);
      expect(instructions.length).toBeGreaterThan(1000);
    });
  });

  // ---------------------------------------------------------------- context

  describe('request context', () => {
    test('cloud: the Deno host, x-api-key only on the API-key path', () => {
      expect(buildToolContext(CLOUD, 'tok', 'sk-key-secret')).toEqual({
        authInfo: { token: 'tok', apiBaseUrl: 'https://pg.example.com/rest/v1' },
        request: {
          method: 'POST',
          url: 'https://acme.semantius.ai/mcp',
          headers: { host: 'acme.semantius.ai', 'x-api-key': 'sk-key-secret' },
          query: {},
        },
      });
      expect(buildToolContext(CLOUD, 'tok').request.headers).toEqual({
        host: 'acme.semantius.ai',
      });
    });

    test('self-hosted: <host>/api/mcp and just the host header', () => {
      expect(buildToolContext(SELF_HOSTED, 'tok', 'sk-key-secret')).toEqual({
        authInfo: { token: 'tok', apiBaseUrl: 'https://x.example.com/rest' },
        request: {
          method: 'POST',
          url: 'https://x.example.com/api/mcp',
          headers: { host: 'x.example.com' },
          query: {},
        },
      });
    });

    test('cloud getCurrentUser: cloud-derived fields, no echoed bearer', async () => {
      route('pg.example.com', () => json({ email: 'a@b.test' }));
      const conn = await connect(CLOUD);
      const envelope = JSON.parse(textOf(await conn.callTool('getCurrentUser', {})));

      expect(envelope.response.data).toEqual({
        email: 'a@b.test',
        api_baseurl: 'https://acme.semantius.ai',
        semantius_org: 'acme',
        ui_baseurl: 'https://acme.semantius.app',
      });
      expect(envelope.request.url).toBe('https://pg.example.com/rest/v1/rpc/get_userinfo');
      expect(envelope.request.headers.authorization).toBeUndefined();
      // ...but it was sent.
      expect(requestsTo('pg.example.com')[0].headers.authorization).toBe(
        `Bearer ${process.env.SEMANTIUS_JWT}`,
      );
    });

    test('self-hosted getCurrentUser: api_baseurl <host>/api, no org, ui = host', async () => {
      route('x.example.com', () => json({ email: 'a@b.test' }));
      const conn = await connect(SELF_HOSTED, { postgrest: true });
      const envelope = JSON.parse(textOf(await conn.callTool('getCurrentUser', {})));
      expect(envelope.response.data).toEqual({
        email: 'a@b.test',
        api_baseurl: 'https://x.example.com/api',
        semantius_org: null,
        ui_baseurl: 'https://x.example.com',
      });
      expect(requestsTo('x.example.com')[0].url).toBe(
        'https://x.example.com/rest/rpc/get_userinfo',
      );
    });

    test('postgrestRequest envelope drops the authorization header; errors pass through', async () => {
      route('pg.example.com', (req) =>
        req.url.includes('missing')
          ? json({ code: 'PGRST205', message: 'no table' }, 404)
          : json([{ id: 1 }]),
      );
      const conn = await connect(CLOUD);
      const ok = JSON.parse(
        textOf(await conn.callTool('postgrestRequest', { method: 'GET', path: '/t' })),
      );
      expect(ok.request.headers).toEqual({
        'content-type': 'application/json',
        prefer: 'return=representation',
      });
      expect(ok.response.data).toEqual([{ id: 1 }]);

      const failed = await conn.callTool('postgrestRequest', {
        method: 'GET',
        path: '/missing',
      });
      expect(failed).toEqual({
        content: [{ type: 'text', text: 'Error: (PGRST205) no table' }],
        isError: true,
      });
    });

    test('no credentials → NoCredentialsError when connecting', async () => {
      delete process.env.SEMANTIUS_JWT;
      await expect(connect(CLOUD)).rejects.toBeInstanceOf(NoCredentialsError);
    });

    test('tool filters apply to listTools and callTool', async () => {
      const conn = await connect(CLOUD, { ...CRUD_CONFIG, disabledTools: ['delete_*'] });
      const names = (await conn.listTools()).map((t) => t.name);
      expect(names).not.toContain('delete_entity');
      expect(names).toContain('read_entity');
      await expect(conn.callTool('delete_entity', { table_name: 'x' })).rejects.toThrow(
        'disabled by configuration',
      );
    });
  });

  // ----------------------------------------------------------------- shims

  describe('stdout hygiene and env guard', () => {
    test('vendored console.log never reaches stdout; goes to debug() under SEMANTIUS_DEBUG', async () => {
      route('pg.example.com', () => json({ email: 'a@b.test' }));
      const conn = await connect(CLOUD);

      const originalLog = console.log;
      const originalError = console.error;
      const logSpy = mock((..._args: unknown[]) => {});
      const errorSpy = mock((..._args: unknown[]) => {});
      console.log = logSpy;
      console.error = errorSpy;
      try {
        await conn.callTool('getCurrentUser', {});
        expect(logSpy).not.toHaveBeenCalled();
        expect(errorSpy).not.toHaveBeenCalled(); // debug off
        expect(console.log).toBe(logSpy); // restored after the call

        process.env.SEMANTIUS_DEBUG = '1';
        await conn.callTool('getCurrentUser', {});
        expect(logSpy).not.toHaveBeenCalled();
        expect(errorSpy).toHaveBeenCalledWith(
          '[semantius] Making POST request to PostgREST: https://pg.example.com/rest/v1/rpc/get_userinfo',
        );
      } finally {
        console.log = originalLog;
        console.error = originalError;
      }
    });

    test('an unrelated API_KEY / SUPABASE_* in the shell never reaches PostgREST', async () => {
      process.env.API_KEY = 'leak';
      process.env.SUPABASE_ANON_KEY = 'anon-leak';
      process.env.SUPABASE_URL = 'https://supabase.example.com';
      process.env.API_BASE_URL = 'https://wrong.example.com';
      route('pg.example.com', () => json({ email: 'a@b.test' }));
      const conn = await connect(CLOUD);

      const envelope = JSON.parse(textOf(await conn.callTool('getCurrentUser', {})));

      const sent = requestsTo('pg.example.com')[0];
      expect(sent.headers.apikey).toBeUndefined();
      expect(sent.url).toBe('https://pg.example.com/rest/v1/rpc/get_userinfo');
      // SUPABASE_URL would also have added a /functions/v1/postgrest-mcp base path.
      expect(envelope.response.data.api_baseurl).toBe('https://acme.semantius.ai');
      // Restored afterwards.
      expect(process.env.API_KEY).toBe('leak');
      expect(process.env.SUPABASE_URL).toBe('https://supabase.example.com');
    });

    test('vendored console.error (failure logs with request body and stack) never reaches stderr', async () => {
      route('pg.example.com', () => json({ code: 'PGRST205', message: 'no table' }, 404));
      const conn = await connect(CLOUD);
      const originalError = console.error;
      const errorSpy = mock((..._args: unknown[]) => {});
      console.error = errorSpy;
      try {
        const result = await conn.callTool('getCurrentUser', {});
        expect(textOf(result)).toBe('Error: (PGRST205) no table');
        expect(errorSpy).not.toHaveBeenCalled();
        expect(console.error).toBe(errorSpy);
      } finally {
        console.error = originalError;
      }
    });

    test('an error without a PostgREST body names the status, the request and the host', async () => {
      // e.g. a web app or proxy at the host: 405, empty body
      route('x.example.com', () => new Response(null, { status: 405 }));
      const conn = await connect(SELF_HOSTED, { postgrest: true });
      const result = await conn.callTool('getCurrentUser', {});
      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: 'Error: (HTTP 405) Method Not Allowed from POST https://x.example.com/rest/rpc/get_userinfo — is x.example.com a Semantius instance? Its PostgREST is expected at https://x.example.com/rest',
          },
        ],
        isError: true,
      });
    });

    test('an unreachable PostgREST is named in the error', async () => {
      route('x.example.com', () => {
        throw new Error('Unable to connect. Is the computer able to access the url?');
      });
      const conn = await connect(SELF_HOSTED, { postgrest: true });
      const result = await conn.callTool('read_entity', {});
      expect(textOf(result)).toStartWith(
        'Error: GET https://x.example.com/rest/entities failed: Unable to connect.',
      );
    });

    test('client.callTool gets the SEMANTIUS_TIMEOUT budget, not the SDK 60 s default', async () => {
      process.env.SEMANTIUS_TIMEOUT = '77';
      route('pg.example.com', () => json({ email: 'a@b.test' }));
      const conn = await connect(CLOUD);
      const spy = spyOn(Client.prototype, 'callTool');
      try {
        await conn.callTool('getCurrentUser', {});
        expect(spy.mock.calls[0][2]).toEqual({ timeout: 77_000 });
      } finally {
        spy.mockRestore();
      }
    });
  });

  // ---------------------------------------------- schema-cache side effect

  describe('resetSchemaCache replacement and drain', () => {
    test('outside the local layer (no active host) it is a no-op', async () => {
      expect(await resetSchemaCache('localhost', 'tok')).toBeNull();
      expect(pendingSideEffectCount()).toBe(0);
      expect(requests).toEqual([]);
    });

    test('self-hosted: returns null and registers nothing', async () => {
      setCurrentContext(SELF_HOSTED, buildToolContext(SELF_HOSTED, 'tok'));
      expect(await resetSchemaCache('x.example.com', 'tok')).toBeNull();
      expect(pendingSideEffectCount()).toBe(0);
      expect(requests).toEqual([]);
    });

    test('drain with nothing pending returns at once', async () => {
      const t0 = Date.now();
      await drainPendingSideEffects(5000);
      expect(Date.now() - t0).toBeLessThan(100);
    });

    test('cloud create_field: fires refresh_schema_cache on the remote server; drain waits for it', async () => {
      process.env.SEMANTIUS_DEBUG = '1';
      const originalError = console.error;
      const errorSpy = mock((..._args: unknown[]) => {});
      console.error = errorSpy;

      let remoteCalls = 0;
      route('pg.example.com', () => json([{ id: 't.note' }], 201));
      route(
        'acme.semantius.ai',
        fakeRemoteMcp(async (params) => {
          expect(params.name).toBe('refresh_schema_cache');
          await Bun.sleep(150);
          remoteCalls++;
          return { content: [{ type: 'text', text: '{\n  "success": true\n}' }] };
        }),
      );
      try {
        const conn = await connect(CLOUD);
        const result = await conn.callTool('create_field', {
          data: { table_name: 't', field_name: 'note', title: 'Note', format: 'string' },
        });
        expect((result as { isError?: boolean }).isError).toBeUndefined();

        expect(pendingSideEffectCount()).toBe(1);
        expect(remoteCalls).toBe(0);
        await drainPendingSideEffects(5000);
        expect(remoteCalls).toBe(1);
        expect(pendingSideEffectCount()).toBe(0);

        // The remote call authenticates with the same bearer, not the API key.
        const remote = requestsTo('acme.semantius.ai').filter((r) => r.method === 'POST');
        expect(remote[0].url).toBe('https://acme.semantius.ai/mcp');
        expect(remote[0].headers.authorization).toBe(`Bearer ${process.env.SEMANTIUS_JWT}`);
        expect(remote[0].headers['x-api-key']).toBeUndefined();

        const okLines = errorSpy.mock.calls.filter(
          (c) => c[0] === '[semantius] resetSchemaCache: refresh_schema_cache ok',
        );
        expect(okLines.length).toBe(1);
      } finally {
        console.error = originalError;
      }
    });

    test('drain gives up after its timeout', async () => {
      route('pg.example.com', () => json([{ table_name: 't' }], 201));
      route(
        'acme.semantius.ai',
        fakeRemoteMcp(async () => {
          await Bun.sleep(1500);
          return { content: [{ type: 'text', text: '{}' }] };
        }),
      );
      const conn = await connect(CLOUD);
      await conn.callTool('create_entity', {
        data: { table_name: 't', singular_label: 'T', module_id: 1 },
      });

      const t0 = Date.now();
      await drainPendingSideEffects(100);
      expect(Date.now() - t0).toBeLessThan(1000);
      expect(pendingSideEffectCount()).toBe(1);
    });

    test('a failing remote refresh is logged, never fails the tool', async () => {
      process.env.SEMANTIUS_DEBUG = '1';
      const originalError = console.error;
      const errorSpy = mock((..._args: unknown[]) => {});
      console.error = errorSpy;
      route('pg.example.com', () => json([{ id: 't.note' }]));
      route(
        'acme.semantius.ai',
        fakeRemoteMcp(() => ({
          content: [{ type: 'text', text: 'Error: refresh failed (500)' }],
          isError: true,
        })),
      );
      try {
        const conn = await connect(CLOUD);
        const result = await conn.callTool('update_field', {
          id: 't.note',
          data: { title: 'Note 2' },
        });
        expect((result as { isError?: boolean }).isError).toBeUndefined();
        await drainPendingSideEffects(5000);
        expect(errorSpy).toHaveBeenCalledWith(
          '[semantius] resetSchemaCache: refresh_schema_cache failed: refresh failed (500)',
        );
      } finally {
        console.error = originalError;
      }
    });

    test('the refresh_schema_cache tool awaits the remote call and formats its body', async () => {
      route(
        'acme.semantius.ai',
        fakeRemoteMcp(() => ({
          content: [{ type: 'text', text: '{\n  "success": true\n}' }],
        })),
      );
      const conn = await connect(CLOUD);
      const result = await conn.callTool('refresh_schema_cache', {});
      expect(textOf(result)).toBe('{\n  "success": true\n}');
      expect(pendingSideEffectCount()).toBe(0);
    });
  });

  // ------------------------------------------------------------------ retry

  describe('withLocalRetries', () => {
    const errorResult = (text: string) => ({
      content: [{ type: 'text', text }],
      isError: true,
    });
    const okResult = { content: [{ type: 'text', text: '[]' }] };

    test('a JWT-looking error refreshes the token and re-runs', async () => {
      delete process.env.SEMANTIUS_JWT;
      const op = mock<() => Promise<unknown>>()
        .mockResolvedValueOnce(errorResult('Error: (PGRST301) JWT expired'))
        .mockResolvedValueOnce(okResult);
      const refresh = mock(async () => {});
      expect(await withLocalRetries(op, { refresh })).toEqual(okResult);
      expect(op).toHaveBeenCalledTimes(2);
      expect(refresh).toHaveBeenCalledTimes(1);
    });

    test('a 429-looking error re-runs without a refresh', async () => {
      const op = mock<() => Promise<unknown>>()
        .mockResolvedValueOnce(errorResult('Error: (429) Too Many Requests: rate limit'))
        .mockResolvedValueOnce(okResult);
      const refresh = mock(async () => {});
      expect(await withLocalRetries(op, { refresh })).toEqual(okResult);
      expect(op).toHaveBeenCalledTimes(2);
      expect(refresh).not.toHaveBeenCalled();
    });

    test('a non-retryable error result is returned as-is, once', async () => {
      const failure = errorResult('Error: (23505) duplicate key value violates unique constraint');
      const op = mock<() => Promise<unknown>>().mockResolvedValue(failure);
      const refresh = mock(async () => {});
      expect(await withLocalRetries(op, { refresh })).toEqual(failure);
      expect(op).toHaveBeenCalledTimes(1);
      expect(refresh).not.toHaveBeenCalled();
    });

    test('with a static SEMANTIUS_JWT a JWT error fails at once', async () => {
      const op = mock<() => Promise<unknown>>().mockResolvedValue(errorResult('Error: (PGRST301) JWT expired'));
      const refresh = mock(async () => {});
      await expect(withLocalRetries(op, { refresh })).rejects.toThrow('JWT expired');
      expect(op).toHaveBeenCalledTimes(1);
      expect(refresh).not.toHaveBeenCalled();
    });

    test('a rejected API key is never retried', async () => {
      delete process.env.SEMANTIUS_JWT;
      const op = mock<() => Promise<unknown>>().mockResolvedValue(
        errorResult('Error: (PGRST301) JWT expired'),
      );
      const refresh = mock(async () => {
        throw new ApiKeyRejectedError(CLOUD, 401, 'Invalid API key');
      });
      await expect(withLocalRetries(op, { refresh })).rejects.toBeInstanceOf(
        ApiKeyRejectedError,
      );
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(op).toHaveBeenCalledTimes(1);
    });

    test('end to end: an expired token is re-exchanged and the call retried', async () => {
      delete process.env.SEMANTIUS_JWT;
      const apiKey = `sk-crudlocal${randomBytes(4).toString('hex')}-${randomBytes(16).toString('hex')}`;
      process.env.SEMANTIUS_API_KEY = apiKey;
      const first = makeJwt('first');
      const second = makeJwt('second');
      let exchanges = 0;
      route('acme.semantius.cloud', () => {
        exchanges++;
        return json({ access_token: exchanges === 1 ? first : second, expires_in: 3600 });
      });
      route('pg.example.com', (req) =>
        req.headers.authorization === `Bearer ${first}`
          ? json({ code: 'PGRST301', message: 'JWT expired' }, 401)
          : json([{ table_name: 'orders' }]),
      );
      try {
        const conn = await connect(CLOUD);
        const result = await conn.callTool('read_entity', { select: 'table_name' });
        expect(JSON.parse(textOf(result))).toEqual([{ table_name: 'orders' }]);
        expect(exchanges).toBe(2);
        expect(requestsTo('pg.example.com').map((r) => r.headers.authorization)).toEqual([
          `Bearer ${first}`,
          `Bearer ${second}`,
        ]);
      } finally {
        deleteCachedToken(apiKey, CLOUD.host);
      }
    });
  });
});
