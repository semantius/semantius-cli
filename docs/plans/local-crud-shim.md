# Plan: bypass the crud MCP server with a local PostgREST shim

Status: record of analysis, measurements, verification and decisions. Sections 1–8 are the original
analysis (2026-09-10); decisions taken since are logged in sections 11–13 and supersede earlier
options where marked. The daemon fix (section 11) is committed on `main` as `9ac9574`, unreleased.
The actionable checklist is `local-crud-shim-implementation.md`.

Repos analysed (read-only):
- `C:\dev\semantius-cli` (Bun, compiled single binary, MCP client)
- `C:\dev\postgrest-mcp` (Hono + `@hono/mcp`, deployed on Deno Deploy as `https://<org>.semantius.ai/mcp`)

---

## 1. What happens today on `semantius call crud <tool>` 

```
CLI (bun binary)                     Deno Deploy (postgrest-mcp)             Semantius cloud
----------------------------------   -------------------------------------   ---------------------------
loadConfig / .env
JWT cache read (AES file in tmp)
  miss → MCP connect + get_cli_token  → POST https://<org>.semantius.cloud/token (x-api-key)
[POSIX only] daemon spawn/lookup
HTTP: POST /mcp initialize          → auth: Bearer passthrough (NOT verified)
HTTP: POST /mcp notifications/init  → resolveTenant(<org>) via
HTTP: GET  /mcp (SSE probe, 405)      GET https://api.semantius.cloud/organization/<org>  (cached per isolate)
HTTP: POST /mcp tools/call          → new McpServer() + register 54 tools (per request)
                                    → zod validate args
                                    → fetch <tenant.postgrest_url>/<path>  → PostgREST (semantius extension)
                                    ← response.json()                      ← rows
                                    ← JSON.stringify(rows, null, 2)  (pretty)
                                    ← wrapped as content[0].text inside JSON-RPC (string-escaped)
parse JSON-RPC → parse text → re-stringify pretty → stdout
```

Key facts established from the code:

- `src/index.ts` (postgrest-mcp): the Bearer token is passed straight through to PostgREST; the MCP
  server does **no** verification, no rate limiting, no RBAC. Everything security-relevant happens in
  the `/token` exchange and in PostgREST/RLS. The server is a pure forwarder plus tool-schema host.
- The MCP client transport (`StreamableHTTPClientTransport`) makes 3–4 HTTP requests per CLI
  invocation before the actual tool call (initialize, initialized, SSE GET probe, tools/call). On
  Windows there is no daemon, so this happens on every single command. On POSIX the daemon is
  spawned via `bun run <import.meta.dir>/daemon.ts`. Verified with a compiled probe binary: inside a
  `bun build --compile` binary `import.meta.dir` is the virtual bundle path (`/$bunfs/root` on
  Linux/macOS, `B:\~BUN
oot` on Windows), the file does not exist on disk, and the spawn fails
  with "Module not found", after which `getConnection` silently falls back to a direct connection.
  So the daemon only works in dev mode (`bun run src/index.ts` from a checkout); every installed
  binary pays the full handshake on every command, on every platform (see Q17).
- A fresh `McpServer` with all 54 tools (zod → JSON-schema conversion) is built on every request on
  the server side (`createMcpServer` in `mcp.ts`).
- Payload handling for large results: PostgREST body is parsed once on the server, re-serialised
  pretty-printed (2-space indent), string-escaped inside JSON-RPC, then parsed twice and
  re-serialised once on the CLI. For the raw `postgrestRequest` tool the envelope also echoes the
  request headers including the `authorization: Bearer <jwt>` header back over the wire.
- `accept: text/csv` is documented but `makePostgrestRequest` always calls `response.json()`, so CSV
  export through the MCP server cannot work today. A local shim could support it natively.
- CLI already has everything a local shim needs except the PostgREST base URL:
  - encrypted JWT cache + `get_cli_token` flow (`jwt-cache.ts`, `client.ts::resolveJwt`)
  - static `SEMANTIUS_JWT` mode
  - JWT-expiry and transient retry logic (`withRetries`)
  - an in-process MCP server pattern (`local-tools/`, `InMemoryTransport`) that keeps the exact
    MCP result envelope, so `formatToolResult`, `--single`, `--diag`, exit codes and skills stay valid
  - same dependencies: `@modelcontextprotocol/sdk` server side and `zod` 4 (postgrest-mcp imports
    `zod/v4`, CLI has `zod ^4.3.5`)

---

## 2. Does it make sense? (assessment, not decision)

Yes for the CRUD/PostgREST tools; the MCP hop adds no security or business logic for them, only
transport, schema hosting and per-request overhead. The gains split into "certain by construction"
and "must be measured":

Certain by construction
- Per invocation: 3–4 MCP HTTP round trips + Deno Deploy request handling + per-request server
  construction collapse into 1 HTTP request to PostgREST (plus a one-time token fetch and a one-time
  tenant resolution, both cacheable on disk like the JWT).
- Large downloads: one parse/serialise instead of ~4, no pretty-printing inflation, no JSON-RPC
  string escaping; the CLI can stream the PostgREST body to stdout.
- Large uploads: body goes straight from stdin JSON to PostgREST; no JSON-RPC embedding, no
  server-side zod re-validation of every row (see Q9 on whether to keep zod validation locally).
- Windows users get the biggest relative win because they never had a daemon.

Must be measured before committing (baseline step in section 6)
- How much of today's latency is Deno Deploy cold start vs. the MCP handshake vs. PostgREST itself.
  `semantius ping -n 10` gives the end-to-end number; a direct `curl` against PostgREST with the
  cached JWT gives the floor.
- Any request/response size ceilings on Deno Deploy that the local path would remove.

Costs / what is lost
- The crud tool schemas and the ~50 KB instructions text (`src/SKILL.md` in postgrest-mcp) would have
  to live in (or be reachable by) the CLI. Today the CLI discovers them at runtime; `semantius info
  crud`, `-md` and `grep` all rely on that.
- Two copies of the tool definitions unless the code is shared (Q3).
- A CLI release becomes necessary to ship tool/schema changes (today a server deploy is enough).
- Some tools genuinely need the server (section 3) — the result is a hybrid, not a full bypass.
- Server-side logs (Deno Deploy console) disappear for locally executed calls.

---

## 3. Tool inventory (54 tools on `crud`) and what each needs

| Group | Tools | Needs | Local feasibility |
|---|---|---|---|
| A. Pure PostgREST passthrough | 44 typed CRUD tools (`create/read/update/delete_*` for 11 entities), `postgrestRequest`, `getCurrentUser` (`/rpc/get_userinfo`), `generate_api_key`, `list_api_keys`, `delete_api_key`, `get_cli_config` (`/rpc/generate_api_key`) | JWT + tenant PostgREST URL (+ optional `apikey` header, see Q6) | Straightforward. `getCurrentUser` and `get_cli_config` also derive `api_baseurl` / `semantius_org` from the *request host*; locally these must be synthesised from `SEMANTIUS_ORG` (`api_baseurl` must keep pointing at `https://<org>.semantius.ai` because webhooks `/hook/:id` stay remote). |
| A2. Passthrough + fire-and-forget side effect | `create/update/delete_entity`, `create/update/delete_field` | Same as A, plus `resetSchemaCache()` which reads `_settings.slug` from the tenant DB via Kysely/Neon using `CONTROL_PLANE_DATABASE_URL`, then POSTs `https://<slug>.semantius.cloud/refresh-schema-cache` | The DB lookup is impossible locally (no DB credentials on the client, by design). The POST itself is possible with `slug = SEMANTIUS_ORG`. See Q10. |
| B. Semantius cloud API, not PostgREST | `sendEmail` → `https://<org>.semantius.cloud/api/email/send` (Bearer or x-api-key) | Only the token | Trivial locally. |
| C. Token issuance | `get_cli_token` → `https://<org>.semantius.cloud/token` | x-api-key | Becomes the CLI's own token fetch (the CLI already has the cache and expiry logic; only the transport changes from MCP-tool-call to direct POST). The tool itself becomes redundant in local mode. |
| D. Server-only | `refresh_schema_cache` | Same DB lookup as A2 | Must stay remote or be approximated (Q10). |
| E. Pure compute | `sqlToRest` (`@supabase/sql-to-rest` → `@supabase/pg-parser`, WASM libpg_query) | nothing remote | Possible, but adds a WASM dependency to the compiled binary; bundling/size/licensing to verify (Q11). |

Not affected at all: the `cube` server (separate backend on `semantius.io`), the webhook receiver
(`POST /hook/:id`), the `/claude-plugin` zip endpoint, OAuth metadata endpoints — all stay on the
Deno server.

---

## 4. Architecture options (for decision, section 7)

### 4.1 Where the local shim plugs into the CLI

Option A — **built-in in-process MCP server** (extend the existing `local-tools/` pattern).
A second built-in server hosts the crud tools with an `McpServer` over `InMemoryTransport`, exactly
like `utils`. Tool handlers receive a synthesised context `{ authInfo: { token, apiBaseUrl }, request:
{ url: https://<org>.semantius.ai/mcp, headers: { host, x-api-key } } }`, which is the shape the
postgrest-mcp handlers already expect (`types.ts::RequestContext`). Result: zero changes to
`call.ts`, `output.ts`, `--single`, `--diag`, `info`, `grep`, `-md`, exit-code mapping.
Cost: the JSON-RPC-in-memory hop still stringifies the payload once (no network, but no streaming).

