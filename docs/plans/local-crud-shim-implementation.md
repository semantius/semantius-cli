# Implementation plan: local PostgREST crud layer + OAuth login

Compact, ordered checklist. Rationale, measurements and decision history are in
`local-crud-shim.md` (referenced as *R §n*). Every step ends with a "done when" line; do not start a
step whose inputs are still open. Rewritten 2026-09-11 after the second review (all findings folded in).

## 0. Fixed decisions (do not re-open)

- PostgREST is the CLI's primary crud transport; the Deno MCP server stays for remote MCP clients and
  for the one cloud-only side effect below. *(R §12, D5, D9)*
- Tool code is owned by `postgrest-mcp` and copied into this repo **unchanged** by a sync script. *(D6)*
- Schema-cache reset: cloud → call `refresh_schema_cache` on the original crud MCP server; self-hosted
  → no-op. No direct POST from the CLI. *(D9)*
- Auth v1: authorization-code + PKCE via `cli-auth`, plus the existing API-key and `SEMANTIUS_JWT`
  paths. No device code. Secrets in `Bun.secrets`, cli-auth `fileStorage` as headless fallback. *(D2, D3, D7, D8)*
- PKCE against cloud is **verified end to end** (R §9.1, 2026-09-11): scope
  `openid profile email offline_access tenant:<tenant id>:user`, client `client_id_cli` from the
  control plane, redirect `http://127.0.0.1:{53682,53683,53684}/callback`; PostgREST accepts the token.
- The daemon fix (R §11) is committed on `main` as `9ac9574`, unreleased. Releasing it is Martin's.
- Self-hosted: server URL configurable; no control plane, no Deno, no `cube`. *(D1, D12)*
- Host resolution order: `--host` → `${PREFIX}_HOST` → project `.env` → global `.env` → cloud default. *(D10)*
- `crud` defaults to the local layer; `--crud-mcp` (env `${PREFIX}_CRUD_MCP=1`) routes it through the
  Deno MCP server again; cloud only. *(D11)*
- Cloud-host rule: host matches `*.semantius.cloud` → cloud (org = first label, control plane used);
  anything else → self-hosted (host + fixed paths `/rest`, root `.well-known`, `/api/auth/token`). *(Q39, Q41)*
- All tools go local; no automatic fallback to MCP; the `postgrestRequest` envelope no longer echoes
  the `authorization` header. *(Q1, Q14, Q15)*
- Architecture: A (in-process MCP server) plus an additive `--stream` for `postgrestRequest`. *(D15)*
- Cloud first; a review gate precedes any self-hosted testing. *(D14)*
- Backup/restore postponed. *(D13)* — All other answers: R §14.2. No open questions (R §14.1).

## 1. Phasing, stop points, guardrails

| Phase | Steps | Exit gate |
|---|---|---|
| **A1 — local layer with the existing API key** | 2, 3, 3b, 4, 4b, 6 | §10 "A1 implementer stop" |
| **A2 — OAuth login (cloud)** | 5 | §10 "A2 implementer stop" |
| **review** | — | Martin reviews A1+A2 and runs the manual list in §10 |
| **B — self-hosted** | self-hosted items of 3, 3b, 4, 5 against a real instance | Martin tests on a self-hosted host |
| **rollout** | 7 | Martin releases via the script |

Self-hosted branches are written in A1 behind the mode flag and covered by unit tests with stubbed
`fetch` only; nothing contacts a self-hosted instance before Phase B.

**Architecture.** The local layer is an in-process `McpServer` over `InMemoryTransport`, like the
built-in `utils` server (`src/local-tools/connection.ts`), so every existing command, exit code,
`--single`, `--diag`, skill and eval keeps working unchanged; `--stream` (Step 4b) is the additive
raw path.

### Guardrails for the implementer (read before Step 2)

1. Never edit files under `src/vendor/postgrest-mcp/` except the one documented replacement
   (`src/utils/resetSchemaCache.ts`). If a vendored file seems to need a change, stop and report —
   the change belongs upstream. Shims *around* unchanged code are allowed only where a step names
   them (Step 4: `console.log` redirect, env guard, context holder, result post-processing).
2. The MCP path must behave exactly as today: after every step run `bun test` (all existing tests
   green) and `bun run dev --crud-mcp call crud getCurrentUser '{}'` must still work.
3. Do not refactor beyond what a step names. Leave `withRetries` untouched (Step 4 uses a separate
   helper). Leave `src/daemon.ts` and `src/daemon-client.ts` untouched (host-keyed socket names are
   Phase B).
4. One step per commit. Never release, never bump the version, never run `scripts/release.sh`
   (editing it where Step 2 says so is allowed).
5. A "done when" that cannot be met is a stop-and-report, not something to reinterpret.
6. Secrets: never print tokens or API keys; tests never touch the real `Bun.secrets` store.
7. Every new flag or env var goes into `--help` and the README in the same step.
8. Names in this plan are binding (files, functions, flags, env vars, error texts). Where the plan
   says "implementer default", take it without asking.

