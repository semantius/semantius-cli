#!/usr/bin/env bun
/**
 * lucide-icon-finder.ts — finds Lucide icon names for Semantius icons.
 *
 * Each argument is one query of one or more words, given most specific first
 * (`"user plus" user person "contact card"`). An icon matches a query when every
 * word of it starts a word (case-insensitive; `user` matches `users`) of the
 * icon's name or one of its tags. Queries are answered in the order given;
 * within a query, the icon named exactly by the query comes first, then icons
 * whose name holds every word, then icons matched by a tag, and an icon listed
 * for an earlier query is not repeated.
 *
 * Source: `lucide-icon-tags.json` next to this script, a snapshot of the
 * `lucide-static` release named in its `version` key. No network access.
 *
 * Usage:   bun lucide-icon-finder.ts <query…>
 *          bun lucide-icon-finder.ts --batch <file.json | ->   (`-` reads the JSON from stdin)
 * Output:  one line per query, `<query>: name, name, …` (at most 10 names), or
 *          `<query>: (none)`. With `--batch`, the file is a JSON object mapping a
 *          label to its queries (`{"status: hired": ["application hired", "hired"]}`,
 *          one label per enum entry); each label prints as `## <label>` followed by
 *          its query lines, and each label is searched on its own (an icon listed
 *          for one label is listed again for another).
 * Exit:    0 some query matched; 1 no query matched; 2 no arguments or a bad file
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const PER_QUERY = 10;

const icons: Record<string, string[]> = JSON.parse(readFileSync(join(import.meta.dir, "lucide-icon-tags.json"), "utf8")).icons;

/** Prints one line per query; returns how many icons were listed. */
function find(queries: string[]): number {
  const listed = new Set<string>();
  for (const query of queries) {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const exact = words.join("-");
    const byName: string[] = [];
    const byTag: string[] = [];
    for (const [name, tags] of Object.entries(icons)) {
      if (listed.has(name)) continue;
      const nameWords = name.split("-");
      const tagWords = tags.flatMap((t) => t.toLowerCase().split(/[\s-]+/));
      const inName = (w: string) => nameWords.some((n) => n.startsWith(w));
      if (name === exact) byName.unshift(name);
      else if (words.every(inName)) byName.push(name);
      else if (words.every((w) => inName(w) || tagWords.some((t) => t.startsWith(w)))) byTag.push(name);
    }
    const found = [...byName, ...byTag].slice(0, PER_QUERY);
    for (const name of found) listed.add(name);
    console.log(`${query}: ${found.length ? found.join(", ") : "(none)"}`);
  }
  return listed.size;
}

const args = process.argv.slice(2);
if (args[0] === "--batch") {
  let batch: Record<string, unknown>;
  try {
    batch = JSON.parse(args[1] === "-" ? await Bun.stdin.text() : readFileSync(args[1] ?? "", "utf8"));
  } catch (e) {
    console.error(`Usage: bun lucide-icon-finder.ts --batch <file.json | ->   (${e instanceof Error ? e.message : e})`);
    process.exit(2);
  }
  let total = 0;
  for (const [label, qs] of Object.entries(batch)) {
    const queries = (Array.isArray(qs) ? qs : [qs]).map(String).filter((q) => q.trim() !== "");
    console.log(`## ${label}`);
    total += find(queries);
  }
  process.exit(total ? 0 : 1);
}
const queries = args.filter((q) => q.trim() !== "");
if (queries.length === 0) {
  console.error('Usage: bun lucide-icon-finder.ts <query…>   e.g. "user plus" user person "contact card" (most specific first)');
  process.exit(2);
}
process.exit(find(queries) ? 0 : 1);
