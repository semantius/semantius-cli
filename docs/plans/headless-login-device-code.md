# Plan: headless login — detect, use device code, or say so

Status: open. Raised 2026-09-20 from the `use-semantius` command audit
(`skill-command-coverage.md` §4). Revised twice after adversarial review; findings from the
second round are marked **[r2]**.

Scope: **`semantius-cli` only**. Server-side work is not scoped here — §6 names what each IdP
needs; the repo plans are `device-code-semantius-cloud.md` and `device-code-semantius-idp.md`.

Goal: **detect a headless environment; use the device code grant when the IdP advertises it;
when it does not, fail immediately with advice that actually works on this host.** No silent
stalling in any case.

Line references verified 2026-09-20.

---

## 1. The bug today

`semantius login` on a headless box:

1. prints `Opening the browser to sign in:` plus the URL (`src/auth/session.ts:398`)
2. spawns `xdg-open` with `stdout`/`stderr` `'ignore'`, no exit-code check, and a missing binary
   caught into `debug()` (`src/auth/session.ts:799-811`) — the failure never surfaces
3. waits on a loopback callback for `LOGIN_TIMEOUT_MS` = 5 minutes (`src/auth/session.ts:54`),
   then fails with `no response from the browser within 5 minutes`

A 5-minute stall ending in a message that blames the browser, after a message that claimed a
browser was opened.

Three entry points reach this:

- `semantius login` — `loginCommand()` has **no TTY guard** (`src/commands/auth.ts:18-31`)
- `semantius use <host>` — signs in when there is no stored session
  (`src/commands/hosts.ts:217-222`), dispatched at `src/index.ts:1199-1204`
- the `--login` flag — the only guarded path, `process.stdin.isTTY` at `src/index.ts:1270`

### Why pasting the URL is not the fix

The callback is a loopback redirect to `127.0.0.1`, first free of ports 53682/53683/53684
(`src/auth/session.ts:49-51`, `pickCallback` at `:773-790`). Pasting the URL into a browser on
another machine sends the IdP's redirect to *that* machine's localhost. It completes only when
the browser shares localhost with the CLI: same machine, WSL, or an `ssh -L` forward.

---

## 2. What already exists

| Side | Status |
|---|---|
| **CLI client** | `cli-auth` implements `strategy: "device-code"`. `DeviceCodeConfig = BaseConfig & {strategy}` (`config.d.ts:175-181`), so `resource`, `scope`, `storage` and `tokenRefreshThreshold` carry over. `onAuthorization` receives `{userCode, verificationUri, verificationUriComplete?, expiresIn}`. |
| **Storage / session layer** | **Works unchanged.** `DeviceCodeAuth.login` ends in `tokenManager.save(e)` with no options (`cli-auth/dist/index.js:214`) — same empty-cache-key behaviour as authorization-code — so `labelStoredTokens` (`session.ts:455-486`) relabels correctly. `storageFor` is keyed by host only. `resource` is forwarded on the device request (`index.js:173`) and every poll (`:206`), so "one host, one audience" holds. |
| **Refresh** | Device sessions refresh through an `authorization-code` `Auth` — both use the shared plain refresh_token helper (`cli-auth/dist/index.js:155-161`). |
| **CLI metadata plumbing** | **The gap.** Step 2. |

`oauthDeviceAuthorization()` is exported by `@better-auth/oauth-provider`. It is **not an
alternative to** `deviceAuthorization` but a **composition of it** —
`{...deviceAuthorization({...options, grant}), init}` — and it throws if a bare
`deviceAuthorization()` is already registered, or if `oauthProvider()`/`mcp()` is absent [r2].

---

## 3. Which IdPs can serve it

| IdP | Advertises | Reached by | Work |
|---|---|---|---|
| **Entra** | ✅ `.../oauth2/v2.0/devicecode` | platform chain | **None in code** — one deployment toggle, §6 |
| **Google** | ✅ | platform chain | None |
| **semantius-idp** (self-hosted) | ❌ | platform chain | `device-code-semantius-idp.md` |
| **semantius-cloud** (managed) | ❌ | legacy chain | `device-code-semantius-cloud.md` |

Entra serves no RFC 8414 document (404), which does not matter: Entra-backed deployments take
the **platform chain**, whose `idp_well_known` is "an OIDC discovery URL taken verbatim"
(`src/auth/provider.ts:5-6`), and that document carries the field. `platformDocUrl` returns
`null` for cloud hosts (`src/auth/platform.ts:58-70`), so the two chains map cleanly onto the
two IdPs.

