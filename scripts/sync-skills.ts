#!/usr/bin/env bun
/**
 * Replace skills/ with the agent skills from semantius-agent.
 *
 * semantius-agent owns the skills (semantius-plugin/skills/); this repo carries
 * an UNCHANGED copy. Never edit files under skills/ by hand — change them
 * upstream and re-sync.
 *
 * Usage:
 *   bun run sync-skills         replace skills/ with upstream's, print the commit message
 *   bun run sync-skills:check   exit 1 (listing the paths) if skills/ differs from
 *                               upstream; writes nothing
 *
 * Upstream checkout: $SEMANTIUS_AGENT_DIR, default <repo root>/../semantius-agent.
 * Its semantius-plugin/skills/ must be clean. Files are read from its HEAD commit
 * rather than the working tree: git stores them with LF, whereas a Windows
 * checkout with core.autocrlf has CRLF on disk, and this repo enforces eol=lf.
 *
 * A sync deletes skills/ before writing, so a file upstream deleted or renamed
 * does not survive here. skills/ holds nothing but upstream's files (no notes,
 * no sync record): `npx skills` reads it. The upstream commit goes in the commit
 * message instead.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const REPO_ROOT = dirname(import.meta.dir);
const UPSTREAM_DIR = process.env.SEMANTIUS_AGENT_DIR
  ? resolve(process.env.SEMANTIUS_AGENT_DIR)
  : join(REPO_ROOT, '..', 'semantius-agent');
const UPSTREAM_ROOT = 'semantius-plugin/skills';
const SKILLS_DIR = join(REPO_ROOT, 'skills');

// ---------------------------------------------------------------------------
// git access
// ---------------------------------------------------------------------------

function git(args: string[]): string {
  const proc = Bun.spawnSync(['git', '-C', UPSTREAM_DIR, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (proc.exitCode !== 0) {
    fail(`git ${args.join(' ')} failed: ${proc.stderr.toString().trim()}`);
  }
  return proc.stdout.toString();
}

/** Read blobs at HEAD in one `git cat-file --batch` round trip. */
function readBlobs(paths: string[]): Map<string, Buffer> {
  const proc = Bun.spawnSync(['git', '-C', UPSTREAM_DIR, 'cat-file', '--batch'], {
    stdin: Buffer.from(paths.map((p) => `HEAD:${p}\n`).join('')),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (proc.exitCode !== 0) {
    fail(`git cat-file failed: ${proc.stderr.toString().trim()}`);
  }

  const out = proc.stdout;
  const blobs = new Map<string, Buffer>();
  let offset = 0;
  for (const path of paths) {
    const headerEnd = out.indexOf(0x0a, offset);
    const header = out.subarray(offset, headerEnd).toString();
    const match = /^[0-9a-f]+ blob (\d+)$/.exec(header);
    if (!match) fail(`git cat-file: unexpected header for ${path}: ${header}`);
    const size = Number(match[1]);
    const start = headerEnd + 1;
    blobs.set(path, Buffer.from(out.subarray(start, start + size)));
    offset = start + size + 1; // content is followed by a newline
  }
  return blobs;
}

function fail(message: string): never {
  console.error(`sync-skills: ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// skills/
// ---------------------------------------------------------------------------

/** skills/-relative paths of every file currently under SKILLS_DIR. */
function listLocal(dir = SKILLS_DIR): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...listLocal(full));
    else files.push(relative(SKILLS_DIR, full).replaceAll('\\', '/'));
  }
  return files;
}

const normalizeEol = (buf: Buffer) => buf.toString('utf8').replace(/\r\n/g, '\n');

function writeFile(path: string, content: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const check = process.argv.includes('--check');

  if (!existsSync(join(UPSTREAM_DIR, '.git'))) {
    fail(`upstream checkout not found at ${UPSTREAM_DIR} (set SEMANTIUS_AGENT_DIR)`);
  }
  const dirty = git(['status', '--porcelain', '--', UPSTREAM_ROOT]).trim();
  if (dirty) {
    fail(`${UPSTREAM_ROOT} in ${UPSTREAM_DIR} has uncommitted changes; commit them first:\n${dirty}`);
  }
  const head = git(['rev-parse', 'HEAD']).trim();

  const upstreamPaths = git(['ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', UPSTREAM_ROOT])
    .split('\0')
    .filter(Boolean);
  if (upstreamPaths.length === 0) fail(`upstream has no ${UPSTREAM_ROOT} at HEAD`);

  const blobs = readBlobs(upstreamPaths);
  const files = new Map(
    upstreamPaths.map((p) => [p.slice(UPSTREAM_ROOT.length + 1), blobs.get(p) as Buffer] as const),
  );
  const local = listLocal();

  if (check) {
    const problems: string[] = [];
    for (const [path, blob] of files) {
      const full = join(SKILLS_DIR, path);
      if (!existsSync(full)) {
        problems.push(`  missing: ${path}`);
      } else if (normalizeEol(readFileSync(full)) !== normalizeEol(blob)) {
        problems.push(`  changed: ${path}`);
      }
    }
    for (const path of local) {
      if (!files.has(path)) problems.push(`  extra:   ${path} (no longer upstream)`);
    }

    const source = `${join(UPSTREAM_DIR, UPSTREAM_ROOT)} @ ${head.slice(0, 12)}`;
    if (problems.length > 0) {
      console.error(
        `sync-skills:check: skills/ differs from ${source}:\n${problems.join('\n')}\nRun \`bun run sync-skills\` and commit the result.`,
      );
      process.exit(1);
    }
    console.log(`sync-skills:check: skills/ matches ${source}`);
    return;
  }

  // Replace, not copy over: a file upstream deleted must not survive here.
  rmSync(SKILLS_DIR, { recursive: true, force: true });
  for (const [path, blob] of files) {
    writeFile(join(SKILLS_DIR, path), blob);
  }

  for (const path of local) {
    if (!files.has(path)) console.log(`  removed ${path}`);
  }
  for (const path of files.keys()) {
    if (!local.includes(path)) console.log(`  added   ${path}`);
  }
  console.log(
    `Replaced skills/ with ${files.size} files from ${join(UPSTREAM_DIR, UPSTREAM_ROOT)}.\nCommit with: git add -A skills && git commit -m "chore(skills): sync from semantius-agent ${head.slice(0, 12)}"`,
  );
}

main();
