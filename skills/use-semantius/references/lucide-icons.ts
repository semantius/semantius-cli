#!/usr/bin/env bun
/**
 * lucide-icons.ts — finds and confirms Lucide icon names for Semantius icons (an
 * `icon` field value, an enum entry's `icon`, a module's `icon_name`).
 *
 * Source: https://cdn.jsdelivr.net/npm/lucide-static/tags.json (latest release;
 * icon name → search tags). It is downloaded once and cached as
 * `<OS temp folder>/semantius-lucide-tags.json` for 24 hours. When a refresh
 * fails and a cached copy exists, the cached copy is used and a warning goes to
 * stderr.
 *
 * Usage:
 *   bun lucide-icons.ts check <name…>   every name is a Lucide icon name or an http(s):// URL
 *   bun lucide-icons.ts find <word…>    icon names whose name or tags contain every word
 *
 * Output (stdout):
 *   check  one line per unknown name
 *   find   at most 20 lines, `name: tag, tag, …`
 *
 * Exit codes:
 *   0  check: all names valid; find: at least one match
 *   1  check: a name is unknown; find: no match
 *   2  usage error, or no cached copy and the download failed
 */

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SOURCE = "https://cdn.jsdelivr.net/npm/lucide-static/tags.json";
const CACHE = join(tmpdir(), "semantius-lucide-tags.json");
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const FIND_LIMIT = 20;

const USAGE = `Usage:
  bun lucide-icons.ts check <name…>   confirm Lucide icon names (or icon URLs); exit 1 names the unknown ones
  bun lucide-icons.ts find <word…>    list icon names whose name or tags contain every word`;

type Tags = Record<string, string[]>;

async function loadTags(): Promise<Tags> {
  const cached = existsSync(CACHE);
  if (cached && Date.now() - statSync(CACHE).mtimeMs < MAX_AGE_MS) {
    return JSON.parse(readFileSync(CACHE, "utf8"));
  }
  try {
    const res = await fetch(SOURCE);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const tags = JSON.parse(text) as Tags;
    writeFileSync(CACHE, text);
    return tags;
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    if (!cached) {
      console.error(`could not download ${SOURCE} (${reason}) and there is no cached copy`);
      process.exit(2);
    }
    console.error(`warning: could not refresh ${SOURCE} (${reason}); using the cached copy ${CACHE}`);
    return JSON.parse(readFileSync(CACHE, "utf8"));
  }
}

const isUrl = (v: string): boolean => /^https?:\/\//i.test(v);

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if ((cmd !== "check" && cmd !== "find") || args.length === 0) {
    console.error(USAGE);
    process.exit(2);
  }
  const tags = await loadTags();

  if (cmd === "check") {
    const unknown = args.filter((a) => !isUrl(a) && !Object.hasOwn(tags, a));
    for (const name of unknown) console.log(`unknown icon: ${name}`);
    process.exit(unknown.length ? 1 : 0);
  }

  const words = args.map((w) => w.toLowerCase());
  const matches = Object.entries(tags).filter(([name, t]) => {
    const hay = [name, ...t].map((s) => s.toLowerCase());
    return words.every((w) => hay.some((s) => s.includes(w)));
  });
  for (const [name, t] of matches.slice(0, FIND_LIMIT)) console.log(`${name}: ${t.join(", ")}`);
  process.exit(matches.length ? 0 : 1);
}

main();
