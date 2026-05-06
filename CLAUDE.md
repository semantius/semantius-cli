# semantius-cli

## Release process

Always use the release script — it handles everything (version bumps, tests, annotated tag, push):

```
./scripts/release.sh 0.x.x
```

The script updates `package.json` AND `src/version.ts` (the actual version embedded in the binary), runs lint and tests, commits, creates an annotated tag, and pushes branch + tag. Do NOT do any of these steps manually — manual releases have repeatedly caused the binary to report the wrong version or the release workflow to not trigger.

## Memory

Do NOT use the local Claude memory system (`~/.claude/...`) for anything in this project. All conventions, rules, and notes must go in this file (CLAUDE.md) so they are committed to the repo and visible to all users and agents.
