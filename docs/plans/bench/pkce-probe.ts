/**
 * PKCE probe: does an OAuth token obtained by the CLI-style browser login work against PostgREST?
 * No dependencies. Prints NO tokens. Writes url.txt (for the user to open) and result.txt.
 *
 * Steps: control plane → client_id_cli + postgrest_url; discovery → endpoints; PKCE authorize URL;
 * loopback listener on 127.0.0.1:53682/callback; code → token; decode claims; POST /rpc/get_userinfo
 * with the Bearer (what `whoami` does); try the refresh_token grant.
 */
import { join } from 'node:path';

const ORG = 'tests';
const HERE = import.meta.dir;
const out: string[] = [];
const log = (m: string) => { out.push(m); console.log(m); };
const write = async () => Bun.write(join(HERE, 'result.txt'), out.join('\n') + '\n');

const b64url = (b: Uint8Array) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const decodeJwt = (t: string) => JSON.parse(Buffer.from(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());

const cp = await (await fetch(`https://api.semantius.cloud/organization/${ORG}`)).json();
const clientId: string = cp.client_id_cli;
const postgrest: string = cp.postgrest_url;
const disc = await (await fetch(`https://${ORG}.semantius.cloud/.well-known/openid-configuration`)).json();
log(`client_id_cli present: ${!!clientId}; tenant id: ${cp.id}`);
log(`authorization_endpoint: ${disc.authorization_endpoint}`);
log(`token_endpoint: ${disc.token_endpoint}`);

const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
const PORTS = [53682, 53683, 53684];
const scope = process.env.PROBE_SCOPE ?? 'openid profile email offline_access';
const resource = process.env.PROBE_RESOURCE; // e.g. tenant://<id> (RFC 8707), optional
log(`scope requested: ${scope}${resource ? `; resource=${resource}` : ''}`);

let server: ReturnType<typeof Bun.serve> | undefined;
let port = 0;
const codePromise = new Promise<{ code?: string; error?: string }>((resolve) => {
  for (const p of PORTS) {
    try {
      server = Bun.serve({
        hostname: '127.0.0.1', port: p,
        fetch(req) {
          const u = new URL(req.url);
          if (u.pathname !== '/callback') return new Response('not found', { status: 404 });
          if (u.searchParams.get('state') !== state) { resolve({ error: 'state mismatch' }); return new Response('state mismatch', { status: 400 }); }
          const err = u.searchParams.get('error');
          if (err) { resolve({ error: `${err}: ${u.searchParams.get('error_description') ?? ''}` }); return new Response(`Login failed: ${err}`, { status: 400 }); }
          resolve({ code: u.searchParams.get('code') ?? undefined });
          return new Response('<html><body><h2>semantius PKCE probe: login received, you can close this tab.</h2></body></html>', { headers: { 'content-type': 'text/html' } });
        },
      });
      port = p; break;
    } catch (e) { log(`port ${p} busy: ${(e as Error).message}`); }
  }
  if (!server) resolve({ error: 'no free port' });
});
if (!server) { await write(); process.exit(1); }
const redirectUri = `http://127.0.0.1:${port}/callback`;
log(`listening on ${redirectUri}`);

const authUrl = new URL(disc.authorization_endpoint);
for (const [k, v] of Object.entries({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, scope, state, code_challenge: challenge, code_challenge_method: 'S256', ...(resource ? { resource } : {}) })) authUrl.searchParams.set(k, v);
await Bun.write(join(HERE, 'url.txt'), authUrl.toString());
log('authorize URL written to url.txt; waiting up to 10 min for the browser callback…');
await write();

const timeout = new Promise<{ error: string }>((r) => setTimeout(() => r({ error: 'timeout (10 min)' }), 600_000));
const cb = await Promise.race([codePromise, timeout]);
server.stop(true);
if (!cb.code) { log(`callback failed: ${cb.error}`); await write(); process.exit(1); }
log('callback received with code + matching state');

const tok = await fetch(disc.token_endpoint, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'authorization_code', code: cb.code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier, ...(resource ? { resource } : {}) }),
});
const tj: any = await tok.json().catch(() => ({}));
log(`token exchange: HTTP ${tok.status}; keys: ${Object.keys(tj).join(',')}`);
if (!tj.access_token) { log(`token error: ${JSON.stringify(tj).slice(0, 300)}`); await write(); process.exit(1); }
const claims = decodeJwt(tj.access_token);
log(`access_token claims: aud=${JSON.stringify(claims.aud)} scope=${JSON.stringify(claims.scope)} role=${claims.role ?? '-'} tid=${claims.tid ?? '-'} exp-iat=${claims.exp - claims.iat}s email=${claims.email ? 'present' : 'absent'}`);
log(`refresh_token: ${tj.refresh_token ? 'present' : 'ABSENT'}; id_token: ${tj.id_token ? 'present' : 'absent'}; expires_in=${tj.expires_in}`);

// whoami equivalent
const who = await fetch(`${postgrest}/rpc/get_userinfo`, { method: 'POST', headers: { authorization: `Bearer ${tj.access_token}`, 'content-type': 'application/json' }, body: '{}' });
const wt = await who.text();
let wj: any = null; try { wj = JSON.parse(wt); } catch {}
log(`PostgREST /rpc/get_userinfo with the OAuth token: HTTP ${who.status}${wj?.email ? `; email=${wj.email}; roles=${(wj.roles ?? []).map((r: any) => r.role_name).join(',')}` : `; body=${wt.slice(0, 200)}`}`);
const rd = await fetch(`${postgrest}/products?select=id&limit=1`, { headers: { authorization: `Bearer ${tj.access_token}` } });
log(`PostgREST GET /products?limit=1 with the OAuth token: HTTP ${rd.status} ${(await rd.text()).slice(0, 60)}`);

// refresh grant
if (tj.refresh_token) {
  const rf = await fetch(disc.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tj.refresh_token, client_id: clientId }) });
  const rj: any = await rf.json().catch(() => ({}));
  log(`refresh_token grant: HTTP ${rf.status}; new access_token=${!!rj.access_token}; rotated refresh_token=${!!rj.refresh_token}`);
  // best-effort revoke so the probe leaves nothing usable behind
  if (disc.revocation_endpoint) {
    const rv = await fetch(disc.revocation_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: rj.refresh_token ?? tj.refresh_token, token_type_hint: 'refresh_token', client_id: clientId }) });
    log(`revocation: HTTP ${rv.status}`);
  }
}
log('DONE');
await write();
