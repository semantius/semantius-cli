/**
 * jsonlogic-kit.ts — builds the JsonLogic of `computed_fields`, `validation_rules`, `select_rule` and
 * `input_type_rule` from small functions, so a payload is composed from named parts in a Bun script and
 * written as a file, never typed as nested JSON by hand. Not a CLI: import it from the builder script.
 *
 *   import { all, changedTo, hasPerm, iff, rule, writePayload } from "<skill-folder>/references/jsonlogic-kit.ts";
 *   const orderGate = rule("99004", "order_purchase_request", "Only a Buyer can order a purchase request.",
 *     iff(changedTo("workflow_state", "ordered"), hasPerm("spend:order_purchase_request"), true));
 *   writePayload(".tmp_deploy/entities.json", { data: [{ table_name: "purchase_requests", validation_rules: [orderGate] }] });
 *
 * Each function returns plain JsonLogic (the operators in `jsonlogic.md`). It throws on what the platform would
 * accept and then get wrong: an empty variable name, a permission name that is a role name, a rule code outside
 * class 99, a repeated rule code or name. `composedLabel` builds the label of a record its related records name.
 *
 * A build writes its model with `writeModel(".tmp_deploy", { entities, fields, access, relationships })`: it checks
 * the entities, the fields, the access record and the relationship record together (`modelProblems`), names every
 * problem, and writes `entities.json`, `fields.json`, `access.json` and `relationships.json` only when there is none.
 * The access record says who moves a record into each state of each `workflow_state` (`access-rules.ts`);
 * `module-rbac-setup.ts --access` writes the gates and roles from it once the entities exist. The relationship record
 * holds the facts that decide each relationship field's format (`relationship-rules.ts`). For a module that already
 * has its entities, `writeAccess(dir, access)` writes `access.json` alone.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { coverageProblems, labelColumnProblems, lifecycleNameProblems, lifecyclesOf, planAccess, shapeProblems, type AccessRecord } from "./access-rules";
import { FIELD_FORMATS as FORMATS, fieldProblems, iconProblems, keyProblems, labelReadProblems, madeFieldProblems, rollupRelationshipProblems, writeTierProblems, type EntityInfo } from "./call-file";
import { relationshipProblems, type RelationshipRecord } from "./relationship-rules";

export type Logic = unknown;

const shown = (x: unknown): string => (JSON.stringify(x) ?? String(x)).slice(0, 80);

/**
 * bun does not type-check a builder script, so a helper that takes a field name checks it, and a wrong argument
 * throws with the helper's own signature and a right call. A `v(...)` passed where a name belongs is named as such.
 */
function needName(signature: string, param: string, value: unknown, example: string): void {
  if (typeof value === "string" && value !== "") return;
  const isVar = !!value && typeof value === "object" && "var" in (value as object);
  throw new Error(
    `${signature}: ${param} is ${shown(value)}, not a field name` +
    (isVar ? "; the helper builds the v() itself, so pass the name" : "") + `. A right call: ${example}`,
  );
}


/** The value of a field of the record, or of `$old.<field>`, `$user_id`, `$mode`, `$now`, `$today`. */
export function v(name: string, fallback?: unknown): Logic {
  if (typeof name !== "string" || name === "" || name.startsWith(".") || name.endsWith(".")) {
    throw new Error(`v(${shown(name)}): a variable needs a field name, or $old.<field>, $user_id, $mode, $now or $today. A right call: v("workflow_state")`);
  }
  return fallback === undefined ? { var: name } : { var: [name, fallback] };
}
/** The stored value before this write: `$old.<field>` (null on an insert). */
export const old = (field: string): Logic => {
  needName("old(field)", "field", field, 'old("workflow_state")');
  return v(`$old.${field}`);
};
export const userId: Logic = { var: "$user_id" };
export const now: Logic = { var: "$now" };
export const today: Logic = { var: "$today" };
/** True when the write is an insert, an update or a delete. */
export const modeIs = (mode: "insert" | "update" | "delete"): Logic => eq(v("$mode"), mode);

