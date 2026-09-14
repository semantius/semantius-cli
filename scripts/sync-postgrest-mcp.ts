#!/usr/bin/env bun
/**
 * Vendor the crud tool code from postgrest-mcp into src/vendor/postgrest-mcp/.
 *
 * postgrest-mcp owns the tool code; this repo carries an UNCHANGED copy so the
 * CLI can run the crud tools in-process against PostgREST. Never edit files
 * under src/vendor/postgrest-mcp/ by hand — change them upstream and re-sync.
 *
 * Usage:
 *   bun run sync-mcp-tools         copy the upstream files, regenerate instructions.ts
 *                                  and registry.ts, rewrite the upstream bulk test,
 *                                  write UPSTREAM
 *   bun run sync-mcp-tools:check   exit 1 (listing the paths) if the vendored copy
 *                                  differs from upstream; writes nothing. Release-only gate.
 *
 * Upstream checkout: $POSTGREST_MCP_DIR, default <repo root>/../postgrest-mcp.
 * It must be a clean git checkout. Files are read from its HEAD commit rather
 * than the working tree: git stores them with LF, whereas a Windows checkout
 * with core.autocrlf has CRLF on disk, and this repo enforces eol=lf.
 *
 * Owned by this script but never compared by --check:
 *   - src/generated/instructions.ts  generated from the copied src/SKILL.md
 *   - registry.ts                    `tools` array of every copied *Tool export
 *   - UPSTREAM                       the upstream commit of the last sync
 * Never written by this script:
 *   - src/utils/resetSchemaCache.ts  the CLI's local replacement (the upstream
 *                                    file needs Kysely/Neon and DB credentials)
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
const UPSTREAM_DIR = process.env.POSTGREST_MCP_DIR
  ? resolve(process.env.POSTGREST_MCP_DIR)
  : join(REPO_ROOT, '..', 'postgrest-mcp');
const VENDOR_DIR = join(REPO_ROOT, 'src', 'vendor', 'postgrest-mcp');
const VENDOR_TEST_DIR = join(REPO_ROOT, 'tests', 'vendor');

/** Upstream paths whose files are copied (directories are taken recursively). */
const COPY_ROOTS = [
  'types.ts',
  'src/SKILL.md',
  'src/tools',
  ...[
    'postgrest',
    'bulk',
    'formatResponse',
    'errorHandler',
    'apiKeyAuth',
    'semantiusOrg',
    'env',
  ].map((name) => `src/utils/${name}.ts`),
];

/**
 * Upstream files under COPY_ROOTS that are not copied:
 *   - echo.ts is commented out of upstream's tool list (debug only).
 *   - sqlToRest.ts needs @supabase/sql-to-rest, whose WASM parser is loaded
 *     from disk next to its glue code and is missing inside a
 *     `bun build --compile` binary (ENOENT on $bunfs/root/pg-parser.wasm).
 *     The tool stays available through the MCP route (--crud-mcp).
 */
const EXCLUDED = new Set(['src/tools/echo.ts', 'src/tools/sqlToRest.ts']);

/** Vendor-relative paths owned by this script but excluded from --check. */
const INSTRUCTIONS_FILE = 'src/generated/instructions.ts';
const REGISTRY_FILE = 'registry.ts';
const UPSTREAM_FILE = 'UPSTREAM';
/** Vendor-relative path of the CLI's own replacement module. */
const REPLACEMENT_FILE = 'src/utils/resetSchemaCache.ts';
const NOT_COPIED = new Set([
  INSTRUCTIONS_FILE,
  REGISTRY_FILE,
  UPSTREAM_FILE,
  REPLACEMENT_FILE,
]);