Option B — **direct connection type** (`McpConnection` implementation that skips MCP entirely).
`getConnection` returns an object whose `callTool` calls the handler function directly and whose
`listTools` returns pre-computed JSON schemas. Same tool modules, no `McpServer`. Allows a
streaming fast path for `postgrestRequest`/`read_*` (pipe the PostgREST body to stdout without
parsing). Slightly more bespoke code; must reproduce zod validation and error envelopes by hand.

Option C — **both**: A as the general path, plus a streaming special case for downloads (Q13).

### 4.2 How to get the tool code into the CLI

Option 1 — vendor/copy the tool modules into `semantius-cli/src/local-tools/crud/` (like the
vendored `csv-schema.js`), with a sync script. Two copies, explicit drift.
Option 2 — move `postgrest-mcp/src/tools/**`, `utils/bulk.ts`, `utils/postgrest.ts`,
`utils/formatResponse.ts`, `utils/errorHandler.ts`, `types.ts` into a shared package (npm/git
dependency or workspace) consumed by both repos. One source of truth; postgrest-mcp's Deno import
map needs adjusting (`zod/v4`, `.ts` extension imports).
Option 3 — git submodule of postgrest-mcp inside the CLI (or vice versa).
Option 4 — CLI fetches tool schemas + instructions from the remote server once and caches them on
disk; only handlers are local. Keeps runtime discovery but reintroduces a network dependency for
`info`/`grep` on cache miss.

### 4.3 How to resolve the tenant PostgREST URL locally

Option i — call the control plane like the server does: `GET https://api.semantius.cloud/organization/<org>`
(unauthenticated today; response includes `postgrest_url`, `client_id`, and a `database_url` field —
see Q5 on whether that endpoint is meant to be public).
Option ii — new env var / config field (`SEMANTIUS_POSTGREST_URL`), no discovery.
Option iii — have the `/token` response or the JWT claims carry the PostgREST URL (server-side
change in the semantius extension).
Option iv — extend `getCurrentUser`/`get_userinfo` to return it and cache it on disk next to the JWT.
Any of i/iii/iv should be cached on disk (same lifetime policy as the JWT cache, or longer).

### 4.4 How the user switches it on

Option a — env var `SEMANTIUS_CRUD_MODE=local|mcp` (fits the existing `<PREFIX>_*` convention).
Option b — CLI flag (`--local` / `--direct`).
Option c — config file: a new server type in `mcp_servers.json`, e.g. `"crud": { "postgrest": true }`
or `{ "builtin": "crud" }`, and the default config picks one.
Option d — default local with automatic fallback to MCP on failure (tenant resolution fails,
unknown tool, etc.).
Option e — separate server name (`semantius call pg read_entity`) so both coexist and skills can
choose. Note the skills, README and `ping`/`whoami` hard-code `crud`.

### 4.5 Hybrid routing for tools that must stay remote

Option x — tool-level routing table: local for groups A/B/C/E, remote MCP for D (and A2 side effect
delegated remotely or approximated).
Option y — everything local; `refresh_schema_cache` implemented as the direct POST with
`slug = SEMANTIUS_ORG` (loses the `_settings.slug` override case).
Option z — everything local except the user explicitly calls the remote server under another name
for the rare tools.

---

## 5. Parity checklist (what the local path must reproduce so nothing downstream breaks)

- Result envelope: `{ content: [{ type: 'text', text }] , isError? }` with `text` being
  `JSON.stringify(data, null, 2)` for typed tools and the `{ request, response: { data, status, headers } }`
  envelope for `postgrestRequest` / `getCurrentUser` (both `formatToolResult` and `--single` unwrap it).
- Error text format `Error: (PGRST###) message` / `Error: (SQLSTATE) message` — `isAuthErrorMessage`,
  `classifyRetry`, `logger.extractErrorMeta` and the `--single` "0 rows" detection all pattern-match on it.
- `getCurrentUser` extra fields `api_baseurl`, `semantius_org`, `ui_baseurl`.
- `get_cli_config` output text.
- Bulk semantics from `utils/bulk.ts` (`?columns=`, `Prefer: missing=default`, `in.()` quoting).
- Default headers: `content-type: application/json`, `prefer: return=representation`, optional `apikey`.
- JWT expiry → invalidate cache → re-fetch → retry (today done by `withRetries` around MCP calls;
  the same wrapper can wrap the local handler).
- Tool filtering (`allowedTools`/`disabledTools`) keeps working through `filterTools`/`isToolAllowed`.
- Instructions text for `info crud` and `-md` (with `${slug}` substituted).
- Logging: `recordUrl` should record the PostgREST URL; `mcp_ms` timing wrapper (`timeMcp`) should
  still measure the remote call.

---

## 6. Phased plan (draft; each phase ends with a check-in)

Phase 0 — Baseline measurements (no code)
1. `semantius ping -n 10` (Windows and one POSIX box) for the MCP round trip.
2. Same call via direct `curl` to PostgREST using the cached JWT and the tenant URL from the control plane.
3. One large read (e.g. 10–50k rows via `postgrestRequest`) and one large bulk insert, timed both ways;
   note payload sizes on the wire.
4. Take all POSIX numbers with the installed binary (the daemon only exists in dev mode, Q17).
Output: a table that quantifies the win and decides whether Phase 1+ is worth it.

Phase 1 — Decisions (section 7) and spike
5. Pick options in 4.1–4.5.
6. Spike: wire `read_entity` + `postgrestRequest` + `getCurrentUser` through the chosen mechanism behind
   a feature switch; run the existing unit tests unchanged; compare byte-for-byte output of
   `semantius call crud read_entity '{}'` in both modes.

Phase 2 — Full tool set
7. Bring over all 54 tools (per 4.2), the bulk helpers, the instruction text, and the context shim.
8. Implement tenant resolution (4.3) with on-disk cache and `--reset-...` style invalidation.
9. Hybrid routing for D/A2 (4.5).
10. Retry/JWT-refresh wrapper around local calls; error-text parity.
11. Unit tests: port `postgrest-mcp/tests/crud-bulk.test.ts` (fetch-stub pattern) to bun test; add
    parity tests that run the same tool through MCP-in-memory and local and diff the result.

Phase 3 — Performance features that only the local path can offer (each optional, Q13)
12. Streaming download to stdout (no parse) for `postgrestRequest` GET and `read_*`.
13. Native `accept: text/csv` support.
14. Streaming/chunked upload for large bulk inserts (or automatic batching).

Phase 4 — Rollout
15. Help text, README, `skills/use-semantius/references/cli-usage.md`, CLAUDE.md conventions.
16. Decide default (local vs. MCP) and fallback behaviour; release via `scripts/release.sh`.
17. Optionally slim down postgrest-mcp (e.g. `get_cli_token` stays; nothing else needs to change).

---

## 7. Open questions (moved to §14)

The original Q1–Q18 were consolidated into §14 on 2026-09-11: answered ones with their
source, open ones with a proposed default. Section 4 keeps the option descriptions they refer to.

## 8. Risks

- Drift between server and CLI tool definitions if code is copied (mitigated by 4.2 option 2 or a
  sync test that diffs the JSON schemas from both sides).
- Secrets on the client: today only the API key/JWT lives on the client; `apikey` (Q6) or control-plane
  data (Q5) would widen that.
- Release coupling: schema changes need a CLI release; users on old binaries keep old schemas.
- Binary size / compile issues if `sqlToRest` (WASM) is bundled.
- Subtle output differences breaking scripted skills (`--single` row detection, exit codes) — parity
  tests in Phase 2 are the guard.
- `api_baseurl`-based webhook workflows silently breaking if Q12 is answered differently from today.

---

## 9. Verification ledger

Every claim in this document falls into one of three buckets. "Executed" means I ran something and
saw the result. "Code-read" means I read the source and the claim follows directly from it, but I did
not execute that path. "Not verified" means I could not or did not check; those claims are
assumptions and must be confirmed before they drive a decision.

### 9.1 Executed (observed, not inferred)

