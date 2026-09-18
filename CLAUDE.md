# semantius-cli

## Linux is a first-class target

The CLI ships for Linux, macOS and Windows, and CI tests `ubuntu-latest` and `windows-latest`. A green local run only proves the platform you ran it on. Before calling platform-sensitive work done, think through how it behaves on the other platforms and run the tests on them. If you're not on Linux, use Docker (`oven/bun` image plus Node for the `npx` integration tests) or push a branch and wait for the ubuntu CI job. Never stack days of unpushed commits that have only been tested on one OS.

Watch for these, which have all broken Linux CI before while passing on Windows:

- **Paths:** `semantius` is the vendor directory and `cli` this product's directory inside it, so configuration is `%APPDATA%\semantius\cli` on Windows and `~/.config/semantius/cli` on Linux/macOS. Credentials are not in it: stored sessions live under `getUserSecretsDir()`, `%LOCALAPPDATA%\semantius\cli` on Windows — Roaming is the half of the profile built to travel, and a credential belongs on the side that stays on the machine. On Linux/macOS both roots are the same directory. Never hardcode any of it: go through `getUserConfigDir()` / `getUserSecretsDir()`, and keep the product segment in the one constant that defines it (`PRODUCT_DIR`, `src/config.ts`). Anything the CLI leaves directly in the vendor directory is a layout an older version wrote, and is moved out of it on the next run (`migrateUserConfigDir`, and `createSecretStorage` for sessions).
- **Env read at startup:** Bun's `os.homedir()` is fixed when the process starts, so code that must follow a runtime `HOME` change reads `process.env.HOME`.
- **No OS keyring:** a session is sealed (AES-256-GCM, `src/auth/envelope.ts`) into a file, under a per-host key the keyring holds — so the keyring only ever stores ~60 bytes, and its size limits cannot decide where the payload lands. Headless Linux has no keyring at all: there the file is written in the clear, which is the normal path there and must stay silent and correct. Never put the payload itself in the keyring again: Windows Credential Manager refuses a blob over 2560 bytes, an Entra session is ~3.4 KB, and the fallback that produced was a plaintext refresh token on disk plus a stale keyring entry that shadowed it on every later read.
- **No browser:** headless Linux has no `xdg-open` target, so a login in tests must stub `openUrl`. The real one completes the mock flow on Windows and hangs on Linux.
- **Platform APIs:** signals, file modes (`chmod` 0600), Unix sockets (the daemon is Linux/macOS-only), and case-sensitive file names.

## Release process

Always use the release script — it handles everything (version bumps, tests, annotated tag, push):

```
./release.sh v0.x.x        # or 0.x.x; pre-releases: v0.x.x-rc.1; -y skips the prompt
```

`release.sh` lives at the repository root, with the same checks as semantius-idp's. It refuses to run with uncommitted changes, when HEAD differs from its upstream, when the tag already exists locally or on origin, or when the version is not newer than the latest tag. It then runs the local gates: vendored drift check, typecheck, lint, full test suite. Next it prints a summary that includes the CI status of the commit, and asks for confirmation. Only then does it bump `version` in `package.json`, commit and push the bump, create the tag (signed if a key is configured) and push it. `package.json` is the single source of version truth, imported directly into the binary (`src/index.ts`, `src/client.ts`), and `release.yml` refuses a tag that disagrees with it. A pre-release is published as a GitHub pre-release, so `releases/latest`, which the install scripts download, is untouched.

Do NOT do any of these steps manually — manual releases have repeatedly caused the binary to report the wrong version or the release workflow to not trigger. Commit and push your actual code changes first; the script only commits the version bump itself. The local gates prove only your own OS, so check that the summary's CI line shows green runs on the commit being tagged.

## Vendored code

The vendored tree under `src/vendor/` is synced, never edited: `src/vendor/postgrest-mcp/` is copied from the `postgrest-mcp` repo by `bun run sync-mcp-tools` (`scripts/sync-postgrest-mcp.ts`) — change the code upstream, then re-sync and commit. The one exception is `src/vendor/postgrest-mcp/src/utils/resetSchemaCache.ts`, the CLI's local replacement, which the script never writes. `bun run sync-mcp-tools:check` (run by the release script) fails if the copy drifted from upstream.

## Self-hosted configuration comes from the platform document

A self-hosted instance configures the CLI by serving `/.well-known/semantius.json`
(`src/auth/platform.ts`). Four rules hold there:

- **Never branch on `idp_type`.** It is advisory: log it, quote it in errors, and
  otherwise ignore it. The CLI implements the document, not a provider — an
  Entra-backed deployment is just a deployment that serves different values.