export const eq = (a: Logic, b: Logic): Logic => ({ "==": [a, b] });
export const ne = (a: Logic, b: Logic): Logic => ({ "!=": [a, b] });
export const lt = (a: Logic, b: Logic): Logic => ({ "<": [a, b] });
export const le = (a: Logic, b: Logic): Logic => ({ "<=": [a, b] });
export const gt = (a: Logic, b: Logic): Logic => ({ ">": [a, b] });
export const ge = (a: Logic, b: Logic): Logic => ({ ">=": [a, b] });
/** `value` is one of `list` (a literal array). */
export const isIn = (value: Logic, list: ReadonlyArray<unknown>): Logic => {
  if (!Array.isArray(list)) throw new Error(`isIn(value, list): list is ${shown(list)}, not a list. A right call: isIn(v("workflow_state"), ["approved", "closed"])`);
  return { in: [value, [...list]] };
};
export const all = (...parts: Logic[]): Logic => ({ and: parts });
export const any = (...parts: Logic[]): Logic => ({ or: parts });
export const not = (part: Logic): Logic => ({ "!": [part] });
/** `if`: condition, then, and either the else branch or more condition/then pairs. */
export const iff = (...parts: Logic[]): Logic => {
  if (parts.length < 2) throw new Error("iff(condition, then, otherwise): at least a condition and a then branch");
  return { if: parts };
};
export const cat = (...parts: Logic[]): Logic => ({ cat: parts });

const PERMISSION = /^[a-z0-9][a-z0-9_-]*:[a-z0-9_]+$/;
function permission(name: string, op: string): string {
  if (name !== "admin" && !PERMISSION.test(name)) throw new Error(`${op}("${name}"): a permission is named <module_slug>:<action>`);
  if (/:(manager|viewer)$/.test(name)) {
    throw new Error(`${op}("${name}"): ${name.split(":")[1]} is a role name; the tier permissions are <slug>:read, <slug>:manage and <slug>:admin`);
  }
  return name;
}
/** True when the caller holds the permission (never throws): the shape for select rules and for a rule's own message. */
export const hasPerm = (name: string): Logic => ({ has_permission: permission(name, "hasPerm") });
/** True when the caller holds the permission; the write fails with the platform's permission error otherwise. */
export const requirePerm = (name: string): Logic => ({ require_permission: permission(name, "requirePerm") });

/** True when the write changes `field` (always on an insert). */
export const changed = (field: string): Logic => {
  needName("changed(field)", "field", field, 'changed("workflow_state")');
  return { value_changed: field };
};
/** The move of `field` into `value`: `changedTo("workflow_state", "approved")`. */
export const changedTo = (field: string, value: unknown): Logic => {
  needName("changedTo(field, value)", "field", field, 'changedTo("workflow_state", "approved")');
  return all(changed(field), eq(v(field), value));
};
/** Reads one row of `table` by `id` into `name` for `body`; the row is null when it is missing or the caller may not read it. */
export const setRecord = (name: string, table: string, id: Logic, body: Logic): Logic => {
  const example = 'setRecord("order", "orders", v("order_id"), eq(v("order.workflow_state"), "shipped"))';
  needName("setRecord(name, table, id, body)", "name", name, example);
  needName("setRecord(name, table, id, body)", "table", table, example);
  return { set_record: [name, table, id, body] };
};

/** The value that counts as set for a field of `format` (`data-modeling.md` → "Fields that apply only to some enum or boolean values"). */
export function isSet(field: string, format: string): Logic {
  const example = 'isSet("rejection_reason", "text"), isSet("sold_date", "date"), isSet("sale_price", "number")';
  needName("isSet(field, format)", "field", field, example);
  if (typeof format !== "string" || !FORMATS.has(format)) {
    throw new Error(`isSet(field, format): format is ${shown(format)}, not a field format; give the field's own format, because what counts as empty depends on it. A right call: ${example}`);
  }
  if (format === "boolean") throw new Error(`isSet("${field}", "boolean"): a boolean cannot be told from empty, so it stays out of the validation rule (data-modeling.md → "Fields that apply only to some enum or boolean values")`);
  if (["date", "date-time", "reference"].includes(format)) return ne(v(field), null);
  if (["number", "float", "double", "integer", "int32", "int64", "rating"].includes(format)) return ne(v(field), 0);
  return ne(v(field), "");
}

