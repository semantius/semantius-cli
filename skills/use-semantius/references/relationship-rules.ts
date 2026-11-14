/**
 * relationship-rules.ts — checks the relationship record (`relationships.json`, `build-module.md` step 5.6): for each
 * `reference` and `parent` field, keyed `<table>.<field>`, the facts the three questions of `data-modeling.md` →
 * "Choosing the Right Format" turn on. The format follows from the facts: a field is a `parent` only when nothing
 * saves the child without its parent, the people who create it all work the parent, every person of the module
 * reaches these records only from the parent's page (or never), and nobody cites one by its own number.
 *
 *   - `jsonlogic-kit.ts` (`writeModel`, `modelProblems`) checks the record with the model and writes it;
 *   - `call-file.ts` checks a `create_field` payload against `relationships.json` in the payload's folder.
 *
 * A `parent` field needs an entry whose facts make it one, and that answers for the everyday person and each role of
 * the access record. A `reference` needs no proof: when the facts cannot tell, a field is a reference.
 */
import type { AccessRecord } from "./access-rules";

export type RelationshipEntry = {
  format: string;
  delete?: string;
  savedWithout: boolean;
  createdBy: string[];
  parentWorkedBy: string[];
  reachedBy: Record<string, string>;
  citedByNumber: boolean;
  label?: string;
};
export type RelationshipRecord = Record<string, RelationshipEntry>;

const KEYS = new Set(["format", "delete", "savedWithout", "createdBy", "parentWorkedBy", "reachedBy", "citedByNumber", "label"]);
const SECTION = `data-modeling.md, "Choosing the Right Format"`;
const isList = (how: string) => /^list: \S/.test(how);

/** What makes a field a reference, read from its entry's facts; empty when the facts make it a parent. */
export function referenceReasons(e: RelationshipEntry): string[] {
  const out: string[] = [];
  if (e.savedWithout) out.push("it is saved without its parent, or must outlive it (question 1)");
  const others = e.createdBy.filter((p) => !e.parentWorkedBy.includes(p));
  if (others.length) out.push(`${others.join(" and ")} create${others.length === 1 ? "s" : ""} it without working the parent (question 2)`);
  for (const [person, how] of Object.entries(e.reachedBy)) if (how !== "parent" && how !== "never") out.push(`${person} reaches these records through "${how}" (question 3)`);
  if (e.citedByNumber) out.push("people cite one by its own number (question 3)");
  return out;
}

/** The problems of one entry's shape; empty when every key has the type it needs. */
function shapeOf(id: string, e: any): string[] {
  if (!e || typeof e !== "object" || Array.isArray(e)) return [`${id}: its entry is { "format", "delete", "savedWithout", "createdBy", "parentWorkedBy", "reachedBy", "citedByNumber", "label" }`];
  const out: string[] = [];
  for (const k of Object.keys(e)) if (!KEYS.has(k)) out.push(`${id}: unknown key "${k}"; an entry has ${[...KEYS].join(", ")}`);
  if (e.format !== "parent" && e.format !== "reference") out.push(`${id}: "format" is "parent" or "reference"`);
  for (const k of ["savedWithout", "citedByNumber"]) if (typeof e[k] !== "boolean") out.push(`${id}: "${k}" is true or false`);
  for (const k of ["createdBy", "parentWorkedBy"]) if (!Array.isArray(e[k]) || e[k].some((p: unknown) => typeof p !== "string")) out.push(`${id}: "${k}" is a list of people`);
  if (!e.reachedBy || typeof e.reachedBy !== "object" || Array.isArray(e.reachedBy)) out.push(`${id}: "reachedBy" is { "<person>": "parent" | "list: <name>" | "never" }`);
  else for (const [p, how] of Object.entries(e.reachedBy)) {
    if (typeof how !== "string" || (how !== "parent" && how !== "never" && !isList(how))) out.push(`${id}: reachedBy.${p} is "parent", "list: <name of the list>" or "never", not ${JSON.stringify(how)}`);
  }
  return out;
}

