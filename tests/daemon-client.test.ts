/**
 * Tests for daemon-client.ts's stopAllDaemons: called after `logout` to stop
 * every running daemon, since a revoked bearer can be baked into any of
 * their HTTP configs and a PID file's opaque config hash alone cannot say
 * which one (see the function's own docstring for why it cannot be scoped
 * to one host).
 *
 * POSIX only: Windows has no daemon at all (isDaemonEnabled() is always
 * false there — no Unix domain sockets, no process.getuid), so
 * stopAllDaemons() is a guaranteed no-op and there is nothing to verify.
 *
 * getSocketDir() is a fixed, shared directory (not a test seam), so these
 * use a server name unique to this process — matching
 * tests/integration/daemon.test.ts's own safety strategy — so a real daemon
 * elsewhere on the machine is never touched by name collision.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { getPidPath, getSocketDir, getSocketPath } from '../src/config';
import { isProcessRunning } from '../src/daemon';
import { stopAllDaemons } from '../src/daemon-client';

const posixOnly = process.platform !== 'win32';

describe.skipIf(!posixOnly)('stopAllDaemons', () => {
  const serverName = `stop-all-test-${process.pid}`;
  let child: ReturnType<typeof Bun.spawn> | undefined;

  beforeEach(() => {
    mkdirSync(getSocketDir(), { recursive: true });
  });

  afterEach(async () => {
    if (child && child.exitCode === null) {
      child.kill();
      await child.exited.catch(() => {});
    }
    child = undefined;
    for (const p of [getPidPath(serverName), getSocketPath(serverName)]) {
      try {
        unlinkSync(p);
      } catch {
        // already removed by the test, or never created
      }
    }
  });

  function writeFakePidFile(pid: number): void {
    writeFileSync(
      getPidPath(serverName),
      JSON.stringify({
        pid,
        configHash: 'irrelevant-for-this-test',
        startedAt: new Date().toISOString(),
      }),
    );
    // stopAllDaemons only ever removes this file, never connects to it.
    writeFileSync(getSocketPath(serverName), '');
  }

  test('kills the daemon process and removes its PID and socket files', async () => {
    // A real, harmless long-running process stands in for a daemon: what
    // matters is that it is a live PID stopAllDaemons must be able to kill.
    child = Bun.spawn({
      cmd: ['bun', '-e', 'setInterval(() => {}, 1000)'],
      stdout: 'ignore',
      stderr: 'ignore',
    });
    writeFakePidFile(child.pid);
    expect(isProcessRunning(child.pid)).toBe(true);

    await stopAllDaemons();

    // SIGTERM is not instant.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && isProcessRunning(child.pid)) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(isProcessRunning(child.pid)).toBe(false);
    expect(existsSync(getPidPath(serverName))).toBe(false);
    expect(existsSync(getSocketPath(serverName))).toBe(false);
  }, 10_000);

  test('removes a stale PID file even when nothing needed killing', async () => {
    // No live process holds this PID (process.kill(pid, 0) reliably reports
    // ESRCH for it) — killProcess must fail silently and cleanup must still
    // happen, the same as it already does for an orphaned daemon.
    writeFakePidFile(2 ** 30);

    await stopAllDaemons();

    expect(existsSync(getPidPath(serverName))).toBe(false);
    expect(existsSync(getSocketPath(serverName))).toBe(false);
  });
});
