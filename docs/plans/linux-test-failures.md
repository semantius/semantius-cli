# Problem: tests that fail on Linux in Docker

Status: **open, cause unknown.** Seen 2026-11-03. Fix what is wrong, then verify it with the criteria at
the end. Nothing below is a diagnosis unless it says so.

## What is known

Three test files fail when the suite runs in a Linux container. All of it reproduces without the
rollup or error-message work: each failure was also seen on clean commits, as noted below.

The `Test (ubuntu-latest)` CI job was green at `64e8895` and `b0211a0`, and its log shows the `--stream`
test passing at `b0211a0`. So the failures have only been seen in this container so far. That has not
been explained, and it does not prove the code is fine: AGENTS.md treats Linux as a first-class
target, and this session's container already caught a real Linux hang that CI had missed (`sliceStream`).

### 1. `tests/postgrest-proxy.test.ts`

`PostgREST through its daemon > requests go direct again once the daemon is gone`

- Fails in about 10 ms, in every full-suite run in the container.
- Fails when the whole file runs (3 pass, 1 fail). Passes alone, 3 of 3.
- The same on a clean `64e8895`.

```
error: Was there a typo in the url or port?
  path: "http://localhost/rest/v1/after",
  code: "FailedToOpenSocket"
      at src/postgrest-proxy.ts:88
      at tests/postgrest-proxy.test.ts:181
```

### 2. `tests/stream.test.ts`

`call crud postgrestRequest --stream (end to end) > pipes the PostgREST body to stdout byte for byte`

- Hangs until the test timeout, whatever that is set to (seen at 15 s, 20 s and 60 s). The CLI process
  is then killed, and bun also reports `1 error`, an unhandled error between tests:
  ```
  tests/stream.test.ts:193  expect(result.exitCode).toBe(0)   Received: 143
  ```
- Fails when the whole file runs (16 pass, 1 fail), with or without Node installed.
- Passes alone with `--test-name-pattern 'byte for byte'`, in about 270 ms.
- The same on a clean `b0211a0`.
- **Unexplained:** this test passed in the first full Linux run of the session, in the same image, then
  failed in every run after it. No code difference was found that accounts for the change.

### 3. `tests/integration/daemon.test.ts`

`compiled binary daemon`

- In a full-suite run: only `large request and response frames survive the daemon socket` failed, after
  about 8.2 s. That was seen once, in the last full run. Earlier full runs did not report this file.
- With the file run alone, fails 3 of 3 on a clean `fe931e4` and on the working tree. Among the failures:
  - `first call goes direct and starts a daemon that outlives the CLI process`, in about 100 ms;
  - `large request and response frames survive the daemon socket`, in about 110 ms;
  - `SIGTERM shuts the daemon down cleanly`, where `daemonPid()` is null at line 267, so it may only
    follow from the first failure.
- **Caveat:** those file-alone runs used a container without `nodejs`, `npm` and `git`, unlike the full
  runs. They may have failed for that reason, so repeat them with the recipe below before relying on them.

## Pattern worth checking first

Failures 1 and 2 pass alone and fail with the rest of their file. That points at state left behind by an
earlier test in the file, or at timing, more than at the code under test. This has not been tested.

Differences between this container and the CI job, none of them tested:

- The container runs as root; CI runs as a non-root user.
- `CI=1` here, `CI=true` in GitHub Actions.
- Docker Desktop on a Windows host, with 12 CPUs.

## How to reproduce

From the repository root, in Git Bash on Windows (elsewhere, use `$(pwd)` and drop `MSYS_NO_PATHCONV`):

```bash
MSYS_NO_PATHCONV=1 docker run --rm -e CI=1 -v "$(pwd -W):/src:ro" oven/bun:1.3.12 sh -c '
  mkdir -p /work && cd /src && tar --exclude=node_modules --exclude=.git -cf - . | tar -xf - -C /work
  (apt-get update -qq && apt-get install -y -qq nodejs npm git) >/dev/null 2>&1
  cd /work && bun install --frozen-lockfile >/dev/null 2>&1
  bun test --timeout 60000 > /tmp/out.txt 2>&1
  grep -E "^\(fail\)" /tmp/out.txt | sort -u
  tail -5 /tmp/out.txt'
```

To run one file, replace the `bun test` line, for example with
`bun test tests/stream.test.ts --timeout 20000 > /tmp/out.txt 2>&1`. To compare with clean code, make a
`git archive HEAD` tarball and unpack that into `/work` instead of the working tree.

The source is mounted read-only and copied, so the container cannot change the repository. Do not use
the working tree's `node_modules`: on this machine they had gone stale and produced false typecheck
errors.

## Done when

All of these hold, each checked by running it, not inferred:

1. In the recipe's container, with `nodejs`, `npm` and `git` installed, each of the three files passes
   as a whole file, 3 runs in a row.
2. The full suite passes in that container with 0 failures and 0 errors, 2 runs in a row.
3. `Test (ubuntu-latest)` and `Test (windows-latest)` are green on the commit with the fix.
4. The cause of each failure is stated, including why the `--stream` test passed at first. If a failure
   turns out to be specific to this container, say what about the container causes it.

Do not make a test pass by skipping it, lengthening its timeout, or loosening what it asserts, unless the
stated cause shows that the test itself is wrong. Do not edit `src/vendor/`: it is synced from upstream.
