/**
 * What the environment can tell us about completing an interactive login.
 *
 * Four independent facts, no grant logic — the choice between the loopback
 * browser flow and the device code grant also depends on what the IdP
 * advertises, and is made in session.ts once discovery has run.
 *
 * Every value is read from `process.env` at call time rather than captured at
 * module load: a spawned child or a test may set DISPLAY / CI between import
 * and use, and Bun fixes some process-level values at startup (see the
 * os.homedir() note in AGENTS.md).
 */

/** Values of CI that mean "not CI" despite being a non-empty string. */
const CI_FALSE = new Set(['false', '0', 'no', 'off']);

/**
 * Whether a browser can be opened on *this* machine, i.e. whether the
 * loopback flow has any chance of completing.
 *
 * `$BROWSER` wins: it is the POSIX way to name a URL opener, xdg-open honours
 * it, and VS Code Remote-SSH sets it — without this, a Remote-SSH session is
 * demoted to device code even though loopback genuinely works there (VS Code
 * forwards the opener *and* auto-forwards localhost ports).
 *
 * On Linux the test is a graphical session. macOS and Windows have no DISPLAY
 * to consult, so the answer there is a weak "probably": macOS-over-SSH,
 * Windows-over-SSH/WinRM, a Session-0 service and Server Core all report true
 * and all lack a usable browser. That is why the spawn result is checked too
 * (openBrowser) — this predicate predicts, the spawn observes.
 */
export function hasLocalBrowser(): boolean {
  if (process.env.BROWSER) return true;
  if (process.platform === 'win32' || process.platform === 'darwin') {
    return true;
  }
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

/**
 * Whether this is an unattended pipeline. Nothing interactive completes here:
 * nobody reads a build log in time to approve a device code inside its expiry,
 * and nobody clicks through a consent screen.
 *
 * `CI` is the de facto standard (GitHub Actions, GitLab CI, CircleCI, Travis,
 * Buildkite, Vercel). A runner may allocate a TTY, so a TTY does not clear it.
 */
export function isCi(): boolean {
  const value = process.env.CI;
  if (value === undefined || value === '') return false;
  return !CI_FALSE.has(value.toLowerCase());
}

/**
 * Whether something other than a person is reading our output: an agent's
 * shell tool, a script, a service. That caller may well relay a device code to
 * a human, but cannot be trusted to be at this machine, so a browser opened
 * here would wait for nobody — on Windows and macOS hasLocalBrowser() cannot
 * tell.
 *
 * stdout only. stderr carries every diagnostic this CLI emits, so redirecting
 * it alone (`login 2>log`) is ordinary on a desktop. Under MSYS/mintty neither
 * stream is a TTY, so a person in Git Bash there gets the device code too:
 * more friction than a browser, but it completes. Deliberately not stdin: the user types a device code into a
 * browser on another device, never into us, and an inherited, open-but-idle
 * pipe is not a TTY yet never reaches EOF (see readStdin in commands/call.ts).
 */
export function outputIsCaptured(): boolean {
  return !process.stdout.isTTY;
}

/** The stream a user-facing prompt should go to. stderr keeps stdout clean. */
export function promptStream(): 'stderr' | 'stdout' {
  return process.stderr.isTTY || !process.stdout.isTTY ? 'stderr' : 'stdout';
}
