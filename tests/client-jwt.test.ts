/**
 * Unit tests for the static SEMANTIUS_JWT path of transformConfigWithJwt.
 *
 * Only branches that return BEFORE any cache/network I/O are exercised —
 * there is no get_cli_token mock, so the resolveJwt path stays untested here
 * (covered by integration tests against a real server).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync } from 'node:fs';
import { transformConfigWithJwt } from '../src/client';
import { setEnvPrefix } from '../src/config';
import { getCachePath } from '../src/jwt-cache';

describe('transformConfigWithJwt with static SEMANTIUS_JWT', () => {
  const VARS = ['SEMANTIUS_JWT', 'SEMANTIUS_DISABLE_JWT_CACHE'];
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    setEnvPrefix('SEMANTIUS');
    saved = {};
    for (const v of VARS) {
      saved[v] = process.env[v];
      delete process.env[v];
    }
  });

  afterEach(() => {
    for (const v of VARS) {
      if (saved[v] !== undefined) {
        process.env[v] = saved[v];
      } else {
        delete process.env[v];
      }
    }
  });

  test('swaps x-api-key for Authorization: Bearer <env jwt>', async () => {
    process.env.SEMANTIUS_JWT = 'eyJ.e30.sig';
    const result = (await transformConfigWithJwt('crud', {
      url: 'https://test-org.semantius.ai/mcp',
      headers: { 'x-api-key': 'sk-test-secret', 'X-Custom': 'kept' },
    })) as any;
    expect(result.headers.Authorization).toBe('Bearer eyJ.e30.sig');
    expect(result.headers['x-api-key']).toBeUndefined();
    expect(result.headers['X-Custom']).toBe('kept');
  });

  test('matches the x-api-key header case-insensitively', async () => {
    process.env.SEMANTIUS_JWT = 'eyJ.e30.sig';
    const result = (await transformConfigWithJwt('crud', {
      url: 'https://test-org.semantius.ai/mcp',
      headers: { 'X-Api-Key': 'sk-test-secret' },
    })) as any;
    expect(result.headers.Authorization).toBe('Bearer eyJ.e30.sig');
    expect(result.headers['X-Api-Key']).toBeUndefined();
  });

  test('applies in JWT-only mode where the substituted x-api-key is empty', async () => {
    process.env.SEMANTIUS_JWT = 'eyJ.e30.sig';
    const result = (await transformConfigWithJwt('crud', {
      url: 'https://test-org.semantius.ai/mcp',
      headers: { 'x-api-key': '' },
    })) as any;
    expect(result.headers.Authorization).toBe('Bearer eyJ.e30.sig');
    expect(result.headers['x-api-key']).toBeUndefined();
  });

  test('strips an org prefix from the raw env value', async () => {
    // Normalization usually bares the value first; getEnvJwt strips defensively.
    process.env.SEMANTIUS_JWT = 'my-org:eyJ.e30.sig';
    const result = (await transformConfigWithJwt('crud', {
      url: 'https://test-org.semantius.ai/mcp',
      headers: { 'x-api-key': 'sk-test-secret' },
    })) as any;
    expect(result.headers.Authorization).toBe('Bearer eyJ.e30.sig');
  });

  test('takes precedence over SEMANTIUS_DISABLE_JWT_CACHE', async () => {
    process.env.SEMANTIUS_JWT = 'eyJ.e30.sig';
    process.env.SEMANTIUS_DISABLE_JWT_CACHE = '1';
    const result = (await transformConfigWithJwt('crud', {
      url: 'https://test-org.semantius.ai/mcp',
      headers: { 'x-api-key': 'sk-test-secret' },
    })) as any;
    expect(result.headers.Authorization).toBe('Bearer eyJ.e30.sig');
  });

  test('leaves servers without an x-api-key header untouched', async () => {
    process.env.SEMANTIUS_JWT = 'eyJ.e30.sig';
    const config = {
      url: 'https://other.example.com/mcp',
      headers: { Authorization: 'Bearer custom-token' },
    };
    const result = (await transformConfigWithJwt('other', config)) as any;
    expect(result.headers.Authorization).toBe('Bearer custom-token');
  });

  test('leaves stdio servers untouched', async () => {
    process.env.SEMANTIUS_JWT = 'eyJ.e30.sig';
    const config = { command: 'echo', args: ['hi'] };
    const result = await transformConfigWithJwt('local', config);
    expect(result).toEqual(config);
  });

  test('without env JWT and cache disabled the config passes through', async () => {
    process.env.SEMANTIUS_DISABLE_JWT_CACHE = '1';
    const config = {
      url: 'https://test-org.semantius.ai/mcp',
      headers: { 'x-api-key': 'sk-test-secret' },
    };
    const result = (await transformConfigWithJwt('crud', config)) as any;
    expect(result.headers['x-api-key']).toBe('sk-test-secret');
    expect(result.headers.Authorization).toBeUndefined();
  });

  test('writes nothing to the token cache', async () => {
    process.env.SEMANTIUS_JWT = 'eyJ.e30.sig';
    // 'sk-test-secret' parses to id 'sk-test' → this would be its cache file
    const cachePath = getCachePath('sk-test');
    await transformConfigWithJwt('crud', {
      url: 'https://test-org.semantius.ai/mcp',
      headers: { 'x-api-key': 'sk-test-secret' },
    });
    expect(existsSync(cachePath)).toBe(false);
  });
});