/** The `input_type_rule` of a field that applies only in some states: `mode` there, hidden otherwise. */
export function appliesIn(states: ReadonlyArray<string>, mode: "required" | "default" | "readonly", field = "workflow_state"): Logic {
  const example = 'appliesIn(["rejected"], "required"), or appliesIn([true], "required", "is_recurring") for a boolean';
  if (!Array.isArray(states) || states.some((x) => !(typeof x === "string" && x !== "") && typeof x !== "boolean")) {
    throw new Error(`appliesIn(states, mode, field?): states is ${shown(states)}; it is a list of the values where the field applies. A right call: ${example}`);
  }
  if (!["required", "default", "readonly"].includes(mode)) {
    throw new Error(`appliesIn(states, mode, field?): mode is ${shown(mode)}; it is "required", "default" or "readonly". A right call: ${example}`);
  }
  needName("appliesIn(states, mode, field?)", "field", field, example);
  if (!states.length) throw new Error("appliesIn: name the states where the field applies");
  return iff(states.length === 1 ? eq(v(field), states[0]) : isIn(v(field), states), mode, "hidden");
}

export type ValidationRule = { code: string; name: string; message: string; jsonlogic: Logic; description?: string };
export type ComputedField = { name: string; jsonlogic: Logic; description?: string };

/** A validation rule: a class-99 code, a snake_case name, the message the caller sees, and the logic that must hold. */
export function rule(code: string, name: string, message: string, jsonlogic: Logic, description?: string): ValidationRule {
  if (typeof code !== "string" || typeof name !== "string" || typeof message !== "string" || jsonlogic === undefined) {
    throw new Error(`rule(code, name, message, jsonlogic, description?): code, name and message are strings and jsonlogic is the logic that must hold. A right call: rule("99001", "rejection_reason_when_rejected", "A rejected application needs a rejection reason.", iff(eq(v("workflow_state"), "rejected"), isSet("rejection_reason", "text"), true))`);
  }
  if (!/^99\d{3}$/.test(code)) throw new Error(`rule ${name}: the code "${code}" is not a class-99 code (99001 to 99999)`);
  if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error(`rule "${name}": the name is snake_case`);
  if (!message.trim()) throw new Error(`rule ${name}: the message is empty`);
  return description ? { code, name, message, jsonlogic, description } : { code, name, message, jsonlogic };
}

/** A computed field: the field it fills and the logic that gives its value. */
export function computed(name: string, jsonlogic: Logic, description?: string): ComputedField {
  needName("computed(name, jsonlogic, description?)", "name", name, 'computed("notice_deadline", <logic>)');
  if (jsonlogic === undefined) throw new Error(`computed("${name}", jsonlogic): jsonlogic is missing; it is the logic that gives the value`);
  if (!/^[a-z][a-z0-9_.]*$/.test(name)) throw new Error(`computed "${name}": name the field it fills`);
  return description ? { name, jsonlogic, description } : { name, jsonlogic };
}

/**
 * One part of a composed label: a related record's label column (`via` is the relationship field, `table` the
 * related entity, `column` its label column), or a field of the record itself (`labels` maps an enum's values to
 * the words the label shows).
 */
export type LabelPart =
  | { via: string; table: string; column: string }
  | { field: string; labels?: Record<string, string> };

/**
 * The `computed_fields` entry of a label composed from the records a record relates (`data-modeling.md` →
 * "Choosing the label"): each related record is read with `set_record`, and the parts are joined with `separator`.
 * When a relationship field is set but its record reads as null (the writer may not see it), an update keeps the
 * stored label.
 */
