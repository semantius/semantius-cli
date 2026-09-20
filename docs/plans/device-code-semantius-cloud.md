# Plan: device code grant on semantius-cloud

Status: **blocked by repo policy — not schedulable as written.** Raised 2026-09-20, revised
after review.

> **Move this file into `semantius-cloud` before starting** — its `AGENTS.md` §"Docs Boundary"
> designates `docs/` as "repo/codebase docs for agents and contributors". It was written in
> `semantius-cli` only because the CLI plan motivating it lives there.

Purpose: let `semantius-cli` complete a login on a headless box against the **managed cloud**,
`<org>.semantius.cloud`. The CLI half is `headless-login-device-code.md`; the self-hosted IdP is
`device-code-semantius-idp.md`.

**This is the last of the three IdPs to benefit, and by some distance.** Entra-backed
deployments work as soon as the CLI ships. semantius-idp needs a spec amendment and config work
on a current dependency. The managed cloud needs a dependency pin lifted that the repo has
explicitly set against.

References verified 2026-09-20 against `C:\dev\semantius-cloud`.

---

## 1. The blocker is a policy, not a risk

`packages/better-auth/src/auth.ts:214` registers `oauthProvider()`, so cloud **is** an OAuth
provider — the dependency lives in `packages/better-auth/package.json:31` as `catalog:`, not in
`apps/web/package.json`, which is why a naive check misses it.

`AGENTS.md`, Upstream Sync Policy:

> **Better Auth pinned at 1.5.5** (local bug/limit fixes depend on it). **Never bump to 1.6.x.**
> Upstream code using 1.6-only APIs must be adapted (e.g. `consumeVerificationValue` → find +
> delete in `packages/otp/src/server/verification-binding.store.ts`; `CheckoutSessionLocale`
> local alias in `packages/billing/stripe/src/stripe-provider.ts`).

and the ported-from-1.8.6 line records **"Skipped: BA 1.6"**.

Installed 1.5.5 contains **zero** device-code symbols — no `oauthDeviceAuthorization`, no
`DEVICE_CODE_GRANT_TYPE`, no device-authorization plugin. The feature cannot be configured,
only upgraded to. And the upgrade is the thing the repo has said no to.

### Step 0 — the actual first step

Before any of this is schedulable, someone has to:

1. **Enumerate the "local bug/limit fixes [that] depend on it"** that `AGENTS.md` cites but does
   not list. That list is the real cost of the bump and nobody has written it down.
2. **Get the owner to lift or scope the pin.** A green test suite is not authority here.
3. Decide whether device code on the managed cloud is worth that, given headless cloud users
   already get the CLI's honest failure pointing at an API key — a real improvement over
   today's 5-minute stall, costing this repo nothing.

**A reasonable outcome of Step 0 is "no".** Nothing in the CLI plan depends on this landing.

---

## 2. Before anything: find out who serves the cloud's RFC 8414 document

**There is no `/.well-known/oauth-authorization-server` route in this repo.** `apps/web/app`
has only `.well-known/workflow`; `apps/web/proxy.ts:13-14` excludes `api/.*` from the matcher;
no `oauthProviderAuthServerMetadata` / `getOAuthServerConfig` call exists in `apps/` or
`packages/`.

Yet the CLI fetches `https://<org>.semantius.cloud/.well-known/oauth-protected-resource`, then
`https://<org>.semantius.cloud/.well-known/oauth-authorization-server/api/auth`, and
**hard-fails** unless that document's `issuer` byte-equals the RFC 9728 `authorization_servers[0]`
(`semantius-cli/src/auth/provider.ts:193-199`), then compares the callback `iss` against it
(`src/auth/session.ts:497-510`).

So either something outside this repo synthesises the per-org RFC 8414 document — most likely
the `*.semantius.cloud` tenant gateway that also serves `/token` and `/rest` — or cloud logins
would already be failing. **Find that component first.** It, not `packages/better-auth`, is
what has to advertise `device_authorization_endpoint` for the CLI's legacy chain to see it, and
it is not in any of these three plans' scope.

Until this is answered, Step 2 below cannot be specified, only guessed at.

**Done when:** the component that serves the cloud's RFC 8414 document is identified by name
and repo, and its role is recorded in this plan.

---

## 3. Steps, once Step 0 and §2 clear

### Step 1 — upgrade `@better-auth/oauth-provider` 1.5.5 → 1.7.x

Couplings to re-verify:

**(a) The replicated hasher — already checked, not a risk.** An earlier draft called this the
top risk. It isn't: 1.5.5's `defaultHasher` and 1.7.1's are **character-identical** (SHA-256 →
unpadded base64url), and `storeClientSecret` still defaults to `"hashed"` in both. The
fixed-vector test at `packages/organization/core/src/services/__tests__/oauth-clients.service.test.ts:50-53`
will pass unchanged. Run it first anyway — it is cheap and it is the guard the docstring at
`oauth-clients.service.ts:19-26` asks for — but do not plan around it.

**(b) The tenant issuer hook.** `packages/better-auth/src/utils/oauth-tenant-issuer-hook.ts`
rewrites `ctx.context.baseURL` per organization so each org is its own logical authorization
server. Confirm 1.7.x still derives the issuer from `ctx.context.baseURL` at every endpoint —
the hook is built entirely on that assumption. See Step 3.

