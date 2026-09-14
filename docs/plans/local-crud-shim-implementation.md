# Implementation plan: local PostgREST crud layer + OAuth login

Compact, ordered checklist. Rationale, measurements and decision history are in
`local-crud-shim.md` (referenced as *R §n*). Every step ends with a "done when" line; do not start a
step whose inputs are still open. Rewritten 2026-09-11 after the second review (all findings folded in).

## Status and hand-over (2026-09-12, end of the A3 session)

**Where things are.** Phases **A1 (Steps 2, 3, 3b, 4, 4b, 6), A2 (Step 5), A2b (Step 5b) and A3
(Step 5c) are implemented and committed** on the branch **`local-crud-layer`** (not on `main`, so
the daemon fix `9ac9574` can still be released alone first; **not pushed**). Gates at the last
commit: `bun run lint`, `bunx tsc --noEmit`, `bun test --timeout 60000` → 482 pass / 15 skip / 0
fail (the skips: 6 pre-existing + the gated parity suite); `SEMANTIUS_PARITY=1 bun test --timeout
120000 tests/integration/parity.test.ts` → 7/7 against `tests`, last run after A2 because A2 changed
the MCP route's bearer (A3 touches no crud path). Plain `bun test` (5 s default timeout) times out
the npx-based `tests/integration/cli.test.ts` on Windows — pre-existing, CI uses `--timeout 60000`.

