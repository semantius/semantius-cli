/**
 * Preloaded before every test file (bunfig.toml [test].preload).
 *
 * src/output.ts colorizes when stdout is a TTY. `bun test` run by hand in a
 * terminal (e.g. by ./release.sh) has a TTY stdout, CI and piped runs do not,
 * so any test asserting on formatted output would pass in CI and fail at a
 * developer's terminal. Colors are off for the whole suite instead.
 */
process.env.NO_COLOR = '1';