export function composedLabel(field: string, parts: ReadonlyArray<LabelPart>, separator = " – "): ComputedField {
  const example = 'composedLabel("enrollment_name", [{ via: "student_id", table: "students", column: "student_name" }, { field: "start_date" }])';
  needName("composedLabel(field, parts, separator?)", "field", field, example);
  const badPart = Array.isArray(parts) ? parts.find((p: any) => !p || typeof p !== "object" || !("via" in p || (typeof p.field === "string" && p.field !== ""))) : parts;
  if (!Array.isArray(parts) || badPart !== undefined) {
    throw new Error(`composedLabel(field, parts, separator?): ${Array.isArray(parts) ? `the part ${shown(badPart)} is` : `parts is ${shown(parts)}, `} not { via, table, column } or { field, labels? }. A right call: ${example}`);
  }
  const related = parts.filter((p): p is { via: string; table: string; column: string } => "via" in p);
  if (!related.length) throw new Error(`composedLabel ${field}: name at least one related record; a label from the record's own fields alone is a typed label`);
  const bindings = new Set<string>();
  const binding = (via: string) => (via.endsWith("_id") ? via.slice(0, -3) : `${via}_record`);
  for (const p of related) {
    if (!p.via || !p.table || !p.column) throw new Error(`composedLabel ${field}: a related part needs via, table and column`);
    if (bindings.has(binding(p.via))) throw new Error(`composedLabel ${field}: ${p.via} is named twice`);
    bindings.add(binding(p.via));
  }
  const values = parts.map((p) => {
    if ("via" in p) return v(`${binding(p.via)}.${p.column}`);
    if (bindings.has(p.field)) throw new Error(`composedLabel ${field}: the field ${p.field} has the name of a related record's binding`);
    const entries = Object.entries(p.labels ?? {});
    if (p.labels && !entries.length) throw new Error(`composedLabel ${field}: labels of ${p.field} is empty`);
    return entries.length ? iff(...entries.flatMap(([value, label]) => [eq(v(p.field), value), label]), v(p.field)) : v(p.field);
  });
  const joined = cat(...values.flatMap((value, i) => (i ? [separator, value] : [value])));
  const unreadable = related.map((p) => all(ne(v(p.via), null), eq(v(binding(p.via)), null)));
  const body = iff(all(modeIs("update"), unreadable.length === 1 ? unreadable[0] : any(...unreadable)), old(field), joined);
  return computed(field, related.reduceRight((inner, p) => setRecord(binding(p.via), p.table, v(p.via), inner), body));
}

/**
 * Writes a payload file for `call-file.ts`. Before writing it checks the rules of every entity in it: rule codes
 * are distinct across the payload, and rule and computed-field names are distinct within an entity.
 */
export function writePayload(path: string, payload: unknown): void {
  const entities = (payload as { data?: unknown })?.data;
  const list = Array.isArray(entities) ? entities : entities ? [entities] : [];
  const codes = new Map<string, string>();
  const problems: string[] = [];
  for (const e of list as Array<Record<string, any>>) {
    const where = String(e?.table_name ?? "?");
    const names = new Set<string>();
    for (const r of Array.isArray(e?.validation_rules) ? e.validation_rules : []) {
      if (codes.has(r.code)) problems.push(`code ${r.code} is used by ${codes.get(r.code)} and ${where}.${r.name}`);
      codes.set(r.code, `${where}.${r.name}`);
      if (names.has(r.name)) problems.push(`${where}: two validation rules are named ${r.name}`);
      names.add(r.name);
    }
    const filled = new Set<string>();
    for (const c of Array.isArray(e?.computed_fields) ? e.computed_fields : []) {
      if (filled.has(c.name)) problems.push(`${where}: two computed_fields fill ${c.name}`);
      filled.add(c.name);
    }
  }
  if (problems.length) throw new Error(`writePayload ${path}: nothing written:\n  - ${problems.join("\n  - ")}`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`wrote ${path}${list.length ? `: ${list.length} item(s)` : ""}`);
}

/** True when `logic` reads the record's field `name` with `var`. */
function readsField(logic: unknown, name: string): boolean {
  if (Array.isArray(logic)) return logic.some((x) => readsField(x, name));
  if (!logic || typeof logic !== "object") return false;
  return Object.entries(logic as Record<string, unknown>).some(([key, value]) =>
    key === "var" ? (Array.isArray(value) ? value[0] : value) === name : readsField(value, name));
}