const UPSTREAM_TEST = 'tests/crud-bulk.test.ts';
const VENDOR_TEST = 'crud-bulk.test.ts';

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
  console.error(`sync-postgrest-mcp: ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Transformations
// ---------------------------------------------------------------------------

const DENO_ASSERT_URL = 'https://deno.land/std@0.224.0/assert/mod.ts';

/**
 * The only three rewrites applied to the upstream test (--check applies the
 * same before comparing): (1) the Deno std assert URL → the local bun:test
 * shim, (2) Deno.test( → test( with the bun:test import prepended, (3) the
 * relative imports re-rooted at the vendored tree.
 */
function rewriteTest(source: string): string {
  if (source.split(DENO_ASSERT_URL).length !== 2) {
    fail(`${UPSTREAM_TEST}: expected exactly one import of ${DENO_ASSERT_URL}`);
  }
  if (!source.includes('Deno.test(')) {
    fail(`${UPSTREAM_TEST}: no Deno.test( calls found`);
  }

  const out = `import { test } from 'bun:test';\n${source
    .replace(DENO_ASSERT_URL, './deno-assert.ts')
    .replaceAll('Deno.test(', 'test(')
    .replaceAll('"../types.ts"', '"../../src/vendor/postgrest-mcp/types.ts"')
    .replaceAll('"../src/', '"../../src/vendor/postgrest-mcp/src/')}`;

  if (/\bDeno\./.test(out)) {
    fail(`${UPSTREAM_TEST}: Deno API use beyond Deno.test( — the three rewrites no longer suffice`);
  }
  return out;
}

/** Same escaping as upstream scripts/generate-instructions.js. */
function generateInstructions(skillMd: string): string {
  const escaped = skillMd
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$');
  return `// Auto-generated from src/SKILL.md by scripts/sync-postgrest-mcp.ts — do not edit manually\nexport const instructions = \`${escaped}\`;\n`;
}

/**
 * The upstream tool order, read from the `tools` array in src/mcp.ts (which
 * is not copied and does not export it). listTools returns tools in
 * registration order, so matching it keeps `info`, `grep` and `-md` output
 * identical to the remote server.
 */
function upstreamToolOrder(mcpTs: string): string[] {
  const match = /const tools = \[([\s\S]*?)\n\]/.exec(mcpTs);
  if (!match) fail('src/mcp.ts: could not find the `const tools = [...]` array');
  return match[1]
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, '').trim())
    .flatMap((line) => line.split(','))
    .map((name) => name.trim())
    .filter((name) => /^\w+$/.test(name));
}

/**
 * registry.ts: every *Tool export of the copied src/tools/*.ts, ordered as in
 * upstream src/mcp.ts; tools missing there (none today) follow alphabetically.
 */