| Claim | How verified |
|---|---|
| A `bun build --compile` binary cannot start the daemon: `import.meta.dir` is a virtual path (`B:\~BUN\root` on Windows, `/$bunfs/root` on Linux), `daemon.ts` is not on disk, and the spawn fails either with `Module not found "/$bunfs/root/daemon.ts"` (a `bun` is on PATH) or `Executable not found in $PATH: "bun"` (no bun installed). | Compiled a probe with the same `join(import.meta.dir, 'daemon.ts')` + `Bun.spawn` logic as `daemon-client.ts`; ran it on Windows arm64 and, cross-compiled with `--target=bun-linux-arm64`, inside WSL Ubuntu 24.04 (Linux 6.6, aarch64) with and without a bun on PATH. Bun 1.3.12 in all cases. macOS and x64 Linux not executed; the mechanism is identical. |
| Release binaries are built with `bun build --compile --minify` for six targets. | Read `.github/workflows/release.yml` lines 53–68 and the `package.json` build scripts. |
| `install.sh` / `install.ps1` download those compiled binaries (`semantius-linux-x64`, `semantius-darwin-arm64`, `semantius-windows-x64.exe`, …), not the source tree. | Read both installers. |
| The daemon spawn command (`bun run <import.meta.dir>/daemon.ts`) has been unchanged since the initial commit (2026-04-25). | `git log -S` on `src/daemon-client.ts`. |
| README lines 305–306 and `--help` describe connection caching on Linux/macOS. | grep. |
| The local `semantius.log` in the repo root contains zero `daemon_start` / `daemon_stop` events. | grep. Weak evidence: this machine is Windows, where the daemon is disabled by design. |
| `@supabase/sql-to-rest` 0.1.8 depends on `@supabase/pg-parser`, `@babel/parser`, `prettier`. | Read its `package.json` in `postgrest-mcp/node_modules`. `@supabase/pg-parser` itself is not installed there, so its contents (WASM or not) were not inspected. |
| No `docs/` folder existed in the CLI repo before this plan. | `ls`. |
| `GET https://api.semantius.cloud/organization/<org>` is reachable from a client machine without auth (HTTP 200) and returns `id`, `name`, `logo`, `postgrest_url`, `client_id`, and (since 2026-09-11) `client_id_cli`. The response body has **no** `database_url` field (only the TypeScript type declares one). | Called it from this machine (Phase 0). Answers Q5's reachability part; whether it is *intended* to be public is still Martin's call. |
| The tenant `postgrest_url` is a Neon Data API endpoint of the form `https://<endpoint>.apirest.<region>.aws.neon.tech/neondb/rest/v1`. | Same call. |
| `POST https://<org>.semantius.cloud/token` with `x-api-key` works from a client machine (HTTP 200); the JWT is EdDSA, `aud = ["tenant://<tenant id>"]`, `iss = https://<org>.semantius.cloud/api/auth`, `role = authenticated`, 60-minute lifetime; claims: `scope,role,tid,azp,sid,email,name,given_name,family_name,sub,aud,iss,iat,exp`. No PostgREST URL in the claims (rules out 4.3 option iii without a server change). | Called it from this machine; decoded the payload; token not persisted. |
| Direct PostgREST calls succeed with only `Authorization: Bearer <jwt>`: no `apikey` header is needed (Q6 answered for the `tests` tenant). | 136 direct calls in Phase 0, all HTTP 200. |
| PKCE login against `tests` with `client_id_cli` and redirect `http://127.0.0.1:53682/callback`, scope `openid profile email offline_access tenant:<id>:user`: token issued (3600 s, refresh + id token), claims `aud = [<org>.semantius.cloud/mcp, …/userinfo]`, `tid`, `role = authenticated`; PostgREST accepts it (`/rpc/get_userinfo` and a table read both HTTP 200); refresh grant and revocation HTTP 200. Callback `iss` is `app.semantius.com/api/auth`, discovery issuer is `<org>.semantius.cloud/api/auth`. Two earlier runs failed until the server granted the tenant scope to the CLI client (`invalid_scope`, then `Client has no tenant scope`). | Probe `docs/plans/bench/pkce-probe.ts`, three browser logins by Martin, 2026-09-11. |
| Vendored `apiKeyAuth.ts` fails the CLI's strict `tsc` with two `TS18046` errors; vendored `postgrest.ts:67` logs to stdout per request; upstream `crud-bulk.test.ts` has 23 `Deno.test` calls and 35 relative imports. | Reproduced 2026-09-11 (tsc with the repo tsconfig on a scratch copy; grep). |
| Cloud OIDC discovery (full document): auth methods `none, client_secret_basic, client_secret_post`; scopes `openid, profile, email, offline_access, tenant:<tenant id>:user`; response types `code`; endpoints for revocation, end-session, userinfo, jwks and dynamic client registration (`/api/auth/oauth2/register`). | Fetched 2026-09-11 (implementation plan step 5). |
| Deno Deploy cold start after 20 min idle adds ≈ 2.1–2.2 s to the first CLI call (two passes); PostgREST/Neon cold start adds ≈ 0.2 s to the first direct call. | Section 10.3, `docs/plans/bench/cold.log`. |
| For a 2155-row read the MCP `tools/call` response is 1.72× the compact PostgREST body and CLI stdout is 1.31×. | One `--diag` capture measured locally (section 10.2). |
| OAuth discovery for a tenant is served at the host root (`https://<org>.semantius.cloud/.well-known/openid-configuration`, 200), not under the issuer path (404); grants `authorization_code`, `client_credentials`, `refresh_token`; PKCE `S256`; no device-authorization endpoint. | Fetched 2026-09-11 (section 13.1). |
| `Bun.secrets` set/get/delete works on Windows (Bun 1.3.12) and throws "libsecret not available" on headless Linux (WSL, Bun 1.4.2). | Probe run on both (section 13.2). |
| The CLI (v0.8.5 built from the current tree) and direct PostgREST return identical data for every benchmark scenario (deep-equal after parsing; for `getCurrentUser` after stripping the three server-added fields and the `last_seen`/`updated_at` timestamps that the RPC bumps on each call). | Phase 0 harness, first iteration of each scenario. |

### 9.2 Code-read (follows from source; path not executed)

| Claim | Source |
|---|---|
| `/mcp` passes a Bearer token through unverified; with `x-api-key` it exchanges per request at `https://<org>.semantius.cloud/token`. | `postgrest-mcp/src/index.ts`, `src/utils/apiKeyAuth.ts` |
| Tenant PostgREST URL comes from an unauthenticated `GET https://api.semantius.cloud/organization/<slug>` (URL hard-coded, env var commented out), cached in a per-isolate `Map`; the `TenantInfo` type has `database_url`. | `src/utils/controlPlane.ts` |
| A fresh `McpServer` with 54 tools is built per request (3 utility + 44 CRUD + 7 others). | `src/mcp.ts` tools array, counted by hand |
| `makePostgrestRequest` sets `content-type`, `prefer: return=representation`, optional `apikey` from `API_KEY` / `SUPABASE_ANON_KEY`, Bearer; always `response.json()`; error text `(code) message`; returns `request.headers` (incl. `authorization`) in the envelope. | `src/utils/postgrest.ts` |
| `text/csv` therefore cannot work through the server. | Same file: `response.json()` on a CSV body throws. Not executed. |
| Seven tools call `resetSchemaCache` (create/update/delete for entity and field, plus `refresh_schema_cache`); it needs `CONTROL_PLANE_DATABASE_URL` via Kysely/Neon to read `_settings.slug`, then POSTs `https://<slug>.semantius.cloud/refresh-schema-cache`. | grep + `src/utils/resetSchemaCache.ts`, `src/db/client.ts` |
| `sendEmail` posts to `https://<org>.semantius.cloud/api/email/send` with Bearer or `x-api-key`. | `src/tools/send_email.ts` |
| `getCurrentUser` derives `api_baseurl` from the request origin and `semantius_org` / `ui_baseurl` from the host; `get_cli_config` derives the org the same way. | `src/tools/getCurrentUser.ts`, `get_cli_config.ts`, `utils/semantiusOrg.ts` |
| Bulk semantics (`?columns=`, `Prefer: missing=default`, `in.()` quoting). | `src/utils/bulk.ts`, covered by `tests/crud-bulk.test.ts` (Deno, fetch stubbed; not run by me) |
| Tool handlers only need `{ authInfo: { token, apiBaseUrl }, request: { url, headers } }`. | `postgrest-mcp/types.ts` |
| Both repos use zod 4 (`zod/v4` vs `zod ^4.3.5`) and `@modelcontextprotocol/sdk` 1.25.x. | both `package.json` / `deno.json` |
| CLI: JWT cache is AES-256-GCM in tmpdir keyed from the API key; `resolveJwt` fetches via MCP `get_cli_token`; static `SEMANTIUS_JWT` bypasses it; `withRetries` re-fetches on JWT-looking errors and retries on 429/503-style text. | `src/jwt-cache.ts`, `src/client.ts` |
| `formatToolResult`, `--single`, `whoami`, `parseTokenResult` all unwrap the `{ response: { data } }` envelope and pattern-match error text; exit codes derive from message patterns. | `src/output.ts`, `src/commands/call.ts`, `identity.ts`, `src/errors.ts` |
| Windows never uses the daemon (`isDaemonEnabled` returns false on win32). | `src/config.ts` |
| Even a correctly spawned `--daemon` process would be killed: `daemon.ts` starts `runDaemon` at import time, then `main()` in `index.ts` rejects `--daemon` as an unknown option and exits. | bottom of `src/daemon.ts`, `src/index.ts::parseArgs` default branch |
| Built-in `utils` server pattern (McpServer over `InMemoryTransport`) keeps the MCP envelope and skips the daemon/JWT/retry layers. | `src/local-tools/connection.ts`, `client.ts::getConnection` |
| The uncommitted skill edit states the schema cache refreshes automatically after structural changes. | `git diff` of `skills/use-semantius/references/crud-tools.md` |
| The MCP client sends `initialize`, the `initialized` notification, opens a GET SSE stream, then `tools/call`: 3–4 HTTP requests per invocation. | Inferred from `@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js` (`_startOrAuthSse` at lines 56/78/151/293/376/471). I did not trace the full control flow or capture traffic; the exact count per invocation is **unconfirmed**. |
| The payload is parsed/serialised about four times end to end and pretty-printed with 2-space indent. | `formatSuccessResponse` (`JSON.stringify(data, null, 2)`), `formatToolResult` (parse + re-stringify), JSON-RPC framing by the SDK. The count is approximate. |

### 9.3 Not verified (assumptions; confirm before deciding)

