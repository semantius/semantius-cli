#!/usr/bin/env bun
/**
 * vendor-names.ts — turns a product's record and field names into Semantius
 * names, the same way every time: `table_name` and labels for a record,
 * `field_name` and label for a field.
 *
 * Rules:
 *   - A name already in lower snake_case is kept as written (`firstname`).
 *   - Otherwise it is split into words, a run of capitals being one word
 *     (`SLAPolicyId` → sla, policy, id), and joined in lower snake_case.
 *   - A record's table name is plural on the last word only
 *     (`OpportunityLineItem` → `opportunity_line_items`). Pass the singular name.
 *   - A name ending in `__<suffix>` (Salesforce `Region__c`) is a field or record
 *     one company added, not the product's: skipped.
 *   - Labels keep the product's capitals for acronyms (`SLA Policy`); a name in
 *     all capitals with separators (`LINE_ITEM`) is words, not acronyms.
 *
 * Usage:   bun vendor-names.ts <entity:Name | field:Name>…
 * Output:  one line per name:
 *            entity <Name> -> <table_name> | <Singular Label> | <Plural Label>[ | built-in: <table>]
 *            field <Name> -> <field_name> | <Label>
 *            <kind> <Name> -> skip: <reason>
 *            <kind> <Name> -> reserved: <reason>
 * Exit:    0 every name converted; 1 a name was skipped or is reserved; 2 usage error
 */

const BUILT_IN_TABLES = new Set([
  "users", "roles", "permissions", "permission_hierarchy", "user_roles", "role_permissions",
  "webhook_receivers", "webhook_receiver_logs", "modules", "entities", "fields", "queues",
  "queue_table_events", "dashboards",
]);
const AUTOMATIC_FIELDS = new Set(["id", "created_at", "updated_at", "label"]);

const IRREGULAR: Record<string, string> = {
  person: "people", man: "men", woman: "women", child: "children", foot: "feet", tooth: "teeth",
  mouse: "mice", criterion: "criteria", phenomenon: "phenomena", datum: "data", medium: "media",
  analysis: "analyses", basis: "bases", crisis: "crises", diagnosis: "diagnoses", thesis: "theses",
  leaf: "leaves", life: "lives", knife: "knives", shelf: "shelves", half: "halves", wife: "wives",
  hero: "heroes", potato: "potatoes", tomato: "tomatoes", echo: "echoes", veto: "vetoes",
  quiz: "quizzes",
};
const UNCOUNTABLE = new Set([
  "data", "metadata", "information", "equipment", "feedback", "software", "hardware", "staff",
  "personnel", "series", "species", "news", "media", "people", "criteria",
]);

export type Kind = "entity" | "field";
export type Result =
  | { kind: "entity"; source: string; table: string; singular: string; plural: string; builtIn?: string }
  | { kind: "field"; source: string; field: string; label: string }
  | { kind: Kind; source: string; skip: string }
  | { kind: Kind; source: string; reserved: string };

/** Splits a product name into words; a run of capitals is one word. */
export function words(name: string): string[] {
  return name.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+/g) ?? [];
}

/** Plural of one word, keeping its case form (`Item` → `Items`, `SLA` → `SLAs`). */
export function pluralWord(word: string): string {
  const lower = word.toLowerCase();
  let plural: string;
  if (UNCOUNTABLE.has(lower)) plural = lower;
  else if (IRREGULAR[lower]) plural = IRREGULAR[lower];
  else if (word.length > 1 && word === word.toUpperCase() && /[A-Z]/.test(word)) return `${word}s`;
  else if (/[^aeiou]y$/.test(lower)) plural = `${lower.slice(0, -1)}ies`;
  else if (/(s|x|z|ch|sh)$/.test(lower)) plural = `${lower}es`;
  else plural = `${lower}s`;
  return word[0] === word[0].toUpperCase() ? plural[0].toUpperCase() + plural.slice(1) : plural;
}

function labelWord(word: string): string {
  if (word.length > 1 && word === word.toUpperCase() && /[A-Z]/.test(word)) return word;
  return word[0].toUpperCase() + word.slice(1).toLowerCase();
}

export function convert(kind: Kind, source: string): Result {
  const name = source.trim();
  if (/__[a-z]+$/i.test(name)) return { kind, source, skip: "a custom field or record one company added, not part of the product" };

  const keep = /^[a-z][a-z0-9_]*$/.test(name);
  // All capitals with separators (`LINE_ITEM`) are words, not acronyms.
  const shouting = !/[a-z]/.test(name) && /[_\s-]/.test(name);
  const parts = keep ? name.split("_").filter(Boolean) : words(shouting ? name.toLowerCase() : name);
  if (parts.length === 0 || /^[0-9]/.test(parts[0])) return { kind, source, skip: "no name can be made from it" };

  const labelParts = parts.map(labelWord);
  const label = (ws: string[]) => ws.join(" ");

  if (kind === "field") {
    const field = keep ? name : parts.join("_").toLowerCase();
    if (AUTOMATIC_FIELDS.has(field)) return { kind, source, skip: `${field} is automatic on every table` };
    if (field.startsWith("_") || field.endsWith("_id_label")) return { kind, source, reserved: `${field} is reserved by the platform; pick another name` };
    return { kind, source, field, label: label(labelParts) };
  }

  const pluralParts = [...labelParts.slice(0, -1), pluralWord(labelParts[labelParts.length - 1])];
  const table = keep
    ? [...parts.slice(0, -1), pluralWord(parts[parts.length - 1]).toLowerCase()].join("_")
    : pluralParts.join("_").toLowerCase();
  const result: Result = { kind, source, table, singular: label(labelParts), plural: label(pluralParts) };
  if (BUILT_IN_TABLES.has(table)) result.builtIn = table;
  return result;
}

export function format(r: Result): string {
  const head = `${r.kind} ${r.source} ->`;
  if ("skip" in r) return `${head} skip: ${r.skip}`;
  if ("reserved" in r) return `${head} reserved: ${r.reserved}`;
  if (r.kind === "field") return `${head} ${r.field} | ${r.label}`;
  return `${head} ${r.table} | ${r.singular} | ${r.plural}${r.builtIn ? ` | built-in: ${r.builtIn}` : ""}`;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const parsed = args.map((a) => a.match(/^(entity|field):(.+)$/));
  if (args.length === 0 || parsed.some((p) => !p)) {
    console.error("Usage: bun vendor-names.ts <entity:Name | field:Name>…   convert a product's record and field names");
    process.exit(2);
  }
  const results = parsed.map((p) => convert(p![1] as Kind, p![2]));
  for (const r of results) console.log(format(r));
  process.exit(results.some((r) => "skip" in r || "reserved" in r) ? 1 : 0);
}