function generateRegistry(
  toolFiles: Map<string, string>,
  mcpTs: string,
): string {
  const exports: Array<{ name: string; file: string }> = [];
  for (const [file, source] of toolFiles) {
    for (const m of source.matchAll(/^export const (\w+Tool)\b/gm)) {
      exports.push({ name: m[1], file });
    }
  }

  const order = upstreamToolOrder(mcpTs);
  const rank = (name: string) => {
    const i = order.indexOf(name);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  exports.sort(
    (a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name),
  );

  const imports = exports
    .map(({ name, file }) => `import { ${name} } from './${file}'`)
    .join('\n');
  const entries = exports.map(({ name }) => `  ${name},`).join('\n');
  return `// Auto-generated by scripts/sync-postgrest-mcp.ts — do not edit manually.\n// Every *Tool export of the copied src/tools/*.ts, in upstream src/mcp.ts order.\n${imports}\n\nexport const tools = [\n${entries}\n]\n`;
}

// ---------------------------------------------------------------------------
// Vendored tree
// ---------------------------------------------------------------------------

/** Vendor-relative paths of every file currently under VENDOR_DIR. */
function listVendored(dir = VENDOR_DIR): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...listVendored(full));
    else files.push(relative(VENDOR_DIR, full).replaceAll('\\', '/'));
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
    fail(`upstream checkout not found at ${UPSTREAM_DIR} (set POSTGREST_MCP_DIR)`);
  }
  const dirty = git(['status', '--porcelain']).trim();
  if (dirty) {
    fail(`upstream checkout ${UPSTREAM_DIR} is not clean:\n${dirty}`);
  }
  const head = git(['rev-parse', 'HEAD']).trim();

  const copySet = git(['ls-tree', '-r', '--name-only', 'HEAD', '--', ...COPY_ROOTS])
    .split('\n')
    .filter((p) => p && !EXCLUDED.has(p));
  for (const root of COPY_ROOTS) {
    if (!copySet.some((p) => p === root || p.startsWith(`${root}/`))) {
      fail(`upstream has no ${root} at HEAD`);
    }
  }

  const blobs = readBlobs([...copySet, UPSTREAM_TEST, 'src/mcp.ts']);
  const expectedTest = rewriteTest(blobs.get(UPSTREAM_TEST)?.toString('utf8') ?? '');

  if (check) {
    const problems: string[] = [];
    const vendored = new Set(listVendored().filter((p) => !NOT_COPIED.has(p)));
    for (const path of copySet) {
      const local = join(VENDOR_DIR, path);
      if (!existsSync(local)) {
        problems.push(`  missing: ${path} (upstream file not vendored)`);
      } else if (normalizeEol(readFileSync(local)) !== normalizeEol(blobs.get(path) as Buffer)) {
        problems.push(`  changed: ${path}`);
      }
      vendored.delete(path);
    }
    for (const path of vendored) {
      problems.push(`  extra:   ${path} (vendored file no longer upstream)`);
    }
    const testPath = join(VENDOR_TEST_DIR, VENDOR_TEST);
    if (
      !existsSync(testPath) ||
      normalizeEol(readFileSync(testPath)) !== expectedTest.replace(/\r\n/g, '\n')
    ) {
      problems.push(`  changed: tests/vendor/${VENDOR_TEST}`);
    }
    if (!existsSync(join(VENDOR_DIR, REPLACEMENT_FILE))) {
      problems.push(`  missing: ${REPLACEMENT_FILE} (the CLI's local replacement)`);
    }

    const recordedPath = join(VENDOR_DIR, UPSTREAM_FILE);
    const recorded = existsSync(recordedPath)
      ? readFileSync(recordedPath, 'utf8')
          .split('\n')
          .find((l) => /^[0-9a-f]{40}$/.test(l.trim()))
          ?.trim()
      : undefined;
    const from = `vendored from ${recorded ?? '(no UPSTREAM record)'}, upstream HEAD ${head}`;

    if (problems.length > 0) {
      console.error(
        `sync-mcp-tools:check: src/vendor/postgrest-mcp differs from ${UPSTREAM_DIR} (${from}):\n${problems.join('\n')}\nRun \`bun run sync-mcp-tools\` and commit the result.`,
      );
      process.exit(1);
    }
    console.log(`sync-mcp-tools:check: vendored copy is current (${from})`);
    return;
  }

  // Sync: mirror the copy set, dropping vendored files that left upstream.
  for (const path of listVendored()) {
    if (!NOT_COPIED.has(path) && !copySet.includes(path)) {
      rmSync(join(VENDOR_DIR, path));
      console.log(`  removed ${path}`);
    }
  }
  for (const path of copySet) {
    writeFile(join(VENDOR_DIR, path), blobs.get(path) as Buffer);
  }

  const skillMd = normalizeEol(blobs.get('src/SKILL.md') as Buffer);
  writeFile(join(VENDOR_DIR, INSTRUCTIONS_FILE), generateInstructions(skillMd));

  const toolFiles = new Map(
    copySet
      .filter((p) => /^src\/tools\/[^/]+\.ts$/.test(p))
      .map((p) => [p, (blobs.get(p) as Buffer).toString('utf8')] as const),
  );
  const mcpTs = (blobs.get('src/mcp.ts') as Buffer).toString('utf8');
  writeFile(join(VENDOR_DIR, REGISTRY_FILE), generateRegistry(toolFiles, mcpTs));

  writeFile(join(VENDOR_TEST_DIR, VENDOR_TEST), expectedTest);

  writeFile(
    join(VENDOR_DIR, UPSTREAM_FILE),
    `# postgrest-mcp commit this tree was copied from (written by \`bun run sync-mcp-tools\`)\n${head}\n`,
  );

  if (!existsSync(join(VENDOR_DIR, REPLACEMENT_FILE))) {
    console.warn(
      `sync-postgrest-mcp: warning: ${REPLACEMENT_FILE} (the CLI's local replacement) is missing; the vendored tools import it`,
    );
  }

  console.log(
    `Synced ${copySet.length} files from ${UPSTREAM_DIR} @ ${head.slice(0, 12)} into src/vendor/postgrest-mcp (${toolFiles.size} tool files)`,
  );
}

main();
