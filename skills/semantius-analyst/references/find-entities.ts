#!/usr/bin/env bun
/**
 * find-entities.ts — finds live entities by keyword for `semantius-analyst`
 * (Stage 2g concept pass). Deterministic: the same keywords and the same live
 * catalog always give the same result, in the same order. The analyst chooses
 * every keyword and then judges each returned entity; the script neither
 * invents words nor judges.
 *
 * It runs one full-text query on `entities.search_vector` (`wfts(simple)`,
 * keywords joined with `or`) plus one `read_module` for the owning modules,
 * both read-only through the semantius CLI. `simple` does not stem and is
 * language-agnostic, so a keyword matches only that exact word form: pass every
 * form and language worth finding.
 *
 * Usage:
 *   bun find-entities.ts --keywords vendor,vendors,supplier,suppliers,lieferant,lieferanten,供应商 \
 *       [--exclude service_vendors,assets]
 *
 *   --keywords  comma-separated words, searched exactly as given (lowercased and
 *               split on anything that is not a letter or digit, the way the
 *               search index splits text: `service_vendors` → `service`, `vendors`).
 *   --exclude   comma-separated table names to leave out (the blueprint's own
 *               entities). Built-ins are always left out.
 *
 * Output (stdout): one JSON object
 *   { keywords, entities }
 *   keywords = the words searched, after lowercasing and splitting
 *   entities = [{ table_name, singular_label, plural_label, description,
 *                 module_slug, matches: [{ keyword, in: "label" | "table_name" | "description" }] }]
 *   Sorted by: matched in a label or table name first, then more distinct
 *   keywords matched, then table_name. `matches` lists where each keyword
 *   appears; it is empty when the search index matched on something else.
 *
 * Exit codes:
 *   0  searched (an empty `entities` list is a result, not an error)
 *   1  a live read failed
 *   2  usage error (an unknown flag, no keywords)
 *
 * `--from-fixture <file.json>` is for tests only: it replaces both live reads with
 * `[{ table_name, singular_label, plural_label, description, module_slug }]` and
 * applies the keyword match locally.
 */

import { readFileSync } from "node:fs";

const BUILT_INS = new Set([
  "users", "roles", "permissions", "permission_hierarchy", "role_permissions", "user_roles",
  "webhook_receivers", "webhook_receiver_logs", "modules", "entities", "fields",
]);

type Row = {
  table_name: string;
  singular_label: string;
  plural_label: string;
  description: string;
  module_slug: string | null;
};
type Where = "label" | "table_name" | "description";
type Match = { keyword: string; in: Where };
type Hit = Row & { matches: Match[] };

class UsageError extends Error {}
class LiveReadError extends Error {}

// ---------- arguments ----------

const FLAGS = new Set(["--keywords", "--exclude", "--from-fixture"]);

function parseArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!FLAGS.has(flag)) throw new UsageError(`unknown argument "${flag}"`);
    const value = argv[i + 1];
    if (value === undefined || FLAGS.has(value)) throw new UsageError(`${flag} needs a value`);
    if (out.has(flag)) throw new UsageError(`${flag} given twice`);
    out.set(flag, value);
    i++;
  }
  return out;
}

// ---------- keywords ----------

const words = (text: string): string[] => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

// ---------- matching ----------

function matchesFor(row: Row, keywords: string[]): Match[] {
  const fields: [Where, Set<string>][] = [
    ["label", new Set([...words(row.singular_label ?? ""), ...words(row.plural_label ?? "")])],
    ["table_name", new Set(words(row.table_name))],
    ["description", new Set(words(row.description ?? ""))],
  ];
  const out: Match[] = [];
  for (const keyword of keywords) {
    for (const [where, set] of fields) if (set.has(keyword)) out.push({ keyword, in: where });
  }
  return out;
}

function rank(hits: Hit[]): Hit[] {
  const strong = (h: Hit) => h.matches.some((m) => m.in !== "description");
  const distinct = (h: Hit) => new Set(h.matches.map((m) => m.keyword)).size;
  return [...hits].sort((a, b) =>
    Number(strong(b)) - Number(strong(a)) ||
    distinct(b) - distinct(a) ||
    a.table_name.localeCompare(b.table_name));
}

// ---------- live reads ----------

async function cli(tool: string, args: Record<string, unknown>): Promise<any[]> {
  let proc;
  try {
    proc = Bun.spawn(["semantius", "call", "crud", tool, JSON.stringify(args)], { stdout: "pipe", stderr: "pipe" });
  } catch (err) {
    throw new LiveReadError(`cannot run the semantius CLI: ${(err as Error).message}`);
  }
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  if (code !== 0) throw new LiveReadError(`${tool} failed (exit ${code}): ${err.trim()}`);
  const trimmed = out.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    throw new LiveReadError(`${tool} returned output that is not JSON: ${trimmed.slice(0, 200)}`);
  }
}

async function liveRows(keywords: string[]): Promise<Row[]> {
  const query = keywords.map(encodeURIComponent).join("%20or%20");
  const entities = await cli("postgrestRequest", {
    method: "GET",
    path: `/entities?search_vector=wfts(simple).${query}&select=table_name,singular_label,plural_label,description,module_id&order=table_name`,
  });
  const moduleIds = [...new Set(entities.map((e) => e.module_id).filter((id) => id !== null && id !== undefined))];
  const modules = moduleIds.length
    ? await cli("read_module", { filters: `id=in.(${moduleIds.join(",")})`, select: "id,module_slug" })
    : [];
  const slugById = new Map(modules.map((m) => [m.id, m.module_slug]));
  return entities.map((e) => ({
    table_name: e.table_name,
    singular_label: e.singular_label ?? "",
    plural_label: e.plural_label ?? "",
    description: e.description ?? "",
    module_slug: slugById.get(e.module_id) ?? null,
  }));
}

function fixtureRows(path: string, keywords: string[]): Row[] {
  let rows: any;
  try {
    rows = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new UsageError(`cannot read --from-fixture ${path}: ${(err as Error).message}`);
  }
  if (!Array.isArray(rows)) throw new UsageError("--from-fixture needs a JSON array of entity rows");
  return rows.filter((r: Row) => matchesFor(r, keywords).length > 0);
}

// ---------- main ----------

async function main(): Promise<number> {
  const args = parseArgs(Bun.argv.slice(2));
  const raw = args.get("--keywords");
  if (!raw) throw new UsageError("--keywords is required");
  const keywords = [...new Set(words(raw))].sort();
  if (keywords.length === 0) throw new UsageError("--keywords has no words");
  const exclude = new Set((args.get("--exclude") ?? "").split(",").map((s) => s.trim()).filter(Boolean));

  const fixture = args.get("--from-fixture");
  const rows = fixture !== undefined ? fixtureRows(fixture, keywords) : await liveRows(keywords);

  const hits: Hit[] = rows
    .filter((r) => !BUILT_INS.has(r.table_name) && !exclude.has(r.table_name))
    .map((r) => ({ ...r, matches: matchesFor(r, keywords) }));

  console.log(JSON.stringify({ keywords, entities: rank(hits) }, null, 2));
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    if (err instanceof UsageError) {
      console.error(`find-entities: ${err.message}`);
      process.exit(2);
    }
    console.error(`find-entities: ${(err as Error).message}`);
    process.exit(1);
  },
);