/** True when an `input_type_rule` can return the input type `mode`. */
function canReturn(rule: unknown, mode: string): boolean {
  if (rule === mode) return true;
  if (Array.isArray(rule)) return rule.some((x) => canReturn(x, mode));
  return !!rule && typeof rule === "object" && Object.values(rule as Record<string, unknown>).some((x) => canReturn(x, mode));
}

/** Formats whose empty value is also a real value: a field of these gets no "needed in this state" rule. */
const NO_EMPTY_VALUE = new Set(["boolean", "integer", "int32", "int64", "number", "float", "double", "rating"]);

/**
 * Every problem of a new model's entities and fields, checked together before anything is written:
 * - the field checks of `call-file.ts` (a field `create_entity` already made, a required reference with `clear`, a
 *   rollup over hidden rows, a rollup whose `link_field` is not a relationship field of the child that points at the
 *   rollup's own entity) and its icons;
 * - a field its `input_type_rule` makes required in some states, with no validation rule of its entity that reads it
 *   (`data-modeling.md` → "Fields that apply only to some enum or boolean values");
 * - a field its `input_type_rule` shows `readonly` while no `computed_fields` rule of its entity fills it;
 * - a `computed_fields` entry that fills neither a field of the model nor the label column;
 * - a `computed_fields` or `validation_rules` rule that reads `_label` or `<fk>_label`, which the record being written does not hold;
 * - an entity whose `edit_permission` is not the write tier of its class (`catalog` at `:admin`, an operational class at `:manage`);
 * - a `workflow_state` whose states the access record does not cover, and every problem of the record itself;
 * - a `parent` field without an entry in the relationship record whose facts make it a parent, an entry whose format
 *   is not its field's, and every other problem of that record (`relationship-rules.ts`).
 * A field whose entity is not in `entities` is checked by `call-file.ts` alone, except against the relationship record.
 */
export function modelProblems(entities: ReadonlyArray<any>, fields: ReadonlyArray<any>, access?: AccessRecord, relationships?: RelationshipRecord): string[] {
  const byTable = new Map<string, any>(entities.filter((e) => typeof e?.table_name === "string").map((e) => [e.table_name, e]));
  const out = [
    ...keyProblems("create_entity", entities), ...keyProblems("create_field", fields),
    ...iconProblems(entities, fields), ...madeFieldProblems(fields, byTable as Map<string, EntityInfo>), ...fieldProblems(fields, byTable as Map<string, EntityInfo>),
    ...rollupRelationshipProblems(fields, [], new Set(byTable.keys())),
  ];
  const fieldsOf = new Map<string, Set<string>>();
  for (const f of fields) {
    if (!fieldsOf.has(f.table_name)) fieldsOf.set(f.table_name, new Set());
    fieldsOf.get(f.table_name)!.add(f.field_name);
  }
  for (const f of fields) {
    const e = byTable.get(f.table_name);
    const rule = f.input_type_rule;
    if (!e || !rule || typeof rule !== "object" || !Object.keys(rule).length) continue;
    const where = `${f.table_name}.${f.field_name}`;
    const rules: any[] = Array.isArray(e.validation_rules) ? e.validation_rules : [];
    if (canReturn(rule, "required") && !NO_EMPTY_VALUE.has(f.format) && !rules.some((r) => readsField(r?.jsonlogic, f.field_name))) {
      out.push(`${where}: its input_type_rule makes it required in some states, but no validation rule of ${f.table_name} reads it, so the platform still saves a record without it. Put that rule in the create_entity payload of ${f.table_name} (data-modeling.md, "Fields that apply only to some enum or boolean values").`);
    }
    const filled = new Set((Array.isArray(e.computed_fields) ? e.computed_fields : []).map((c: any) => String(c?.name ?? "").split(".")[0]));
    if (canReturn(rule, "readonly") && !filled.has(f.field_name)) {
      out.push(`${where}: its input_type_rule shows it readonly in some states, but no computed_fields rule of ${f.table_name} fills it, so nobody can enter it there. Readonly is for a field a computed rule fills; return "required" or "default" there instead (data-modeling.md, "Fields that apply only to some enum or boolean values").`);
    }
  }
  for (const e of byTable.values()) {
    const base = typeof e.id_refentity === "string" ? byTable.get(e.id_refentity) : undefined;
    const own = new Set([...(fieldsOf.get(e.table_name) ?? []), ...(base ? fieldsOf.get(base.table_name) ?? [] : []), e.label_column, base?.label_column]);
    for (const c of Array.isArray(e.computed_fields) ? e.computed_fields : []) {
      const name = String(c?.name ?? "").split(".")[0];
      if (!own.has(name)) out.push(`${e.table_name}: computed_fields fills ${c?.name}, which is neither a field of this model nor the label column; add the field or fix the name.`);
    }
  }
  out.push(...labelReadProblems(entities, fields));
  out.push(...entityPermissionProblems(entities), ...writeTierProblems(entities));
  out.push(...accessProblems(entities, fields, access));
  out.push(...relationshipProblems(fields, relationships, access, "relationships (writeModel)"));
  return out;
}

