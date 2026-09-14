#!/usr/bin/env bash
# Cut a release: run the local gates, bump the version, tag it, push the tag.
#
# Pushing the tag is the entire trigger. `.github/workflows/release.yml` then
# tests on ubuntu, builds the six binaries (linux/darwin/windows x
# x64/arm64) and creates the GitHub Release with checksums. Nothing is built
# or uploaded locally here.
#
# `package.json` is the single source of the version: the binary imports it
# (`semantius --version`, the MCP client info), and the release workflow's
# first step **refuses a tag that disagrees with it**, so a binary can never
# report a different version than the tag it was built from.
#
# Same shape and checks as semantius-idp's `release.sh`, with these
# differences:
#
#   * the version may be given as `v1.2.3` or `1.2.3` — the tag is always
#     `v1.2.3`;
#   * a **pre-release** (`v0.9.0-rc.1`) bumps `package.json` to the full
#     `0.9.0-rc.1`, not to the core version: this artifact is a binary that
#     prints its own version, and an rc claiming to be `0.9.0` is exactly the
#     "binary reports the wrong version" failure. The workflow publishes it as
#     a GitHub pre-release, so `releases/latest` (what install.sh / install.ps1
#     download) keeps pointing at the last full release;
#   * "newer than the latest tag" uses semver precedence (Bun.semver), so
#     `v0.9.0` after `v0.9.0-rc.1` is allowed — `sort -V` gets that backwards;
#   * **local gates** run before anything is changed: the vendored
#     postgrest-mcp drift check (CI has no upstream checkout, so this is the
#     only place it can run), typecheck, lint and the full test suite. They
#     prove only the OS you run them on — the CI line in the summary is where
#     the other platforms show up (see "Linux is a first-class target" in
#     CLAUDE.md);
#   * no CHANGELOG.md: the workflow uses GitHub's generated release notes.
#
# Usage: ./release.sh v0.9.0 [-y]
#        ./release.sh 0.9.0 [-y]
set -euo pipefail
cd "$(dirname "$0")"

die() { printf 'release: %s\n' "$*" >&2; exit 1; }

INPUT="${1:-}"
[ -n "$INPUT" ] || die "usage: ./release.sh [v]X.Y.Z[-pre] [-y]"

ASSUME_YES=0
case "${2:-}" in
  -y|--yes) ASSUME_YES=1 ;;
  "") ;;
  *) die "unknown option: $2" ;;
esac