| Open item | Why not verified | How to verify |
|---|---|---|
| Whether the Deno Deploy deployment sets `API_KEY` / `SUPABASE_ANON_KEY`. | Not visible in the repo. | Moot for the `tests` tenant: PostgREST accepts the Bearer token alone (see 9.1). Other tenants/backends unverified. |
| The `/token` JWT works against PostgREST from *any* origin. | Verified only from this one machine/network (see 9.1). | Repeat from a second network (e.g. a CI runner). (Q7) |
| Deno Deploy / `@hono/mcp` request or response size limits. | Not documented in either repo. | Deno Deploy docs plus a large-payload test. (Q8) |
| Latency on Linux/macOS and from other networks. | Phase 0 ran on one Windows arm64 machine only (section 10). | Repeat the harness elsewhere. |
| Exact HTTP request count per CLI invocation (3 vs. 4). | See the last rows of 9.2. Phase 0 measured the handshake's *cost* (≈ 640 ms warm) but not its request count. | `SEMANTIUS_DEBUG=1` plus a proxy (mitmproxy) or a packet capture. |
| Cold-start behaviour after idle gaps shorter than 20 min. | Only 20-min gaps were tested. | Repeat the cold runner with 5- and 10-min sleeps. |
| Write-path performance (bulk inserts / updates). | Phase 0 measured reads only, to avoid mutating the sample data. | Extend the harness with a scratch table. |
| `@supabase/pg-parser` is WASM-based and whether Bun's compiler can bundle it; binary size impact. | Package not present locally; "WASM" is from memory, not from inspection. | `bun add` it in a scratch project and `bun build --compile`. (Q11) |
| Whether the daemon ever worked in any released binary (as opposed to dev mode). | Spawn command unchanged since the initial commit, but I did not test older binaries. | Run an older release with `SEMANTIUS_DEBUG=1` on Linux. |
| Whether `bun` is on PATH on end-user machines. | Not checked; also moot because the file path fails first. | n/a |
| How often `_settings.slug` differs from the org slug (impact of Q10 option b). | Tenant data. | Query a few tenants' `_settings`. |
| Whether anyone relies on Deno Deploy console logs for the crud tools. | Operational knowledge. | Ask. |
| Whether skills/evals depend on byte-exact output beyond what `output.ts` / `call.ts` encode. | I read the skills but did not run the evals. | Run `skills/use-semantius/evals` in both modes after the spike. |
| The CLI unit test suite passes on the current tree. | I did not run `bun test`; no code was changed. | `bun test`. |
| The same on macOS and x64 Linux. | Probe executed on Windows arm64 and Linux arm64 (WSL) only. | Run the same probe there; the mechanism does not depend on the platform. |

---

## 10. Phase 0 baseline results

Setup (2026-09-10, one machine: Windows 11 arm64, Bun 1.3.12, home network, Europe; tenant `tests`;
Northwind sample: products 77, orders 830, order_details 2155, customers 91 rows). Harness, raw samples
(`results.jsonl`, 156 samples, 0 failures, 0 in-call token fetches) and logs are in `docs/plans/bench/`.
Re-run with `bun run docs/plans/bench/bench.ts warm 8` (needs the repo `.env` and a built
`semantius-bench.exe` one level above the script; see the header comment).

Three paths per scenario:

- **cli** — `semantius-bench.exe` built from the current tree (v0.8.5), spawned per call exactly as a
  user or agent would run it; `SEMANTIUS_LOG_FILE` set so the CLI's own `mcp_ms` (time inside
  `tools/call`, excluding the MCP connect handshake) is captured. JWT cache warm; no token fetch
  occurred inside any timed call (checked via debug output).
- **direct-proc** — a fresh `bun` process doing one `fetch` to PostgREST with the Bearer JWT (fresh
  TLS). This is the closest model of what a local shim inside the CLI would cost.
- **direct-keep** — in-process `fetch` with a kept-alive connection: the network floor.

Every scenario is a read; writes were not benchmarked. Data returned by cli and direct was
deep-equal in every scenario (see ledger 9.1).

### 10.1 Warm (8 interleaved iterations per cell)

| Scenario | Path | min ms | median ms | p90 ms | max ms | median inner ms | stdout/body bytes |
|---|---|---:|---:|---:|---:|---:|---:|
| `--version` (process start only) | cli | 108 | 117 | 142 | 3224¹ | – | – |
| `utils/get_csvschema` (process + in-process MCP, no network) | cli | 132 | 141 | 152 | 265 | – | – |
| getCurrentUser | cli | 1080 | 1093 | 1144 | 2132 | 315 (mcp) | 2758 |
| getCurrentUser | direct-proc | 363 | 369 | 408 | 775 | 287 (fetch) | 2183 |
| getCurrentUser | direct-keep | 94 | 99 | 105 | 346 | – | 2183 |
| single record (`products?id=eq.N`, `--single`) | cli | 1080 | 1110 | 1128 | 1147 | 316 | 375 |
| single record | direct-proc | 360 | 368 | 393 | 400 | 284 | 324 |
| single record | direct-keep | 91 | 95 | 112 | 113 | – | 324 |
| page 100 (`orders?limit=100`) | cli | 1350 | 1360 | 1374 | 1391 | 583 | 63 086 |
| page 100 | direct-proc | 539 | 556 | 578 | 587 | 463 | 51 988 |
| page 100 | direct-keep | 266 | 274 | 283 | 288 | – | 51 988 |
| page 1000 (`order_details?limit=1000`) | cli | 1632 | 1660 | 1749 | 1928 | 878 | 280 910 |
| page 1000 | direct-proc | 710 | 734 | 768 | 779 | 643 | 221 472 |
| page 1000 | direct-keep | 446 | 449 | 490 | 492 | – | 221 472 |
| full table (`order_details`, 2155 rows) | cli | 1855 | 1930 | 2071 | 2399 | 1103 | 606 237 |
| full table | direct-proc | 817 | 825 | 846 | 854 | 735 | 478 508 |
| full table | direct-keep | 539 | 543 | 585 | 619 | – | 478 508 |

¹ first-ever launch of the freshly built binary (Windows Defender / page cache); all later launches 108–142 ms.

### 10.2 Where the CLI's time goes (warm medians)

| Scenario | CLI wall | inside `tools/call` (mcp_ms) | remainder | direct-proc wall | ratio CLI ÷ direct-proc |
|---|---:|---:|---:|---:|---:|
| getCurrentUser | 1093 | 315 | 778 | 369 | 3.0× |
| single record | 1110 | 316 | 794 | 368 | 3.0× |
| page 100 | 1360 | 583 | 777 | 556 | 2.4× |
| page 1000 | 1660 | 878 | 782 | 734 | 2.3× |
| full table | 1930 | 1103 | 827 | 825 | 2.3× |

Reading the table:

- The **remainder is a constant ≈ 780 ms** regardless of payload. Process start + config + JWT-cache
  read account for ≈ 120–140 ms of it (rows 1–2 of 10.1), so **≈ 640 ms per invocation is the MCP
  connect handshake** (`initialize` → `initialized` → SSE probe) before `tools/call` even starts.
  A local shim removes this entirely; nothing else in the plan buys that much.
- Inside `tools/call`, the MCP path costs **≈ 30–370 ms more than a direct fetch**, growing with
  payload (315 vs 287 ms for a single row; 1103 vs 735 ms for 2155 rows). That is the Deno hop plus
  the serialise/escape/parse passes described in section 1.
- **The direct path with a fresh process is 2.3–3.0× faster end to end**, and the network floor
  (keep-alive) is another 2–4× below that; the latter is only reachable by a long-lived process
  (a working daemon or a batch mode), not by a per-call CLI.
- **Payload inflation, full table (2155 rows), measured from one `--diag` capture:**

  | Stage | bytes | × raw |
  |---|---:|---:|
  | PostgREST body (compact JSON) | 464 005 | 1.00 |
  | CLI stdout (2-space pretty-print) | 606 236 | 1.31 |
  | MCP `tools/call` response on the wire (pretty envelope, string-escaped inside JSON-RPC) | 797 732 | 1.72 |

  The `direct-proc` byte counts in 10.1 (478 508) are slightly above the compact figure because the
  live PostgREST body carries whitespace of its own. The envelope also echoes the request headers
  including `authorization: Bearer …` on every `postgrestRequest` response (parity item, Q15).
- `single` vs `page 1000`: for the CLI the single record costs 1110 ms and 1000 rows 1660 ms, so
  **per-call overhead, not payload, dominates every realistic agent workload**; an agent doing 20
  reads pays ≈ 16 s of pure handshake today.

### 10.3 Cold start (two passes, each after 20 min with no traffic to either backend)

Each pass runs the five scenarios once per path, in the stated order, with no warm-up. Only the first
call of a pass can be cold; the table shows all calls so the recovery is visible.

Pass 1, CLI first (Deno cold, PostgREST cold; the CLI call warms PostgREST for the direct call that follows):

| Scenario | Path | wall ms | inner ms | vs. warm median |
|---|---|---:|---:|---|
| getCurrentUser | **cli (cold)** | **3197** | 641 (mcp) | +2104 ms |
| getCurrentUser | direct-proc | 375 | 287 | +6 ms (PostgREST already warmed by the CLI call) |
| single record | cli | 1075 | 308 | warm |
| single record | direct-proc | 362 | 283 | warm |
| page 100 | cli | 1398 | 588 | warm |
| page 100 | direct-proc | 549 | 462 | warm |
| page 1000 | cli | 1785 | 996 | +125 ms |
| page 1000 | direct-proc | 717 | 639 | warm |
| full table | cli | 1886 | 1092 | warm |
| full table | direct-proc | 820 | 735 | warm |

Pass 2, direct first (PostgREST cold for the direct call; Deno still cold for the CLI call that follows):

| Scenario | Path | wall ms | inner ms | vs. warm median |
|---|---|---:|---:|---|
| getCurrentUser | **direct-proc (cold)** | **579** | 488 | +210 ms |
| getCurrentUser | **cli (cold)** | **3253** | 457 (mcp) | +2160 ms (PostgREST already warm) |
| single record | direct-proc | 428 | 342 | +60 ms |
| single record | cli | 1119 | 314 | warm |
| page 100 | direct-proc | 574 | 493 | warm |
| page 100 | cli | 1439 | 668 | +79 ms |
| page 1000 | direct-proc | 1217 | 1130 | +483 ms (single outlier; warm max was 779) |
| page 1000 | cli | 1646 | 863 | warm |
| full table | direct-proc | 845 | 766 | warm |
| full table | cli | 1896 | 1078 | warm |

