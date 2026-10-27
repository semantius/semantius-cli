#!/usr/bin/env bun
/**
 * lucide-icon-checker.ts — confirms that values are valid Semantius icons (an
 * `icon` field value, an enum entry's `icon`, a module's or entity's `icon_name`): a Lucide
 * icon name, or an http(s):// URL, which always passes.
 *
 * Source: `lucide-icon-tags.json` next to this script, a snapshot of the
 * `lucide-static` release named in its `version` key. No network access.
 *
 * Usage:   bun lucide-icon-checker.ts <value…>
 * Output:  one line per value that is not a Lucide icon name: `unknown icon: <name>`
 * Exit:    0 all valid; 1 a value is unknown; 2 no arguments
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const values = process.argv.slice(2);
if (values.length === 0) {
  console.error("Usage: bun lucide-icon-checker.ts <value…>   confirm Lucide icon names (or icon URLs)");
  process.exit(2);
}

const icons: Record<string, string[]> = JSON.parse(readFileSync(join(import.meta.dir, "lucide-icon-tags.json"), "utf8")).icons;
const unknown = values.filter((v) => !/^https?:\/\//i.test(v) && !Object.hasOwn(icons, v));
for (const name of unknown) console.log(`unknown icon: ${name}`);
process.exit(unknown.length ? 1 : 0);