/**
 * A new entity is created with its module's tier permissions, which `module-rbac-setup.ts` made with the module:
 * read with `<slug>:read`, written with `<slug>:manage` or `<slug>:admin`. Any other, such as `<slug>:write_<entity>`,
 * does not exist yet; `module-rbac-setup.ts --access` creates it and switches the entity (rbac.md, "Choosing an entity's permissions").
 */
function entityPermissionProblems(entities: ReadonlyArray<any>): string[] {
  const prefixOf = (p: unknown) => (typeof p === "string" && p.includes(":") ? p.split(":")[0] : "");
  const tally = new Map<string, number>();
  for (const e of entities) for (const p of [e?.edit_permission, e?.view_permission]) if (prefixOf(p)) tally.set(prefixOf(p), (tally.get(prefixOf(p)) ?? 0) + 1);
  const slug = [...tally.entries()].sort((x, y) => y[1] - x[1])[0]?.[0];
  if (!slug) return [];
  const later = `module-rbac-setup.ts --access creates ${slug}:write_<entity> for an entity a role that does part of the work writes, and switches its edit_permission; never create it by hand (rbac.md, "Choosing an entity's permissions")`;
  const out: string[] = [];
  for (const e of entities) {
    if (typeof e?.view_permission === "string" && e.view_permission !== `${slug}:read`) {
      out.push(`${e.table_name}: view_permission is ${e.view_permission}, but a new entity of the module is created with ${slug}:read; ${later}.`);
    }
    if (typeof e?.edit_permission === "string" && ![`${slug}:manage`, `${slug}:admin`].includes(e.edit_permission)) {
      out.push(`${e.table_name}: edit_permission is ${e.edit_permission}, which does not exist when create_entity runs. Create the entity with ${slug}:manage (${slug}:admin for a catalog entity); ${later}.`);
    }
  }
  return out;
}

/** The access record checked against a new model: every lifecycle covered, and the record's own problems. */
function accessProblems(entities: ReadonlyArray<any>, fields: ReadonlyArray<any>, access: AccessRecord | undefined): string[] {
  const lifecycles = lifecyclesOf(fields).filter((l) => entities.some((e) => e?.table_name === l.table));
  if (access === undefined) {
    return [
      ...lifecycleNameProblems(fields.filter((f) => entities.some((e) => e?.table_name === f?.table_name))),
      ...labelColumnProblems(entities),
      ...coverageProblems(null, lifecycles).map((p) => `${p}; pass it as access in writeModel (rbac.md, "The access record")`),
    ];
  }
  const slug = String(entities.find((e) => typeof e?.view_permission === "string")?.view_permission ?? "module:read").split(":")[0];
  return planAccess({ slug, moduleName: "", record: access, entities, fields }).problems.map((p) => `access: ${p}`);
}

