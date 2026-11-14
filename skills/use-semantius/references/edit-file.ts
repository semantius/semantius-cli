#!/usr/bin/env bun
/**
 * edit-file.ts — changes a file you wrote by exact replacement, for a harness with no file-edit tool.
 * Each block names text that must occur exactly once in the file and the text that replaces it; every
 * block is applied, or none is. The file keeps its line endings.
 *
 * Usage:   bun edit-file.ts <file> <<'EOF'
 *          <<<<<<< OLD
 *          the exact lines to replace
 *          =======
 *          the lines that replace them
 *          >>>>>>> NEW
 *          EOF
 *          Several blocks may follow one another. An empty NEW part deletes the OLD lines.
 * Output:  each changed line, numbered as in the changed file
 * Exit:    0 when every block was applied; 1 on wrong arguments, a block that is not found, one that
 *          matches more than once, or one whose NEW part is the same as its OLD part (nothing is changed then)
 */

import { readFileSync, writeFileSync } from "node:fs";

export type Block = { old: string; next: string };

const USAGE = "Usage: bun edit-file.ts <file>, with blocks on stdin: <<<<<<< OLD / the exact old lines / ======= / the new lines / >>>>>>> NEW";

/** The blocks of a change, read from text with `<<<<<<< OLD`, `=======` and `>>>>>>> NEW` lines. */
export function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() === "") { i++; continue; }
    if (lines[i].trimEnd() !== "<<<<<<< OLD") throw new Error(`line ${i + 1}: expected "<<<<<<< OLD", found "${lines[i].slice(0, 60)}"`);
    const start = ++i;
    while (i < lines.length && lines[i].trimEnd() !== "=======") i++;
    if (i >= lines.length) throw new Error(`the block starting at line ${start} has no "=======" line`);
    const old = lines.slice(start, i).join("\n");
    const mid = ++i;
    while (i < lines.length && lines[i].trimEnd() !== ">>>>>>> NEW") i++;
    if (i >= lines.length) throw new Error(`the block starting at line ${start} has no ">>>>>>> NEW" line`);
    blocks.push({ old, next: lines.slice(mid, i).join("\n") });
    i++;
  }
  if (!blocks.length) throw new Error("no block found on stdin");
  return blocks;
}

const count = (hay: string, needle: string): number => {
  let n = 0;
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) n++;
  return n;
};

/** The file's text with every block applied; throws, naming the block, when one is missing or ambiguous. */
export function applyBlocks(text: string, blocks: ReadonlyArray<Block>): { text: string; changed: number[] } {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  let out = text;
  const spans: Array<{ at: number; length: number }> = [];
  blocks.forEach((b, n) => {
    const old = b.old.split("\n").join(eol);
    const next = b.next.split("\n").join(eol);
    if (!old.trim()) throw new Error(`block ${n + 1}: the OLD part is empty; name the lines to replace`);
    if (b.old === b.next) throw new Error(`block ${n + 1}: the NEW part is the same as the OLD part, so nothing would change; the halt is not fixed`);
    const hits = count(out, old);
    if (hits === 0) {
      const first = b.old.split("\n").find((l) => l.trim()) ?? "";
      const near = out.split(/\r?\n/).findIndex((l) => l.trim() === first.trim());
      throw new Error(
        `block ${n + 1}: the OLD text is not in the file` +
        (near >= 0 ? `; its first line is at line ${near + 1}, so a later line differs (spaces count)` : `; its first line "${first.trim().slice(0, 60)}" is not in the file either`) +
        ". Read those lines again and copy them exactly.",
      );
    }
    if (hits > 1) throw new Error(`block ${n + 1}: the OLD text occurs ${hits} times; add lines around it until it occurs once`);
    const at = out.indexOf(old);
    // an empty NEW part deletes the lines, with their line break
    const cut = next === "" && out.startsWith(eol, at + old.length) ? old.length + eol.length : old.length;
    out = out.slice(0, at) + next + out.slice(at + cut);
    const delta = next.length - cut;
    for (const s of spans) if (s.at > at) s.at += delta;   // earlier changes below this one moved
    if (next.length) spans.push({ at, length: next.length });
  });
  const lineOf = (offset: number) => out.slice(0, offset).split(/\n/).length;
  const changed = new Set<number>();
  for (const s of spans) {
    const first = lineOf(s.at);
    const last = lineOf(s.at + Math.max(s.length - 1, 0));
    for (let l = first; l <= last; l++) changed.add(l);
  }
  return { text: out, changed: [...changed].sort((a, b) => a - b) };
}

/** Runs the script and returns its exit code. */
export async function main(argv: string[], stdin: string, print: (line: string) => void = console.log, printError: (line: string) => void = console.error): Promise<number> {
  const [file, ...rest] = argv;
  if (!file || rest.length) { printError(USAGE); return 1; }
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch (e) { printError(`${file}: ${e instanceof Error ? e.message : e}`); return 1; }
  try {
    const { text: changedText, changed } = applyBlocks(text, parseBlocks(stdin));
    writeFileSync(file, changedText);
    const lines = changedText.split(/\r?\n/);
    print(`${file}: ${changed.length} line(s) changed`);
    for (const l of changed) print(`${String(l).padStart(5)}  ${lines[l - 1] ?? ""}`);
    return 0;
  } catch (e) {
    printError(`${file}: nothing changed: ${e instanceof Error ? e.message : e}`);
    return 1;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2), await new Response(Bun.stdin.stream()).text()));