## 2. Vendoring script — `scripts/sync-postgrest-mcp.ts`

Prerequisite (Martin, upstream, before Step 2 starts): in `postgrest-mcp/src/utils/apiKeyAuth.ts`
type the token response (`const data = (await response.json()) as { access_token?: string }`) and
commit. Reason: under the CLI's strict `tsc` with bun types, `response.json()` is `unknown` and the
file fails with two `TS18046` errors; the copy may not be edited. **If this is not committed when
Step 2 starts, exclude `src/utils/apiKeyAuth.ts` and `src/tools/get_cli_token.ts` from the copy set
instead** (the CLI does the exchange itself in Step 3b; `get_cli_token` is then MCP-only).

- [ ] `package.json` scripts: `"sync": "bun run scripts/sync-postgrest-mcp.ts"`,
      `"sync:check": "bun run scripts/sync-postgrest-mcp.ts --check"`.
- [ ] Source root: `POSTGREST_MCP_DIR` env, default `<repo root>/../postgrest-mcp` (repo root =
      `dirname(import.meta.dir)`), not cwd. Require a clean upstream `git status`; record the
      upstream commit in `src/vendor/postgrest-mcp/UPSTREAM` (sync mode writes it, `--check` only reads).
- [ ] Copy unchanged into `src/vendor/postgrest-mcp/`, preserving relative layout:
      `types.ts`; `src/tools/**` (incl. `schemas/`) except `echo.ts` (upstream comments it out) and,
      depending on the `sqlToRest` spike below, `sqlToRest.ts`; `src/utils/{postgrest,bulk,formatResponse,errorHandler,apiKeyAuth,semantiusOrg,env}.ts`;
      `src/SKILL.md`.
- [ ] Generate `src/vendor/postgrest-mcp/src/generated/instructions.ts` from the copied `SKILL.md`
      with the same escaping as upstream `scripts/generate-instructions.js` (`\` → `\\`, `` ` `` →
      `` \` ``, `$` → `\$`; output `export const instructions = \`…\`;`). Note: `SKILL.md` currently
      contains no `${slug}` placeholder, so the substitution in Step 4 is a no-op today.
- [ ] Exclude `src/utils/resetSchemaCache.ts`, `src/utils/controlPlane.ts`, `src/utils/webhook.ts`,
      `src/db/**`, `src/index*.ts`, `src/mcp.ts`, `src/plugin/**`, `src/generated/**`. The CLI
      provides `src/vendor/postgrest-mcp/src/utils/resetSchemaCache.ts` itself (Step 4), same
      relative path, same export `resetSchemaCache(host: string, token?: string): Promise<unknown>`;
      the script never overwrites it (header comment "LOCAL REPLACEMENT — not synced").
- [ ] Generate `src/vendor/postgrest-mcp/registry.ts`: `export const tools = [ … ]` importing every
      `*Tool` export from the copied `src/tools/*.ts` (upstream `mcp.ts` does not export its array).
- [ ] Build gates: add `"src/vendor/**"` to `biome.json` → `files.ignore` (upstream has no
      semicolons); add `"allowImportingTsExtensions": true` to `tsconfig.json` (upstream imports
      `./x.ts`; `noEmit` is already set; `bun build --compile` ignores the flag). Add any upstream
      bare dependency missing from `package.json` (`zod` and `@modelcontextprotocol/sdk` are present).
