#!/usr/bin/env bun
/**
 * entity-match-checker.ts — compares the entities about to be created with every
 * entity on the instance, built-ins included, so one real-world thing is never
 * modeled twice.
 *
 * SAME NAME: the new `table_name` equals an existing one. SIMILAR NAME: the new
 * `table_name`, or one of the other words given for it, matches an existing
 * `table_name`, `singular_label` or `plural_label`. Two names match when they are
 * equal once singular and plural are set aside (`person` = `people`), or when one
 * holds the other and both end in the same word (`employees` = `hr_employees`, but
 * not `orders` = `order_lines`). Trailing copy markers are ignored (`vendors_copy`,
 * `vendors_2`).
 *
 * Reads the instance through the `semantius` CLI and changes nothing.
 *
 * Usage:   bun entity-match-checker.ts --batch <file.json | -> [--separate <table_name,…>]
 *          (`-` reads the JSON from stdin.) The JSON maps each new `table_name` to
 *          the other words people use for that thing, at least one each:
 *          `{"vendors": ["suppliers", "providers"]}`. `--separate` names the new
 *          entities the user said are different from their similar-name matches;
 *          a same-name match cannot be set aside.
 * Output:  one line per match, `same name: <new> = <Plural Label> in <Module> (<table_name>)`
 *          or `similar name: <new> ~ <Plural Label> in <Module> (<table_name>), matched "<word>"`,
 *          then a count line, then `Existing entities: <Plural Label>, …`
 * Exit:    0 nothing to settle; 1 a match to settle; 2 bad arguments or the instance cannot be read
 */

import { readFileSync } from "node:fs";

export type Existing = { table_name: string; singular_label?: string | null; plural_label?: string | null; module_id?: number | null };
export type Match = { table: string; kind: "same"; entity: Existing } | { table: string; kind: "similar"; entity: Existing; word: string };

const COPY_MARKER = /^(copy|local|new|old|temp|tmp|backup|v?\d+)$/;
const IRREGULAR: Record<string, string> = { people: "person", men: "man", women: "woman", children: "child" };

function singular(word: string): string {
  if (Object.hasOwn(IRREGULAR, word)) return IRREGULAR[word];
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (/(ch|sh|x|z|ss)es$/.test(word)) return word.slice(0, -2);
  if (word.endsWith("s") && !/(ss|us|is)$/.test(word)) return word.slice(0, -1);
  return word;
}

/** The singular words of a name, without trailing copy markers. */
export function nameWords(name: string): string[] {
  const words = name.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).map(singular);
  while (words.length > 1 && COPY_MARKER.test(words[words.length - 1])) words.pop();
  return words;
}

function namesMatch(a: string[], b: string[]): boolean {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length > 0 && short[short.length - 1] === long[long.length - 1] && short.every((w) => long.includes(w));
}

/** Every match between the new entities and the existing ones; `separate` sets aside similar-name matches only. */
export function findMatches(batch: Record<string, string[]>, existing: Existing[], separate: Set<string> = new Set()): Match[] {
  const matches: Match[] = [];
  for (const [table, others] of Object.entries(batch)) {
    for (const entity of existing) {
      if (entity.table_name === table) {
        matches.push({ table, kind: "same", entity });
        continue;
      }
      if (separate.has(table)) continue;
      const targets = [entity.table_name, entity.singular_label, entity.plural_label].filter((n): n is string => !!n).map(nameWords);
      const word = [table, ...others].find((w) => targets.some((t) => namesMatch(nameWords(w), t)));
      if (word) matches.push({ table, kind: "similar", entity, word });
    }
  }
  return matches;
}

/** Checks the batch JSON; throws with the reason when it is not usable. */
export function parseBatch(json: unknown): Record<string, string[]> {
  if (!json || typeof json !== "object" || Array.isArray(json) || Object.keys(json).length === 0) {
    throw new Error("expected a JSON object mapping each new table_name to other words for it");
  }
  const batch: Record<string, string[]> = {};
  for (const [table, words] of Object.entries(json)) {
    const list = (Array.isArray(words) ? words : [words]).filter((w): w is string => typeof w === "string" && w.trim() !== "");
    if (list.length === 0) throw new Error(`${table}: give at least one other word people use for it`);
    batch[table] = list;
  }
  return batch;
}

async function read(tool: string, args: object): Promise<any[]> {
  const proc = Bun.spawn(["semantius", "call", "crud", tool, JSON.stringify(args)], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  if ((await proc.exited) !== 0) throw new Error(`${tool}: ${err.trim() || out.trim()}`);
  return JSON.parse(out);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const fail = (why: unknown): never => {
    console.error(`Usage: bun entity-match-checker.ts --batch <file.json | -> [--separate <table_name,…>]   (${why instanceof Error ? why.message : why})`);
    process.exit(2);
  };

  if (args[0] !== "--batch" || !args[1]) fail("--batch is required");
  let batch: Record<string, string[]> = {};
  try {
    batch = parseBatch(JSON.parse(args[1] === "-" ? await Bun.stdin.text() : readFileSync(args[1], "utf8")));
  } catch (e) {
    fail(e);
  }
  const at = args.indexOf("--separate");
  const separate = new Set(at < 0 ? [] : (args[at + 1] ?? "").split(",").filter(Boolean));

  let existing: Existing[] = [];
  let moduleNames = new Map<number, string>();
  try {
    const [entities, modules] = await Promise.all([
      read("read_entity", { select: "table_name,singular_label,plural_label,module_id", order: "table_name.asc" }),
      read("read_module", { select: "id,module_name" }),
    ]);
    existing = entities;
    moduleNames = new Map(modules.map((m) => [m.id, m.module_name]));
  } catch (e) {
    fail(e);
  }

  const label = (e: Existing) => e.plural_label || e.table_name;
  const matches = findMatches(batch, existing, separate);
  for (const m of matches) {
    const where = `${label(m.entity)} in ${moduleNames.get(m.entity.module_id ?? -1) ?? "another module"} (${m.entity.table_name})`;
    console.log(m.kind === "same" ? `same name: ${m.table} = ${where}` : `similar name: ${m.table} ~ ${where}, matched "${m.word}"`);
  }
  console.log(matches.length ? `${matches.length} match(es) to settle before the first create_entity.` : `Nothing to settle: ${Object.keys(batch).length} new compared with ${existing.length} existing.`);
  console.log(`Existing entities: ${existing.map(label).join(", ")}`);
  process.exit(matches.length ? 1 : 0);
}