No change to `/.well-known/semantius.json`: the endpoint comes from the OIDC document it points
at. `CLAUDE.md` governs that schema tightly.

---

## 4. Steps

### Step 1 — report environment facts, decide nothing

Three pure predicates; Step 3 makes the decision.

**`hasLocalBrowser()`** — Linux: `!DISPLAY && !WAYLAND_DISPLAY`, but honour **`$BROWSER`**
first (the POSIX way to name a URL opener; `xdg-open` honours it and VS Code Remote-SSH sets
it — without this, Remote-SSH regresses, since loopback genuinely works there). Read
`process.env` directly (`CLAUDE.md`, the `os.homedir()` rule).

**This predicate is weak on macOS and Windows**, where there is no `DISPLAY` and the naive
answer is "always". Misclassified: macOS-over-SSH, Windows-over-SSH/WinRM, Session-0 services,
Server Core. Step 5 is the correction, not this predicate.

**`isCi()`** — `process.env.CI`, treating `"false"` and `"0"` as not-CI (non-empty strings that
a truthiness check gets wrong). A TTY does not clear it: nobody tails a build log to approve a
code inside its expiry.

**`canShowUser()`** — `process.stdout.isTTY || process.stderr.isTTY`; print to whichever is a
terminal. Not stderr alone — stderr carries all diagnostics here, and `stderr.isTTY` is false
under MSYS/mintty, this repo's own shell.

**Not `stdin.isTTY`.** Device code needs no stdin: the user reads a code and types it into a
browser elsewhere. The codebase already documents why stdin is a poor signal
(`src/commands/call.ts:97-102`). Note this **removes a live guard** — the `--login` check at
`src/index.ts:1270`, which today exits **1** with `Error [LOGIN_FAILED]: --login needs an
interactive terminal` [r2]. No test asserts that code, but the change is deliberate and should
be declared in the commit.

Keep the attendedness signals apart: loopback needs no output from us, so only `isCi()` blocks
it; device code needs the code read, so `canShowUser()` blocks that and only that.

**Done when:** three pure predicates, no I/O, unit-tested for the Linux matrix, `$BROWSER` with
no `DISPLAY`, the Windows/macOS answer, `CI=true` with a TTY, and `CI=false`. Tests must
**save and restore** `process.env` around each case — `bun test` runs in-band — and the "not
CI" case must **delete** `CI`, which is already set on every runner [r2].

### Step 2 — carry `device_authorization_endpoint` through discovery

Four locations:

1. `OAuthMetadata` — add `deviceAuthorizationEndpoint?: string` (`src/host.ts:100-112`)
2. platform chain — `record(host, {...})`, `src/auth/provider.ts:158-169`
3. legacy chain — `record(...)`, `src/auth/provider.ts:209-218`
4. **`createAuth`'s provider metadata** — `src/auth/session.ts:630-636` rebuilds
   `provider.metadata` field by field and silently drops anything not listed. Without this,
   cli-auth throws `deviceAuthorizationEndpoint is required for device-code strategy` and
   Steps 1 and 3 look correct while never working.

`createAuth` is called from exactly three sites — `session.ts:220` (token/refresh), `:383`
(login), `:538` (revoke) — and `type Auth = ReturnType<typeof createCliAuth<'authorization-code'>>`
(`session.ts:65`) must widen to a union. Only `:383` changes strategy.

**Security: the device endpoint needs the issuer-origin check, not just `requireSecure()`.**
`issuerMismatch` (`session.ts:497-510`) is the CLI's only defence against a metadata mix-up,
and it runs on the **loopback callback**, which a device flow has none of — so it and
`issParameterSupported` are dead on that path. Move the compensating control into discovery:
bind `device_authorization_endpoint` to the issuer's origin exactly as the platform chain binds
`authorization_endpoint` (`provider.ts:145-149`).

**Done when:** both chains surface the endpoint, a non-issuer-origin device endpoint is
refused, and — critically — the test **drives `login()`** against a stub device endpoint.
cli-auth throws this inside `login()` (`dist/index.js:171-172`), not in the constructor, so an
"Auth constructs without throwing" assertion passes whether or not location 4 was done [r2].

### Step 3 — select the grant

**The gate runs inside `login()`, immediately after the discovery calls at
`src/auth/session.ts:366-370`** — a change from the earlier "at the three entry points" [r2].
The intent behind that choice was *after discovery*, and this preserves it while fixing what
entry-point placement could not:

- the entry points do **no** discovery today (`commands/auth.ts:18-31`,
  `commands/hosts.ts:217-222`, `index.ts:1199-1204`). Gating there means calling
  `getOAuthMetadata` again: without `rediscover` it reads the 24 h disk cache, where an entry
  written by an older CLI has `deviceAuthorizationEndpoint === undefined` and silently demotes
  a device-capable host to Step 4's failure; with `rediscover` it doubles every login's round
  trips, since `login()` rediscovers again at `:366-370`.
- `login()` already has fresh metadata, so the gate is free there.
- all three entry points funnel through it, so none can be left ungated.

The cost is that **in-process tests now hit the gate** and must opt out via the override below:
the 38 `await login(...)` calls in `tests/auth.test.ts`, the four `await loginCommand({openUrl})`
calls at `tests/auth.test.ts:1554, 1562, 1578, 1582`, and `useCommand` at
`tests/commands-hosts.test.ts:290` [r2]. That is ordinary test setup, in the same class as the
`openUrl` stub `CLAUDE.md` already requires.

Discovery failures still surface first, so `tests/acceptance-hosts.test.ts:177-188`
(`login --host 127.0.0.1:1` → exit 1, `could not reach`) and
`tests/commands-hosts.test.ts:372-378` pass unchanged. Both spawn helpers pass the parent env
through, so `CI=true` reaches the child on a runner — which is exactly why the gate must sit
after discovery, not before.

Ordered cascade, first match wins:

| # | Condition | Outcome |
|---|---|---|
| 1 | `--login-flow browser` | loopback, unconditionally (the test/override path) |
| 2 | `--login-flow device` | device code; error if no endpoint advertised |
| 3 | `isCi()` | fail fast → Step 4 |
| 4 | `hasLocalBrowser()` | **loopback** |
| 5 | endpoint advertised **and** `canShowUser()` | **device code** |
| 6 | otherwise | fail fast → Step 4 |

Rows 1-2 **deliberately outrank the CI guard** — they are escape hatches, and tests need row 1
on a runner where `isCi()` is true. State that explicitly in the help text [r2].

Row 4 does not consult `canShowUser()`: loopback needs no output from us, so
`semantius login 2>log.txt` on a desktop must still work. Row 5 needs both conjuncts.

Select on the advertised endpoint, **never on `idp_type`** (`CLAUDE.md`).

**Keep a CLI-side ceiling on the device poll** [r2]. cli-auth's loop is
`for (; Date.now() < p;)` with no `AbortSignal` (`dist/index.js:197-230`) and the server's
`expires_in` defaults to 30 minutes. Replacing `LOGIN_TIMEOUT_MS`'s `Promise.race`
(`session.ts:403-420`) with nothing turns today's bounded 5-minute stall into an unbounded
30-minute one — the plan's own opening complaint, made worse. Use a device-specific timeout
that is generous relative to a human walking to another device but still finite, and make row 2
in CI fail on it rather than hang.

**`--login-flow auto|browser|device`**: add to `parseArgs` (which rejects unknown options), to
`--help`, and mirror as a **prefixed** env var via `prefixedEnvName('LOGIN_FLOW')` — the prefix
is configurable (`src/config.ts:211-227, 343-345`).

**Done when:** the full suite passes on `ubuntu-latest` and `windows-latest`; the only test
changes are flow overrides at in-process login call sites; and the device path is covered as
described in Step 6.

### Step 4 — the honest failure

Rows 3 and 6. Fail **before** printing "Opening the browser" and before any wait. Exit **5**
(`AUTH_ERROR`, `src/errors.ts:26`), which needs an explicit exit or classification alongside
`NoCredentialsError` — `main().catch()` exits `CLIENT_ERROR` at `src/index.ts:1366`.

**The advice has to be inverted, not extended** [r2]. `noCredentialsHint`
(`src/auth/token.ts:52-67`, module-private) is the right *place* and the wrong *text*: all
three of its branches end in "Run `semantius login`" — the command that just failed. And on a
session-only host there is **no credential that works**: with `--host` or a current host, env
credentials are ignored outright (`isSessionOnlyHost()`, `src/config.ts:490-492`;
`ignoreEnvCredentials()`, `src/index.ts:1220-1221`). So the goal "name the credential that will
work" is unreachable there without first changing how the host was resolved. The honest text
is:

- **`--host X`** → "drop `--host` and set `${PREFIX}_HOST=X` with `${PREFIX}_API_KEY`"
- **current host** → "`semantius use --clear`, then set `${PREFIX}_HOST` + `${PREFIX}_API_KEY`"
- **neither** → "set `${PREFIX}_API_KEY`" (today's advice, which is correct only here)

Name **which** of the three reasons applies: CI, no advertised endpoint, or no way to display
the code. For the loopback-adjacent case mention `ssh -L` with the **candidate port list**, not
a chosen port — the gate fires before `pickCallback` runs (`session.ts:380`), calling it early
has a socket side effect and can itself throw, and on a platform-document host the candidates
come from `platform.redirects`.

Use `prefixedEnvName()` throughout, never literal names.

**Done when:** the failure is immediate relative to the 5-minute stall (it does pay discovery —
sub-second is not achievable for any row, since the gate runs after `:366-370` [r2]), names the
applicable reason, and gives advice that works for `--host`, for a current host, and for
neither.

### Step 5 — make `openBrowser` report its own failure

`openBrowser` (`session.ts:799-811`) spawns with output ignored and never reads an exit code.
Steps 1-4 only *predict*; this is the only observation.

**Scope it as diagnosis, not as a live fallback** [r2]. A fallback to device code from here is
not reachable: `onAuthorization` is synchronous (`(url: string) => void`), the CLI prints at
`:398` and spawns at `:399`, and by the time a spawn result exists `auth.login()` is in flight
with a bound loopback server and no abort. Building a second `Auth` would mean abandoning the
first and leaking its listener until process exit.

So: **reorder print and spawn** so the claim follows the attempt, and on a spawn error abort
the wait with Step 4's message instead of burning 5 minutes.

Be honest about the signal's limits: `rundll32` exits 0 with no browser registered, macOS
`open` returns 0 for a launched-but-invisible session, and *awaiting* `xdg-open` can block for
the browser's lifetime under some handlers — a new Linux-only hang on the platform `CLAUDE.md`
singles out. Detect the spawn **error**, and a fast non-zero exit; do not await the child.

If `openUrl` must become async, note the ripple: `session.ts:358`, `commands/auth.ts:19`, and
the `openUrl` stubs throughout `tests/auth.test.ts`.

**Done when:** a failed browser launch is reported in seconds, not at the timeout, and no run
prints "Opening the browser" before one has been attempted.

### Step 6 — test the device path without a real IdP

**Step 3's end-to-end goal is not testable as stated** — CI has no device-capable IdP and no
reproducible headless environment [r2]. Make it testable instead:

- extend the mock provider in `tests/auth.test.ts:150-230` with `/device/code` and a poll on
  the token endpoint
- force the grant with `--login-flow device`, which outranks `isCi()` (row 2)
- the device path needs **no `openUrl` stub**, so `CLAUDE.md`'s browser rule is satisfied by
  construction there — but every browser-path test still needs one, and **`useCommand` calls
  `login(facts)` with no way to pass one** (`src/commands/hosts.ts:222`), which must be fixed
  since Step 3 gates that call site
- Step 4's exit-code assertions are spawned tests, so they need the `APPDATA` / `LOCALAPPDATA`
  / `HOME` redirect and the platform-branching `semantiusDir` helper (`CLAUDE.md`)

**Done when:** a device-code login completes against the mock provider on both CI platforms.

---

## 5. Sequencing

All steps are CLI-only. Until an IdP advertises, every headless login takes Step 4's honest
failure instead of a 5-minute stall — the larger win, needing no cross-repo coordination.

**Entra-backed self-hosted deployments get working device code the moment Steps 1-3 land.** The
managed cloud is the last to benefit.

Steps 4 and 5 are each worth landing alone.

---

## 6. Server-side prerequisites (not scoped here)

| IdP | What it needs |
|---|---|
| **Entra** | **"Allow public client flows" = Yes** on the app registration — required for device code *even for a confidential client*. Otherwise `/devicecode` succeeds and the **token poll** fails with `AADSTS7000218`, i.e. after the user has read the code and approved. cli-auth sends `client_id` with no secret, which is exactly the condition that triggers it. Map that error explicitly. Per deployment, not per release. |
| **semantius-idp** | `device-code-semantius-idp.md` |
| **semantius-cloud** | `device-code-semantius-cloud.md` — blocked on a dependency pin the repo has explicitly set |

---

## 7. Follow-through

`skills/use-semantius` documents `login` as "never run unattended"
(`skill-command-coverage.md` Step 2). When this lands, that needs revisiting: the command stops
being a trap and becomes merely interactive. The prohibition for **agents** stands either way —
a device code still needs a human to read it and approve.