- **Self-hosted `HostFacts` resolution stays synchronous and network-free.** The
  document is an auth-layer concern, read only when a login or a refresh happens.
  `selfHostedFacts()` must not fetch it, or every command pays a round trip; the
  invariant is asserted by `tests/host.test.ts`. Only its cache slot lives in
  `src/host.ts`, beside the OAuth endpoints and under the same 24 h TTL.
- **Clean absence and failure are not the same thing.** A 404, or a 2xx that is
  not JSON (the instance's web app catching the path), means the deployment
  serves no document: fall back to the legacy RFC 9728 → RFC 8414 chain and
  cache that fact. A network error, a timeout or a 5xx is a failure: raise. A
  silent fallback there would log in with the wrong client id, or mint a token
  for the wrong audience.
- **One host, one audience, one stored access token.** cli-auth keys its token
  cache by what was requested, and its `login()` saves the token it just
  obtained *without* the resource it asked for — filing a token minted for the
  host's audience under the key that means "no audience". `labelStoredTokens`
  (`src/auth/session.ts`) corrects that label at the end of every login, so a
  session never holds two entries for one audience and nothing is left for an
  unlabelled lookup to find. Keep it that way: resolve the resource indicator
  once per invocation and thread it, rather than deriving it again on a path
  that might come out empty (`resourceIsKnown`, `requireHonestResource`).

## Transfer files carry names, not host ids

`utils/export_entities`, `export_module`, `import_entities` and `import_module`
(`src/local-tools/transfer/`) move entities and modules between hosts through
one JSON file. Its rules:

- **Metadata is keyed by name.** `module_id` travels as `module_name`, role ids
  as the role's `slug`, permissions by `permission_name`. A host id in the
  metadata of a transfer file is a bug: it means something else on the target.
  The column lists derive from the vendored schemas (`format.ts`); never edit
  those to suit the transfer.
- **Records keep their ids**, and the import upserts by the entity's id column.
  References to `users` travel as `{"external_id": …}`, found through the
  fields with `reference_table = 'users'` — never by the shape of a value.
- **Every read is paged** (`PostgrestClient.pages`): a page shorter than
  `limit` does not end a read, because PostgREST's `db-max-rows` may cut it;
  only an empty page does. There is no unpaged GET in the client.
- **Never trust `Bun.file(p).slice(a, b).stream()` to stop at `b`.** On Windows
  a small slice of a file over ~75 KB streams on past its end; `sliceStream`
  (`format.ts`) counts the bytes and cuts it off.
- **The import needs `fix_id_sequence`** on the target: explicit ids do not move
  the sequence. Databases on 0.5.0-beta1 lack the RPC until they are rebuilt;
  the import stops at `PGRST202` before writing any record.

## Tests that spawn the CLI

Any test that spawns the CLI as a subprocess must redirect `APPDATA`, `LOCALAPPDATA` and `HOME` to a temp dir in the child's env. The user config dir (`getUserConfigDir()`: `hosts.json`, the global `.env`) and the secrets dir (`getUserSecretsDir()`: stored sessions and their lock files) are derived from those vars, so without the redirect a spawned test can silently pick up a real developer's current host or credentials instead of the hermetic state the test set up. The current host is checked right after `--host`/`--token` (see `src/host.ts`'s `resolveHostValue`), ahead of `SEMANTIUS_HOST`/`SEMANTIUS_ORG`, so a leaked one doesn't just affect host-specific tests — it can silently redirect almost any test that resolves a host at all. In-process tests (not spawning a subprocess) need the same isolation via `setHostsIndexDirForTests` from `src/hosts-index.ts`. When a test seeds files into that dir, don't hardcode `<dir>/semantius/cli/...` — that is only the Windows layout (`%APPDATA%\semantius\cli`); Linux/macOS use `<HOME>/.config/semantius/cli`. Use `getUserConfigDir()` / `getUserSecretsDir()` in-process, or a platform-branching helper for a spawned child (see `semantiusDir` in `tests/acceptance-hosts.test.ts`, whose children point both vars at one dir). Do not reach into the fake keyring for a stored session either — it holds a key, and the file is bound to the name it was written for, so `createSecretStorage(...)` is the only way in or out (see `storedSession` / `copySessionTo` in `tests/auth.test.ts`). Never call a login path without an `openUrl` stub: the real one opens a browser, which happens to complete the flow on Windows but hangs to the timeout on a headless Linux runner. See `tests/token-arg.test.ts`, `tests/acceptance-hosts.test.ts`, or `tests/host.test.ts`'s outer `beforeEach`/`afterEach` for the pattern.

## Memory

Do NOT use the local Claude memory system (`~/.claude/...`) for anything in this project. All conventions, rules, and notes must go in this file (CLAUDE.md) so they are committed to the repo and visible to all users and agents.