/** Writes a module's access record as `access.json` in `dir`, for a module that already has its entities. */
export function writeAccess(dir: string, access: AccessRecord): void {
  const problems = shapeProblems(access);
  if (problems.length) throw new Error(`writeAccess ${dir}: nothing written, ${problems.length} problem(s):\n  - ${problems.join("\n  - ")}`);
  const path = join(dir, "access.json");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(access, null, 2)}\n`);
  console.log(`wrote ${path}; run module-rbac-setup.ts --slug <module-slug> --access ${path}`);
}

/**
 * Writes a new model's payloads into `dir` once `modelProblems` finds nothing: `entities.json` (or `entities-1.json`,
 * `entities-2.json`, … for an `is_a` / `has_a` family, one file per level, bases first), `fields.json`, with the
 * rollups after every other field and each field a `computed_fields` rule fills `disabled`, `labels.json` (the
 * `update_field` that sets each label column a rule fills to `disabled`) when there is one, `access.json` when the model
 * has an access record, and `relationships.json` when it has a relationship record. Throws, naming every problem, and
 * writes nothing otherwise.
 */
export function writeModel(dir: string, model: { entities: ReadonlyArray<any>; fields: ReadonlyArray<any>; access?: AccessRecord; relationships?: RelationshipRecord }): void {
  const problems = modelProblems(model.entities, model.fields, model.access, model.relationships);
  if (problems.length) throw new Error(`writeModel ${dir}: nothing written, ${problems.length} problem(s):\n  - ${problems.join("\n  - ")}`);
  const tables = new Set(model.entities.map((e) => e.table_name));
  const level = new Map<string, number>();
  const levelOf = (e: any, seen = new Set<string>()): number => {
    if (level.has(e.table_name)) return level.get(e.table_name)!;
    if (seen.has(e.table_name)) throw new Error(`writeModel ${dir}: ${e.table_name} is based on itself through id_refentity`);
    seen.add(e.table_name);
    const base = typeof e.id_refentity === "string" && tables.has(e.id_refentity) ? model.entities.find((x) => x.table_name === e.id_refentity) : undefined;
    const n = base ? levelOf(base, seen) + 1 : 1;
    level.set(e.table_name, n);
    return n;
  };
  const levels = Math.max(1, ...model.entities.map((e) => levelOf(e)));
  const written: string[] = [];
  for (let n = 1; n <= levels; n++) {
    const path = join(dir, levels === 1 ? "entities.json" : `entities-${n}.json`);
    writePayload(path, { data: model.entities.filter((e) => level.get(e.table_name) === n) });
    written.push(`${path} with create_entity`);
  }
  const isRollup = (f: any) => !!f?.rollup && typeof f.rollup === "object" && Object.keys(f.rollup).length > 0;
  // A field a computed_fields rule fills is disabled: the platform leaves a required one required.
  const filled = (table: string, field: string) => (model.entities.find((e) => e.table_name === table)?.computed_fields ?? [])
    .some((c: any) => String(c?.name ?? "").split(".")[0] === field);
  const fields = model.fields.map((f) => (filled(f.table_name, f.field_name) && f.input_type !== "hidden" ? { ...f, input_type: "disabled" } : f));
  const fieldsPath = join(dir, "fields.json");
  writePayload(fieldsPath, { data: [...fields.filter((f) => !isRollup(f)), ...fields.filter(isRollup)] });
  written.push(`${fieldsPath} with create_field`);
  // create_entity makes the label field required, so a label a rule fills is disabled with update_field.
  const labels = model.entities.filter((e) => e.label_column && filled(e.table_name, e.label_column)).map((e) => `${e.table_name}.${e.label_column}`);
  if (labels.length) {
    const labelsPath = join(dir, "labels.json");
    writePayload(labelsPath, { id: labels, data: { input_type: "disabled" } });
    written.push(`${labelsPath} with update_field`);
  }
  if (model.access !== undefined) {
    const accessPath = join(dir, "access.json");
    writeFileSync(accessPath, `${JSON.stringify(model.access, null, 2)}\n`);
    console.log(`wrote ${accessPath}`);
  }
  if (model.relationships !== undefined) {
    const relationshipsPath = join(dir, "relationships.json");
    writeFileSync(relationshipsPath, `${JSON.stringify(model.relationships, null, 2)}\n`);
    console.log(`wrote ${relationshipsPath}`);
  }
  console.log(`send in this order with call-file.ts: ${written.join(", then ")}` +
    (model.access !== undefined ? `; then run module-rbac-setup.ts --slug <module-slug> --access ${join(dir, "access.json")}` : ""));
}