**(c) The OAuth client schema and tables.** `packages/organization/core/src/schemas/oauth-clients.schema.ts:51`
mirrors the plugin's `SafeUrlSchema`; `packages/database/src/schema/schema.ts:65` holds the
provider tables — whose own comment scopes them to *"the MCP server"*, a surface worth checking
since 1.5.5 also exports `mcpHandler`.

**(d) The client plugin.** `packages/better-auth/src/auth-client.ts:3` imports
`oauthProviderClient` from `@better-auth/oauth-provider/client` — a client-side API surface that
moves in lockstep and that no test under `packages/better-auth/src/utils/__tests__/` exercises.

Unrelated despite the version match: `packages/billing/stripe/src/stripe-provider.ts:8` pins
1.5.5 for a Stripe *type*.

**Done when:** the hasher test passes, the OAuth suites pass, and a normal authorization-code
CLI login against a cloud org still works end to end. **Release it alone**, before any
device-code work — it is the risky part, and bundling it makes a regression hard to attribute.

### Step 2 — register the device grant

Add `oauthDeviceAuthorization()` alongside `oauthProvider()` at
`packages/better-auth/src/auth.ts:214`; run the migration.

Unlike semantius-idp, cloud passes **no `grantTypes`** to `oauthProvider()` — it relies on
defaults, and sets `allowDynamicClientRegistration: true` and `accessTokenJWT: true`. There is
no allowlist to widen; decide instead whether **DCR clients** should be able to request the
device grant at all, since registration is open here in a way it is not on the self-hosted IdP.

Per-client `grantTypes` must include the device grant **in addition to** `authorization_code`,
never replacing it — `clientAllowsGrant` returns true for `refresh_token` only when
`authorization_code` remains in the list, so replacing it silently kills refresh tokens.

**Done when:** whatever §2 identified as the owner of the RFC 8414 document advertises
`device_authorization_endpoint` — that is the document the CLI's legacy chain fetches, so
OIDC-only advertisement is not enough.

### Step 3 — the tenant issuer hook and `/device/code`

`oauth-tenant-issuer-hook.ts:21` gates on `OAUTH_PATH_PREFIX = '/oauth2/'` and returns early at
`:49-51`; the device authorization endpoint is `/device/code`, outside that prefix.

**What this does and does not break** — an earlier draft got the category wrong:

- **The issuer is fine.** A device login's `iss` lands in the token minted at `/oauth2/token`,
  which *does* match the prefix; the CLI's poll posts `client_id` in the body and `getClientId`
  reads `body?.client_id` (`:96`), so the org resolves. This is **not** an RFC 9207 failure.
- **The verification URI is not.** `buildVerificationUris(opts.verificationUri, ctx.context.baseURL, userCode)`
  means users of `acme` are sent to `https://app.semantius.com/device` instead of their org's
  host. A real multi-tenancy defect — but a tenancy/UX one, and fixing it as an issuer bug
  would put the fix in the wrong place.
- **Widening the prefix cannot make discovery per-tenant.** The metadata endpoint is
  `createAuthEndpoint("/.well-known/oauth-authorization-server", …)` — outside the prefix *and*
  carrying no `client_id`, so `getClientId(ctx)` returns `null` and the hook returns at `:62-64`
  regardless. This is the same fact §2 is about.
- **`/device/token` needs nothing.** The 1.7.1 extension deliberately rejects OAuth-owned device
  codes there, directing them to `/oauth2/token`.

Work: extend the hook to cover `/device/code` for the verification URI (that path does carry
`client_id` — the body schema adds `client_id: z.string().optional()` and `authorizeRequest`
requires it, so the existing `getClientId(ctx)` reuse is mechanically sound). Re-derive the path
list from 1.7.x's code rather than trusting this one; a prefix constant is exactly what a
version bump invalidates.

**Done when:** a device authorization request for an org client produces that org's
verification URI, covered by a test alongside
`packages/better-auth/src/utils/__tests__/oauth-issuer-response.test.ts`.

### Step 4 — the verification page

`verificationUri` defaults to `/device`, separate from `/device/code`. Cloud has its own auth UI
(`loginPage: '/auth/sign-in'`, `consentPage: '/auth/consent'`), so the page must fit that
surface rather than land on an unstyled default, be reachable per-org, and carry the same
protections as the consent page — authenticated, CSRF-protected, rate-limited against guessing
an 8-character code.

**Done when:** branded, per-org reachable, and protected like `/auth/consent`.

---

## 4. Verification

From a box with no browser, against a cloud org:

1. `semantius login --host <org>.semantius.cloud` picks device code and prints a code + URI
2. the URI is on the **org's** host (Step 3)
3. approving elsewhere completes the poll; `semantius whoami` reports the right org
4. the `iss` in the token is the org's issuer

Negative: unregistered — the state until this ships — the CLI falls back to the honest failure,
not a stall.

---

## 5. Sequencing

0. **Step 0** — enumerate the pin's dependants, get a decision. May end here, legitimately.
1. **§2** — identify who serves the RFC 8414 document. Needed regardless; the answer may move
   most of this plan to another repo.
2. **Step 1 alone**, released on its own.
3. Steps 2-4 together.

There is **no pressure from the CLI** on any of this: headless cloud users get the honest
failure and an API key path, which requires nothing from this repo.
