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
 *
 * `parentChainProblems` reads the fields alone, not the record: a chain of `parent` relationships holds at most
 * three entities, and a longer one is refused with every entity and `parent` field in it. `otherParentProblems`
 * names every other `parent` field when one is refused as a parent, so all of them are answered again.
 * `cascadeProblems` refuses any delete mode but `restrict` on a `parent` child with a `workflow_state` of its own.
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

/** The most entities a chain of `parent` relationships holds: a parent, its child, and that child's child. */
export const MAX_PARENT_CHAIN = 3;

/**
 * The chains of `parent` relationships with more than `MAX_PARENT_CHAIN` entities, one line each, naming every entity
 * of the chain and every `parent` field in it. `fields` are the fields being written; `host` holds the `parent` fields
 * read from the host, and a field of `fields` stands for the same field there. Only a chain with a field of `fields`
 * in it is named. A `parent` field to its own table adds no entity, and a chain stops where it would come back to an
 * entity it already holds.
 */
export function parentChainProblems(fields: ReadonlyArray<any>, host: ReadonlyArray<any> = []): string[] {
  return longChains(fields, host).map(({ chain, between }) =>
    `${chain.join(" → ")}: a chain of ${chain.length} entities, each a parent child of the one before. A chain holds at most ${MAX_PARENT_CHAIN}. Answer the three questions again for every parent field of the chain (${between.map(idOf).join(", ")}); each one that fails any of them is a reference (${SECTION})`);
}

const idOf = (f: { table_name: string; field_name: string }) => `${f.table_name}.${f.field_name}`;

/** Each chain of more than `MAX_PARENT_CHAIN` entities with a field of `fields` in it: its entities from the top down, and the `parent` fields between them. */
function longChains(fields: ReadonlyArray<any>, host: ReadonlyArray<any>): Array<{ chain: string[]; between: any[] }> {
  const usable = (f: any) => f && typeof f.table_name === "string" && typeof f.field_name === "string";
  const written = new Set(fields.filter(usable).map((f) => `${f.table_name}.${f.field_name}`));
  const isParent = (f: any) => usable(f) && f.format === "parent" && typeof f.reference_table === "string" && f.reference_table !== f.table_name;
  const own = fields.filter(isParent);
  const all = [...own, ...host.filter((f) => isParent(f) && !written.has(`${f.table_name}.${f.field_name}`))];
  const childrenOf = new Map<string, string[]>();
  for (const f of all) {
    const children = childrenOf.get(f.reference_table) ?? [];
    if (!children.includes(f.table_name)) children.push(f.table_name);
    childrenOf.set(f.reference_table, children);
  }
  const hasParent = new Set(all.map((f) => f.table_name));
  const chains: string[][] = [];
  const walk = (chain: string[]) => {
    const next = (childrenOf.get(chain[chain.length - 1]) ?? []).filter((t) => !chain.includes(t));
    if (!next.length) { if (chain.length > MAX_PARENT_CHAIN) chains.push(chain); return; }
    for (const t of next) walk([...chain, t]);
  };
  for (const top of childrenOf.keys()) if (!hasParent.has(top)) walk([top]);
  return chains
    .map((chain) => ({ chain, between: chain.slice(1).flatMap((t, i) => all.filter((f) => f.table_name === t && f.reference_table === chain[i])) }))
    .filter(({ between }) => between.some((f) => own.includes(f)));
}

/**
 * The `parent` fields of an entity with a `workflow_state` of its own whose delete mode is not `restrict`. A cascade
 * deletes the children with their parent without their own permission and rules, so a child with its own states is
 * removed on its own. `host` holds fields read from the host: a `workflow_state` there counts for its table.
 */
export function cascadeProblems(fields: ReadonlyArray<any>, host: ReadonlyArray<any> = []): string[] {
  const withStates = new Set([...fields, ...host].filter((f) => f && f.field_name === "workflow_state" && typeof f.table_name === "string").map((f) => f.table_name));
  return fields
    .filter((f) => f && f.format === "parent" && typeof f.table_name === "string" && typeof f.field_name === "string" && withStates.has(f.table_name) && f.reference_delete_mode !== "restrict")
    .map((f) => `${idOf(f)}: ${f.table_name} has a workflow_state of its own, and a cascade deletes its records with their parent, without their own permission and rules. A parent child with its own states takes restrict: write "reference_delete_mode": "restrict" in the field and "delete": "restrict" in its entry of the relationship record (${SECTION})`);
}

/**
 * One line that names every other `parent` field of `fields`, when a check refuses one of them as a parent: its
 * entry's facts make it a reference, a role of the access record is limited to its entity (`limitedTo`), or it is in a
 * chain of more than `MAX_PARENT_CHAIN` entities. A refusal is evidence about all of the answers, so each of the
 * other `parent` fields is answered again. `scope` names what `fields` are in the line ("the model", "the payload").
 */
export function otherParentProblems(fields: ReadonlyArray<any>, record: unknown, access?: AccessRecord | null, host: ReadonlyArray<any> = [], scope = "the model"): string[] {
  const parents = fields.filter((f) => f && typeof f.table_name === "string" && typeof f.field_name === "string" && f.format === "parent");
  const rec = record && typeof record === "object" && !Array.isArray(record) ? (record as Record<string, any>) : {};
  const roles = access && typeof access === "object" && access.roles && typeof access.roles === "object" ? Object.values(access.roles) : [];
  const limited = new Set(roles.flatMap((r: any) => (r?.limitedTo && typeof r.limitedTo === "object" ? Object.keys(r.limitedTo) : [])));
  const inChain = new Set(longChains(fields, host).flatMap(({ between }) => between.map(idOf)));
  const refused = parents.filter((f) => {
    const e = rec[idOf(f)];
    return limited.has(f.table_name) || inChain.has(idOf(f)) || (!shapeOf(idOf(f), e).length && e.format === "parent" && referenceReasons(e).length > 0);
  });
  const others = parents.filter((f) => !refused.includes(f));
  if (!refused.length || !others.length) return [];
  return [`every other parent field of ${scope} (${others.map(idOf).join(", ")}): answer the three questions again for each, from how the leading products handle these records. ${refused.map(idOf).join(", ")} ${refused.length === 1 ? "was" : "were"} refused as a parent, which is evidence about all of the answers, not only about ${refused.length === 1 ? "that one" : "those"}; each field that fails any question is a reference (${SECTION})`];
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
