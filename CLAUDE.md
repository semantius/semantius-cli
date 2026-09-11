# semantius-cli

## Release process

Always use the release script — it handles everything (version bumps, tests, annotated tag, push):

```
./scripts/release.sh 0.x.x
```

The script bumps the `version` in `package.json` — the single source of version truth, imported directly into the binary (`src/index.ts`, `src/client.ts`), so there is no separate `src/version.ts` to maintain. It then runs lint and tests, commits the bump, creates an annotated tag, and pushes branch + tag. Do NOT do any of these steps manually — manual releases have repeatedly caused the binary to report the wrong version or the release workflow to not trigger.

The script requires a clean working tree, so commit your actual code changes first; it only commits the version bump itself.

## Vendored code

The vendored tree under `src/vendor/` is synced, never edited: `src/vendor/postgrest-mcp/` is copied from the `postgrest-mcp` repo by `bun run sync` (`scripts/sync-postgrest-mcp.ts`) — change the code upstream, then re-sync and commit. The one exception is `src/vendor/postgrest-mcp/src/utils/resetSchemaCache.ts`, the CLI's local replacement, which the script never writes. `bun run sync:check` (run by the release script) fails if the copy drifted from upstream.

## Memory

Do NOT use the local Claude memory system (`~/.claude/...`) for anything in this project. All conventions, rules, and notes must go in this file (CLAUDE.md) so they are committed to the repo and visible to all users and agents.
