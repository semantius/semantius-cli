# semantius-cli

## Release process

Full release checklist — follow every step in order:

1. Bump the version in `package.json` to the new version and commit it.
2. Run lint and unit tests and ensure they pass:
   ```
   npm run lint
   bun test tests/config.test.ts tests/output.test.ts tests/client.test.ts tests/errors.test.ts
   ```
3. Create a dedicated release commit, tag it, and push branch + tag separately:
   ```
   git commit --allow-empty -m "Release v0.x.x"
   git tag v0.x.x
   git push origin main
   git push origin v0.x.x
   ```

Do NOT use `git push --follow-tags` — it silently skips lightweight tags and the release workflow will not trigger.

Do NOT tag an existing commit directly — always create a dedicated "Release v0.x.x" commit that the tag points to.

## Memory

Do NOT use the local Claude memory system (`~/.claude/...`) for anything in this project. All conventions, rules, and notes must go in this file (CLAUDE.md) so they are committed to the repo and visible to all users and agents.
