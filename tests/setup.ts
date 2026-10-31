/**
 * Preloaded before every test file (bunfig.toml [test].preload).
 *
 * src/output.ts colorizes when stdout is a TTY. `bun test` run by hand in a
 * terminal (e.g. by ./release.sh) has a TTY stdout, CI and piped runs do not,
 * so any test asserting on formatted output would pass in CI and fail at a
 * developer's terminal. Colors are off for the whole suite instead.
 */
process.env.NO_COLOR = '1';

/**
 * No daemons either, unless a test asks for one. On Linux/macOS any
 * connection, local PostgREST layer included, would otherwise start a
 * detached daemon that outlives the test by its idle timeout: from an
 * in-process test as `bun <test file> --daemon`, which is no daemon at all,
 * and from a spawned CLI (which inherits this) as a real one, aimed at the
 * test's stub servers. Tests of the daemon itself set it to '0'.
 */
process.env.SEMANTIUS_NO_DAEMON = '1';
