/**
 * The three environment predicates that decide whether an interactive login
 * can happen, and with which grant (auth/environment.ts).
 *
 * Every one reads process.env at call time, and `bun test` runs in-band, so
 * each case saves and restores the vars it touches. CI in particular is
 * already set on a runner, so a "not CI" case has to delete it rather than
 * trust it to be absent.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  canShowUser,
  hasLocalBrowser,
  isCi,
  promptStream,
} from '../src/auth/environment';

const VARS = ['DISPLAY', 'WAYLAND_DISPLAY', 'BROWSER', 'CI'];

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const v of VARS) {
    saved[v] = process.env[v];
    delete process.env[v];
  }
});

afterEach(() => {
  for (const v of VARS) {
    if (saved[v] !== undefined) process.env[v] = saved[v];
    else delete process.env[v];
  }
});

/** hasLocalBrowser short-circuits on platform, so Linux cases need the flag. */
const onLinux = process.platform !== 'win32' && process.platform !== 'darwin';

describe('hasLocalBrowser', () => {
  test('$BROWSER wins on every platform', () => {
    process.env.BROWSER = 'firefox';
    expect(hasLocalBrowser()).toBe(true);
  });

  test('$BROWSER rescues a session with no DISPLAY (VS Code Remote-SSH)', () => {
    // Remote-SSH forwards an opener and auto-forwards localhost ports, so the
    // loopback flow genuinely works there even though DISPLAY is unset.
    process.env.BROWSER = '/usr/bin/code --openExternal';
    expect(hasLocalBrowser()).toBe(true);
  });

  test('Windows and macOS always claim a browser; Linux needs a display', () => {
    if (onLinux) {
      expect(hasLocalBrowser()).toBe(false);
      process.env.DISPLAY = ':0';
      expect(hasLocalBrowser()).toBe(true);
      delete process.env.DISPLAY;
      process.env.WAYLAND_DISPLAY = 'wayland-0';
      expect(hasLocalBrowser()).toBe(true);
    } else {
      // No DISPLAY to consult: the answer is a weak "probably", which is why
      // openBrowser's own failure is reported rather than trusted blindly.
      expect(hasLocalBrowser()).toBe(true);
    }
  });

  test('an empty DISPLAY is not a display', () => {
    if (!onLinux) return;
    process.env.DISPLAY = '';
    expect(hasLocalBrowser()).toBe(false);
  });
});

describe('isCi', () => {
  test('unset or empty is not CI', () => {
    expect(isCi()).toBe(false);
    process.env.CI = '';
    expect(isCi()).toBe(false);
  });

  test('the usual truthy values are CI', () => {
    for (const v of ['true', '1', 'TRUE', 'yes']) {
      process.env.CI = v;
      expect(isCi()).toBe(true);
    }
  });

  test('CI=false is not CI, though it is a non-empty string', () => {
    // A plain truthiness check on process.env.CI gets each of these wrong.
    for (const v of ['false', '0', 'no', 'off', 'False', 'OFF']) {
      process.env.CI = v;
      expect(isCi()).toBe(false);
    }
  });
});

describe('canShowUser / promptStream', () => {
  test('either stream being a terminal is enough', () => {
    // Under `bun test` both are pipes, so this asserts the contract on stubs
    // rather than on the harness's own streams.
    const cases: [boolean, boolean, boolean][] = [
      [true, true, true],
      [true, false, true],
      [false, true, true],
      [false, false, false],
    ];
    for (const [out, err, expected] of cases) {
      const restore = stubTty(out, err);
      try {
        expect(canShowUser()).toBe(expected);
      } finally {
        restore();
      }
    }
  });

  test('a prompt goes to stderr unless only stdout is a terminal', () => {
    let restore = stubTty(false, true);
    expect(promptStream()).toBe('stderr');
    restore();

    restore = stubTty(true, false);
    expect(promptStream()).toBe('stdout');
    restore();

    // Neither is a terminal: stderr, so the text still lands somewhere a
    // redirect can capture rather than polluting parsed stdout.
    restore = stubTty(false, false);
    expect(promptStream()).toBe('stderr');
    restore();
  });
});

/** Swap both isTTY flags, returning an undo. */
function stubTty(stdout: boolean, stderr: boolean): () => void {
  const o = process.stdout.isTTY;
  const e = process.stderr.isTTY;
  (process.stdout as { isTTY?: boolean }).isTTY = stdout;
  (process.stderr as { isTTY?: boolean }).isTTY = stderr;
  return () => {
    (process.stdout as { isTTY?: boolean }).isTTY = o;
    (process.stderr as { isTTY?: boolean }).isTTY = e;
  };
}
