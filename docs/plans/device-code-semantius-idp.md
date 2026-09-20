# Plan: device code grant on semantius-idp

Status: open, **needs a spec amendment before any code**. Raised 2026-09-20, revised after
review.

> **Move this file into `semantius-idp` before starting.** Its `AGENTS.md` opens: *"Everything
> an agent must remember lives here, in the repository. Not in a per-user memory store outside
> it — that is invisible to review, invisible to every other agent and to every human."* A plan
> for that repo sitting in `semantius-cli` is exactly what that rule forbids. It was written
> here only because the CLI plan motivating it lives here. `semantius-idp/docs/` already holds
> `admin-api.md`, `clients.md`, `configuration.md`, `release.md`, `runbooks.md` — it belongs
> there.

Purpose: let `semantius-cli` complete a login on a headless box against a **self-hosted**
instance using the bundled IdP. The CLI half is `headless-login-device-code.md`.

References verified 2026-09-20 against `C:\dev\semantius-idp`.

---

## 1. Read this before assuming the prohibition was deliberate

`spec-v1.md:193`, FR-OIDC-1:

> Supported: `authorization_code` with **PKCE S256 only** … and `refresh_token` — **these two
> only** (D26). … `client_credentials`, implicit, hybrid, ROPC and **device-code are disabled,
> rejected with `unsupported_grant_type`, and absent from `grant_types_supported` in
> discovery**.

**But D26 is not about device code.** The decision log (§12.1, *Owner decisions*, 2026-08-23):

> **D26** — *No machine-to-machine support in v1: the `client_credentials` grant, the `service`
> client type, `clientCredentialsScopes` and `oauth.m2mAccessTokenTtl` are removed; "API keys" =
> per-user keys (FR-KEY) only.*

Device code appears nowhere in it. The `(D26)` citation in FR-OIDC-1 attaches to the *supported
pair*; device code was swept into the prose list of everything else, alongside items that are
different in kind — implicit and hybrid are legacy, ROPC is unsafe, `client_credentials` was a
deliberate scope cut with its own decision. Device code is none of those.

So **there is no owner decision to overturn** — only a spec line to amend, and a genuine design
question (§2) that the default-deny posture happened to sidestep.

Do not treat this section as authority to skip the amendment. `AGENTS.md` makes `spec-v1.md`
mandatory reading and says *"The owner decides. Ask."*; `CONTRIBUTING.md` documents how to
amend. What this section establishes is that the amendment is a **first decision**, not a
reversal.

---

## 2. The real design question: PKCE

FR-OIDC-1 also mandates **"PKCE mandatory for public clients"**, and FR-OIDC-3 gives public
clients `requirePKCE` default true. The device grant is a public-client grant **with no PKCE** —
RFC 8628 substitutes its own user-interaction step (the user must fetch the verification URI
and enter a short code out of band) for the code-interception defence PKCE provides.

This is the substantive question for the amendment, and it should be answered on the merits:

- PKCE defends against **authorization-code interception** on the redirect. A device flow has
  no redirect and no code travelling through a user agent, so the attack PKCE closes does not
  exist in the same shape.
- What replaces it is user verification plus the rate/entropy properties of the user code —
  which is why §4's rate limiting is not optional.

Whatever is decided, the amendment should say *why*, so the next reader does not see a second
"public client without PKCE" line and assume it was another oversight.

**Note for the amendment:** the implementation cannot enforce PKCE here even if the spec kept
demanding it — `isPKCERequired` is called only from `/oauth2/authorize` and the
authorization-code grant handler; `exchangeOAuthDeviceCode` never reaches it. So the spec and
the plugin would silently disagree.

---

## 3. Steps

### Step 1 — amend FR-OIDC-1 (blocking; no code before this)

New D-number, owner sign-off, per `CONTRIBUTING.md`. It must cover:

- removing device-code from FR-OIDC-1's disabled list and adding it to the supported set
- the PKCE carve-out from §2, with reasoning
- `FR-OIDC-3`'s client schema: `grantTypes` is currently `⊆ ["authorization_code", "refresh_token"]`
- `CFG-5`'s startup cross-checks (`spec-v1.md:347`)
- `TST-4`, which **asserts the negative** (`spec-v1.md:429`) and will fail the moment the grant
  is enabled
- `spec-v1.md:199`'s AC list, which names the rejection as expected behaviour

**Done when:** the amendment is merged with a D-number, and TST-4's expectation is inverted in
the same change.

### Step 2 — open the config allowlist

`apps/web/src/server/config/schema/clients-schema.ts:35-38`:

```ts
export const SUPPORTED_GRANT_TYPES = [
  "authorization_code",
  "refresh_token",
] as const
```

validated at `:78`, rejected at `:89`. Widen it so a config naming the device grant parses.

**`instance.ts:480` does not need editing** — settled, no test required:
`getSupportedGrantTypes` unions the server options with registered extension grants
(`@better-auth/oauth-provider/dist/utils-*.mjs:153-155`), feeding both `grant_types_supported`
and the token-endpoint gate. Registering the plugin adds the grant to dispatch and discovery on
its own.

That has a consequence worth recording: the comment at `instance.ts:477-479` — *"these two
grants and nothing else… discovery never advertises it"* — **becomes false** the moment any
extension grant registers. The allowlist there is not the policy surface it reads as. Correct
the comment in this step.

**Done when:** a config naming the device grant parses, and the misleading comment is fixed.

### Step 3 — register the plugin and migrate

Add `oauthDeviceAuthorization()` alongside `oauthProvider()` at
`apps/web/src/server/auth/instance.ts:472`; run the device-authorization migration.

It is **not an alternative to** `better-auth`'s `deviceAuthorization` but a composition of it,
and it throws if a bare `deviceAuthorization()` is already registered or if `oauthProvider()` is
absent. The dependency is already current — `apps/web/package.json:27-37` pins `better-auth`,
`@better-auth/core`, `@better-auth/api-key` and `@better-auth/oauth-provider` all at **1.7.1**,
which exports it. **No version bump needed**, unlike semantius-cloud.

**Done when:** `device_authorization_endpoint` appears in discovery and
`urn:ietf:params:oauth:grant-type:device_code` in `grant_types_supported`.

### Step 4 — let the CLI client use the grant — *additively*

`clientAllowsGrant` defaults to `["authorization_code"]` and `validateClientCredentials` throws
`unauthorized_client` unless the client's `grantTypes` includes the grant. So the CLI's client
record needs the device grant **in addition to** what it already has — never replacing it.

**This is the trap:** refresh-token issuance is gated by
`isRefreshToken = user && clientAllowsGrant(client, "refresh_token") && …offline_access…`, and
`clientAllowsGrant` returns true for `refresh_token` only when **`authorization_code` is still
in the list**. Dropping it to "device grant only" silently kills refresh tokens for that
client, so every headless user re-runs the whole device flow at each token expiry. The CLI does
request `offline_access` (`semantius-cli/src/auth/provider.ts:54`).

Persisting it touches the reconcile path (`apps/web/src/server/oidc/reconcile.ts:226`, where
`"grantTypes"` is in `OWNED_COLUMNS`) and the auth schema
(`apps/web/src/server/db/schema/auth-schema.ts:242`), so an **upgraded** deployment's stored
client is corrected, not only freshly registered ones.

**Done when:** an upgraded deployment's existing CLI client completes the device grant **and**
still receives refresh tokens — assert both in one test.

*(An earlier draft worried that `isPKCERequired` would refuse `offline_access` without PKCE.
It does not apply: that check is reachable only from `/oauth2/authorize` and the
authorization-code grant. The real gate is the composition above.)*

### Step 5 — the verification page

`verificationUri` defaults to `/device`, distinct from the `/device/code` endpoint. Since the
page takes a user code and grants a session-bearing approval, it needs the same treatment as
the consent page: authenticated, CSRF-protected, and **rate-limited against code guessing** —
the default user code is 8 characters, and with PKCE absent (§2) this is a load-bearing control,
not a nicety.

Confirm both paths are reachable on the instance's **public** origin, not just the internal
base URL. Note `spec-v1.md`'s D2 requires sub-path deployment to work (OPS-10, FR-OIDC-15), so
test under a sub-path too.

**Done when:** the page is authenticated, rate-limited, and works under a sub-path deployment.

---

## 4. Verification

From a box with no browser, against a self-hosted instance:

1. `semantius login --host <instance>` picks device code, prints a user code and verification URI
2. approving in a browser on another device completes the poll
3. `semantius whoami` reports `auth_method: oauth`
4. the session survives an access-token expiry without re-authorising (Step 4)

Negative: with the plugin unregistered the CLI must fall back to the honest failure from
`headless-login-device-code.md` Step 4 — not a stall. That is every deployment's state until
this ships, so it is the more common path.

---

## 5. Anchors

- `apps/web/src/server/auth/instance.ts:472` — `oauthProvider()` alone today; anchor for Step 3
- Plugin defaults: `expiresIn: "30m"`, `interval: "5s"`, `userCodeLength: 8`
- This repo's own `release.sh`, CI gates and `AGENTS.md` conventions apply throughout
