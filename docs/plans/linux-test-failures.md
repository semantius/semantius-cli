# Problem: tests that fail on Linux in Docker

Status: **causes found, fix verified locally; the CI check on the fix commit is still open.** Seen
2026-11-03. "What is known" below is the original report; "Causes" replaces its open questions.

## Causes

The difference the report missed is the Bun version: the recipe pinned 1.3.12, the version on the
development machine, while CI installs `latest`, 1.4.4. Failures 1 and 2 exist only on 1.3.12. Failure 3
exists on both, and is a product bug. The recipe now uses 1.4.4.

1. **`postgrest-proxy`: Bun 1.3.12.** Its `fetch` reports an unreachable Unix socket as
   `FailedToOpenSocket`; 1.4.4 reports the `ENOENT` or `ECONNREFUSED` that `socketUnreachable` checks for.
   The test "passed alone" without testing anything: with no earlier test there is no PID file, so its
   pid is 0, `isProcessRunning(0)` is true (signal 0 to its own process group), and no daemon ever exists.
2. **`stream`: Bun 1.3.12.** The CLI hangs on most runs of this test on that version, and not at all on
   1.4.4 (0 failures in 40 file runs, 20 of them under CPU load). It is intermittent, not order-dependent:
   on 1.3.12 it passed 1 of 12 runs alone and 0 of 12 in the whole file, with 5 s timeouts, and 1 of 3 in
   the whole file with 20 s. That is why it passed at first. **Not found:** what in Bun 1.3.12 hangs.
3. **`integration/daemon`: two `npx -y` at once, on any Bun.** The first call started the daemon and then
   connected directly, so both launched `npx -y` within milliseconds, into one cold `_npx/<hash>` directory.
   `HOME` is redirected, so the cache is cold on every run and CI's pre-cache step does not reach it. The
   installs collide under CPU load (`ENOTEMPTY`, `TAR_ENTRY_ERROR`): 5 of 25 runs on 1.4.4, 0 of 40 on an
   idle machine. All 5 failures show it. When the direct connection lost, the user's own command exited
   3. The other failing tests followed from that.

   **Fix:** the daemon now starts after the direct connection is up (`getDaemonConnection` in
   `src/daemon-client.ts`, `getConnection` in `src/client.ts`), when the install is finished. The same
   load: 0 of 40. On 1.3.12: 8 of 8, up from 1 of 3. A new test with a fixture that models the install
   failed 5 of 5 before the fix, with no load needed. Two separate CLI invocations on a cold cache can
   still collide: that is `npx` itself.

   **Also found under load:** the test's `daemonPid` parsed the PID file without a guard and could read
   it while it was being written (1 of 40). The test was wrong, and now uses `readPidFile`.

Results on 1.4.4, with the fix: every "Done when" item below except 3. Each file passed 3 of 3 from a clean
image, the full suite passed twice (841 pass, 10 skip, 0 fail), and Windows passed (823 pass, 32 skip, 0 fail).

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
MSYS_NO_PATHCONV=1 docker run --rm -e CI=1 -v "$(pwd -W):/src:ro" oven/bun:1.4.4 sh -c '
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