/**
 * The problems of the relationship record against the relationship fields of `fields` and the access record:
 * - a `parent` field with no entry, or whose entry's facts make it a reference;
 * - a `parent` field whose `reachedBy` leaves out the everyday person or a role of the access record;
 * - an entry whose format is not the field's, an entry of the wrong shape, and a person the access record does not have.
 * `where` names the record in the messages (the path of `relationships.json`, or `relationships` in `writeModel`).
 */
export function relationshipProblems(fields: ReadonlyArray<any>, record: unknown, access?: AccessRecord | null, where = "relationships.json"): string[] {
  const related = fields.filter((f) => f && typeof f.table_name === "string" && typeof f.field_name === "string" && (f.format === "parent" || f.format === "reference"));
  const parents = related.filter((f) => f.format === "parent");
  if (record === undefined || record === null) {
    return parents.map((f) => `${f.table_name}.${f.field_name}: a parent field needs its entry in ${where}: the facts that make it a parent, from how the leading products handle these records (build-module.md, step 5.6; ${SECTION})`);
  }
  if (typeof record !== "object" || Array.isArray(record)) return [`${where}: the record is { "<table>.<field>": { … } }, one entry per relationship field`];
  const rec = record as Record<string, any>;
  const out: string[] = [];
  if (access && typeof access !== "object") access = null;
  const everyday = access ? (typeof access.everyday === "string" ? access.everyday : "manager") : null;
  const roles = access && access.roles && typeof access.roles === "object" ? Object.keys(access.roles) : [];
  const people = access && access.people && typeof access.people === "object" ? Object.keys(access.people) : [];
  const known = access ? new Set([everyday!, ...roles, ...people]) : null;
  const shaped = new Map<string, RelationshipEntry>();
  for (const [id, e] of Object.entries(rec)) {
    const shape = shapeOf(id, e);
    out.push(...shape);
    if (shape.length) continue;
    shaped.set(id, e as RelationshipEntry);
    if (known) {
      const named = [...new Set([...e.createdBy, ...e.parentWorkedBy, ...Object.keys(e.reachedBy)])];
      for (const p of named.filter((x) => !known.has(x))) out.push(`${id}: names "${p}", who is neither the everyday person ("${everyday}"), a key of "roles", nor a key of "people" in the access record`);
    }
  }
  for (const f of related) {
    const id = `${f.table_name}.${f.field_name}`;
    const e = shaped.get(id);
    if (!e) {
      if (f.format === "parent" && !(id in rec)) out.push(`${id}: a parent field needs its entry in ${where}: the facts that make it a parent, from how the leading products handle these records (build-module.md, step 5.6; ${SECTION})`);
      continue;
    }
    if (e.format !== f.format) { out.push(`${id}: the field is a ${f.format}, but its entry in ${where} says ${e.format}; write one format in both`); continue; }
    if (e.delete !== undefined && f.reference_delete_mode !== undefined && e.delete !== f.reference_delete_mode) out.push(`${id}: the field's delete mode is ${f.reference_delete_mode}, but its entry in ${where} says ${e.delete}; write one delete mode in both`);
    if (f.format !== "parent") continue;
    const missing = access ? [everyday!, ...roles].filter((p) => !(p in e.reachedBy)) : Object.keys(e.reachedBy).length ? [] : ["anyone"];
    if (missing.length) out.push(`${id}: reachedBy says how each person of the module finds these records; add ${missing.map((p) => `"${p}"`).join(", ")} ("parent", "list: <name>" or "never")`);
    const reasons = referenceReasons(e);
    if (reasons.length) out.push(`${id} is a parent, but its entry in ${where} makes it a reference: ${reasons.join("; ")}. Make it a reference (${SECTION})`);
  }
  return out;
}