- [ ] Copy `tests/crud-bulk.test.ts` to `tests/vendor/crud-bulk.test.ts` applying exactly three
      rewrites (and `--check` applies the same before comparing): (1) the URL import
      `https://deno.land/std@0.224.0/assert/mod.ts` → `./deno-assert.ts` (a local shim exporting
      `assert`, `assertEquals`, `assertStringIncludes` over `bun:test`'s `expect`); (2) `Deno.test(`
      → `test(` with `import { test } from 'bun:test';` prepended; (3) relative imports
      `"../types.ts"` → `"../../src/vendor/postgrest-mcp/types.ts"` and `"../src/` →
      `"../../src/vendor/postgrest-mcp/src/`.
- [ ] `--check` mode: byte-compare the copy set against upstream (test file after the three
      rewrites); generated files, `UPSTREAM` and the replacement are excluded; exit 1 on drift with
      the differing paths listed. Decided: `--check` is a **release-only gate** (add it to
      `scripts/release.sh` before its test run); CI does not check out upstream. Also add
      `tests/vendor/` and every new `tests/*.test.ts` of this plan to the fixed list in
      `.github/workflows/release.yml:33` and to `scripts/release.sh:72` (which globs only
      `tests/*.test.ts`).
- [ ] `sqlToRest` spike, **capped at one hour**: add `@supabase/sql-to-rest`, run
      `bun build --compile src/index.ts --outfile /tmp/x` and `semantius call crud sqlToRest
      '{"sql":"select 1"}'` on the binary. Works → keep; otherwise remove the dependency, exclude
      `sqlToRest.ts` from the copy set, document the tool as MCP-only (`--crud-mcp`). The registry
      test's tool count is 54 with it, 53 without (55 files − echo − sqlToRest).
- Done when: `bun run sync && bun run sync:check && bun run lint && bunx tsc --noEmit && bun test`
  all pass with the vendored tree included.

## 3. Host / server resolution — `src/host.ts` (new), `src/config.ts`, `src/index.ts`

Precedence (D10): `--host` flag → `${PREFIX}_HOST` env → project `.env` (cwd → config dir → exe dir)
→ global `.env` in the user config dir → managed-cloud default from `${PREFIX}_ORG`. Shell env keeps
beating `.env` files; `loadDotEnv()` already implements layers 2–4, so only the flag, the default
and the resolution are new code.

- [ ] `--host <url|hostname>`: parsed early in `src/index.ts` next to `findEnvPrefix` (same
      pre-scan pattern) and added to `parseArgs` (its default branch rejects unknown `--` options);
      accept `https://host[:port]` and bare hostnames (assume `https://`); strip trailing slashes.
      `${PREFIX}_HOST` read via `getPrefixedEnv('HOST')` after `loadDotEnv()`. `getHost()` in
      `src/host.ts` returns the winner or, when only `${PREFIX}_ORG` is set, `https://<org>.semantius.cloud`.
- [ ] `resolveHost(): Promise<HostFacts>` in `src/host.ts`, `HostFacts = { mode: 'cloud' | 'selfhosted',
      host, org: string | null, tenantId: string | null, postgrestUrl, discoveryUrl, tokenExchange:
      { method: 'POST' | 'GET', url }, clientId: string | null, apiBaseUrl, uiBaseUrl }`.
      **Cloud** (host matches `*.semantius.cloud`): `org` = first label; unauthenticated
      `GET https://api.semantius.cloud/organization/<org>` → `postgrest_url`, `id` (tenantId),
      `client_id_cli`; `discoveryUrl = https://<org>.semantius.cloud/.well-known/openid-configuration`;
      `tokenExchange = POST https://<org>.semantius.cloud/token`; `apiBaseUrl = https://<org>.semantius.ai`;
      `uiBaseUrl = https://<org>.semantius.app`. **Self-hosted** (any other host): no network:
      `postgrestUrl = {host}/rest`, `discoveryUrl = {host}/.well-known/openid-configuration`,
      `tokenExchange = GET {host}/api/auth/token`, `clientId` = the fixed self-hosted constant
      (`SELF_HOSTED_CLIENT_ID` in `src/host.ts`, value supplied in Phase B; until then `null` and
      `login` refuses on self-hosted), `apiBaseUrl = {host}/api`, `uiBaseUrl = {host}`, `org = null`.
- [ ] Cloud only: cache the control-plane record as JSON at `<user config dir>/hosts/<host>.json`
      with `:` and `/` in `<host>` replaced by `_` (Windows), mode 0600, 24 h TTL, no secrets.
      Extend `--reset-jwt-cache` to also delete it and add `--reset-cache` as the preferred spelling
      (both in `--help`). Self-hosted needs no cache.
- [ ] Org propagation: after resolution in cloud mode set `process.env[`${PREFIX}_ORG`] = org`
      (flag wins over `.env`), because `getDefaultConfig()` still interpolates `${PREFIX}_ORG` into
      the `cube` URL and the internal remote-crud URL. Note: an `org:`-prefixed API key hoisted by
      `normalizeCredentialEnv` that disagrees with `--host` yields a 401 from the token endpoint;
      document, do not special-case.
- [ ] Relaxed startup gate: `checkRequiredEnvVars` (in `src/index.ts`) and
      `getMissingRequiredEnvVars` (`src/config.ts`) currently require `${PREFIX}_ORG` and (`_API_KEY`
      or `_JWT`) and exit 5. New rule: a host must be resolvable (org, `--host`, `${PREFIX}_HOST`);
      credentials are checked later by Step 3b (`NoCredentialsError`). Also extend
      `normalizeCredentialEnv` to backfill `${PREFIX}_API_KEY=''` whenever it is undefined (not only
      in JWT-only mode), otherwise strict `${VAR}` substitution in the default config throws
      `MISSING_ENV_VAR` for OAuth-only sessions. Update `getRequiredEnvVarNames`, the `--help` env
      list and the missing-var message (which now says "set SEMANTIUS_ORG or --host").
- [ ] Config shape for the local layer in `mcp_servers.json` (implementer default): `{ "postgrest":
      true }` (resolve from host) or `{ "postgrest": "https://…/rest" }` (explicit PostgREST base
      URL); `isPostgrestServer()` guard in `config.ts`; validation: `postgrest` must be `true` or an
      `https?://` URL, not combinable with `url`/`command`. After resolution the config object
      carries the resolved URL (`{ postgrest: 'https://…' }`) so `formatServerDetails` can print it.
- [ ] `getDefaultConfig()`: `crud: { postgrest: true }`, `cube` unchanged (cloud) / absent
      (self-hosted). The remote crud MCP config (`https://<org>.semantius.ai/mcp`, headers
      `x-api-key: ${PREFIX}_API_KEY`) is still built internally under the constant name
      `REMOTE_CRUD_MCP` (not user-visible) for the cache-reset call and `--crud-mcp`.
- [ ] Explicit `mcp_servers.json` `crud` entry with `url`/`command` keeps today's behaviour; the
      local layer applies only to `{ postgrest: … }` entries and the default config (Q34).
- [ ] `--crud-mcp` flag + `${PREFIX}_CRUD_MCP=1` (same precedence as `--host`): `crud` resolves to
      `REMOTE_CRUD_MCP` for this invocation. Self-hosted → exit 1, text
      `Error [NOT_AVAILABLE]: --crud-mcp needs the Semantius cloud MCP server; self-hosted instances have none`.
      `info crud` prints `Transport: postgrest` / `Transport: HTTP` accordingly (existing label for
      HTTP). Daemon applies to the MCP route as before.
- [ ] Self-hosted: `semantius call cube …` / `info cube` → exit 1
      `Error [NOT_AVAILABLE]: the cube (analytics) server is not available on self-hosted instances`.
- Done when: `tests/host.test.ts` (fetch stubbed) covers: `--host` beats `${PREFIX}_HOST` beats
  `.env` beats org default; cloud record parsed (`postgrest_url`, `id`, `client_id_cli`); cache hit
  (no fetch), TTL expiry, reset flag; control-plane failure message
  `Error [HOST_RESOLUTION_FAILED]: …`; self-hosted facts for `--host https://x.example.com`; org
  propagation; relaxed gate (no credentials → passes the gate, fails later in 3b); `--crud-mcp` and
  `cube` self-hosted errors.

## 3b. Token source for the local layer — `src/auth/token.ts` (API key and static JWT; OAuth in Step 5)

Step 4 needs a bearer without the MCP server; today that exists only inside `transformConfigWithJwt`
for HTTP configs.

- [ ] `getAccessToken(host: HostFacts, opts?: { forceRefresh?: boolean }): Promise<string>`, order
      (P12 minus OAuth for now): `${PREFIX}_JWT` → `${PREFIX}_API_KEY` → (Step 5 inserts the OAuth
      session here) → throw `NoCredentialsError` with message
      `Authentication required: no credentials for <host>. Set SEMANTIUS_API_KEY or run "semantius login".`
      (the phrase "Authentication required" is what `isAuthErrorMessage()` matches, so the existing
      connect-error path exits 5; additionally add an `instanceof NoCredentialsError` branch in
      `call.ts` and `identity.ts` that exits `ErrorCode.AUTH_ERROR` without the connection-failed wrapper).
- [ ] API-key exchange without Deno, two shapes behind one function: cloud `POST <tokenExchange.url>`
      (body `grant_type=client_credentials`, header `x-api-key`, form-encoded) — the request the Deno
      server's `apiKeyAuth.ts` makes; self-hosted `GET <tokenExchange.url>` (header `x-api-key`).
      Parse `access_token`; `expires` = JWT `exp − 10 s` (as upstream `get_cli_token`); persist with
      the existing `writeCachedToken`/`readCachedToken`/`deleteCachedToken` (`src/jwt-cache.ts`,
      unchanged); own in-process dedupe map in `token.ts` (the one in `client.ts` is private).
- [ ] `forceRefresh`: `deleteCachedToken` then exchange again. With a static `${PREFIX}_JWT` there is
      nothing to refresh: `forceRefresh` is a no-op and callers must not retry (`withRetries` has the
      same rule).
- [ ] The MCP path (`transformConfigWithJwt`/`resolveJwt`) is **not** changed in A1.
- Done when: `tests/token.test.ts` (fetch stubbed): JWT wins over API key; cache hit → no fetch;
  cache miss → one fetch then cached; `forceRefresh` → delete + fetch; self-hosted GET shape; no
  credentials → `NoCredentialsError`; and `bun run dev call crud getCurrentUser '{}'` works with
  only `SEMANTIUS_API_KEY`/`SEMANTIUS_ORG` set (that call goes through Step 4, so run it after Step 4).

## 4. Local crud server — `src/local-tools/crud/`

- [ ] `registry.ts`: `createCrudServer(getContext: () => ToolContext): McpServer` — name `crud`,
      `instructions` = vendored `instructions` with `${slug}` → `org` (no-op today); for each entry
      of the vendored `registry.ts` call `server.registerTool(tool.name, tool.options, (input) =>
      tool.handler(input, getContext()))`. The SDK's `ToolCallback` is `(args, extra)`; `extra` is
      ignored (over `InMemoryTransport` it carries no auth/request info) — upstream ignores it too.
      Exclude `sendEmail`, `get_cli_token`, `get_cli_config` on self-hosted (they assume the cloud
      token endpoint/org); on cloud register all.
- [ ] `context.ts`: `ToolContext = { authInfo: { token, apiBaseUrl }, request: { method: 'POST',
      url, headers, query: {} } }` (upstream `RequestContext.request` requires `method` and `query`).
      Cloud: `url = https://<org>.semantius.ai/mcp`, `headers = { host: '<org>.semantius.ai', 'x-api-key':
      <only when the API-key path is active> }` (lowercase keys — that is how `getCurrentUser`,
      `get_cli_config`, `sendEmail`, `get_cli_token` derive the slug and `api_baseurl`). Self-hosted:
      `url = <apiBaseUrl>/mcp`, `headers = { host: <host name> }`; `getCurrentUser` then yields
      `api_baseurl = <apiBaseUrl>`, `semantius_org = <host name>` — post-process the result to set
      `semantius_org = null` and `ui_baseurl = <uiBaseUrl>` (Q29) in `connection.ts`, not in the
      vendored code. A **context holder** (`let current: ToolContext`) is set by `connection.ts`
      before each call and updated by `retry.ts` after a token refresh; the wrapper reads it per call.
- [ ] `stdout hygiene` (sanctioned shim): vendored `src/utils/postgrest.ts` line 67 and
      `refreshSchemaCache.ts` line 16 `console.log(...)` on every request — on Deno that is a server
      log, in-process it would corrupt stdout. For the lifetime of a crud call (and in `--stream`),
      `connection.ts` swaps `globalThis.console.log` for a function that forwards to `debug()`
      (stderr, only under `SEMANTIUS_DEBUG`) and restores it in `finally`. Test: stdout of a call
      contains only the tool result.
- [ ] `env guard` (sanctioned shim): vendored `getHeaders`/`makePostgrestRequest`/`getCurrentUser`
      read `API_KEY`, `SUPABASE_ANON_KEY`, `API_BASE_URL`, `SUPABASE_URL` from the environment; an
      unrelated `API_KEY` in a developer's shell would be sent to PostgREST as `apikey`. For the
      lifetime of a crud call `connection.ts` deletes those four names from `process.env` and
      restores them in `finally`. Test: with `API_KEY=leak` set, the captured request has no `apikey`.
- [ ] `resetSchemaCache.ts` replacement (path in Step 2), signature
      `resetSchemaCache(host, token)`: cloud → `connectToServer('crud-mcp', REMOTE_CRUD_MCP with
      headers { Authorization: 'Bearer ' + token })` (import `../../../../client.js`; no daemon, no
      `transformConfigWithJwt`), `callTool('refresh_schema_cache', {})`, close; self-hosted → return
      `null` without registering anything. Six of the seven upstream callers fire-and-forget
      (`.catch(() => {})`); only `refresh_schema_cache` awaits. Register every in-flight promise in a
      module-level set and export `drainPendingSideEffects(timeoutMs = 10_000)` (env
      `${PREFIX}_SIDE_EFFECT_TIMEOUT` in seconds). `call.ts` awaits it before **every** `process.exit`
      it performs, including the ones inside `handleSingleResult` (wrap the command body in
      `try/finally`). Under `SEMANTIUS_DEBUG` log `[semantius] resetSchemaCache: refresh_schema_cache ok|failed: <msg>`.
- [ ] `connection.ts`: `createCrudConnection(serverName, config, hostFacts): Promise<McpConnection>`
      — copy of `local-tools/connection.ts` plus: token via `getAccessToken(hostFacts)`, context
      holder, stdout hygiene, env guard, `client.callTool({ name, arguments }, undefined,
      { timeout: getTimeoutMs() })` (the utils copy uses the SDK default of 60 s — too short for bulk
      calls), `timeMcp` around the call (`src/logger.ts`), `recordUrl(postgrestUrl)`, result
      post-processing (self-hosted `getCurrentUser` fields; strip `request.headers.authorization`
      from the `postgrestRequest` envelope, Q15). No automatic fallback to MCP (Q14); on cloud the
      connection-failed message ends with `(try --crud-mcp)`.
- [ ] `retry.ts`: export `classifyRetry`, `retryableErrorFromResult`, `jitter`,
      `TRANSIENT_RETRY_DELAYS_MS`, `JWT_RETRY_DELAYS_MS` from `src/client.ts` (pure, no behaviour
      change) and implement `withLocalRetries(op, { refresh })` with the same schedule and
      `logRetryEvent` calls; `'jwt'` → `getAccessToken(host, { forceRefresh: true })`, update the
      context holder, re-run; `'transient'` → re-run; static `${PREFIX}_JWT` → never retry `'jwt'`.
      Test with a handler failing once with a JWT-looking error, once with a 429-looking error, once
      non-retryable.
- [ ] `client.ts::getConnection`: short-circuit `isPostgrestServer(config)` right after the
      `isBuiltinServer` short-circuit; tool filtering reused.
- Parity (the A1 acceptance): `tests/integration/parity.test.ts`, skipped unless
  `SEMANTIUS_PARITY=1` and `SEMANTIUS_API_KEY`/`SEMANTIUS_ORG` are set (the repo `.env` has them
  for `tests`). It spawns `bun run src/index.ts` twice per scenario, once plain and once with
  `--crud-mcp`, env from `.env` plus `SEMANTIUS_NO_DAEMON=1`, for the five scenarios of
  `docs/plans/bench/bench.ts` (getCurrentUser; `--single` first product; orders×100;
  order_details×1000; order_details×10000). Parity means: default stdout → JSON-equal after deleting
  `last_seen`/`updated_at` from `getCurrentUser` (the RPC bumps them); `--diag` → compare only
  `response.status`, `response.data`, `request.method`, `request.url`, `request.body` (response
  headers differ per call; `request.headers` differ by design, Q15); `info crud` → tool names and
  instructions equal, ignore the `Transport:`/`URL:` lines; `grep`, `-md` → text-equal apart from
  those lines. Write test: `create_entity {data:{table_name:'zz_parity_<epoch>', singular_label:'Parity',
  module_id:1001}}`, then `create_field` with the required keys of `fieldSchema` (`table_name`,
  `field_name:'note'`, `title:'Note'`, `format:'string'`), asserting under `SEMANTIUS_DEBUG=1`
  exactly one `resetSchemaCache: refresh_schema_cache ok` line for the `create_field` call, then
  `delete_entity {table_name}` in `afterAll` even on failure. Needs network to
  `tests.semantius.ai` (Deno), `api.semantius.cloud`, `tests.semantius.cloud/token` and the tenant
  PostgREST.
- Done when: `tests/crud-local.test.ts` (fetch stubbed) covers registry (54/53 tools, `echo`
  absent, self-hosted exclusions), context per mode, stdout hygiene, env guard, replacement + drain
  (waits, times out, no-op, self-hosted registers nothing), timeout option passed, retry cases; and
  the parity test passes against `tests`.

## 4b. `--stream` raw path — `src/local-tools/crud/stream.ts` (D15)

- [ ] `--stream` flag (+ `${PREFIX}_STREAM=1`) valid only for `call crud postgrestRequest`. There is
      nothing reusable in the vendored code (`getHeaders` is private, `makePostgrestRequest` parses
      the body): duplicate the request construction — `URL = postgrestUrl + path`, method, body
      (`JSON.stringify` unless string), headers `content-type: application/json`,
      `prefer: return=representation`, `accept` if given, `authorization: Bearer <token>`, no
      `apikey` — and prove equality in `tests/stream.test.ts` by stubbing `fetch`, running the
      vendored `postgrestRequestTool.handler` and the stream builder with the same args, and
      comparing captured method/URL/headers/body.
- [ ] Pipe `response.body` to stdout unchanged (compact JSON, or CSV when `accept: text/csv`).
- [ ] Errors: non-2xx → read the body and print `Error: (<code>) <message>` (same text shape as
      `makePostgrestRequest`) to stderr; exit codes: 401/403 → 5, 5xx or network → 3, other non-2xx
      → 4. Retry via `withLocalRetries`.
- [ ] Reject with exit 1 and a one-line message: `--stream` with `--single`, `--diag`, `--crud-mcp`,
      or any tool other than `postgrestRequest`. Stdin JSON args work as usual.
- [ ] Docs: output is compact, may be CSV; `jq` consumers keep working, pretty-diff consumers do not.
- Done when: `bun run dev call crud postgrestRequest --stream '{"method":"GET","path":"/order_details?limit=10000"}' | wc -c`
  equals the PostgREST body size (compare with a direct `fetch` in the test); CSV passthrough;
  equality test; rejected combinations; exit-code table. Bench re-run with a `stream` path is
  Martin's (needs `semantius-bench.exe` built from the branch).

## 5. OAuth login — `src/auth/` (Phase A2)

- [ ] Add `cli-auth` **pinned exactly** (`"cli-auth": "0.1.0-beta.0"`, no caret; do not vendor —
      vendor only if upstream is abandoned or unfixable; MIT, zero runtime deps). Raise
      `engines.bun` to `>=1.3` (`Bun.secrets` and cli-auth's README requirement). `@types/bun`
      1.3.5 already declares `Bun.secrets`.
- [ ] `src/auth/storage.ts`: `createSecretStorage(name: string, secrets = Bun.secrets): Storage<TokenSet>`
      implementing cli-auth's contract exactly (`load(): Promise<TokenSet | undefined>`,
      `save(credential)`, `clear()`, optional `lock()`), over `secrets.get/set/delete({ service:
      'semantius', name })`, JSON-serialising the `TokenSet`. `name = <env prefix>:<host>`. Probe
      once at first use; on failure (headless Linux: "libsecret not available") delegate every call
      to cli-auth's `fileStorage({ dir: getUserConfigDir() })` and print one stderr line
      `[semantius] no OS keyring available; storing the session in <dir>`. Wrap with
      `fileLock({ lockPath: join(getUserConfigDir(), name + '.lock') })` (check the exact `fileLock`
      signature in the pinned package). Never `/tmp`; never swallow save errors. Tests inject a fake
      `secrets` object — never monkey-patch the `Bun` global (the Windows CI runner has a real store).
- [ ] `src/auth/provider.ts`: fetch `discoveryUrl` (cached with the host facts) and pass explicit
      `provider.metadata = { authorizationEndpoint, tokenEndpoint, revocationEndpoint }` to cli-auth
      (it has no built-in discovery). Verified cloud values: authorize
      `https://<org>.semantius.cloud/api/auth/oauth2/authorize`, token `https://<org>.semantius.cloud/token`,
      revoke `…/api/auth/oauth2/revoke`.
- [ ] Scope and claims (verified 2026-09-11): request
      `openid profile email offline_access tenant:<tenantId>:user`. The access token carries
      `tid = <tenantId>`, `role = authenticated`, `aud = ["https://<org>.semantius.cloud/mcp",
      "…/api/auth/oauth2/userinfo"]` (not `tenant://…` like the API-key JWT) and PostgREST accepts
      it. The callback's `iss` is `https://app.semantius.com/api/auth` while discovery says
      `https://<org>.semantius.cloud/api/auth`: cli-auth does not validate `iss`; **do not add an
      `iss` check** (reported upstream).
- [ ] Callback: cli-auth builds `redirect_uri = http://127.0.0.1:<port>/callback` (path default
      `/callback`, host hard-coded). Registered for `client_id_cli`: ports 53682, 53683, 53684. Pick
      the first free one (probe with `Bun.listen` on `127.0.0.1`, close, pass as `callbackPort`); all
      busy → exit 1 `Error [LOGIN_FAILED]: ports 53682-53684 are in use`. Login timeout 5 min.
- [ ] Commands: add `login` and `logout` to `SUBCOMMANDS` and to the `ParsedArgs.command` union in
      `src/index.ts` (today `semantius login` parses as `info login`). `semantius login [--host]
      [--env]`: `createCliAuth({ strategy: 'authorization-code', provider, clientId:
      hostFacts.clientId, storage, scope, callbackPort })`, `login({ onAuthorization(url) })` → print
      the URL and open the browser (`cmd /c start ""` / `open` / `xdg-open`, ignore failures);
      `semantius logout` → `auth.logout()` (best-effort revoke + `clear`). Self-hosted with
      `clientId === null` → exit 1 `Error [NOT_AVAILABLE]: OAuth login is not configured for
      self-hosted instances yet`.
- [ ] Flags: `--auth jwt|apikey|oauth` forces one source for this invocation; `--login` runs the
      browser flow first, then uses that session for this invocation even if a JWT/API key is set;
      `--login` with `!process.stdin.isTTY` → exit 1 `Error [LOGIN_FAILED]: --login needs an
      interactive terminal`. Never open a browser implicitly: no credentials → `NoCredentialsError`
      (Step 3b), exit 5.
- [ ] `getAccessToken` gains the OAuth source: `--auth` → `${PREFIX}_JWT` → `${PREFIX}_API_KEY` →
      stored session for (prefix, host) via `auth.getToken()` (auto-refresh 300 s before expiry;
      `forceRefresh` → `getToken({ forceRefresh })` or clear+refresh per cli-auth's API) → error.
- [ ] MCP route with an OAuth-only session (`cube`, `--crud-mcp`): `transformConfigWithJwt` currently
      returns early when `config.headers['x-api-key']` is falsy (`''`). Change the gate to "the
      `x-api-key` header **key** is present" and obtain the bearer from `getAccessToken` (this is
      the one A2 change to the MCP path; the API-key behaviour stays identical).
- [ ] `whoami` shows `auth_method: jwt|apikey|oauth` and, for oauth, the session expiry; `--diag`
      still shows the bearer in use.
- [ ] Daemon interplay: the daemon config hash includes the bearer, so a refreshed token restarts
      the daemon (about hourly). Test: two calls with the same token → one `daemon_start`; a call
      after a forced refresh → exactly one more.
- Done when: `tests/auth.test.ts` green — storage adapter with a fake `secrets` and forced file
  fallback; PKCE `login` against a mock provider on a local `Bun.serve` (authorize redirect →
  loopback callback → token), refresh before expiry, `logout` clears; precedence incl. `--auth` and
  `--login`; non-TTY `--login`; the `transformConfigWithJwt` gate. Then **stop** (§10): the real
  `semantius login` against `tests` is Martin's.

## 6. Commands, docs, skills

- [ ] `--help` and README: three credential methods and their precedence; `--host` / `SEMANTIUS_HOST`;
      `--crud-mcp`; `--stream`; `--reset-cache`; `login`/`logout`; `ping` now measures PostgREST,
      not Deno. `skills/use-semantius/references/cli-usage.md` likewise (env var names must match
      `--help`). `CLAUDE.md`: add "vendored tree under `src/vendor/` is synced, never edited".
- [ ] `semantius info crud` shows `Transport: postgrest` and the resolved URL (no token).
- [ ] `tests/cli-errors.test.ts` extended for the local path: RLS denial → 4; `--single` 0 rows → 1;
      2+ rows → 2; invalid API key at exchange → 5; expired static `${PREFIX}_JWT` → 4 (unchanged
      today: the tool returns an `isError` result). Error text shape `Error: (CODE) message` preserved.
- [ ] `info crud` / `-md` work offline through the local layer (instructions are vendored; keep the
      `-md` behaviour of `80810b3`).
- Done when: the extended `cli-errors` tests pass and `bun run dev -md` output is reviewed by the
  implementer for stray lines. Skill evals (need model runs) are Martin's, §10.

## 7. Rollout (Martin)

- [ ] Martin: release the daemon fix (`9ac9574`) as its own release first.
- [ ] Martin: review A1+A2 (§10), then Phase B, then release via `./scripts/release.sh` only.
- [ ] Martin: after release re-run `docs/plans/bench/bench.ts` (Windows) and
      `docs/plans/bench/linux-daemon-ab.sh` (WSL), append to R §10.
- Done when: both releases are tagged, the parity test passes on the released binary, R §10 updated.

## 8. Explicitly out of scope

- Device-code login (D7). Backup/restore (D13; R §12.2 keeps the requirements). `--profile` (Q36).
- Windows daemon (R §11.2) and host-keyed daemon socket names (Phase B).
- Streaming beyond `postgrestRequest` (typed `read_*`, uploads).
- `sqlToRest` only if the one-hour spike fails.
- Slimming the Deno server after the CLI moves off it (R §6 step 17).

## 9. Test matrix

| Test | Where | Covers |
|---|---|---|
| `tests/daemon-framing.test.ts`, `tests/integration/daemon.test.ts` | all / `skipIf(win32)` | daemon (done) |
| `tests/vendor/crud-bulk.test.ts` (copied, three rewrites) | all | copied tool handlers, fetch stubbed |
| `tests/host.test.ts` (new) | all | Step 3 done-when list |
| `tests/token.test.ts` (new) | all | Step 3b done-when list |
| `tests/crud-local.test.ts` (new) | all | Step 4 done-when list |
| `tests/stream.test.ts` (new) | all | Step 4b done-when list |
| `tests/cli-errors.test.ts` (extended) | all | exit codes 1/2/4/5 and error shape through the local layer and `--stream` |
| `tests/auth.test.ts` (new, A2) | all | Step 5 done-when list; fake `secrets` only |
| `tests/integration/parity.test.ts` (new) | gated: `SEMANTIUS_PARITY=1` + creds | local vs `--crud-mcp`, five bench scenarios + scratch-entity write with cleanup (Step 4) |
| `bun run sync:check` | `scripts/release.sh` only | vendored copy is current |
| `bun run lint`, `bunx tsc --noEmit`, `bun test`; `release.yml` / `release.sh` test lists updated | all | gates |

## 10. Stop points and Martin's manual list

**A1 implementer stop.** Steps 2, 3, 3b, 4, 4b, 6 committed one per step; `bun run lint && bunx tsc
--noEmit && bun test` green; `SEMANTIUS_PARITY=1 bun test --timeout 120000
tests/integration/parity.test.ts` green against `tests`; then STOP and post this list for Martin
(all from the repo root, `.env` present):

```
bun run dev call crud getCurrentUser '{}'
bun run dev --crud-mcp call crud getCurrentUser '{}'
bun run dev whoami --diag
bun run dev ping -n 5
bun run dev info crud
bun run dev -md | head -60
bun run dev call crud read_entity '{"select":"table_name","filters":"module_id=eq.1001"}'
bun run dev call crud postgrestRequest --single '{"method":"GET","path":"/products?id=eq.1"}'
bun run dev call crud postgrestRequest --stream '{"method":"GET","path":"/order_details?limit=10000"}' | wc -c
bun run dev call crud postgrestRequest --stream '{"method":"GET","path":"/products?limit=3","accept":"text/csv"}'
SEMANTIUS_DEBUG=1 bun run dev call crud create_field '{"data":{"table_name":"<scratch>","field_name":"x","title":"X","format":"string"}}'
```

**A2 implementer stop.** Step 5 committed; `tests/auth.test.ts` green against the mock provider;
do NOT run `semantius login` (needs Martin's browser); STOP. Martin then runs:

```
bun run dev login
bun run dev whoami
bun run dev call crud getCurrentUser '{}'
bun run dev call cube discover '{}'
bun run dev --auth apikey whoami
bun run dev logout
```

Never in A1/A2: releasing, version bumps, running `scripts/release.sh`, contacting a self-hosted host.
