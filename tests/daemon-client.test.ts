/**
 * Tests for the daemon bookkeeping: getConfigHash, the PID-file claim, how
 * getDaemonState reads a daemon's files, getSelfCommand, and stopAllDaemons,
 * which is called after `logout` to stop every running daemon, since a
 * revoked bearer can be baked into any of their HTTP configs and a PID file's
 * opaque config hash alone cannot say which one (see the function's own
 * docstring for why it cannot be scoped to one host).
 *
 * The file-based tests are POSIX only: Windows has no daemon at all
 * (isDaemonEnabled() is always false there — no Unix domain sockets, no
 * process.getuid), so there is nothing to verify.
 *
 * getSocketDir() is a fixed, shared directory (not a test seam), so these
 * use server names unique to this process — matching
 * tests/integration/daemon.test.ts's own safety strategy — so a real daemon
 * elsewhere on the machine is never touched by name collision.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import {
  getConfigHash,
  getPidPath,
  getSocketDir,
  getSocketPath,
} from '../src/config';
import { claimPidFile, isProcessRunning, readPidFile } from '../src/daemon';
import {
  getDaemonState,
  getSelfCommand,
  stopAllDaemons,
} from '../src/daemon-client';

const posixOnly = process.platform !== 'win32';

/** A harmless long-running process to stand in for a daemon's PID. */
function spawnStandIn(): ReturnType<typeof Bun.spawn> {
  return Bun.spawn({
    cmd: ['bun', '-e', 'setInterval(() => {}, 1000)'],
    stdout: 'ignore',
    stderr: 'ignore',
  });
}

async function waitForExit(pid: number): Promise<void> {
  // SIGTERM is not instant.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && isProcessRunning(pid)) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // already removed by the test, or never created
  }
}

describe('getConfigHash', () => {
  const server = {
    url: 'https://acme.semantius.ai/mcp',
    headers: { Authorization: 'Bearer AAA', 'x-api-key': '' },
  };

  // A daemon keyed by a hash that ignored headers kept sending the bearer it
  // was started with long after the CLI had refreshed it.
  test('changes when a nested value changes, the bearer above all', () => {
    expect(getConfigHash(server)).not.toBe(
      getConfigHash({
        ...server,
        headers: { ...server.headers, Authorization: 'Bearer BBB' },
      }),
    );
  });

  test('ignores key order at every level', () => {
    expect(getConfigHash(server)).toBe(
      getConfigHash({
        headers: { 'x-api-key': '', Authorization: 'Bearer AAA' },
        url: 'https://acme.semantius.ai/mcp',
      }),
    );
  });
});

describe('getSelfCommand', () => {
  // A release binary is built as semantius-linux-x64 & co. and installed as
  // semantius: the bundle path's name never matches the installed file's.
  test('re-launches a compiled binary alone, whatever it was renamed to', () => {
    expect(getSelfCommand('/$bunfs/root/semantius-linux-x64')).toEqual([
      process.execPath,
    ]);
    expect(getSelfCommand('B:\\~BUN\\root\\semantius-windows-x64.exe')).toEqual(
      [process.execPath],
    );
    expect(getSelfCommand('B:/~BUN/root/semantius-windows-x64.exe')).toEqual([
      process.execPath,
    ]);
  });

  test('passes the entry script to bun when run from source', () => {
    expect(getSelfCommand('/home/dev/semantius-cli/src/index.ts')).toEqual([
      process.execPath,
      '/home/dev/semantius-cli/src/index.ts',
    ]);
  });
});

