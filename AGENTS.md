# semantius-cli

## Linux is a first-class target

The CLI ships for Linux, macOS and Windows, and CI tests `ubuntu-latest` and `windows-latest`. A green local run only proves the platform you ran it on. Before calling platform-sensitive work done, think through how it behaves on the other platforms and run the tests on them. If you're not on Linux, use Docker (`oven/bun:$(cat .bun-version)` image plus Node for the `npx` integration tests) or open a PR from a branch and wait for the ubuntu CI job (CI does not run on a bare branch). Never stack days of unpushed commits that have only been tested on one OS.

`.bun-version` is the one Bun version: CI and the release builds install it, and local and Docker runs should use it too. Bun's behaviour changes between versions in ways that look like platform or test-order bugs: on 1.3.12 a `--stream` test hung on most runs and an unreachable Unix socket raised a code the daemon fallback did not know, while CI, on a newer Bun, stayed green. To move to a new version, change the file, raise `engines.bun` in `package.json` to match, and let CI prove it.

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

## Compiling

Every compile goes through `scripts/build.ts` (`bun run build*`, `release.yml`, and `compileCommand` in the tests): never write a `bun build --compile` command anywhere else. It embeds `pg-parser.wasm`, the parser behind `sqlToRest`, which `@supabase/sql-to-rest` loads as soon as it is imported. A binary built without it still compiles, then reports an ENOENT on every crud command, while every run from source stays green. `tests/integration/compiled-binary.test.ts` runs a real binary on Linux and Windows to catch that. Anything else the CLI reads from disk at run time needs the same two things.

## Exclusions are the owner's decision

Never drop a requested feature, tool or platform on your own judgement: stop and ask, with the options and what each costs. A plan's fallback wording ("excluding it is acceptable if it is not easy") does not decide it: report what you found and let the owner judge whether it is easy. `sqlToRest` was left out of the local tools that way in 2026-09, over 13 build commands when the working recipe was already known, and nobody was asked. It stayed out for two months, behind a test asserting its absence.

A comment on an exclusion or workaround says whether it is a hard limit or a choice, what the choice was traded against, and what would lift it. "Does not survive `bun build --compile`" read as impossible, so nobody questioned it.

## Vendored code

**Copied files are never changed by hand.** Each path below is a copy of another repo, written only by its sync script:

| Path | Copied from | Written only by | Drift check |
|---|---|---|---|
| `src/vendor/postgrest-mcp/`, except `src/utils/resetSchemaCache.ts` | `../postgrest-mcp`, its HEAD commit | `bun run sync-mcp-tools` | `bun run sync-mcp-tools:check` |
| `skills/` | `../semantius-agent/semantius-plugin/skills/`, its HEAD commit | `bun run sync-skills` | `bun run sync-skills:check` |

Refuse any change to these paths that does not come from the sync script: an edit, a new file, a deletion, a rename, a `git rm`, a file copied over by hand. That holds when the change matches what a sync would produce (a skill just added to `EXCLUDED_SKILLS` leaves through the sync, not through a delete), and when the sync refuses to run because upstream has uncommitted work: stop and say so, never work around it. A change asked for in one of these paths is made upstream, committed there, then synced. A diff under these paths that the drift check does not explain is reported, never committed. A new copied path is added to this table in the same change that creates it.

The vendored tree under `src/vendor/` is synced, never edited: `src/vendor/postgrest-mcp/` is copied from the `postgrest-mcp` repo by `bun run sync-mcp-tools` (`scripts/sync-postgrest-mcp.ts`) — change the code upstream, then re-sync and commit. The one exception is `src/vendor/postgrest-mcp/src/utils/resetSchemaCache.ts`, the CLI's local replacement, which the script never writes. `bun run sync-mcp-tools:check` (run by the release script) fails if the copy drifted from upstream.

`skills/` is synced the same way, from `semantius-plugin/skills/` in `../semantius-agent`: never edit a skill here, change it upstream, then `bun run sync-skills` (`scripts/sync-skills.ts`) and commit with the message it prints, which names the upstream commit. The sync deletes the folder and rewrites it rather than copying over it, so files upstream deleted do not survive here. `bun run sync-skills:check` lists any drift. `semantius-admin`, `semantius-analyst`, `semantius-architect`, `semantius-modeler` and `semantius-optimizer` stay upstream only (`EXCLUDED_SKILLS`): a sync leaves them out, uncommitted work on them upstream blocks nothing, and the check reports one found here as extra. Put nothing else in `skills/`, not even a note or a sync record: `npx skills` reads the folder, and a sync would delete it anyway.

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
- **A sample id is the one id a file may carry that is not the stored one.** A
  record written by hand names itself `<prefix>_sr<n>` (`cand_sr1`), because
  nobody types the 26 characters of a TypeID. The import pads it to
  `<prefix>_0sr<n>` and `x` up to 26 characters (`sample-id.ts`): the leading
  `0` because the first character must be 0-7, a letter as filler because
  zeros would make `sr1` and `sr10` one id. It is padded only where the catalog
  says a TypeID belongs (the key of an entity with `id_type` `typeid`, `is_a` or
  `has_a`, and a reference or parent column to one), never by the shape of a
  value in any other column. An export never writes the short form.