# The same grammar the workflow's guard enforces, checked here so the refusal
# arrives before the tag is pushed rather than a minute after.
[[ "$INPUT" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] \
  || die "version must look like 1.2.3, v1.2.3 or v1.2.3-rc.1 (got '$INPUT')"
NUMBER="${INPUT#v}"
VERSION="v$NUMBER"
CORE="${NUMBER%%-*}"
PRERELEASE=0
[ "$NUMBER" != "$CORE" ] && PRERELEASE=1

command -v bun >/dev/null 2>&1 || die "bun is not on PATH"

git fetch --quiet --tags origin

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" != "HEAD" ] || die "detached HEAD — check out a branch first"

git diff --quiet && git diff --cached --quiet \
  || die "uncommitted changes to tracked files — commit or stash first"

UPSTREAM="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null)" \
  || die "branch '$BRANCH' has no upstream — push it first"
[ "$(git rev-parse HEAD)" = "$(git rev-parse '@{u}')" ] \
  || die "HEAD differs from $UPSTREAM — push/pull first; the tag must point at a commit the remote has"

# `cmd && die` would abort under `set -e` when cmd fails, so both existence
# checks are explicit ifs.
if git rev-parse -q --verify "refs/tags/$VERSION" >/dev/null 2>&1; then
  die "tag $VERSION already exists locally"
fi
if [ -n "$(git ls-remote --tags origin "refs/tags/$VERSION")" ]; then
  die "tag $VERSION already exists on origin"
fi

# Decisions come back from bun as an exit code, never as printed text to
# compare: console.log output is not plain data (under FORCE_COLOR it wraps
# numbers in ANSI codes). The only text read back is a tag name or a version
# string, written with process.stdout.write.

# Highest existing v* tag by semver precedence.
LATEST="$(git tag --list 'v*' | bun -e '
  const tags = (await Bun.stdin.text()).split(/\r?\n/).map((t) => t.trim())
    .filter((t) => /^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(t));
  tags.sort((a, b) => Bun.semver.order(a.slice(1), b.slice(1)));
  process.stdout.write(tags.at(-1) ?? "");
')"
if [ -n "$LATEST" ] && ! NUMBER="$NUMBER" LATEST="${LATEST#v}" bun -e '
  process.exit(Bun.semver.order(process.env.NUMBER, process.env.LATEST) > 0 ? 0 : 1);
'; then
  die "$VERSION is not newer than the latest tag $LATEST"
fi

pkg_version() { bun -e 'process.stdout.write(String(JSON.parse(await Bun.file("package.json").text()).version))'; }
CURRENT="$(pkg_version)"

# Advisory only. It cannot gate — `gh` may be absent, the run may still be in
# flight — but the local gates below prove one OS, and this is the moment to
# see whether ubuntu and windows were green on the commit being tagged.
CI="not checked (gh not on PATH)"
if command -v gh >/dev/null 2>&1; then
  CI="$(gh run list --commit "$(git rev-parse HEAD)" --limit 5 \
        --json workflowName,conclusion,status \
        --jq '[.[] | "\(.workflowName)=\(.conclusion // .status)"] | join(" ")' 2>/dev/null)" \
    || CI="not checked (gh call failed)"
  [ -n "$CI" ] || CI="no runs recorded for this commit"
fi

# Local gates, before anything is changed. The drift check needs the upstream
# checkout at ../postgrest-mcp (or $POSTGREST_MCP_DIR).
echo "release: checking the vendored postgrest-mcp copy..."
bun run sync-mcp-tools:check
echo "release: installing the locked dependencies..."
bun install --frozen-lockfile
echo "release: typecheck, lint, tests..."
bun run typecheck
bun run lint
# --timeout is explicit: bun ignores [test].timeout in bunfig.toml, and the
# default 5 s is too tight for the tests that spawn a CLI subprocess.
# bun runs the whole suite before exiting non-zero; the release then stops
# here, before any bump or tag.
bun test --timeout 60000

if [ "$PRERELEASE" -eq 1 ]; then
  LATEST_NOTE="GitHub pre-release (releases/latest stays on the last full release)"
else
  LATEST_NOTE="GitHub Release, becomes releases/latest (what install.sh / install.ps1 fetch)"
fi

printf '\n  release    %s%s\n  commit     %s  %s\n  branch     %s (in sync with %s)\n  version    package.json %s -> %s\n  gates      drift check, typecheck, lint, tests passed on %s\n  ci         %s\n  publishes  %s\n             6 binaries + checksums.txt, generated notes\n\n' \
  "$VERSION" "$([ "$PRERELEASE" -eq 1 ] && printf '  (pre-release)')" \
  "$(git rev-parse --short HEAD)" "$(git log -1 --format=%s)" \
  "$BRANCH" "$UPSTREAM" "${CURRENT:-?}" "$NUMBER" \
  "$(uname -s)" "$CI" "$LATEST_NOTE"

if [ "$ASSUME_YES" -eq 0 ] && [ -t 0 ]; then
  read -r -p "proceed? [y/N] " reply
  case "$reply" in y|Y|yes|YES) ;; *) die "aborted" ;; esac
fi

if [ "$CURRENT" != "$NUMBER" ]; then
  # Surgical edit of the first "version" line: a JSON round-trip would
  # reformat the whole file. Verified, because a silent no-op here is a tag
  # the workflow refuses.
  NUMBER="$NUMBER" bun -e '
    const path = "package.json";
    const text = await Bun.file(path).text();
    const next = text.replace(/^(\s*"version":\s*")[^"]*(")/m, `$1${process.env.NUMBER}$2`);
    await Bun.write(path, next);
  '
  [ "$(pkg_version)" = "$NUMBER" ] \
    || die "failed to bump package.json (still '$(pkg_version)')"

  git add package.json
  git commit -q -m "chore(release): $VERSION"
  git push -q origin "$BRANCH"
  echo "bumped to $NUMBER and pushed chore(release): $VERSION"
fi

# Signed if this machine is set up to sign, annotated if not. By this point
# the bump commit has already been **pushed**: a configured-but-unusable key
# (locked agent, gpg missing, a key that lives on the other machine) must not
# abort under `set -e` and leave the branch bumped and the release untagged,
# so a failed `-s` degrades to `-a` and says so.
if [ -n "$(git config user.signingkey || true)" ] || [ "$(git config tag.gpgsign || true)" = "true" ]; then
  if git tag -s "$VERSION" -m "Release $VERSION" 2>/dev/null; then
    echo "tagged $VERSION (signed)"
  else
    git tag -a "$VERSION" -m "Release $VERSION"
    echo "tagged $VERSION (annotated — signing was configured but failed; re-tag by hand if a signature is required)"
  fi
else
  git tag -a "$VERSION" -m "Release $VERSION"
  echo "tagged $VERSION (annotated; no signing key configured)"
fi
git push origin "$VERSION"

ORIGIN="$(git remote get-url origin)"
case "$ORIGIN" in
  *github.com*)
    REPO="$(printf '%s' "$ORIGIN" | sed -E 's#^(git@github\.com:|https://github\.com/)##; s#\.git$##')"
    printf '\npushed %s — CI is building. Verify:\n  actions  https://github.com/%s/actions/workflows/release.yml\n  release  https://github.com/%s/releases/tag/%s\n' \
      "$VERSION" "$REPO" "$REPO" "$VERSION"
    ;;
  *) printf '\npushed %s to %s\n' "$VERSION" "$ORIGIN" ;;
esac