describe.skipIf(!posixOnly)('daemon files', () => {
  const serverName = `state-test-${process.pid}`;
  const config = { url: 'https://acme.semantius.ai/mcp' };
  let child: ReturnType<typeof Bun.spawn> | undefined;

  beforeEach(() => {
    mkdirSync(getSocketDir(), { recursive: true, mode: 0o700 });
  });

  afterEach(async () => {
    if (child && child.exitCode === null) {
      child.kill();
      await child.exited.catch(() => {});
    }
    if (child) removeQuietly(getSocketPath(serverName, child.pid));
    child = undefined;
    removeQuietly(getPidPath(serverName));
  });

  function writePidFile(pid: number, startedAt = new Date()): void {
    writeFileSync(
      getPidPath(serverName),
      JSON.stringify({
        pid,
        configHash: getConfigHash(config),
        startedAt: startedAt.toISOString(),
      }),
    );
  }

  test('claimPidFile lets only one live daemon hold a server', () => {
    child = spawnStandIn();
    writePidFile(child.pid);
    expect(claimPidFile(serverName, 'hash')).toBe(false);
    expect(readPidFile(serverName)?.pid).toBe(child.pid);
  });

  test('claimPidFile takes over a file whose process is gone', () => {
    writePidFile(2 ** 30);
    expect(claimPidFile(serverName, 'hash')).toBe(true);
    expect(readPidFile(serverName)?.pid).toBe(process.pid);
  });

  test('a ready daemon is found at its own socket', () => {
    child = spawnStandIn();
    writePidFile(child.pid);
    writeFileSync(getSocketPath(serverName, child.pid), '');
    expect(getDaemonState(serverName, config)).toEqual({
      state: 'ready',
      socketPath: getSocketPath(serverName, child.pid),
    });
  });

  // A daemon opens its socket only once it is up; a second invocation in
  // that window must neither kill it nor start another.
  test('a daemon without its socket yet is left to finish starting', () => {
    child = spawnStandIn();
    writePidFile(child.pid);
    expect(getDaemonState(serverName, config)).toEqual({ state: 'starting' });
    expect(isProcessRunning(child.pid)).toBe(true);
    expect(existsSync(getPidPath(serverName))).toBe(true);
  });

  test('a daemon still without its socket after the grace period is replaced', async () => {
    child = spawnStandIn();
    writePidFile(child.pid, new Date(Date.now() - 60_000));
    expect(getDaemonState(serverName, config)).toEqual({ state: 'absent' });
    await waitForExit(child.pid);
    expect(isProcessRunning(child.pid)).toBe(false);
    expect(existsSync(getPidPath(serverName))).toBe(false);
  }, 10_000);

  test('a daemon started with another config is replaced', async () => {
    child = spawnStandIn();
    writePidFile(child.pid);
    writeFileSync(getSocketPath(serverName, child.pid), '');
    expect(
      getDaemonState(serverName, { ...config, headers: { a: 'b' } }),
    ).toEqual({ state: 'absent' });
    await waitForExit(child.pid);
    expect(isProcessRunning(child.pid)).toBe(false);
    expect(existsSync(getPidPath(serverName))).toBe(false);
    expect(existsSync(getSocketPath(serverName, child.pid))).toBe(false);
  }, 10_000);
});

describe.skipIf(!posixOnly)('stopAllDaemons', () => {
  const serverName = `stop-all-test-${process.pid}`;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let fakePid = 0;

  beforeEach(() => {
    mkdirSync(getSocketDir(), { recursive: true, mode: 0o700 });
  });

  afterEach(async () => {
    if (child && child.exitCode === null) {
      child.kill();
      await child.exited.catch(() => {});
    }
    child = undefined;
    removeQuietly(getPidPath(serverName));
    removeQuietly(getSocketPath(serverName, fakePid));
  });

  function writeFakePidFile(pid: number): void {
    fakePid = pid;
    writeFileSync(
      getPidPath(serverName),
      JSON.stringify({
        pid,
        configHash: 'irrelevant-for-this-test',
        startedAt: new Date().toISOString(),
      }),
    );
    // stopAllDaemons only ever removes this file, never connects to it.
    writeFileSync(getSocketPath(serverName, pid), '');
  }

  test('kills the daemon process and removes its PID and socket files', async () => {
    // A real, harmless long-running process stands in for a daemon: what
    // matters is that it is a live PID stopAllDaemons must be able to kill.
    child = spawnStandIn();
    writeFakePidFile(child.pid);
    expect(isProcessRunning(child.pid)).toBe(true);

    await stopAllDaemons();

    await waitForExit(child.pid);
    expect(isProcessRunning(child.pid)).toBe(false);
    expect(existsSync(getPidPath(serverName))).toBe(false);
    expect(existsSync(getSocketPath(serverName, child.pid))).toBe(false);
  }, 10_000);

  test('removes a stale PID file even when nothing needed killing', async () => {
    // No live process holds this PID (process.kill(pid, 0) reliably reports
    // ESRCH for it) — killProcess must fail silently and cleanup must still
    // happen, the same as it already does for an orphaned daemon.
    writeFakePidFile(2 ** 30);

    await stopAllDaemons();

    expect(existsSync(getPidPath(serverName))).toBe(false);
    expect(existsSync(getSocketPath(serverName, 2 ** 30))).toBe(false);
  });
});