Reading the two passes:

- **Deno Deploy cold start costs ≈ 2.1–2.2 s** on the first CLI call after 20 min idle, and it is
  independent of whether PostgREST is warm (pass 2 proves that: PostgREST had just been hit, the
  CLI still paid 2160 ms). Of that, only ≈ 150–330 ms is inside `tools/call` (per-isolate tenant
  resolution via the control plane, plus the request itself); **≈ 1.8–2.0 s is spent before
  `tools/call`, in the MCP connect handshake against a booting isolate.**
- **PostgREST (Neon Data API) cold start is small: ≈ +210 ms** on the first direct call, back to warm
  on the second. A local shim therefore keeps a cold-start penalty of roughly 0.2 s instead of 2.2 s.
- One cold call is enough to warm each backend; every later call in both passes was at warm levels
  (one page-1000 outlier on the direct path, 1217 ms, is within the noise seen elsewhere).
- 20 minutes idle was enough to observe the Deno cold state both times. Whether it also occurs after
  shorter gaps (5, 10 min) was not measured. Note that other clients of the same tenant (for example
  a claude.ai MCP connector) can keep the isolate warm and mask this in day-to-day use.

### 10.4 What Phase 0 says for the decision

Per CLI invocation against the `crud` server, on this machine:

| | Today (MCP) | Local shim (modelled by direct-proc) | Saved |
|---|---:|---:|---:|
| warm, small read | ≈ 1.1 s | ≈ 0.37 s | ≈ 0.7 s (3.0×) |
| warm, 2155-row read | ≈ 1.9 s | ≈ 0.83 s | ≈ 1.1 s (2.3×) |
| first call after 20 min idle, small read | ≈ 3.2 s | ≈ 0.58 s | ≈ 2.6 s (5.5×) |
| bytes moved for a 2155-row read | 798 KB on the wire, 606 KB on stdout | 464–478 KB | 40 % on the wire |

The dominant term is the fixed per-call handshake (≈ 640 ms warm, ≈ 2 s cold), not payload size, so
the win applies to every call an agent makes, not only to bulk transfers. This is measurement, not a
decision: whether the win justifies the costs listed in section 2 remains Martin's call (section 7).

---

## 11. Daemon fix (2026-09-10; committed on `main` as `9ac9574` on 2026-09-11, not yet released)

Decided by Martin after Q17: fix the daemon rather than drop it. Three defects were found and fixed;
the second and third only became visible once the first was fixed, because the daemon had never
actually run from a released binary.

| # | Defect | Fix |
|---|---|---|
| 1 | `spawnDaemon` ran `bun run <import.meta.dir>/daemon.ts`; inside a compiled binary that path is the virtual bundle, so the spawn always failed and every call silently fell back to a direct connection. | Spawn a second instance of the program itself: `process.execPath` in a compiled binary, `bun <Bun.main>` in dev mode (`getSelfCommand`). `index.ts` routes `--daemon <server> <config>` to `runDaemon` before normal arg parsing (which rejected `--daemon`) and without the CLI's own SIGINT/SIGTERM handlers (which would have pre-empted the daemon's cleanup). The import-time side effect in `daemon.ts` is gone. |
| 2 | Both socket ends parsed every read as a complete JSON message. Any request or response larger than one socket read (~64 KB) failed with "Invalid response from daemon": a 1000-row read exits 4 through the daemon, whereas the direct fallback used to succeed. | Newline-delimited JSON framing on both sides (`createLineReader`, byte-scanning so multi-byte UTF-8 survives chunk boundaries) plus backpressure-aware writes (`writeAll` / `flushPending` on `drain`), since Bun's `socket.write` accepts large frames only partially. |
| 3 | The client's 5-second timeout applied to every daemon request, including `tools/call`, so any tool call slower than 5 s through the daemon would have failed although a direct call gets `SEMANTIUS_TIMEOUT` (30 min). | The liveness ping keeps 5 s (fast fallback); all other requests get `getTimeoutMs()`. Timer cleared on settle; settle happens before `socket.end()` because Bun fires `close` synchronously inside `end()`. |

Tests added:
- `tests/daemon-framing.test.ts` (unit, all platforms): frame reassembly across chunks, UTF-8 split
  inside a 2- and 4-byte character, several frames per chunk, partial-write flushing and ordering.
- `tests/integration/daemon.test.ts` (Linux/macOS only, CI on ubuntu): compiles a real binary, then
  asserts: first call spawns a daemon (`daemon_start` logged) that outlives the CLI process; second
  call reuses it (same pid, no new spawn); a 700 KB UTF-8 payload round-trips through the daemon in
  both directions (request via stdin, response via `--diag`); SIGTERM produces `daemon_stop` and
  removes socket and pid files.

Verification: `bun test` on Windows 323 pass / 0 fail; the integration test on Linux (WSL Ubuntu
24.04, Bun 1.4.2) 4 pass / 0 fail; `biome check src/` and `tsc --noEmit` clean. The pre-existing
`biome` findings in `tests/client*.test.ts` are outside the project's lint scope and untouched.

### 11.1 What the daemon is worth on Linux (fixed binary, same scenarios as section 10, 8 iterations, warm)

| Scenario | daemon: wall median | daemon: mcp_ms | no daemon: wall median | no daemon: mcp_ms | saved |
|---|---:|---:|---:|---:|---:|
| getCurrentUser | 233 | 162 | 1019 | 314 | 786 ms (4.4×) |
| single record | 227 | 159 | 1000 | 305 | 773 ms (4.4×) |
| page 100 | 639 | 575 | 1290 | 579 | 651 ms (2.0×) |
| page 1000 | 736 | 676 | 1560 | 848 | 824 ms (2.1×) |
| full table (2155 rows) | 981 | 916 | 1797 | 1087 | 816 ms (1.8×) |

Zero failures, one `daemon_start` for the whole run. The saving is the ≈ 780 ms per-call remainder
identified in 10.2 (process start stays; the MCP connect handshake disappears). With the daemon, the
CLI on Linux is now within 1.1–1.4× of the direct-fetch-in-a-fresh-process model from section 10
(`direct-proc`), because the daemon's socket hop is cheap and the remaining cost is the Deno hop
inside `tools/call`. The daemon does nothing about cold starts (the isolate is still cold when the
daemon first connects) or about payload inflation.

Consequence for the plan: on Linux/macOS the daemon fix captures most of the *warm* per-call win
that section 10.4 attributed to a local shim; the shim's remaining advantages there are the cold
start (2.2 s vs 0.2 s), the 1.7× wire inflation, CSV, and streaming. On Windows nothing changes
until either the daemon runs there (11.2) or the shim exists.

### 11.2 Windows daemon spike (investigation only, nothing implemented)

- Bun's `unix:` option accepts a Windows named pipe (`\\.\pipe\<name>`): `Bun.listen` +
  `Bun.connect` round-tripped a message on Bun 1.3.12. The socket layer is not the blocker.
- A child started with `Bun.spawn` + `unref()` on Windows is killed when its parent exits (probe:
  heartbeat file never written; pid gone 2 s after the parent returned). The same child started
  directly runs fine. A Windows daemon therefore needs a different detach mechanism (e.g. launching
  through `cmd /c start /b`, `powershell Start-Process`, or a Bun API for detached/job-free spawn if
  one exists); not investigated further.
- Also needed for Windows: replace `process.getuid()` in the socket-dir name, pid liveness via
  `process.kill(pid, 0)` (works on Windows), and a shutdown path other than SIGTERM (no signal
  delivery; a `close` request over the pipe already exists).

Decision for Martin (new): pursue the Windows daemon, or leave Windows to the local shim?

---

## 12. Strategic inputs from Martin (2026-09-10) and what they change

Three facts added after the benchmarks:

- **(a) Deno Deploy costs money.** Every crud call through the MCP server is billable compute; the
  CLI currently sends 3–4 requests per invocation and rebuilds a 54-tool server on each of them.
- **(b) Self-hosted has no MCP.** Analytics (`cube`) stays MCP, but crud access may be needed in the
  free / self-hosted tier as well — where there is no Deno server, no control plane, and possibly no
  `semantius.cloud` token endpoint.
- **(c) Backup and restore is a planned feature** that should work directly against PostgREST, for a
  single table and/or all tables of a module.

### 12.1 What this changes in the assessment

- The local PostgREST layer stops being an optimisation and becomes **the only crud path that works
  everywhere** (cloud and self-hosted). Section 10/11 measured its speed; (b) makes it a requirement.
- (a) turns the per-call MCP overhead into a cost line, not only a latency line: with the local layer,
  crud traffic through Deno drops to the few server-only tools (schema-cache refresh), and the Deno
  server keeps serving remote MCP clients (Claude.ai connectors, the plugin) unchanged.
- (c) needs exactly the primitives the local layer provides (raw GET/POST against tables, CSV,
  pagination, streaming) and none that MCP adds. Building backup/restore on top of the MCP path would
  inherit the 1.7× wire inflation, the missing CSV support, and the per-request server construction.
- The daemon fix (section 11) stays valuable: it serves `cube` and, once the local layer exists, can
  keep the PostgREST TLS connection open (the `direct-keep` floor: 0.1 s small reads).

