#!/usr/bin/env bun
/**
 * call-file.ts — sends a JSON file to a `crud` tool of the `semantius` CLI, so no shell
 * parses or re-encodes the payload. Quotes and apostrophes cannot break the call, and
 * non-ASCII text arrives intact in every shell, Windows PowerShell 5.1 included.
 *
 * Reads the file as UTF-8, with or without a byte order mark, or as UTF-16 LE with one
 * (what `>` writes in Windows PowerShell 5.1). Anything else is refused, never guessed.
 *
 * Usage:   bun call-file.ts <tool> <file.json>
 * Output:  the CLI's own stdout and stderr
 * Exit:    the CLI's own exit code; 1 (the CLI's code for bad arguments) when the
 *          arguments are wrong, or the file cannot be read or is not valid JSON
 */

import { readFileSync } from "node:fs";

export type Send = (tool: string, payload: string) => Promise<number>;

const USAGE = "Usage: bun call-file.ts <tool> <file.json>";

/** The text of a payload file; throws when it is neither UTF-8 nor UTF-16 LE with a byte order mark. */
export function decodePayload(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le", { fatal: true }).decode(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("is not UTF-8 text; save it as UTF-8");
  }
}

const spawnSend: Send = async (tool, payload) => {
  const proc = Bun.spawn(["semantius", "call", "crud", tool], { stdin: "pipe", stdout: "inherit", stderr: "inherit" });
  proc.stdin.write(payload);
  proc.stdin.end();
  return proc.exited;
};

/** Runs the script and returns its exit code. */
export async function main(argv: string[], send: Send = spawnSend, printError: (line: string) => void = console.error): Promise<number> {
  const [tool, file, ...rest] = argv;
  if (!tool || !file || rest.length) {
    printError(USAGE);
    return 1;
  }
  let payload: string;
  try {
    payload = JSON.stringify(JSON.parse(decodePayload(readFileSync(file))));
  } catch (e) {
    printError(`${file}: ${e instanceof Error ? e.message : e}`);
    return 1;
  }
  return send(tool, payload);
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
