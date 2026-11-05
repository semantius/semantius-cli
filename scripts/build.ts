#!/usr/bin/env bun
/**
 * The one definition of how the CLI is compiled. package.json, release.yml and
 * the tests that compile a real binary all come through here, so none of them
 * can lack something the binary needs.
 *
 * Usage: bun run scripts/build.ts --outfile <path> [--target <bun target>]
 *
 * The parser behind the sqlToRest tool (@supabase/pg-parser) is why the command
 * is not just `bun build --compile src/index.ts`. Its glue code reads
 * pg-parser.wasm from its own directory and offers no way to point it elsewhere,
 * so the file has to be inside the binary under exactly that name: an extra
 * entrypoint, plus --asset-naming because Bun otherwise appends a content hash.
 * wasm/17 is the version `new PgParser()` defaults to.
 *
 * Leave that out and the build still succeeds. @supabase/sql-to-rest creates its
 * parser when it is imported, so every crud command then reports an ENOENT on
 * pg-parser.wasm at run time, and some abort. A run from source finds the file
 * in node_modules and never shows it: tests/integration/compiled-binary.test.ts
 * is what catches it.
 */

import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';

const REPO_ROOT = dirname(import.meta.dir);

export interface CompileOptions {
  outfile: string;
  /** A `bun build` target such as bun-linux-x64; omitted, the current platform. */
  target?: string;
  minify?: boolean;
}

/** The argv that compiles the CLI. */
export function compileCommand({
  outfile,
  target,
  minify = true,
}: CompileOptions): string[] {
  return [
    'bun',
    'build',
    '--compile',
    ...(minify ? ['--minify'] : []),
    ...(target ? [`--target=${target}`] : []),
    '--asset-naming=[name].[ext]',
    join(REPO_ROOT, 'src', 'index.ts'),
    join(
      REPO_ROOT,
      'node_modules',
      '@supabase',
      'pg-parser',
      'wasm',
      '17',
      'pg-parser.wasm',
    ),
    '--outfile',
    outfile,
  ];
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      outfile: { type: 'string' },
      target: { type: 'string' },
    },
  });
  if (!values.outfile) {
    console.error(
      'Usage: bun run scripts/build.ts --outfile <path> [--target <bun target>]',
    );
    process.exit(1);
  }
  const build = Bun.spawnSync(
    compileCommand({ outfile: values.outfile, target: values.target }),
    { stdout: 'inherit', stderr: 'inherit' },
  );
  process.exit(build.exitCode);
}