Net: the plan's framing shifts from "bypass option for `crud`" to **"PostgREST is the CLI's primary
crud transport; the MCP route remains for cloud-only, server-side tools"**. Sections 4.1–4.5 stay
valid as design choices, but several defaults look different under the new facts (see 12.3).

### 12.2 What backup/restore needs from the local layer (requirements sketch, not a design)

Export
- Enumerate a module's tables: `entities?module_id=eq.N` (order: `table_name`), columns from `fields`
  (`table_name=eq.X`); snapshot both as the backup's manifest (schema at backup time).
- Per table: paginated GET ordered by the id column (`limit`/`offset` or `Range` header), `Prefer:
  count=exact` for progress; `accept: text/csv` or JSON lines; stream to disk, never buffer whole
  tables in memory (the MCP path cannot do any of this).
- Consistency caveat: each PostgREST request is its own transaction; a multi-table export is not a
  single snapshot. Either accept (document) or pause writes during backup.

Restore
- Dependency order from `fields` (`format` = `parent`/`reference`, `reference_table`): parents first.
- Bulk POST with `?columns=<union>` and `Prefer: missing=default` (what the typed `create_*` tools do
  today); optional `Prefer: resolution=merge-duplicates` for restore-into-existing (upsert).
- Batch size (hundreds of rows per request), retries on transient errors, resume from the last
  committed batch.
- Explicit primary keys: works only if id columns are `GENERATED BY DEFAULT` (or plain serial);
  sequences then need resetting after restore, which PostgREST cannot do without an RPC. Needs an
  answer from the semantius extension (Q19).