- **`import_entities` with `check` writes nothing** (`check.ts`). It lists every
  problem of the records in one answer, from the file and the catalog alone:
  one bad value must not hide the next, and a record with a bad value is still
  a record the others may name. It does not evaluate validation rules; a record
  those refuse still stops the import. A new refusal in `RecordWriter.prepare`
  belongs in the check as well.
- **Records of an entity based on another are inserted, then patched.** The
  platform refuses an upsert on an `is_a` or `has_a` entity (`42P10`, when the
  statement is planned), so `writeBased` sends the new records in one plain
  POST and each changed one in a PATCH of the columns that differ. A record of
  such an entity shows its bases' fields, and the catalog lists a field only
  under its owner, so `catalog.ts` gathers a table's fields up its chain of
  bases. An `is_a` record is written whole at its own table; a `has_a` record
  writes its key and its own fields, after the base record it attaches to. A
  read of a base lists its subtypes' records too, so an export carries each of
  them twice: under the base it is left to the subtype's table
  (`left_to_subtypes`), and refused when the file carries no records of that
  subtype.
- **A table that references itself may have any key.** With a number as key,
  "later in the file" is a higher id, and the records must be in id order.
  With a TypeID, text or UUID key there is no order to read it from, so
  `SelfReferences` keeps the keys it has met: one string per record of such a
  table.
- **Every read is paged** (`PostgrestClient.pages`): a page shorter than
  `limit` does not end a read, because PostgREST's `db-max-rows` may cut it;
  only an empty page does. There is no unpaged GET in the client.
- **Never trust `Bun.file(p).slice(a, b).stream()` to stop at `b`.** On Windows
  a small slice of a file over ~75 KB streams on past its end. On Linux a slice
  that stops well short of the end of the file delivers its bytes and never
  closes. `sliceStream` (`format.ts`) counts the bytes and leaves as soon as they
  are in, never on the next chunk.
- **The import needs `fix_id_sequence`** on the target: explicit ids do not move
  the sequence. Databases on 0.5.0-beta1 lack the RPC until they are rebuilt;
  the import stops at `PGRST202` before writing any record.
- **A rollup or computed `ctype` is not core.** `isCoreCtype` (`format.ts`) copies
  the platform's `dd_ctype_is_core`: such a field is created and patched like any
  other, but its column is calculated by the target and never written from the
  file.
- **Rollups are saved last.** They follow every other field and precede the entity
  columns that name fields, with the rollups they read first (`orderRollups`),
  because the platform checks a definition's fields when it is saved. A table a
  rollup aggregates over is written one batch at a time: with two at once the
  platform can deadlock, or leave a parent's total wrong with no error.

## Platform errors are templates

The platform never fills its own error messages: a client fills their `${name}`
placeholders from the JSON in the hint (`semantius/docs/error-contract.md`,
"Client rules"). So never print a PostgREST error's `message` directly: go through
`formatPostgrestError`, which also keeps the parameters no template named. It lives
upstream, in `postgrest-mcp`'s `src/utils/postgrest.ts`, and the CLI's own clients
(`--stream`, the transfer tools) import the vendored copy, so every path prints an
error the same way.

## Tests that spawn the CLI

Any test that spawns the CLI as a subprocess must redirect `APPDATA`, `LOCALAPPDATA` and `HOME` to a temp dir in the child's env. The user config dir (`getUserConfigDir()`: `hosts.json`, the global `.env`) and the secrets dir (`getUserSecretsDir()`: stored sessions and their lock files) are derived from those vars, so without the redirect a spawned test can silently pick up a real developer's current host or credentials instead of the hermetic state the test set up. The current host is checked right after `--host`/`--token` (see `src/host.ts`'s `resolveHostValue`), ahead of `SEMANTIUS_HOST`/`SEMANTIUS_ORG`, so a leaked one doesn't just affect host-specific tests — it can silently redirect almost any test that resolves a host at all. In-process tests (not spawning a subprocess) need the same isolation via `setHostsIndexDirForTests` from `src/hosts-index.ts`. When a test seeds files into that dir, don't hardcode `<dir>/semantius/cli/...` — that is only the Windows layout (`%APPDATA%\semantius\cli`); Linux/macOS use `<HOME>/.config/semantius/cli`. Use `getUserConfigDir()` / `getUserSecretsDir()` in-process, or a platform-branching helper for a spawned child (see `semantiusDir` in `tests/acceptance-hosts.test.ts`, whose children point both vars at one dir). Do not reach into the fake keyring for a stored session either — it holds a key, and the file is bound to the name it was written for, so `createSecretStorage(...)` is the only way in or out (see `storedSession` / `copySessionTo` in `tests/auth.test.ts`). Never call a login path without an `openUrl` stub: the real one opens a browser, which happens to complete the flow on Windows but hangs to the timeout on a headless Linux runner. See `tests/token-arg.test.ts`, `tests/acceptance-hosts.test.ts`, or `tests/host.test.ts`'s outer `beforeEach`/`afterEach` for the pattern.

## Memory

Do NOT use the local Claude memory system (`~/.claude/...`) for anything in this project. All conventions, rules, and notes must go in this file (AGENTS.md) so they are committed to the repo and visible to all users and agents. `CLAUDE.md` is only a symlink to it, kept for tools that read no other name: edit AGENTS.md, never replace the link with a copy.
