# semantius-cli

## Release process

Before releasing, always run lint and tests and ensure they pass:

```
npm run lint
bun test
```

When tagging a release, always create a dedicated release commit first, then tag it:

```
git commit --allow-empty -m "Release v0.x.x"
git tag v0.x.x
git push origin main
git push origin v0.x.x
```

Do NOT tag an existing commit directly — prior releases (v0.1.0, v0.1.1) all have a dedicated "Release v0.x.x" commit that the tag points to.

## Memory

Do NOT use the local Claude memory system (`~/.claude/...`) for anything in this project. All conventions, rules, and notes must go in this file (CLAUDE.md) so they are committed to the repo and visible to all users and agents.