- Side effects on insert: `order_column` triggers, audit logging, computed fields, validation rules
  (old rows may fail today's rules), RLS (`edit_permission` on every table). Each needs a policy.
- Schema restore (recreating entities/fields from the manifest) vs. data-only restore into an existing
  schema: different scope, different risk (Q20).

### 12.3 Options where the new facts move the default (still Martin's decisions)

| Topic | Under section 4 | Under 12 |
|---|---|---|
| Switch (4.4) | opt-in env var / flag | a first-class server type (`postgrest`) that is the default for `crud`; the MCP route becomes the special case for server-only tools |
| Tenant URL (4.3) | control plane (cloud) | control plane for cloud **plus** explicit config for self-hosted (`SEMANTIUS_POSTGREST_URL` or config field); the config path is mandatory anyway for (b) |
| Auth | `/token` exchange via `semantius.cloud` | same for cloud; self-hosted needs its own answer (static JWT via `SEMANTIUS_JWT` already exists; API-key exchange endpoint on the self-hosted stack?) (Q21) |
| Code sharing (4.2) | copy vs shared package | shared package gains weight: the tool schemas would be needed by the CLI, the Deno server, and possibly a future self-hosted MCP |
| Scope (Q1) | all tools vs data-heavy | all PostgREST-backed tools (self-hosted needs schema management too), hybrid only for `refresh_schema_cache` and the entity/field cache reset — which on self-hosted also need a non-Deno answer (Q22) |
| Hybrid fallback (Q14) | fall back to MCP | on self-hosted there is nothing to fall back to; the local layer must be complete on its own |

### 12.4 New open questions (moved to §14)

Moved to §14 (Q19–Q25; Q22 and Q23 are answered there).

## 13. Decisions D1–D6 from Martin (2026-09-11) and what was verified against them

| # | Decision | Implication for the plan |
|---|---|---|
| D1 | Self-hosted: the server name/URL must be configurable. | Tenant resolution (4.3) becomes: explicit URL wins; control-plane lookup only when no URL is configured (cloud). Naming and shape are open (Q26). Self-hosted also needs the auth server URL, not only the PostgREST URL. |
| D2 | Add OAuth 2.0 authorization-code + PKCE as the default login, keep API keys; device code as a possible option. | Verified against the live tenant auth server (below): PKCE S256 and refresh tokens are supported today; device code is **not** (no `device_authorization_endpoint`), so it needs server-side work before the CLI can offer it. |
| D3 | Store secrets in `Bun.secrets`. | Verified: works on Windows (Credential Manager) with Bun 1.3.12. On headless Linux (WSL, no libsecret, no Secret Service) `Bun.secrets.set` fails with "libsecret not available". A fallback policy for headless Linux/CI is required (Q28). |
| D4 | Undecided: `logto-io/cli-auth` vs own code. | Assessment in 13.3. |
| D5 | Schema-cache reset is cloud-only (Neon Data API has no PostgREST reload signal); self-hosted `pg_semantius` resets on its own. | The hybrid shrinks to one cloud-mode side effect after entity/field writes (and for `refresh_schema_cache`). Self-hosted: no-op. *How* the cloud side effect is issued was settled by D9 (call the remote MCP server's tool, not a direct POST), which also removes the `_settings` slug concern. |
| D6 | `postgrest-mcp` keeps owning the tool code; a script copies it into this repo **unchanged** (like the vendored csv-schema). | Settles 4.2 as "vendor copy with sync script". The copy is not fully self-contained, see 13.4 for what must be shimmed around it without touching the copied files. |

### 13.1 Auth server facts (verified 2026-09-11 against `tests`)

- Discovery documents are served at the **host root**, not under the issuer path:
  `https://<org>.semantius.cloud/.well-known/openid-configuration` and
  `.../.well-known/oauth-authorization-server` both 200; the same paths under `/api/auth/` are 404.
- `issuer = https://<org>.semantius.cloud/api/auth`,
  `authorization_endpoint = https://<org>.semantius.cloud/api/auth/oauth2/authorize`,
  `token_endpoint = https://<org>.semantius.cloud/token` (the endpoint the CLI already uses for the
  API-key exchange).
- `grant_types_supported = authorization_code, client_credentials, refresh_token`;
  `code_challenge_methods_supported = S256`. No device authorization endpoint, no dynamic client
  registration advertised.
- The control plane already returns a per-tenant `client_id` (section 9.1); whether it is a public
  client that accepts loopback redirect URIs (`http://127.0.0.1:<port>/…`, RFC 8252) and receives
  refresh tokens (`offline_access`) is not verified (Q27).
- The `semantius-cloud` auth UI folder in scope contains only sign-in/sign-up/consent pages; the
  OAuth API routes live elsewhere and were not inspected.

### 13.2 Secret storage facts

| Platform | `Bun.secrets` | Note |
|---|---|---|
| Windows 11 (Bun 1.3.12) | set/get/delete OK | Credential Manager |
| Linux headless (WSL Ubuntu 24.04, Bun 1.4.2) | `set` throws "libsecret not available" | No libsecret, no Secret Service daemon; typical for servers, containers, CI |
| macOS | not tested | Keychain expected |

Consequence: `Bun.secrets` can be the default, but the CLI needs a documented fallback for headless
Linux: (a) the existing encrypted file cache (its key is derived from the API key, so it does not
work for OAuth tokens without a new key source), (b) a 0600 JSON file like cli-auth's
`fileStorage`, or (c) refuse OAuth there and require `SEMANTIUS_API_KEY` / `SEMANTIUS_JWT` (the CI
path anyway). Martin's call (Q28).

### 13.3 `logto-io/cli-auth` vs own code (assessment, not a decision)

Facts (from the repo, 2026-09-11): package `cli-auth` 0.1.0-beta.0, MIT, zero runtime dependencies,
requires Node ≥ 22 or Bun ≥ 1.3; provider-agnostic (plain OAuth 2.0 metadata, not tied to Logto);
strategies: authorization-code + PKCE (loopback server on 127.0.0.1, auto-shutdown), device-code,
client-credentials, token-exchange; `Storage` interface with `load/save/clear` (built-ins: memory,
0600 file, keyring via optional `@napi-rs/keyring`); automatic refresh 300 s before expiry;
optional cross-process lock for concurrent refreshes; does **not** open the browser itself
(`onAuthorization(url)` callback). Adoption: 2 stars, 27 commits, beta.

| | cli-auth | own code |
|---|---|---|
| Fit | Exactly the four flows and the storage/refresh shape needed; a `Bun.secrets` adapter is ~10 lines against its `Storage` interface. Device-code is ready for when the server supports it. | Same result; PKCE + loopback (`Bun.serve`) + refresh + storage is roughly 200–300 lines, and the repo already has token caching and retry conventions to reuse. |
| Risk | Beta, single vendor, near-zero adoption; API may change. Mitigation is cheap: zero deps, so vendoring/forking it is trivial and it bundles into the binary without issues. | No third-party risk; more surface to test (PKCE edge cases, refresh races across concurrent CLI processes: cli-auth's lock is exactly the kind of thing that gets forgotten). |
| Effort | Days saved: ~1–2 (mostly the loopback/refresh/lock plumbing and its tests). | ~2–3 days including tests. |
| Semantius-specific parts either way | Tenant discovery (root `.well-known`), `client_id` from the control plane or config, API-key path (`client_credentials` with `x-api-key`, already implemented in `client.ts`), `Bun.secrets` storage + headless fallback, `--login/--logout/whoami` commands, daemon config-hash interplay (the daemon is keyed on the resolved config incl. the token). | |

If a recommendation is wanted: try cli-auth in the spike; if its API or its beta status bites, vendor
the ~few files (MIT) rather than rewriting.

### 13.4 What the "copy unchanged" script must cover (D6)

Copy set from `postgrest-mcp` (unchanged): `types.ts`, `src/tools/**` (54 tools + `schemas/`),
`src/utils/{postgrest,bulk,formatResponse,errorHandler,apiKeyAuth,semantiusOrg,env}.ts`, and
`src/SKILL.md`, from which the sync script regenerates `instructions.ts` locally (decided in the
implementation plan §2 instead of copying the generated file, so a stale upstream generate cannot
ship). Upstream `src/mcp.ts` does not export its `tools` array, so the registry is regenerated from
the copied tool files.

Things the copied code needs that the CLI must provide **around** it, without editing the copies:

- **Context object**: `{ authInfo: { token, apiBaseUrl }, request: { url: https://<org>.semantius.ai/mcp, headers: { host, 'x-api-key'? } } }`. `getCurrentUser`, `get_cli_config`, `send_email`, `get_cli_token` derive the org slug from `request.url`; `api_baseurl` must keep pointing at the Deno host (webhooks live there); on self-hosted these values need a definition (Q29).
- **`src/utils/resetSchemaCache.ts` and `src/db/*`**: the upstream file imports Kysely + Neon to read `_settings`. It cannot be copied (dependencies, no DB credentials on clients). The sync script must exclude it and the CLI must supply a same-path module exporting `resetSchemaCache(host, token)`. *Superseded by D9 (13.6):* in cloud mode that module calls the remote crud MCP server's `refresh_schema_cache` tool (not a direct POST); in self-hosted mode it returns null. Seven tool files import it (unchanged, by relative path), so the replacement must live at the same relative location in the copy tree. Six of those callers fire-and-forget, so the CLI must drain pending calls before `process.exit` (implementation plan §4).
- **`sqlToRest`** pulls `@supabase/sql-to-rest` (+ its WASM parser) into the binary (Q11 still open).
- **Import specifiers**: `zod/v4` and `.ts` extensions work under Bun; `@modelcontextprotocol/sdk` is already a dependency. Deno import map entries (`deno.json`) have no CLI equivalent, so any bare specifier not in the CLI's `package.json` must be added there.
- **Drift check**: the sync script should have a `--check` mode (hash comparison against the upstream checkout) that CI or the release script runs, so an un-synced copy cannot ship silently.
- **Tests**: `postgrest-mcp/tests/crud-bulk.test.ts` stubs `fetch` and runs the tool handlers directly; it can be copied too and run under `bun test` with a small Deno-assert shim, giving the vendored copy the same coverage as upstream.

### 13.5 New open questions (moved to §14)

Moved to §14 (Q26–Q31; Q26, Q28 and Q30 are answered there).

### 13.6 Decisions D7–D9 (2026-09-11)

| # | Decision | Effect |
|---|---|---|
| D7 | No device code in the first iteration. | Auth v1 = authorization-code + PKCE (browser) plus the existing API-key and static-JWT paths. Device code returns when the auth server exposes a device-authorization endpoint. |
| D8 | Use `cli-auth` for the OAuth client. | Its `Storage` interface carries the secret-store question: a `Bun.secrets` adapter as the default store and its built-in 0600 `fileStorage` as the headless-Linux fallback (resolves Q28 in that direction unless Martin objects). |
| D9 | Replace the schema-cache reset helper: on Semantius cloud, call the **original MCP server's** `refresh_schema_cache` tool; on self-hosted, no-op. | Resolves Q10/Q30 (no direct POST, no `_settings` concern: the server keeps that logic). The cloud path costs one MCP round trip after entity/field writes; whether the CLI awaits it or fires-and-forgets before exiting is an implementation detail listed in the implementation plan. |

The implementation checklist lives in `docs/plans/local-crud-shim-implementation.md`; this document
stays the record of evidence and reasoning.

### 13.7 Decision D10 (2026-09-11): host resolution order with `--host`

Martin's target order: 1 CLI flag (`--host https://…`) → 2 env var (`SEMANTIUS_HOST`) → 3 local
project config (`./.env`, project config file) → 4 global user config (`~/.config/semantius/…`) →
5 hard-coded default (managed cloud). Motivation: users with several self-hosted instances.

What already exists in the CLI and maps 1:1:

| Layer | Today | Gap |
|---|---|---|
| 1 flag | `--env <prefix>`, `-c <config>`; no `--host` | add `--host` (and the parse-early treatment `--env` gets in `findEnvPrefix`) |
| 2 env | `${PREFIX}_API_KEY`, `${PREFIX}_ORG`, `${PREFIX}_JWT`; shell env always beats `.env` | add `${PREFIX}_HOST` |
| 3 project | `.env` search: cwd → config-file dir → executable dir (first hit wins); `mcp_servers.json` in cwd | `.env` covers it; `mcp_servers.json` is a separate "servers" layer whose interaction with `--host` must be defined (Q34) |
| 4 global | `.env` in the user config dir, always loaded as fallback for unset vars | covers it; credentials themselves move to `Bun.secrets` keyed by host (Step 5) |
| 5 default | `getDefaultConfig()` → `https://${ORG}.semantius.ai/mcp` etc. | becomes: `SEMANTIUS_ORG` → managed cloud host |

Open sub-questions from this decision: see §14 (Q32–Q36).

### 13.8 Decision D11 (2026-09-11): `--crud-mcp` reactivates the MCP route for `crud`

`crud` defaults to the local PostgREST layer; `--crud-mcp` routes `crud` through the original Deno
MCP server again (same tools, same output). This replaces the earlier idea of a second server name
(`crud-mcp`) as the way back. Implications recorded in the implementation plan: an env-var twin per
the D10 precedence (`${PREFIX}_CRUD_MCP=1`), cloud-only (self-hosted has no MCP: clear error), the
remote crud MCP config must exist internally regardless of the flag because the cloud cache-reset
call (D9) targets it, and the flag is also the A/B switch for the parity tests and the benchmark.

### 13.9 Proposal P12 (2026-09-11, awaiting Martin): credential precedence and forcing PKCE

Requirement: `SEMANTIUS_JWT` and `SEMANTIUS_API_KEY` keep working unchanged; PKCE is the fallback.

Proposed per-invocation order, first match wins: `--auth jwt|apikey|oauth` → `${PREFIX}_JWT` →
`${PREFIX}_API_KEY` → stored OAuth session for (host, prefix), silently refreshed → exit 5 with
"run `semantius login`". The fallback never opens a browser by itself: the CLI is agent-driven, and
an unexpected browser launch inside an agent loop is worse than a clean exit 5 with an instruction.

Forcing PKCE: `semantius login [--host] [--env]` (interactive, stores the session) and
`semantius logout`; plus `--login` as a flag on any command that runs the browser flow first and uses
the new session for that invocation even when a JWT or API key is set.

Open points from this proposal: see §14 (Q37, Q38, Q40).


### 13.10 Decisions D12–D13 and answers batch (Martin, 2026-09-11)

| # | Decision | Effect |
|---|---|---|
| D12 | Self-hosted instances have no analytics MCP server: the `cube` server must be disabled (absent) when the host is self-hosted. | Default config on a self-hosted host contains only `crud` (local layer). `semantius call cube …` and `--crud-mcp` both fail with "not available on self-hosted instances". |
| D13 | Backup/restore is postponed; the first iteration only replaces the MCP route for `crud`. | Q19, Q20, Q25 closed as postponed; R §12.2 stays as the requirements sketch for later. |

Answers to the registry (moved into §14.2 with source "Martin 2026-09-11"): Q1, Q5, Q8, Q11, Q14,
Q15, Q16 (clarified), Q21, Q24, Q27, Q29, Q31, Q32, Q33, Q34, Q35, Q36, Q37, Q38, Q39. Still open:
Q2 (default A stands), Q40 (explanation requested, see §14.1), and three new fact questions Q41–Q43
that fall out of the answers.

### 13.11 Decisions D14–D15 and the last answers (Martin, 2026-09-11)

| # | Decision | Effect |
|---|---|---|
| D14 | Implement cloud first; a review step precedes any self-hosted testing. | The implementation plan gets two phases with a review gate between them: Phase A (cloud: local layer, OAuth, `--crud-mcp`, parity) → review → Phase B (self-hosted: fixed paths, `cube` disabled, self-hosted token exchange, `sendEmail` off). Self-hosted code paths are written in Phase A behind the mode flag but only exercised by unit tests until Phase B. |
| D15 | Architecture (Q2): A (in-process MCP server, byte-compatible) **plus** an additive `--stream` option for raw performance. | `--stream` bypasses the MCP envelope and pipes the PostgREST response body straight to stdout (compact JSON or CSV as returned by PostgREST), no parse, no pretty-print. v1 scope: `postgrestRequest` only (its arguments fully specify the request; typed tools run through vendored handlers that perform the fetch internally). Incompatible with `--single`, `--diag` and `--crud-mcp` (clear error). Exit code from the HTTP status through the existing mapping. Streaming uploads (stdin body → POST) are a later extension. |

Answers: Q40 confirmed; Q41 self-hosted layout: `/.well-known/*` at the host root, `/` is the
Semantius app (UI), `/rest` is the PostgREST endpoint, `/api/auth/token` the token exchange
(so `api_baseurl` = `{host}/api`, `ui_baseurl` = `{host}`, `postgrestUrl` = `{host}/rest`);
Q42 accepted (assume the cloud response shape); Q43 accepted (fixed public client ids; the two
values are supplied at implementation time).

Performance expectation for self-hosted on Windows (no daemon) vs Linux with daemon — estimate,
not measured: the Linux-daemon figure of ≈ 230 ms for a small read (§11.1) is process start
(≈ 120 ms) + a kept-alive socket to Deno + Deno → Neon. The Windows local-layer figure of ≈ 370 ms
(§10, `direct-proc`) is process start + a fresh TLS handshake to Neon in us-east-1 from Europe +
the query. Against a self-hosted PostgREST on the same LAN or region, the TLS handshake and RTT
shrink from ≈ 150–250 ms to ≈ 10–40 ms, so a small read lands around 150–250 ms: comparable to
Linux-with-daemon, without any daemon. Large reads are dominated by transfer and are similar on
both. This is the expectation to verify in Phase B, first measurement on the self-hosted stack.

### 13.12 Second implementation-plan review (2026-09-11) — three "copy unchanged" blockers, fixed in the plan

A second review walked the implementation plan as a weaker model would. Three findings would have
stopped it under the plan's own rule that vendored files are never edited; each was verified here
and the plan was rewritten with the fix:

| Finding (verified) | Fix in the implementation plan |
|---|---|
| Vendored `src/utils/apiKeyAuth.ts` fails the CLI's strict `tsc` (two `TS18046: 'data' is of type 'unknown'`, because `response.json()` is `unknown` under bun types with `lib: ESNext`). | Prerequisite for Martin: a one-line cast upstream; otherwise the file and `get_cli_token.ts` are excluded from the copy set (the CLI does the exchange itself). |
| Vendored `src/utils/postgrest.ts` line 67 (and `refreshSchemaCache.ts` line 16) `console.log` on every request — a server log on Deno, stdout corruption in-process (breaks `jq`, `--single`, parity). | Sanctioned shim in `connection.ts`: redirect `console.log` to `debug()` for the lifetime of a crud call. |
| Upstream `tests/crud-bulk.test.ts` is not "one import rewrite": 23 `Deno.test(` calls, 35 relative imports, one URL import. | The sync script applies exactly three rewrites and `--check` applies the same before comparing. |

Also folded in: an explicit env guard (vendored code would send an unrelated `API_KEY` shell variable
as `apikey`), the per-call context holder for `registerTool`'s `(args, extra)` callback, the SDK
`callTool` timeout (the utils copy uses the 60 s default), org propagation from `--host` into
`getDefaultConfig()`, the `${PREFIX}_API_KEY=''` backfill for OAuth-only sessions, an error text for
`NoCredentialsError` that `isAuthErrorMessage()` maps to exit 5, a precise parity definition
(default stdout vs `--diag` vs `info`), the scratch-entity payload and cleanup, the `--stream`
exit-code table, `login`/`logout` as real subcommands, a non-TTY rule for `--login`, the
`transformConfigWithJwt` gate on header-key presence, and two explicit implementer stop points with
Martin's manual command lists (implementation plan §10).

---

## 14. Question registry (single place for every question; consolidated 2026-09-11, all answers applied)

Numbering is unchanged so older references stay valid. Verification items that are not decisions
stay in §9.3.

### 14.1 Open

None. Values to be supplied at implementation time (not decisions): the two fixed OAuth client ids
(Q43); confirmation of the self-hosted token response shape when Phase B starts (Q42).

### 14.2 Answered

| Q | Answer | Source |
|---|---|---|
| Q2 | Architecture: A (in-process MCP server, byte-compatible) plus an additive `--stream` option for raw performance (`postgrestRequest` in v1). | D15 |
| Q40 | P12 precedence confirmed; no implicit browser launch. | Martin 2026-09-11 |
| Q41 | Self-hosted layout: `/.well-known/*` at the root, `/` = Semantius app, `/rest` = PostgREST, `/api/auth/token` = token exchange; hence `postgrestUrl = {host}/rest`, `api_baseurl = {host}/api`, `ui_baseurl = {host}`. | Martin 2026-09-11 |
| Q42 | Assume the cloud response shape (`access_token`, `expires_in`) for `GET {host}/api/auth/token`; confirm in Phase B. | Martin 2026-09-11 |
| Q43 | Cloud client id = control plane `client_id_cli`; registered redirect URIs `http://127.0.0.1:{53682,53683,53684}/callback` (exact match); the CLI tries the ports in order. Self-hosted id and its registration at Phase B. | Martin 2026-09-11 |
| Q1 | All tools go local (every PostgREST-backed tool; the cloud cache-reset side effect is the only remote call). | Martin 2026-09-11 |
| Q3 | Vendor copy into this repo by a sync script; `postgrest-mcp` owns the code. | D6 |
| Q4 | Local layer is the default for `crud`; `--crud-mcp` / `${PREFIX}_CRUD_MCP=1` switches back (cloud only). | D11 |
| Q5 | The control plane is used for cloud only; self-hosted always gets the host URL explicitly. | Martin 2026-09-11 |
| Q6 | No `apikey` header needed: PostgREST accepts the Bearer token alone. | §9.1 |
| Q7 | The `/token` JWT works directly against PostgREST. | §9.1 |
| Q8 | No enforced payload limits on Deno Deploy today. | Martin 2026-09-11 |
| Q9 | Input validation stays: with architecture A the MCP SDK validates against the same zod schemas. | §4.1, impl §4 |
| Q10 | Cache reset: cloud → remote MCP `refresh_schema_cache`; self-hosted → no-op; pending calls drained before exit. | D9, impl §4 |
| Q11 | Try to include `sqlToRest`; excluding it is acceptable if bundling the WASM parser is not easy. | Martin 2026-09-11 |
| Q12 | `api_baseurl` in cloud mode stays `https://<org>.semantius.ai`; self-hosted per Q29. | impl §4 |
| Q13 | Streaming / CSV / chunked upload deferred with backup/restore. | D13 |
| Q14 | No automatic fallback from the local layer to MCP; errors name `--crud-mcp` (cloud). | Martin 2026-09-11 |
| Q15 | Do not echo the `authorization` header in the `postgrestRequest` envelope; the parity test normalises it. | Martin 2026-09-11 |
| Q16 | Clarified: cli-auth needs no extra cache — it keeps the `TokenSet` (access + refresh token) in its `Storage` (`Bun.secrets` / file); the existing encrypted file cache stays for JWTs minted from API keys. Q16 was about the **host-resolution** cache: on self-hosted there is nothing to cache (fixed paths); on cloud the control-plane lookup (`postgrest_url` is a per-tenant Neon URL, not derivable from the host) is cached on disk in the user config dir, keyed by host, 24 h TTL, cleared by the same reset flag as the JWT cache. | Martin 2026-09-11 + implementer default |
| Q17 | Daemon fixed; committed `9ac9574`, unreleased. | §11 |
| Q18 | Skills/docs stay transport-transparent; only `--crud-mcp` is mentioned. | D11, impl §6 |
| Q19 | Postponed with backup/restore. | D13 |
| Q20 | Postponed with backup/restore. | D13 |
| Q21 | Self-hosted API-key exchange exists: `GET {baseUrl}/api/auth/token` with an `x-api-key` header (semantius-idp FR-KEY-3, spec-v1.md:161; docs/clients.md:279); same endpoint as the first-party session exchange (FR-OIDC-14). Note it is GET on `/api/auth/token`, whereas cloud is `POST /token` form-encoded — the exchange needs two shapes. Response shape → Q42. | Martin 2026-09-11 |
| Q22 | Self-hosted schema cache: `pg_semantius` resets it itself. | D5 |
| Q23 | The Deno server stays the MCP endpoint for remote clients and keeps owning the tool code. | D6, §13.4 |
| Q24 | Deno cost per call is not tracked. | Martin 2026-09-11 |
| Q25 | Postponed with backup/restore. | D13 |
| Q26 | One host value: `--host` / `${PREFIX}_HOST` with the D10 precedence. | D10 |
| Q27 | Cloud: the CLI client id is delivered by the control plane as `client_id_cli` (verified for `tests`, 2026-09-11); self-hosted: one fixed id shipped in the CLI (value at Phase B). | Martin 2026-09-11 |
| Q28 | Headless secret storage: cli-auth `fileStorage` fallback. | D8 |
| Q29 | Self-hosted: only the API URL exists; `semantius_org` is not available (null); `ui_baseurl` = the API URL with `/api` removed; `sendEmail` disabled or no-op. | Martin 2026-09-11 |
| Q30 | Superseded by D9. | D9 |
| Q31 | Login UX defaults accepted: OS opener (`start`/`open`/`xdg-open`), 5-minute timeout, `Bun.secrets` `service=semantius`, `name=<prefix>:<host>`. | Martin 2026-09-11 |
| Q32 | Self-hosted host resolves via host name plus fixed API paths (no descriptor endpoint). Exact paths → Q41. | Martin 2026-09-11 |
| Q33 | `--host <org>.semantius.cloud` works for cloud tenants; `SEMANTIUS_ORG` is sugar for it. | Martin 2026-09-11 |
| Q34 | An explicit `mcp_servers.json` `crud` entry with `url`/`command` keeps today's MCP/stdio behaviour; the local layer applies to `{ "postgrest": … }` entries and the default config. | Martin 2026-09-11 |
| Q35 | Sessions, host cache and daemon socket/pid names are keyed by host. | Martin 2026-09-11 |
| Q36 | No `--profile`: one profile per host (the host *is* the profile). | Martin 2026-09-11 |
| Q37 | `login` does not persist a preference; the explicit precedence order applies. | Martin 2026-09-11 |
| Q38 | Spelling as written: `--auth jwt|apikey|oauth`, `--login`, `login` / `logout`. | Martin 2026-09-11 |
| Q39 | Cloud-host rule: a host is cloud iff it matches `*.semantius.cloud` (org = first label); everything else is self-hosted. | Martin 2026-09-11 |
| — | Device code: not in v1. | D7 |
| — | OAuth client library: cli-auth. | D8 |
| — | Cache reset "await vs fire-and-forget": drain before exit with a bounded timeout. | impl §4 |
| — | Self-hosted has no analytics MCP server; `cube` is disabled there. | D12 |

### 14.3 Not decisions, still unverified

See §9.3. None blocks the implementation plan.