**Verified by hand against `cli1-bb82` (Martin's machine, 2026-09-11):** `login` (browser flow),
`whoami --host` → `auth_method oauth` + session expiry, `logout`, `--auth apikey --host` rejected,
and the API-key path unchanged on `tests` (`whoami`, `call crud getCurrentUser`). The three bugs
that first login exposed are fixed (see "Found in Martin's first real login" under Step 5), and a
**fresh login after the fixes was proven on 2026-09-12**: both stores had been cleared, so the
session `whoami` now uses came from a full authorization-code exchange carrying the resource
indicator, stored in the Credential Manager (no file fallback). A2 has nothing unproven left.

| Commit | Content |
|---|---|
| `7fb433e` | Step 2 — sync script, vendored tree |
| `2f38c8a` | Step 3 — host resolution, default config, `--crud-mcp` |
| `929d071` | Step 3b — token source |
| `8ac5703` | Step 4 — local crud layer, parity test |
| `5dc6288` | Step 4b — `--stream` |
| `3e16fd7` | Step 6 — docs, `cli-errors` extension |
| `64ea99b` | After A1 (Martin's requests): bare hosts, cloud-name mapping, per-host token cache (security fix), readable errors |
| `619fb77` | After A1 (Martin's decision): with `--host` only credentials stored for that host |
| `e655241` | Step 5 (A2) — OAuth browser login for cloud hosts, `login` / `logout`, `--auth`, `--login` |
| `835d31d` | After A2 (Martin's first login): resource indicator for the audience, keyring size limit, Windows browser open |
| `8ca0aaf` | `whoami` shows the session expiry in local time |
| `6146c20` | Log the callback issuer under `SEMANTIUS_DEBUG` (how an auth deploy is verified) |
| `3257e67` | Step 5b (A2b) — metadata and callback issuer checks |
| `cd3e954` | Step 5c (A3) — self-hosted login: fixed client id, refusal dropped, docs, tests |

**Next, in order.**
1. **Martin's instance must serve `/.well-known/oauth-protected-resource`** (body and rules in §10
   "A3 implementer stop"). It is still 404 — re-probed this session in every variant. The CLI side
   of A3 is done and waiting: `login --host localhost:3000` gets as far as that 404 and stops
   there. Nothing else about A3 is open in the code.
2. **Martin:** once it is served, the A3 list in §10 — in particular the `call crud` read, which
   answers the one open question (the `aud` the IdP mints, and whether `/rest` accepts it).
3. **Martin:** the rest of the A2 list in §10 (login, whoami, cube, `--auth apikey`, logout, a second
   host) — the login itself and the issuer check are already proven against `cli1-bb82`.
4. **Martin's decision:** keep or drop the A2 default that `--auth jwt|apikey` is rejected with
   `--host` (Step 5 "As built"); everything else in A2 follows §0.
5. **Phase B**, then **rollout** (§7): the daemon fix `9ac9574` is released alone first, and the
   branch is still unpushed and unreleased.

Not done in A2: the daemon-interplay test (Step 5, last box) — no A2 code touches the daemon.

**Built differently from the text below, and why** (the steps are marked accordingly):
- `sqlToRest` spike failed: in a `bun build --compile` binary the parser's WASM is missing
  (`ENOENT $bunfs/root/pg-parser.wasm`). It works only if every compile command adds
  `node_modules/@supabase/pg-parser/wasm/17/pg-parser.wasm` as an extra entrypoint plus
  `--asset-naming="[name].[ext]"` (7 build scripts + 6 release steps) — not done; the tool is
  excluded (53 local tools) and documented as `--crud-mcp` only.
- The sync script reads the upstream files from `git HEAD` (LF), not the working tree (CRLF on
  Windows with autocrlf), and orders `registry.ts` like upstream `src/mcp.ts` (listTools order =
  parity for `info` / `grep` / `-md`).
- Host format (Martin): a host is a bare `hostname[:port]`; `https://` / `http://` are stripped,
  paths rejected; always HTTPS except loopback (`localhost`, `127.x.x.x`, `[::1]`) = HTTP (local
  dev servers and the test stubs). `<org>.semantius.app` / `.ai` / `.io` map to
  `<org>.semantius.cloud`.
- Credentials belong to their host — see §0.
- The API-key token cache is keyed by host (`jwt-cache.ts` got an optional `scope`); before, a token
  minted by one host was sent to another after `--host` (security fix). The MCP path's cache entry
  (per API key) is unchanged; `--reset-cache` deletes both.
- The local layer fetches its token when the crud connection is created (the plan's connect-error
  path), so `info crud` needs credentials; with a static JWT / warm caches it needs no network.
- Error shape additions: `Error [API_KEY_REJECTED]` (401/403 at the token exchange; names host,
  variable and the `.env` it came from; exit 5; never retried). `NoCredentialsError` has a second
  text for `--host` ("no credentials stored for <host>. Run \"semantius login --host <host>\" …").
  Failed PostgREST requests without a PostgREST error body (empty, HTML, unreachable) are reported
  as `(HTTP <status>) <reason> from <METHOD> <url>` (+ "is <host> a Semantius instance?" on
  self-hosted) — `src/local-tools/crud/http-errors.ts`; token exchange and `--stream` likewise.
- Shims (Martin asked for meaningful errors instead of stack traces): besides `console.log`, the vendored `console.error` goes to
  `debug()` for the lifetime of a call (it printed request bodies and a stack trace); the shims live
  in `src/local-tools/crud/isolate.ts` (so `--stream` does not load all 53 tools, ~90 ms). A fetch
  wrapper records failed requests for the readable errors above.
- Post-processing: the `authorization` header is dropped from the `getCurrentUser` envelope too, not
  only `postgrestRequest`'s; on self-hosted `getCurrentUser` also gets `api_baseurl = <host>/api`
  (the vendored code derives the bare origin, not `{host}/api` as Step 4 assumed).
- `${PREFIX}_STREAM=1` applies only where `--stream` is valid and is ignored elsewhere (a global
  setting must not break every other call); an explicit `--stream` in an invalid combination is
  rejected as specified.
- Step 6's `login` / `logout` / OAuth documentation is deferred to A2 (the commands do not exist yet).

**Open findings for Martin's review** (none blocks A2):
1. `--single` on the Neon Data API: `application/vnd.pgrst.object+json` returns the first row for
   2+ rows (exit 0, not 2) and `null` for 0 rows (exit 1) — identical on both routes. A standard
   PostgREST (self-hosted) answers 406 instead, and the vendored error text drops `details`
   ("0 rows"), so that becomes exit 4. Relevant for Phase B.
2. `cube` on a cold JWT cache: `findJwtIssuer` now finds `cube` (crud is no longer an HTTP entry), so
   `transformConfigWithJwt` calls `get_cli_token` on `cube`, fails, and falls back to `x-api-key` —
   one wasted round trip per cube call until the A2 change to the MCP path (bearer from
   `getAccessToken`) lands.
3. Deno Deploy cold starts (≈ 2–3 s) were seen after only a few minutes idle, not just the 20 min
   R §10.3 measured — the old route pays them far more often than recorded.
4. Optional speed-up (Martin liked it): generate a static tool manifest (name, description, JSON
   Schema — produced by the SDK at sync time) plus lazy per-tool imports, served by the SDK's
   low-level `Server`. Measured gain ≈ 20–30 ms per call and 30–50 ms for `info`/`list`/`-md`; the
   dominant per-call cost is the ~220 ms TCP+TLS setup to Neon, which only a long-lived process
   avoids.
5. Upstream suggestion: `makePostgrestRequest` could include the HTTP status when the error body is
   empty (the CLI compensates in `http-errors.ts`).
6. Wrong-host failures exit 3 (connect path) or 4 (tool path); a config error (1) might fit better.

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
  Endpoints and tenant scope come from the host's `.well-known` documents, RFC 9728 → RFC 8414
  (Martin, 2026-09-11; Step 5); the client id only from the control plane.
- **Login is split by host type (Martin, 2026-09-11).** A2 = OAuth login against the managed cloud,
  where the control plane and the tenant's discovery documents already supply everything (client id,
  tenant id, endpoints). A3 = self-hosted login: Martin supplied its spec after cloud login worked
  (Step 5c). Since A3 the self-hosted `clientId` is the fixed `semantius-cli` and `login` takes the
  same path as cloud; what differs is that the instance itself must serve the RFC 9728 document and
  have that client registered.
- **Issuer checks were A2b, not A2 (Martin, 2026-09-11; both done 2026-09-12).** A2 shipped with no
  issuer verification because the callback carried `iss = https://app.semantius.com/api/auth` while
  the metadata promised `https://<org>.semantius.cloud/api/auth` — a compliant client would have
  rejected every login. The server was fixed, and A2b added both checks (metadata and callback,
  Step 5b). They are binding for A3: there an arbitrary host serves its own metadata, which is
  exactly the mix-up case they defend against.
- The daemon fix (R §11) is committed on `main` as `9ac9574`, unreleased. Releasing it is Martin's.
- Self-hosted: server URL configurable; no control plane, no Deno, no `cube`. *(D1, D12)*
- Host resolution order: `--host` → `${PREFIX}_HOST` → project `.env` → global `.env` → cloud default. *(D10)*
- **Credentials belong to their host (Martin, 2026-09-11; supersedes the "document, do not
  special-case" note in Step 3).** Without `--host` the environment is the profile
  (`${PREFIX}_HOST`/`_ORG` + `_JWT`/`_API_KEY`). With `--host`, only the host name counts: only
  credentials stored for that host are used (one set per host: the OAuth session of Step 5, tokens
  cached per host); the environment's API key, JWT and org are ignored and never sent to another
  host. Implemented after A1: `ignoreEnvCredentials()` in `index.ts`, `getCredentialSource()` in
  `src/auth/token.ts`; the API-key token cache is keyed by host.
- `crud` defaults to the local layer; `--crud-mcp` (env `${PREFIX}_CRUD_MCP=1`) routes it through the
  Deno MCP server again; cloud only. *(D11)*
- Cloud-host rule: host matches `*.semantius.cloud` → cloud (org = first label, control plane used);
  anything else → self-hosted (host + fixed paths `/rest`, root `.well-known`, `/api/auth/token`). *(Q39, Q41)*
  A host is a bare `hostname[:port]` (scheme stripped); `<org>.semantius.app` / `.ai` / `.io` map to
  `<org>.semantius.cloud`; HTTPS except loopback hosts. *(Martin, 2026-09-11)*
- All tools go local (except `sqlToRest`, see hand-over); no automatic fallback to MCP; the
  `postgrestRequest` (and `getCurrentUser`) envelope no longer echoes the `authorization` header. *(Q1, Q14, Q15)*
- Architecture: A (in-process MCP server) plus an additive `--stream` for `postgrestRequest`. *(D15)*
- Cloud first; a review gate precedes any self-hosted testing. *(D14)*
- Backup/restore postponed. *(D13)* — All other answers: R §14.2. No open questions (R §14.1).

## 1. Phasing, stop points, guardrails

| Phase | Steps | Exit gate |
|---|---|---|
| **A1 — local layer with the existing API key** (no login: API key or static JWT only) | 2, 3, 3b, 4, 4b, 6 | §10 "A1 implementer stop" |
| **A2 — OAuth login, cloud hosts only** (no issuer checks) | 5 | §10 "A2 implementer stop" |
| **review** | — | Martin reviews A1+A2 and runs the manual list in §10 |
| **A2b — issuer checks** (server sends the right callback `iss`, CLI verifies) — ✅ done | 5b | §10 "A2b implementer stop" |
| **A3 — OAuth login, self-hosted** — ✅ code done; the login itself waits on the server document | 5c | §10 "A3 implementer stop" |
| **B — self-hosted** | self-hosted items of 3, 3b, 4, 5c against a real instance | Martin tests on a self-hosted host |
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
   them (Step 4: `console.log` / `console.error` redirect, env guard, context holder, fetch-failure
   recording, result post-processing — all in `src/local-tools/crud/`).
2. The MCP path must behave exactly as today: after every step run `bun test --timeout 60000` (all
   existing tests green; the 5 s default times out the npx integration tests on Windows) and
   `bun run dev --crud-mcp call crud getCurrentUser '{}'` must still work.
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

## 2. Vendoring script — `scripts/sync-postgrest-mcp.ts` — ✅ done (`7fb433e`)

Prerequisite (Martin, upstream, before Step 2 starts): in `postgrest-mcp/src/utils/apiKeyAuth.ts`
type the token response (`const data = (await response.json()) as { access_token?: string }`) and
commit. Reason: under the CLI's strict `tsc` with bun types, `response.json()` is `unknown` and the
file fails with two `TS18046` errors; the copy may not be edited. **If this is not committed when
Step 2 starts, exclude `src/utils/apiKeyAuth.ts` and `src/tools/get_cli_token.ts` from the copy set
instead** (the CLI does the exchange itself in Step 3b; `get_cli_token` is then MCP-only).

- [x] `package.json` scripts: `"sync-mcp-tools": "bun run scripts/sync-postgrest-mcp.ts"`,
      `"sync-mcp-tools:check": "bun run scripts/sync-postgrest-mcp.ts --check"`.
- [x] Source root: `POSTGREST_MCP_DIR` env, default `<repo root>/../postgrest-mcp` (repo root =
      `dirname(import.meta.dir)`), not cwd. Require a clean upstream `git status`; record the
      upstream commit in `src/vendor/postgrest-mcp/UPSTREAM` (sync mode writes it, `--check` only reads).
- [x] Copy unchanged into `src/vendor/postgrest-mcp/`, preserving relative layout:
      `types.ts`; `src/tools/**` (incl. `schemas/`) except `echo.ts` (upstream comments it out) and,
      depending on the `sqlToRest` spike below, `sqlToRest.ts`; `src/utils/{postgrest,bulk,formatResponse,errorHandler,apiKeyAuth,semantiusOrg,env}.ts`;
      `src/SKILL.md`.
- [x] Generate `src/vendor/postgrest-mcp/src/generated/instructions.ts` from the copied `SKILL.md`
      with the same escaping as upstream `scripts/generate-instructions.js` (`\` → `\\`, `` ` `` →
      `` \` ``, `$` → `\$`; output `export const instructions = \`…\`;`). Note: `SKILL.md` currently
      contains no `${slug}` placeholder, so the substitution in Step 4 is a no-op today.
- [x] Exclude `src/utils/resetSchemaCache.ts`, `src/utils/controlPlane.ts`, `src/utils/webhook.ts`,
      `src/db/**`, `src/index*.ts`, `src/mcp.ts`, `src/plugin/**`, `src/generated/**`. The CLI
      provides `src/vendor/postgrest-mcp/src/utils/resetSchemaCache.ts` itself (Step 4), same
      relative path, same export `resetSchemaCache(host: string, token?: string): Promise<unknown>`;
      the script never overwrites it (header comment "LOCAL REPLACEMENT — not synced").
- [x] Generate `src/vendor/postgrest-mcp/registry.ts`: `export const tools = [ … ]` importing every
      `*Tool` export from the copied `src/tools/*.ts` (upstream `mcp.ts` does not export its array).
- [x] Build gates: add `"src/vendor/**"` to `biome.json` → `files.ignore` (upstream has no
      semicolons); add `"allowImportingTsExtensions": true` to `tsconfig.json` (upstream imports
      `./x.ts`; `noEmit` is already set; `bun build --compile` ignores the flag). Add any upstream
      bare dependency missing from `package.json` (`zod` and `@modelcontextprotocol/sdk` are present).
- [x] Copy `tests/crud-bulk.test.ts` to `tests/vendor/crud-bulk.test.ts` applying exactly three
      rewrites (and `--check` applies the same before comparing): (1) the URL import
      `https://deno.land/std@0.224.0/assert/mod.ts` → `./deno-assert.ts` (a local shim exporting
      `assert`, `assertEquals`, `assertStringIncludes` over `bun:test`'s `expect`); (2) `Deno.test(`
      → `test(` with `import { test } from 'bun:test';` prepended; (3) relative imports
      `"../types.ts"` → `"../../src/vendor/postgrest-mcp/types.ts"` and `"../src/` →
      `"../../src/vendor/postgrest-mcp/src/`.
- [x] `--check` mode: byte-compare the copy set against upstream (test file after the three
      rewrites); generated files, `UPSTREAM` and the replacement are excluded; exit 1 on drift with
      the differing paths listed. Decided: `--check` is a **release-only gate** (add it to
      `scripts/release.sh` before its test run); CI does not check out upstream. Also add
      `tests/vendor/` and every new `tests/*.test.ts` of this plan to the fixed list in
      `.github/workflows/release.yml:33` and to `scripts/release.sh:72` (which globs only
      `tests/*.test.ts`).
- [x] `sqlToRest` spike, **capped at one hour**: add `@supabase/sql-to-rest`, run
      `bun build --compile src/index.ts --outfile /tmp/x` and `semantius call crud sqlToRest
      '{"sql":"select 1"}'` on the binary. Works → keep; otherwise remove the dependency, exclude
      `sqlToRest.ts` from the copy set, document the tool as MCP-only (`--crud-mcp`). The registry
      test's tool count is 54 with it, 53 without (55 files − echo − sqlToRest).
      **Outcome: failed → excluded, 53 tools (recipe for later: hand-over section).**
- Done when: `bun run sync-mcp-tools && bun run sync-mcp-tools:check && bun run lint && bunx tsc --noEmit && bun test`
  all pass with the vendored tree included.

## 3. Host / server resolution — `src/host.ts` (new), `src/config.ts`, `src/index.ts` — ✅ done (`2f38c8a`, host format changed in `64ea99b`, credentials rule `619fb77`)

Precedence (D10): `--host` flag → `${PREFIX}_HOST` env → project `.env` (cwd → config dir → exe dir)
→ global `.env` in the user config dir → managed-cloud default from `${PREFIX}_ORG`. Shell env keeps
beating `.env` files; `loadDotEnv()` already implements layers 2–4, so only the flag, the default
and the resolution are new code.

- [x] `--host <hostname>` (as built: bare `hostname[:port]`, see §0): parsed early in `src/index.ts` next to `findEnvPrefix` (same
      pre-scan pattern) and added to `parseArgs` (its default branch rejects unknown `--` options);
      accept `https://host[:port]` and bare hostnames (assume `https://`); strip trailing slashes.
      `${PREFIX}_HOST` read via `getPrefixedEnv('HOST')` after `loadDotEnv()`. `getHost()` in
      `src/host.ts` returns the winner or, when only `${PREFIX}_ORG` is set, `https://<org>.semantius.cloud`.
- [x] `resolveHost(): Promise<HostFacts>` in `src/host.ts`, `HostFacts = { mode: 'cloud' | 'selfhosted',
      host, org: string | null, tenantId: string | null, postgrestUrl, discoveryUrl, tokenExchange:
      { method: 'POST' | 'GET', url }, clientId: string | null, apiBaseUrl, uiBaseUrl }`.
      **Cloud** (host matches `*.semantius.cloud`): `org` = first label; unauthenticated
      `GET https://api.semantius.cloud/organization/<org>` → `postgrest_url`, `id` (tenantId),
      `client_id_cli`; `discoveryUrl = https://<org>.semantius.cloud/.well-known/openid-configuration`
      (A2 repoints it at `/.well-known/oauth-protected-resource`, Step 5);
      `tokenExchange = POST https://<org>.semantius.cloud/token`; `apiBaseUrl = https://<org>.semantius.ai`;
      `uiBaseUrl = https://<org>.semantius.app`. **Self-hosted** (any other host): no network:
      `postgrestUrl = {host}/rest`, `discoveryUrl = {host}/.well-known/openid-configuration`,
      `tokenExchange = GET {host}/api/auth/token`, `clientId` = the fixed self-hosted constant
      (`SELF_HOSTED_CLIENT_ID` in `src/host.ts`, a placeholder: `null`, `login` refuses on
      self-hosted; A3 / Step 5c replaces it and the discovery URL per Martin's spec), `apiBaseUrl = {host}/api`, `uiBaseUrl = {host}`, `org = null`.
- [x] Cloud only: cache the control-plane record as JSON at `<user config dir>/hosts/<host>.json`
      with `:` and `/` in `<host>` replaced by `_` (Windows), mode 0600, 24 h TTL, no secrets.
      Extend `--reset-jwt-cache` to also delete it and add `--reset-cache` as the preferred spelling
      (both in `--help`). Self-hosted needs no cache.
- [x] Org propagation: after resolution in cloud mode set `process.env[`${PREFIX}_ORG`] = org`
      (flag wins over `.env`), because `getDefaultConfig()` still interpolates `${PREFIX}_ORG` into
      the `cube` URL and the internal remote-crud URL. Note: an `org:`-prefixed API key hoisted by
      `normalizeCredentialEnv` that disagrees with `--host` yields a 401 from the token endpoint;
      document, do not special-case.
- [x] Relaxed startup gate: `checkRequiredEnvVars` (in `src/index.ts`) and
      `getMissingRequiredEnvVars` (`src/config.ts`) currently require `${PREFIX}_ORG` and (`_API_KEY`
      or `_JWT`) and exit 5. New rule: a host must be resolvable (org, `--host`, `${PREFIX}_HOST`);
      credentials are checked later by Step 3b (`NoCredentialsError`). Also extend
      `normalizeCredentialEnv` to backfill `${PREFIX}_API_KEY=''` whenever it is undefined (not only
      in JWT-only mode), otherwise strict `${VAR}` substitution in the default config throws
      `MISSING_ENV_VAR` for OAuth-only sessions. Update `getRequiredEnvVarNames`, the `--help` env
      list and the missing-var message (which now says "set SEMANTIUS_ORG or --host").
- [x] Config shape for the local layer in `mcp_servers.json` (implementer default): `{ "postgrest":
      true }` (resolve from host) or `{ "postgrest": "https://…/rest" }` (explicit PostgREST base
      URL); `isPostgrestServer()` guard in `config.ts`; validation: `postgrest` must be `true` or an
      `https?://` URL, not combinable with `url`/`command`. After resolution the config object
      carries the resolved URL (`{ postgrest: 'https://…' }`) so `formatServerDetails` can print it.
- [x] `getDefaultConfig()`: `crud: { postgrest: true }`, `cube` unchanged (cloud) / absent
      (self-hosted). The remote crud MCP config (`https://<org>.semantius.ai/mcp`, headers
      `x-api-key: ${PREFIX}_API_KEY`) is still built internally under the constant name
      `REMOTE_CRUD_MCP` (not user-visible) for the cache-reset call and `--crud-mcp`.
- [x] Explicit `mcp_servers.json` `crud` entry with `url`/`command` keeps today's behaviour; the
      local layer applies only to `{ postgrest: … }` entries and the default config (Q34).
- [x] `--crud-mcp` flag + `${PREFIX}_CRUD_MCP=1` (same precedence as `--host`): `crud` resolves to
      `REMOTE_CRUD_MCP` for this invocation. Self-hosted → exit 1, text
      `Error [NOT_AVAILABLE]: --crud-mcp needs the Semantius cloud MCP server; self-hosted instances have none`.
      `info crud` prints `Transport: postgrest` / `Transport: HTTP` accordingly (existing label for
      HTTP). Daemon applies to the MCP route as before.
- [x] Self-hosted: `semantius call cube …` / `info cube` → exit 1
      `Error [NOT_AVAILABLE]: the cube (analytics) server is not available on self-hosted instances`.
- Done when: `tests/host.test.ts` (fetch stubbed) covers: `--host` beats `${PREFIX}_HOST` beats
  `.env` beats org default; cloud record parsed (`postgrest_url`, `id`, `client_id_cli`); cache hit
  (no fetch), TTL expiry, reset flag; control-plane failure message
  `Error [HOST_RESOLUTION_FAILED]: …`; self-hosted facts for `--host https://x.example.com`; org
  propagation; relaxed gate (no credentials → passes the gate, fails later in 3b); `--crud-mcp` and
  `cube` self-hosted errors.

## 3b. Token source for the local layer — `src/auth/token.ts` (API key and static JWT; OAuth in Step 5) — ✅ done (`929d071`, per-host cache + `API_KEY_REJECTED` in `64ea99b`)

Step 4 needs a bearer without the MCP server; today that exists only inside `transformConfigWithJwt`
for HTTP configs.

- [x] `getAccessToken(host: HostFacts, opts?: { forceRefresh?: boolean }): Promise<string>`, order
      (P12 minus OAuth for now): `${PREFIX}_JWT` → `${PREFIX}_API_KEY` → (Step 5 inserts the OAuth
      session here) → throw `NoCredentialsError` with message
      `Authentication required: no credentials for <host>. Set SEMANTIUS_API_KEY or run "semantius login".`
      (the phrase "Authentication required" is what `isAuthErrorMessage()` matches, so the existing
      connect-error path exits 5; additionally add an `instanceof NoCredentialsError` branch in
      `call.ts` and `identity.ts` that exits `ErrorCode.AUTH_ERROR` without the connection-failed wrapper).
- [x] API-key exchange without Deno, two shapes behind one function: cloud `POST <tokenExchange.url>`
      (body `grant_type=client_credentials`, header `x-api-key`, form-encoded) — the request the Deno
      server's `apiKeyAuth.ts` makes; self-hosted `GET <tokenExchange.url>` (header `x-api-key`).
      Parse `access_token`; `expires` = JWT `exp − 10 s` (as upstream `get_cli_token`); persist with
      the existing `writeCachedToken`/`readCachedToken`/`deleteCachedToken` (`src/jwt-cache.ts`,
      unchanged); own in-process dedupe map in `token.ts` (the one in `client.ts` is private).
- [x] `forceRefresh`: `deleteCachedToken` then exchange again. With a static `${PREFIX}_JWT` there is
      nothing to refresh: `forceRefresh` is a no-op and callers must not retry (`withRetries` has the
      same rule).
- [x] The MCP path (`transformConfigWithJwt`/`resolveJwt`) is **not** changed in A1.
- Done when: `tests/token.test.ts` (fetch stubbed): JWT wins over API key; cache hit → no fetch;
  cache miss → one fetch then cached; `forceRefresh` → delete + fetch; self-hosted GET shape; no
  credentials → `NoCredentialsError`; and `bun run dev call crud getCurrentUser '{}'` works with
  only `SEMANTIUS_API_KEY`/`SEMANTIUS_ORG` set (that call goes through Step 4, so run it after Step 4).

## 4. Local crud server — `src/local-tools/crud/` — ✅ done (`8ac5703`, readable errors in `64ea99b`)

- [x] `registry.ts`: `createCrudServer(getContext: () => ToolContext): McpServer` — name `crud`,
      `instructions` = vendored `instructions` with `${slug}` → `org` (no-op today); for each entry
      of the vendored `registry.ts` call `server.registerTool(tool.name, tool.options, (input) =>
      tool.handler(input, getContext()))`. The SDK's `ToolCallback` is `(args, extra)`; `extra` is
      ignored (over `InMemoryTransport` it carries no auth/request info) — upstream ignores it too.
      Exclude `sendEmail`, `get_cli_token`, `get_cli_config` on self-hosted (they assume the cloud
      token endpoint/org); on cloud register all.
- [x] `context.ts`: `ToolContext = { authInfo: { token, apiBaseUrl }, request: { method: 'POST',
      url, headers, query: {} } }` (upstream `RequestContext.request` requires `method` and `query`).
      Cloud: `url = https://<org>.semantius.ai/mcp`, `headers = { host: '<org>.semantius.ai', 'x-api-key':
      <only when the API-key path is active> }` (lowercase keys — that is how `getCurrentUser`,
      `get_cli_config`, `sendEmail`, `get_cli_token` derive the slug and `api_baseurl`). Self-hosted:
      `url = <apiBaseUrl>/mcp`, `headers = { host: <host name> }`; `getCurrentUser` then yields
      `api_baseurl = <apiBaseUrl>`, `semantius_org = <host name>` — post-process the result to set
      `semantius_org = null` and `ui_baseurl = <uiBaseUrl>` (Q29) in `connection.ts`, not in the
      vendored code. A **context holder** (`let current: ToolContext`) is set by `connection.ts`
      before each call and updated by `retry.ts` after a token refresh; the wrapper reads it per call.
- [x] `stdout hygiene` (sanctioned shim): vendored `src/utils/postgrest.ts` line 67 and
      `refreshSchemaCache.ts` line 16 `console.log(...)` on every request — on Deno that is a server
      log, in-process it would corrupt stdout. For the lifetime of a crud call (and in `--stream`),
      `connection.ts` swaps `globalThis.console.log` for a function that forwards to `debug()`
      (stderr, only under `SEMANTIUS_DEBUG`) and restores it in `finally`. Test: stdout of a call
      contains only the tool result.
- [x] `env guard` (sanctioned shim): vendored `getHeaders`/`makePostgrestRequest`/`getCurrentUser`
      read `API_KEY`, `SUPABASE_ANON_KEY`, `API_BASE_URL`, `SUPABASE_URL` from the environment; an
      unrelated `API_KEY` in a developer's shell would be sent to PostgREST as `apikey`. For the
      lifetime of a crud call `connection.ts` deletes those four names from `process.env` and
      restores them in `finally`. Test: with `API_KEY=leak` set, the captured request has no `apikey`.
- [x] `resetSchemaCache.ts` replacement (path in Step 2), signature
      `resetSchemaCache(host, token)`: cloud → `connectToServer('crud-mcp', REMOTE_CRUD_MCP with
      headers { Authorization: 'Bearer ' + token })` (import `../../../../client.js`; no daemon, no
      `transformConfigWithJwt`), `callTool('refresh_schema_cache', {})`, close; self-hosted → return
      `null` without registering anything. Six of the seven upstream callers fire-and-forget
      (`.catch(() => {})`); only `refresh_schema_cache` awaits. Register every in-flight promise in a
      module-level set and export `drainPendingSideEffects(timeoutMs = 10_000)` (env
      `${PREFIX}_SIDE_EFFECT_TIMEOUT` in seconds). `call.ts` awaits it before **every** `process.exit`
      it performs, including the ones inside `handleSingleResult` (wrap the command body in
      `try/finally`). Under `SEMANTIUS_DEBUG` log `[semantius] resetSchemaCache: refresh_schema_cache ok|failed: <msg>`.
- [x] `connection.ts`: `createCrudConnection(serverName, config, hostFacts): Promise<McpConnection>`
      — copy of `local-tools/connection.ts` plus: token via `getAccessToken(hostFacts)`, context
      holder, stdout hygiene, env guard, `client.callTool({ name, arguments }, undefined,
      { timeout: getTimeoutMs() })` (the utils copy uses the SDK default of 60 s — too short for bulk
      calls), `timeMcp` around the call (`src/logger.ts`), `recordUrl(postgrestUrl)`, result
      post-processing (self-hosted `getCurrentUser` fields; strip `request.headers.authorization`
      from the `postgrestRequest` envelope, Q15). No automatic fallback to MCP (Q14); on cloud the
      connection-failed message ends with `(try --crud-mcp)`.
- [x] `retry.ts`: export `classifyRetry`, `retryableErrorFromResult`, `jitter`,
      `TRANSIENT_RETRY_DELAYS_MS`, `JWT_RETRY_DELAYS_MS` from `src/client.ts` (pure, no behaviour
      change) and implement `withLocalRetries(op, { refresh })` with the same schedule and
      `logRetryEvent` calls; `'jwt'` → `getAccessToken(host, { forceRefresh: true })`, update the
      context holder, re-run; `'transient'` → re-run; static `${PREFIX}_JWT` → never retry `'jwt'`.
      Test with a handler failing once with a JWT-looking error, once with a 429-looking error, once
      non-retryable.
- [x] `client.ts::getConnection`: short-circuit `isPostgrestServer(config)` right after the
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

## 4b. `--stream` raw path — `src/local-tools/crud/stream.ts` (D15) — ✅ done (`5dc6288`)

- [x] `--stream` flag (+ `${PREFIX}_STREAM=1`) valid only for `call crud postgrestRequest`. There is
      nothing reusable in the vendored code (`getHeaders` is private, `makePostgrestRequest` parses
      the body): duplicate the request construction — `URL = postgrestUrl + path`, method, body
      (`JSON.stringify` unless string), headers `content-type: application/json`,
      `prefer: return=representation`, `accept` if given, `authorization: Bearer <token>`, no
      `apikey` — and prove equality in `tests/stream.test.ts` by stubbing `fetch`, running the
      vendored `postgrestRequestTool.handler` and the stream builder with the same args, and
      comparing captured method/URL/headers/body.
- [x] Pipe `response.body` to stdout unchanged (compact JSON, or CSV when `accept: text/csv`).
- [x] Errors: non-2xx → read the body and print `Error: (<code>) <message>` (same text shape as
      `makePostgrestRequest`) to stderr; exit codes: 401/403 → 5, 5xx or network → 3, other non-2xx
      → 4. Retry via `withLocalRetries`.
- [x] Reject with exit 1 and a one-line message: `--stream` with `--single`, `--diag`, `--crud-mcp`,
      or any tool other than `postgrestRequest`. Stdin JSON args work as usual.
- [x] Docs: output is compact, may be CSV; `jq` consumers keep working, pretty-diff consumers do not.
- Done when: `bun run dev call crud postgrestRequest --stream '{"method":"GET","path":"/order_details?limit=10000"}' | wc -c`
  equals the PostgREST body size (compare with a direct `fetch` in the test); CSV passthrough;
  equality test; rejected combinations; exit-code table. Bench re-run with a `stream` path is
  Martin's (needs `semantius-bench.exe` built from the branch).

## 5. OAuth login, cloud hosts — `src/auth/` (Phase A2) — ✅ done (uncommitted at the time of writing)

**As built (2026-09-11), deviations and decisions taken:**
- `--auth apikey|jwt` **with `--host` is rejected** (exit 1, `INVALID_OPTION`), and so is
  `--login --auth jwt|apikey`. Implementer default, Martin's call still open: it keeps §0's rule
  intact (with `--host` only stored credentials count), and `--auth oauth` remains valid there.
- `HostFacts.discoveryUrl` is now the RFC 9728 URL; the discovered endpoints live in the host cache
  entry under `oauth`, keeping the entry's original `fetched_at` (caching endpoints must not extend
  the control-plane record's TTL).
- cli-auth has no `forceRefresh`: `getSessionToken({ forceRefresh })` expires the stored access
  tokens (`expireStoredAccessTokens`) and lets cli-auth spend the refresh token; `clear()` would
  have dropped the refresh token too.
- New errors: `LoginUnavailableError` / `LoginFailedError` (exit 1) in `session.ts`;
  `SessionExpiredError` in `token.ts` (a cli-auth refresh failure → "Authentication required", exit 5,
  never retried). `getUsedCredentialSource()` records which source produced the bearer (whoami).
- Test seams (no monkey-patching): `setSecretsForTests()` in `storage.ts`, and `login(host, { openUrl })`
  so the mock-provider test drives the browser step itself.
- The file fallback is per host: `<user config dir>/sessions/<prefix>_<host>/credentials.json`
  (cli-auth's `fileStorage` writes a fixed `credentials.json`, so one dir per session is required);
  the lock file sits next to it and its directory is created lazily.
- `transformConfigWithJwt`'s env-JWT branch already gated on header-key presence (A1); A2 added the
  session branch for an empty `x-api-key` and falls through to the unchanged config when there is no
  session, so a 401 still reads as before.
- **Not done:** the daemon-interplay test below (no A2 code touches the daemon; its config hash
  already includes the bearer). `tests/auth.test.ts` was added to `.github/workflows/release.yml`.

**Found in Martin's first real login against `cli1-bb82` (2026-09-11) and fixed:**
- **The token needs an RFC 8707 resource indicator.** Without one the tenant mints
  `aud = [<host>/mcp, …/oauth2/userinfo]` and its PostgREST answers HTTP 400 "required audience not
  found". Measured on `cli1-bb82`: baseline → 400; `resource=tenant://<tenant id>` →
  `aud = [tenant://<tenant id>, …/userinfo]` → **200**; `resource=<postgrest url>` → `invalid_request`.
  So `tenant://<tenantId>` (the audience the API-key JWTs already carry) is passed as cli-auth's
  `resource` **and on every `getToken()`**: cli-auth keys its token cache by the per-call options, not
  by the config default, so a config-only indicator kept serving the cached wrong-audience token.
  `tests` accepts both audiences, which is why R §9.1 saw no failure there.
- **Windows Credential Manager rejects credentials over 2560 bytes** ("The stub received bad data",
  1783) and the whole session then lands in the file fallback. The stored set was 2859 bytes: an
  unused 617-byte `id_token` plus two access tokens. `storage.ts` now prunes the `id_token` and
  expired entries before saving (~1.1 kB), `clear()` empties the keyring *and* the file, and `load()`
  falls back to a file written by an earlier run.
- **The browser opened a truncated URL on Windows:** `cmd /c start` splits its command line at the
  first unquoted `&`, so only `…/authorize?response_type=code` was opened (`VALIDATION_ERROR`,
  client_id missing). Now `rundll32 url.dll,FileProtocolHandler <url>`, which takes the URL as one
  argument.

**Scope: cloud hosts only.** Every input of the flow comes from what Step 3 already resolves; no new
configuration. Worked example, `semantius login --host cli1-bb82.semantius.app`:

1. `normalizeHost` maps `.app` → `cli1-bb82.semantius.cloud`: cloud mode, org `cli1-bb82`.
2. **Client id:** `resolveHost()` → `GET https://api.semantius.cloud/organization/cli1-bb82`
   (unauthenticated, cached 24 h in `<config dir>/hosts/cli1-bb82.semantius.cloud.json`) →
   `client_id_cli` (`HostFacts.clientId`), plus `id` and `postgrest_url`. The client id is in no
   discovery document; the control plane is its only source.
3. **Resource metadata (RFC 9728):** `GET https://cli1-bb82.semantius.cloud/.well-known/oauth-protected-resource`
   → `authorization_servers[0]` = issuer `https://cli1-bb82.semantius.cloud/api/auth`,
   `scopes_supported` = `["tenant:<id>:user"]`.
4. **Authorization-server metadata (RFC 8414, path-suffix form of that issuer):**
   `GET https://cli1-bb82.semantius.cloud/.well-known/oauth-authorization-server/api/auth` →
   authorize `…/api/auth/oauth2/authorize`, token `…/token`, revoke `…/api/auth/oauth2/revoke`.
5. cli-auth PKCE (S256), scope `openid profile email offline_access` + step 3's `scopes_supported`,
   redirect `http://127.0.0.1:<first free of 53682–53684>/callback`: browser → callback → code →
   token set, stored under `SEMANTIUS:cli1-bb82.semantius.cloud`.

This is the chain MCP clients use against the same server (Martin, 2026-09-11). Checked the same day
for `tests` and `cli1-bb82`, public endpoints only: all six documents answer 200 —
`oauth-protected-resource` (and `/mcp`, identical), `oauth-authorization-server` (and `/api/auth`,
identical), `openid-configuration`, `jwks.json` (one Ed25519 key); the RFC 8414 and OIDC documents
have identical keys and values; issuer = `authorization_servers[0]`; the resource's
`scopes_supported` equals `tenant:<control-plane id>:user`; `S256`, `refresh_token` grant,
`none` client auth; `client_id_cli` present on the control plane, absent from all discovery
documents. Only a browser login proves the server grants the tenant scope to this org's CLI client
— on `tests` the first runs failed with `invalid_scope` / `Client has no tenant scope` until the
server was fixed.

**A2 notes — what A1 left for this step (read before the checklist):**
- **Storage key:** the host is now a bare `hostname[:port]` (`getHost()`, `HostFacts.host`), so the
  `Bun.secrets` name is `<env prefix>:<host>`, e.g. `SEMANTIUS:tests.semantius.cloud`.
- **Credential order** is split by §0 "Credentials belong to their host":
  - without `--host`: `--auth` → `${PREFIX}_JWT` → `${PREFIX}_API_KEY` → stored session for
    (prefix, host) → `NoCredentialsError`;
  - with `--host`: `--auth` → stored session for (prefix, `--host`) → `NoCredentialsError`
    (the environment's JWT / API key / org are already blanked by `ignoreEnvCredentials()` in
    `index.ts`, and `getCredentialSource()` returns null for them).
  Insert the session lookup where `getAccessToken` says "Step 5 (OAuth) looks up the session stored
  for this host here", and add `'oauth'` to `CredentialSource` (the `whoami` `auth_method` reads it).
  Decide with Martin whether `--auth apikey|jwt` may override the `--host` rule (it would reopen it).
- **Messages that already point at login:** both `NoCredentialsError` texts (`src/auth/token.ts`)
  name `semantius login` / `semantius login --host <host>`; keep them in sync with the real commands.
  `login` / `logout` take `--host`; without it they act on the environment's host.
- **MCP route** (`cube`, `--crud-mcp`): with `--host`, the config templates' `x-api-key` is `''`
  (blanked), so the planned gate change ("header key present" + bearer from `getAccessToken`) is
  what makes `cube` work with a stored session — and it also fixes open finding 2 (cube on a cold
  JWT cache).
- **Credential errors** go through `isCredentialError()` (`src/auth/token.ts`): printed as-is, exit 5,
  never retried by `withLocalRetries`. A refresh-token failure should become one of them.
- **Tests:** the pattern for hermetic end-to-end tests is a local `Bun.serve` stub on `127.0.0.1`
  configured as the *environment's* host (`SEMANTIUS_HOST=127.0.0.1:<port>` + a credential), see
  `tests/stream.test.ts` / the local block of `tests/cli-errors.test.ts`. `--host` in such tests
  now means "stored credentials only". But a `127.0.0.1` host is self-hosted, where A2's `login`
  refuses: test the cloud login in-process with hand-built cloud `HostFacts` (`clientId` set,
  `discoveryUrl` on the mock provider's `Bun.serve` stub, whose documents name stub endpoints); the
  `clientId === null` refetch case stubs `fetch` for the control plane.
- **Docs deferred from Step 6:** `login` / `logout`, `--auth`, `--login`, and the third credential
  method in `--help`, README and `skills/use-semantius/references/cli-usage.md`.

- [x] Add `cli-auth` **pinned exactly** (`"cli-auth": "0.1.0-beta.0"`, no caret; do not vendor —
      vendor only if upstream is abandoned or unfixable; MIT, zero runtime deps). Raise
      `engines.bun` to `>=1.3` (`Bun.secrets` and cli-auth's README requirement). `@types/bun`
      1.3.5 already declares `Bun.secrets`.
- [x] `src/auth/storage.ts`: `createSecretStorage(name: string, secrets = Bun.secrets): Storage<TokenSet>`
      implementing cli-auth's contract exactly (`load(): Promise<TokenSet | undefined>`,
      `save(credential)`, `clear()`, optional `lock()`), over `secrets.get/set/delete({ service:
      'semantius', name })`, JSON-serialising the `TokenSet`. `name = <env prefix>:<host>`. Probe
      once at first use; on failure (headless Linux: "libsecret not available") delegate every call
      to cli-auth's `fileStorage({ dir: getUserConfigDir() })` and print one stderr line
      `[semantius] no OS keyring available; storing the session in <dir>`. Wrap with
      `fileLock({ lockPath: join(getUserConfigDir(), name + '.lock') })` (check the exact `fileLock`
      signature in the pinned package). Never `/tmp`; never swallow save errors. Tests inject a fake
      `secrets` object — never monkey-patch the `Bun` global (the Windows CI runner has a real store).
- [x] `src/auth/provider.ts`: discovery as in steps 3–4 of the worked example (cli-auth has none;
      pass explicit `provider.metadata = { authorizationEndpoint, tokenEndpoint, revocationEndpoint }`).
      `HostFacts.discoveryUrl` (cloud) becomes the RFC 9728 URL
      `https://<org>.semantius.cloud/.well-known/oauth-protected-resource`, the start of the chain;
      the RFC 8414 URL is derived from `authorization_servers[0]` (`<origin>/.well-known/oauth-authorization-server<path>`).
      Cache the result (issuer, three endpoints, resource scopes) in the host cache entry — same file,
      same 24 h TTL, cleared by `--reset-cache` — fetched lazily, only when the OAuth source is used:
      every call with a session may refresh and needs `tokenEndpoint`; API-key / JWT calls fetch
      nothing new. Non-200, non-JSON or a missing field → `HostResolutionError` naming the URL. No
      fallbacks to the root or OIDC variants, and no issuer checks in A2 — neither the metadata's
      `issuer` against `authorization_servers[0]` nor the callback's (Step 5b adds both).
- [x] Scope and claims (verified 2026-09-11): request `openid profile email offline_access` plus the
      resource's `scopes_supported` (today exactly `tenant:<tenantId>:user`) — taken from the server,
      not assembled from `tenantId`. No `resource` parameter (RFC 8707): the verified login sent none
      and the token's `aud` already contains `…/mcp`. The access token carries
      `tid = <tenantId>`, `role = authenticated`, `aud = ["https://<org>.semantius.cloud/mcp",
      "…/api/auth/oauth2/userinfo"]` (not `tenant://…` like the API-key JWT) and PostgREST accepts
      it. The callback's `iss` is `https://app.semantius.com/api/auth` while discovery says
      `https://<org>.semantius.cloud/api/auth`: cli-auth does not validate `iss`; **do not add an
      `iss` check in A2** (reported upstream; Step 5b / A2b adds it after the server fix).
- [x] Callback: cli-auth builds `redirect_uri = http://127.0.0.1:<port>/callback` (path default
      `/callback`, host hard-coded). Registered for `client_id_cli`: ports 53682, 53683, 53684. Pick
      the first free one (probe with `Bun.listen` on `127.0.0.1`, close, pass as `callbackPort`); all
      busy → exit 1 `Error [LOGIN_FAILED]: ports 53682-53684 are in use`. Login timeout 5 min.
- [x] Commands: add `login` and `logout` to `SUBCOMMANDS` and to the `ParsedArgs.command` union in
      `src/index.ts` (today `semantius login` parses as `info login`). `semantius login [--host]
      [--env]`: `createCliAuth({ strategy: 'authorization-code', provider, clientId:
      hostFacts.clientId, storage, scope, callbackPort })`, `login({ onAuthorization(url) })` → print
      the URL and open the browser (`cmd /c start ""` / `open` / `xdg-open`, ignore failures);
      `semantius logout` → `auth.logout()` (best-effort revoke + `clear`). Self-hosted (any
      `clientId`) → exit 1 `Error [NOT_AVAILABLE]: OAuth login is not configured for self-hosted
      instances yet` (A3 lifts this). Cloud with `clientId === null` → refetch the control-plane
      record once, bypassing the 24 h cache (it may predate `client_id_cli`); still null → exit 1
      `Error [NOT_AVAILABLE]: OAuth login is not enabled for <org> (no CLI client on the control plane)`.
- [x] Flags: `--auth jwt|apikey|oauth` forces one source for this invocation; `--login` runs the
      browser flow first, then uses that session for this invocation even if a JWT/API key is set;
      `--login` with `!process.stdin.isTTY` → exit 1 `Error [LOGIN_FAILED]: --login needs an
      interactive terminal`. Never open a browser implicitly: no credentials → `NoCredentialsError`
      (Step 3b), exit 5.
- [x] `getAccessToken` gains the OAuth source: `--auth` → `${PREFIX}_JWT` → `${PREFIX}_API_KEY` →
      stored session for (prefix, host) via `auth.getToken()` (auto-refresh 300 s before expiry;
      `forceRefresh` → `getToken({ forceRefresh })` or clear+refresh per cli-auth's API) → error.
      **With `--host` (see §0 "Credentials belong to their host"):** the environment's JWT and API
      key are skipped (`getCredentialSource()` already returns null), so the order is `--auth` →
      stored session for (prefix, `--host`) → `NoCredentialsError` ("Run semantius login --host …").
- [x] MCP route with an OAuth-only session (`cube`, `--crud-mcp`): `transformConfigWithJwt` currently
      returns early when `config.headers['x-api-key']` is falsy (`''`). Change the gate to "the
      `x-api-key` header **key** is present" and obtain the bearer from `getAccessToken` (this is
      the one A2 change to the MCP path; the API-key behaviour stays identical).
- [x] `whoami` shows `auth_method: jwt|apikey|oauth` and, for oauth, the session expiry; `--diag`
      still shows the bearer in use.
- [ ] Daemon interplay (NOT done, see "As built"): the daemon config hash includes the bearer, so a refreshed token restarts
      the daemon (about hourly). Test: two calls with the same token → one `daemon_start`; a call
      after a forced refresh → exactly one more.
- Done when: `tests/auth.test.ts` green — storage adapter with a fake `secrets` and forced file
  fallback; PKCE `login` against a mock provider on a local `Bun.serve` (authorize redirect →
  loopback callback → token), refresh before expiry, `logout` clears; precedence incl. `--auth` and
  `--login`; non-TTY `--login`; the `transformConfigWithJwt` gate; self-hosted refusal; cloud
  `clientId === null` refetch + refusal. Then **stop** (§10): the real `semantius login` against
  `tests` / `cli1-bb82` is Martin's.

## 5b. Issuer checks (Phase A2b) — ✅ done

- [x] Server (Martin's team, deployed 2026-09-12): the login callback now carries the tenant's own
      issuer. Verified on `cli1-bb82`: callback `iss`, the AS metadata `issuer`,
      `authorization_servers[0]` and the access token's `iss` claim are all
      `https://cli1-bb82.semantius.cloud/api/auth` and compare equal as plain strings. Before the
      fix the callback said `https://app.semantius.com/api/auth`; the tenant host's own error
      responses already said the tenant issuer, which is how the app leg was identified as the
      source.
- [x] Metadata check (`provider.ts`): the RFC 8414 document must declare the issuer it was fetched
      for (`authorization_servers[0]` of the RFC 9728 document), else `HostResolutionError` naming
      both values. This is what binds a resource to an authorization server it cannot forge.
- [x] Callback check (`session.ts`, `issuerMismatch()`): RFC 9207 plain-string comparison of the
      callback's `iss` against that issuer; a **missing** `iss` fails only when the metadata sets
      `authorization_response_iss_parameter_supported` (now a field of `OAuthMetadata`, so a cached
      entry without it is refetched). A failure renders the browser's failure page, clears the
      session the exchange just stored — cli-auth decides success on its own and has already
      redeemed the code — and exits 1 with `Error [LOGIN_FAILED]: …`.
- [x] No upstream patch needed: cli-auth's `callbackSource` hands over the raw callback URL.
      `SEMANTIUS_DEBUG=1` logs the observed `iss` and the verdict, which is how a deploy is checked.
- [x] `tests/auth.test.ts`: metadata declaring another issuer, a callback naming another issuer
      (nothing stored), a missing `iss` while advertised, and a missing `iss` while not advertised
      (accepted). Each case uses its own host name — discovery is memoized per host.
- **Issuer rules for A3 (binding, self-hosted login):** the same two checks apply unchanged and must
  not be relaxed — they matter *more* there, because an arbitrary host serves its own metadata and
  can point `authorization_endpoint` at a cloud org while keeping its own `token_endpoint` (PKCE
  does not prevent it: the verifier goes to the same endpoint). Concretely, A3 must (a) keep
  deriving the RFC 8414 URL from `authorization_servers[0]` rather than from the host, so an issuer
  can only be claimed by whoever serves its metadata; (b) keep the callback comparison exact — no
  host-based aliases, no "same registrable domain" shortcuts; (c) treat a self-hosted server that
  omits `iss` as acceptable only when its metadata does not advertise the parameter, exactly as
  here. If Martin's self-hosted spec obtains the client id from the host itself, note that a
  malicious host then supplies both the client id and the metadata, which leaves these checks as
  the only thing tying the login to the host the user typed.

## 5c. OAuth login, self-hosted (Phase A3) — ✅ implemented; the real login waits on the server

**Measured against Martin's instance `http://localhost:3000` on 2026-09-12** (read-only probes; the
CLI was not changed). Its layout: the common documents live at the host root, the IdP's own URLs
under `/idp/`.

| | |
|---|---|
| Issuer | `http://localhost:3000/idp` |
| RFC 8414 metadata | `/.well-known/oauth-authorization-server` **and** `/.well-known/oauth-authorization-server/idp` (the §3.1 form for that issuer) and `/idp/.well-known/{oauth-authorization-server,openid-configuration}` — identical |
| OIDC / JWKS | `/.well-known/openid-configuration`, `/.well-known/jwks.json` (ES256) |
| Endpoints | authorize `/idp/oauth2/authorize`, token `/idp/oauth2/token`, revoke `/idp/oauth2/revoke` |
| Flags | `code_challenge_methods_supported: ["S256"]`, `authorization_response_iss_parameter_supported: true`, **no** `resource_indicators_supported` |
| Scopes | `openid profile email offline_access` — no tenant scope |
| PostgREST | `/rest/` (swagger readable unauthenticated; `/rest` 308s to `/rest/`) |
| CLI client (Martin's registration) | `clientId: "semantius-cli"`, type `native`, redirect URIs `http://127.0.0.1:{53682,53683,53684}/callback`; the idp ignores the port for loopback per RFC 8252 §7.3 |

**Server prerequisite — one missing document.** `/.well-known/oauth-protected-resource` is 404 in
every variant (root, `/rest`, `/mcp`, under `/idp`), and the CLI's chain starts there. With it, the
**existing** chain works unchanged — verified by serving only that document from a local stub
pointing at the real IdP and running `getOAuthMetadata()`: issuer, the three endpoints and
`issParameterSupported: true` resolved, and the A2b metadata check passed because the instance also
serves `/.well-known/oauth-authorization-server/idp` with the matching `issuer`. So **no self-hosted
discovery branch is needed**; do not add one. The document:

```json
GET /.well-known/oauth-protected-resource
{
  "resource": "http://localhost:3000/rest",
  "authorization_servers": ["http://localhost:3000/idp"],
  "scopes_supported": [],
  "bearer_methods_supported": ["header"]
}
```

`authorization_servers[0]` must equal the IdP's `issuer` byte-for-byte; `scopes_supported` is
appended to the base scopes (empty while `/rest` needs none). The `/rest` path-suffix variant is
optional (cloud serves root + `/mcp`).

- [x] `SELF_HOSTED_CLIENT_ID = 'semantius-cli'` in `src/host.ts` (replaces `null`). Kept typed
      `string | null` so the no-client-id branch below stays reachable.
- [x] Drop the self-hosted refusal in `requireLoginableHost()` (`src/auth/session.ts`, the
      `host.mode === 'selfhosted'` branch) so self-hosted takes the same path as cloud, and make the
      `clientId === null` fallback below it mode-aware: the control-plane refetch and its "no CLI
      client on the control plane" text are cloud-only. The `clientId` test now comes first, and a
      self-hosted host without one exits 1 with `Error [NOT_AVAILABLE]: OAuth login is not
      configured for <host> (no CLI client id)` (implementer's wording — the plan fixes no text for
      this case); no refetch, since a self-hosted client id is fixed and there is no control plane.
- [x] Nothing else in the flow changes: storage, `getAccessToken`'s session lookup, `--auth` /
      `--login`, `logout`, the callback port probe and the issuer checks are host-agnostic.
      `resourceIndicator()` already returns undefined when `tenantId` is null, which is right here
      (the server advertises no resource indicators).
- [x] **Do not relax the issuer checks** (Step 5b's "Issuer rules for A3" is binding): derive the
      RFC 8414 URL from `authorization_servers[0]`, compare the callback `iss` exactly, and treat a
      missing `iss` as a failure whenever the metadata advertises the parameter — this one does.
      Untouched; a new self-hosted case pins that they still fire.
- [x] Docs that still say cloud-only: the `--help` credentials block, the README "Browser login"
      section's last line, and `skills/use-semantius/references/cli-usage.md`. The README's last
      line now names the two server prerequisites (the RFC 9728 document and a registered
      `semantius-cli` client) instead of refusing self-hosted.
- [x] `tests/auth.test.ts`: a self-hosted case (hand-built `HostFacts` with `mode: 'selfhosted'` and
      a client id) proving `login` is allowed, that no `resource` is sent, and that the issuer checks
      still apply; keep a case for a self-hosted host whose `clientId` is null. Three cases replace
      "self-hosted hosts refuse to log in"; `tests/host.test.ts` expects the fixed client id on
      self-hosted facts. The cloud "no CLI client" case had to change as well: its refetch calls
      `resolveHost()`, which in that suite resolves the loopback provider — now a self-hosted host
      *with* a client id — so the test puts the invocation on `acme.semantius.cloud` and stubs only
      the control-plane URL, asserting it is called exactly once.
- **Open, answerable only with a real login against the instance** (Martin; still open, it needs the
  server document below): which `aud` the IdP mints and whether `/rest` validates it. There are no
  resource indicators here, so the CLI cannot ask for an audience. This may turn into a server
  change like the cloud's audience did.
- **Unrelated finding, for Phase B:** the self-hosted API-key exchange assumed in Step 3
  (`GET {host}/api/auth/token`) returns the SPA HTML on this build — that path is unverified and
  probably wrong.
- Done when: `bun run dev login --host localhost:3000` stores a session, `whoami --host
  localhost:3000` prints `auth_method oauth`, a `call crud` read works against `/rest`, `logout`
  clears it, `cube` / `--crud-mcp` still exit 1 `NOT_AVAILABLE`, and the gates
  (`bun run lint`, `bunx tsc --noEmit`, `bun test --timeout 60000`) are green. Then STOP.
- **Reached 2026-09-12 as far as the server allows.** Gates green (482 pass / 15 skip / 0 fail).
  `cube` and `--crud-mcp` on `--host localhost:3000` still exit 1 `NOT_AVAILABLE`, and `whoami
  --host localhost:3000` still exits 5 naming `semantius login --host localhost:3000`. The four
  login boxes are **blocked on the server prerequisite**: `/.well-known/oauth-protected-resource`
  is still 404 on `http://localhost:3000`, re-probed at the start of this session in every variant
  (root, `/rest`, `/mcp`, under `/idp` — all serve the SPA HTML). `login --host localhost:3000`
  now gets past the refusal and stops at `Error [HOST_RESOLUTION_FAILED]:
  http://localhost:3000/.well-known/oauth-protected-resource returned 404`, before any browser
  opens. The rest of the chain is ready, re-verified the same way as when the spec was written:
  serving only that document from a local stub (with `authorization_servers[0]` =
  `http://localhost:3000/idp`) and calling `getOAuthMetadata()` resolves the issuer, the three real
  endpoints, `issParameterSupported: true` and `resourceScopes: []` → scope `openid profile email
  offline_access`, with the A2b metadata check passing against the instance's own
  `/.well-known/oauth-authorization-server/idp`. That document is unchanged from the spec's
  measurements.

## 6. Commands, docs, skills — ✅ done (`3e16fd7`) except the `login`/`logout` docs (→ Step 5)

- [x] `--help` and README: three credential methods and their precedence; `--host` / `SEMANTIUS_HOST`;
      `--crud-mcp`; `--stream`; `--reset-cache`; `login`/`logout` (**→ Step 5**, commands do not exist yet); `ping` now measures PostgREST,
      not Deno. `skills/use-semantius/references/cli-usage.md` likewise (env var names must match
      `--help`). `CLAUDE.md`: add "vendored tree under `src/vendor/` is synced, never edited".
- [x] `semantius info crud` shows `Transport: postgrest` and the resolved URL (no token).
- [x] `tests/cli-errors.test.ts` extended for the local path: RLS denial → 4; `--single` 0 rows → 1;
      2+ rows → 2; invalid API key at exchange → 5; expired static `${PREFIX}_JWT` → 4 (unchanged
      today: the tool returns an `isError` result). Error text shape `Error: (CODE) message` preserved.
- [x] `info crud` / `-md` work offline through the local layer (instructions are vendored; keep the
      `-md` behaviour of `80810b3`).
- Done when: the extended `cli-errors` tests pass and `bun run dev -md` output is reviewed by the
  implementer for stray lines. Skill evals (need model runs) are Martin's, §10.

## 7. Rollout (Martin)

- [ ] Martin: release the daemon fix (`9ac9574`) as its own release first.
- [ ] Martin: review A1+A2 (§10), then A2b (issuer checks, server fix first), then A3 (self-hosted
      login, his spec), then Phase B, then release via `./scripts/release.sh` only.
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
| `tests/host.test.ts` (new) | all | Step 3 done-when list; bare host format, cloud-name mapping, loopback HTTP |
| `tests/token.test.ts` (new) | all | Step 3b done-when list; per-host cache, `API_KEY_REJECTED`, the `--host` credential rule |
| `tests/crud-local.test.ts` (new) | all | Step 4 done-when list; `console.error` shim, readable HTTP errors, no retry of rejected keys |
| `tests/stream.test.ts` (new) | all | Step 4b done-when list (real CLI against a local `Bun.serve` stub) |
| `tests/cli-errors.test.ts` (extended) | all | exit codes 1/2/4/5 and error shape through the local layer (local stub); `--host` never sends the environment's credentials |
| `tests/auth.test.ts` (new, A2; A2b and A3 extend) | all | Step 5 done-when list (cloud host facts); fake `secrets` only |
| `tests/integration/parity.test.ts` (new) | gated: `SEMANTIUS_PARITY=1` + creds | local vs `--crud-mcp`, five bench scenarios + scratch-entity write with cleanup (Step 4); `--stream` byte-identical to a direct fetch, CSV (Step 4b) |
| `bun run sync-mcp-tools:check` | `scripts/release.sh` only | vendored copy is current |
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

*Status: A1 stop reached 2026-09-11 (see the hand-over section); the list above is still open for
Martin.* Added after A1 for the post-A1 changes:

```
bun run dev whoami --host tests.semantius.app        # maps to tests.semantius.cloud; until A2: "no credentials stored for …", exit 5
bun run dev --env CLI1 whoami                        # second profile: CLI1_HOST + CLI1_API_KEY in .env
bun run dev call crud postgrestRequest '{"method":"GET","path":"/no_such_table"}'   # one error line, no vendored log noise
bun run dev --reset-cache info utils                 # lists the per-key and the per-host token entry + host cache
```

**A2 implementer stop.** *Reached 2026-09-11:* Step 5 implemented, `tests/auth.test.ts` green (20
tests against the mock provider), full suite 475 pass / 15 skip / 0 fail, `bun run lint` and
`bunx tsc --noEmit` clean; `semantius login` was NOT run (needs Martin's browser). Martin then runs:

```
bun run dev login
bun run dev whoami
bun run dev call crud getCurrentUser '{}'
bun run dev call cube discover '{}'
bun run dev --auth apikey whoami
bun run dev logout
bun run dev login --host cli1-bb82.semantius.app        # a second host keeps its own session
bun run dev whoami --host cli1-bb82.semantius.app
bun run dev --host cli1-bb82.semantius.app call crud getCurrentUser '{}'
bun run dev whoami                                      # still the environment's host and credential
bun run dev logout --host cli1-bb82.semantius.app
bun run dev login --host semantius.example.com          # self-hosted: NOT_AVAILABLE until A3, exit 1
```

**A2b implementer stop.** *Reached 2026-09-12:* both checks implemented, four cases in
`tests/auth.test.ts`, full suite 480 pass / 15 skip / 0 fail, and a real login against `cli1-bb82`
passes with the checks active. Martin's verification of any future auth deploy:

```
$env:SEMANTIUS_DEBUG=1; bun run dev login --host cli1-bb82.semantius.app
# expect: Login callback: success=true, iss=https://cli1-bb82.semantius.cloud/api/auth
# a mismatch prints "— rejected: …" and exits 1 (LOGIN_FAILED), storing nothing
```

**A3 implementer stop.** *Reached 2026-09-12, as far as the server allows:* Step 5c implemented
(fixed client id, refusal dropped, docs, tests), `bun run lint` and `bunx tsc --noEmit` clean, full
suite 482 pass / 15 skip / 0 fail. The browser login itself was NOT run — it cannot be: the
instance still 404s `/.well-known/oauth-protected-resource`, where the CLI's chain starts.

**Server first, then Martin's list.** Serve on `http://localhost:3000`:

```json
GET /.well-known/oauth-protected-resource
{
  "resource": "http://localhost:3000/rest",
  "authorization_servers": ["http://localhost:3000/idp"],
  "scopes_supported": [],
  "bearer_methods_supported": ["header"]
}
```

`authorization_servers[0]` must equal the IdP's `issuer` byte-for-byte (`http://localhost:3000/idp`);
anything else fails the A2b metadata check by design. Check it with
`curl http://localhost:3000/.well-known/oauth-protected-resource`, then:

```
bun run dev login --host localhost:3000                 # was NOT_AVAILABLE before A3
bun run dev whoami --host localhost:3000                # auth_method oauth + session expiry
bun run dev --host localhost:3000 call crud postgrestRequest '{"method":"GET","path":"/<a table>?limit=1"}'
bun run dev --host localhost:3000 call cube discover '{}'        # exit 1 NOT_AVAILABLE
bun run dev --host localhost:3000 --crud-mcp call crud getCurrentUser '{}'   # exit 1 NOT_AVAILABLE
bun run dev logout --host localhost:3000
$env:SEMANTIUS_DEBUG=1; bun run dev login --host localhost:3000  # prints the observed iss + verdict
```

The `call crud` line is the one that answers the open question: if the IdP mints an `aud` that
`/rest` rejects, it fails with "required audience not found" and the fix is server-side (the cloud
needed the same), because the instance advertises no resource indicators for the CLI to ask with.

Never in A1/A2/A2b/A3: releasing, version bumps, running `scripts/release.sh`, contacting a
self-hosted host.
