/**
 * access-rules.ts — turns a module's access record into the module's access (`rbac.md` → "Restricted steps (gates)",
 * "Roles that take gates", "Roles that do part of the work", "Controls on a gate"). Not a CLI:
 *   - `module-rbac-setup.ts --access <file>` applies what `planAccess` returns to a live module;
 *   - `jsonlogic-kit.ts` (`writeModel`, `writeAccess`) checks a record before it is written;
 *   - `call-file.ts` checks a `workflow_state` field against the record next to its payload.
 *
 * The record says who does the everyday work (`everyday`), the other people who use the module (`roles`), and, for
 * each entity with a `workflow_state`, who moves a record into each state: the everyday person, or another person,
 * which makes the move a gate for that person's role (rbac.md's test, applied here). A role-change state given to the
 * everyday person needs a `because`, and every user field that names a person is accounted for (`userFields`).
 * Everything else is derived: names, rules and messages follow `rbac.md`, whose complete rules are this file's output
 * for their examples (`scripts/access-rules.test.ts` compares the two).
 */

export type NamedPerson = true | { via: string | string[]; field?: string; on?: string } | { field: string };
export type GateSpec = {
  takenBy: string[]; verb: string; after: string[]; waiting?: string; namedPerson?: NamedPerson;
  filledLater?: string[]; covers?: string[];
  /** States later in the order that a record can also reach without the gate; with `after`, every later state is decided. */
  notAfter?: string[];
};
/** A state as the record writes it: the person who moves a record into it, or that person with the gate's details. */
export type StateSpec = string | (Partial<GateSpec> & { by?: string | string[]; because?: string });
export type RoleSpec = {
  title: string; seesOnlyNamed?: boolean;
  writes?: string[]; limitedTo?: Record<string, string>; hidden?: string[]; leaves?: Record<string, string[]>;
  /** A role that does part of the work: the entities it sees besides what it writes (all others are hidden from it). */
  sees?: string[];
  /** A role that does part of the work: the fields it fills in on each entity it writes (all others stay with the everyday workers). */
  fills?: Record<string, string[]>;
};
export type EntityAccess = { states?: Record<string, StateSpec>; create?: string[] };
export type AccessRecord = {
  everyday?: string; roles?: Record<string, RoleSpec>; entities: Record<string, EntityAccess>;
  userFields?: Record<string, string | { by: string; because?: string }>;
  /** Why nobody but the everyday person uses the module, when `roles` is empty. */
  onlyEveryday?: string;
  /** Why nobody uses the module without doing its everyday work, when no role `writes`. */
  nobodyDoesPart?: string;
  /** The leading products the module follows (`build-module.md` → "Model it like the leading products"). */
  products?: string[];
  /** Every kind of person who uses those products, and who each is here: the everyday person, a role, or "outside". */
  people?: Record<string, string | { by: string; because?: string }>;
};

export type EntityRow = {
  table_name: string; singular_label?: string; plural_label?: string; entity_type?: string;
  view_permission?: string; edit_permission?: string; label_column?: string;
  validation_rules?: any[] | null; computed_fields?: any[] | null; select_rule?: unknown;
};
export type FieldRow = {
  table_name: string; field_name: string; title?: string; format?: string; enum_values?: any[] | null;
  reference_table?: string | null; reference_delete_mode?: string | null; input_type?: string | null; relationship_label?: string | null;
  ctype?: string | null; rollup?: any; field_order?: number | null; default_value?: unknown;
};

export type AccessPlan = {
  problems: string[];
  warnings: string[];
  notes: string[];
  permissions: Array<{ permission_name: string; description: string }>;
  hierarchy: Array<[string, string]>;
  roles: Array<{ key: string; slug: string; role_name: string; description: string; bundle: string }>;
  gated: boolean;
  fields: FieldRow[];
  rollups: Array<{ id: string; rollup: any }>;
  entities: Map<string, { entity_type?: string; edit_permission?: string; validation_rules?: any[]; computed_fields?: any[]; select_rule?: unknown }>;
  accessSummary: string;
  takers: string[];
};

// ---------- JsonLogic, written the way rbac.md shows it ----------
type L = unknown;
const V = (name: string): L => ({ var: name });
const EQ = (a: L, b: L): L => ({ "==": [a, b] });
const NE = (a: L, b: L): L => ({ "!=": [a, b] });
const AND = (...parts: L[]): L => ({ and: parts });
const OR = (...parts: L[]): L => ({ or: parts });
const NOT = (part: L): L => ({ "!": [part] });
const IF = (...parts: L[]): L => ({ if: parts });
const IN = (value: L, list: string[]): L => ({ in: [value, list] });
const HAS = (permission: string): L => ({ has_permission: permission });
const CHANGED = (field: string): L => ({ value_changed: field });
const MODE = (mode: string): L => EQ(V("$mode"), mode);
const SETREC = (name: string, table: string, id: L, body: L): L => ({ set_record: [name, table, id, body] });
const USER = V("$user_id");
const WS = "workflow_state";
const OLD_WS = V("$old.workflow_state");
const changedTo = (state: string): L => AND(CHANGED(WS), EQ(V(WS), state));
const isOneOf = (value: L, list: string[]): L => (list.length === 1 ? EQ(value, list[0]) : IN(value, list));
const REQ = "requested_by_user_id";

// ---------- words ----------
const article = (phrase: string) => (/^[aeiou]/i.test(phrase) ? "an" : "a");
const a = (phrase: string) => `${article(phrase)} ${phrase}`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const listOf = (items: string[], conj = "or") => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} ${conj} ${items[items.length - 1]}`);
const snake = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
/** A snake_case verb as words: `send_back` → "send back". */
const words = (verb: string) => verb.replace(/_/g, " ");
/** The third person of a verb phrase's first word: approve → approves, verify → verifies, send back → sends back. */
const third = (verb: string) => {
  const [first, ...rest] = words(verb).split(" ");
  const s = /[^aeiou]y$/.test(first) ? `${first.slice(0, -1)}ies` : /(s|sh|ch|x|z)$/.test(first) ? `${first}es` : `${first}s`;
  return [s, ...rest].join(" ");
};
const bindingOf = (fk: string) => (fk.endsWith("_id") ? fk.slice(0, -3) : `${fk}_record`);

/** The kind of gate a move into `state` is (`rbac.md` → "Controls on a gate"). */
export function gateKind(state: string): "approval" | "payout" | "transition" {
  if (["approved", "signed", "posted", "released", "verified"].includes(state)) return "approval";
  if (["paid", "reimbursed", "disbursed"].includes(state)) return "payout";
  return "transition";
}

const ROLE_KEY = /^[a-z][a-z0-9_]*$/;
const RESERVED = new Set(["viewer", "manager", "admin", "read", "manage"]);
const GATE_KEYS = new Set(["by", "takenBy", "because", "verb", "after", "notAfter", "waiting", "namedPerson", "filledLater", "covers"]);
const ROLE_KEYS = new Set(["title", "seesOnlyNamed", "writes", "limitedTo", "hidden", "leaves", "sees", "fills"]);
const RECORD_KEYS = new Set(["products", "people", "everyday", "roles", "entities", "userFields", "onlyEveryday", "nobodyDoesPart"]);
/** User-field names that say what a person did or holds, not which kind of person they are. */
const GENERIC_PERSON = /(_by|^owner|^assigned|^assignee|^responsible|^user|^member|^contact|^primary_contact|^point_of_contact|^account_owner)$/;
const enumValues = (f: FieldRow | undefined): string[] =>
  (Array.isArray(f?.enum_values) ? f!.enum_values : []).map((x: any) => (typeof x === "string" ? x : x?.value)).filter((x: unknown): x is string => typeof x === "string");
const isGate = (s: unknown): s is GateSpec => !!s && typeof s === "object";

/**
 * The states where the role usually changes (`rbac.md` → "Restricted steps (gates)"). They are examples, not the test:
 * giving one to the everyday person is allowed, with a `because` that says who takes it in the leading products.
 */
export const ROLE_CHANGE_STATES = new Set(["approved", "signed", "issued", "released", "posted", "committed", "hired", "void", "voided", "terminated", "paid", "reimbursed", "disbursed", "verified"]);

/** The verb of a move into `state`, for the gate's name (`hired` → `hire`); undefined when the state does not say. */
const VERBS: Record<string, string> = {
  approved: "approve", signed: "sign", issued: "issue", released: "release", posted: "post", committed: "commit", hired: "hire",
  void: "void", voided: "void", terminated: "terminate", paid: "pay", reimbursed: "reimburse", disbursed: "disburse", verified: "verify",
  ordered: "order", accepted: "accept", rejected: "reject", closed: "close", completed: "complete", published: "publish", submitted: "submit",
  sent: "send", scheduled: "schedule", received: "receive", shipped: "ship", delivered: "deliver", invoiced: "invoice", archived: "archive",
  activated: "activate", suspended: "suspend", resolved: "resolve", escalated: "escalate", assigned: "assign", booked: "book", confirmed: "confirm",
  filled: "fill", offered: "offer", withdrawn: "withdraw", declined: "decline", expired: "expire", canceled: "cancel",
  opened: "open", reopened: "reopen", screened: "screen", interviewed: "interview", extended: "extend", onboarded: "onboard", certified: "certify",
  audited: "audit", reviewed: "review", returned: "return", refunded: "refund", settled: "settle", renewed: "renew", retired: "retire",
};
export const verbOf = (state: string): string | undefined => VERBS[state];

/** Problems in the record's own shape, before it is compared with a model. */
export function shapeProblems(record: unknown): string[] {
  const out: string[] = [];
  const example = '{ "everyday": "<person>", "roles": { … }, "entities": { "<table>": { "states": { "<state>": "<person>" } } } }';
  if (!record || typeof record !== "object" || Array.isArray(record)) return [`the access record is an object: ${example}`];
  const r = record as AccessRecord;
  for (const k of Object.keys(r)) if (!RECORD_KEYS.has(k)) out.push(`the access record has an unknown key "${k}" (the keys are ${[...RECORD_KEYS].join(", ")})`);
  if (!r.entities || typeof r.entities !== "object") out.push(`the access record has no "entities": list each entity with a workflow_state and who moves a record into each of its states: ${example}`);
  if (r.everyday !== undefined && (typeof r.everyday !== "string" || !ROLE_KEY.test(r.everyday))) out.push('"everyday" names, in snake_case, the person who does the module\'s everyday work ("recruiter", "agent", "employee")');
  const roles = r.roles ?? {};
  // Who uses the module comes from the products it follows, a fact to recall, never a default.
  if (!Array.isArray(r.products) || !r.products.some((p) => typeof p === "string" && p.trim())) {
    out.push('"products" names the leading products the module follows (build-module.md, "Model it like the leading products"), such as ["Greenhouse", "Lever"]');
  }
  const people = r.people && typeof r.people === "object" && !Array.isArray(r.people) ? r.people : null;
  if (!people || Object.keys(people).length < 2) {
    out.push('"people" lists every kind of person who uses those products, each with who they are here: { "<person>": "<the everyday person, a key of roles, or outside>" }. List them as the products do (their user types and seats), including the people who only take a step and the people who only write their own records; "outside" is someone who never signs in, such as a candidate or an outside customer');
  } else {
    const everydayKey = r.everyday ?? "manager";
    for (const [person, value] of Object.entries(people)) {
      const by = typeof value === "string" ? value : (value as any)?.by;
      const because = typeof value === "object" && typeof (value as any)?.because === "string" ? (value as any).because.trim() : "";
      if (!ROLE_KEY.test(person)) out.push(`people: "${person}" is snake_case`);
      if (by !== everydayKey && by !== "manager" && by !== "outside" && !roles[by]) out.push(`people: ${person} is "${by}", which is neither the everyday person ("${everydayKey}"), a key of "roles", nor "outside"`);
      else if ((by === everydayKey || by === "manager") && person !== everydayKey && because.length < 12) {
        out.push(`people: ${person} is a kind of person of its own in the products. Give it its role in "roles" (the steps it takes, or the records it writes), or write { "by": "${everydayKey}", "because": "<why the products count it as the everyday person>" }`);
      }
    }
    for (const key of Object.keys(roles)) if (!Object.entries(people).some(([p, v]) => p === key || (typeof v === "string" ? v : (v as any)?.by) === key)) out.push(`role "${key}" is not among "people": list the kind of person it is`);
  }
  if (roles && typeof roles === "object" && !Object.keys(roles).length && !(typeof r.onlyEveryday === "string" && r.onlyEveryday.trim().length >= 12)) {
    out.push('who else uses the module in the leading products? Add each kind of person to "roles": a person who takes some steps, or one who does only part of the work (rbac.md, "Roles that do part of the work" lists common ones). When nobody but the everyday person does, write "onlyEveryday": "<why, in the leading products>"');
  } else if (roles && typeof roles === "object" && Object.keys(roles).length && !Object.values(roles).some((x: any) => Array.isArray(x?.writes) && x.writes.length) && !(typeof r.nobodyDoesPart === "string" && r.nobodyDoesPart.trim().length >= 12)) {
    out.push('does anyone use the module in the leading products without doing its everyday work, writing only their own records (a requester\'s tickets, a technician\'s service reports, an employee\'s expense reports, an interviewer\'s feedback)? Add each as a role that does part of the work ("writes", "limitedTo", "sees", "fills"). When nobody does, write "nobodyDoesPart": "<why, in the leading products>"');
  }
  if (typeof roles !== "object" || Array.isArray(roles)) out.push('"roles" is an object keyed by role key');
  for (const [key, role] of Object.entries(roles)) {
    if (!ROLE_KEY.test(key)) out.push(`role "${key}": a role key is snake_case`);
    if (RESERVED.has(key)) out.push(`role "${key}": ${key} is a tier, not a role beyond viewer, manager and admin; take it out of "roles"`);
    if (key === r.everyday) out.push(`role "${key}" is the everyday person, who holds the module's Manager role; take it out of "roles"`);
    if (!role || typeof role !== "object") { out.push(`role "${key}" is { "title": "…" }`); continue; }
    for (const k of Object.keys(role)) if (!ROLE_KEYS.has(k)) out.push(`role "${key}": unknown key "${k}" (the keys are ${[...ROLE_KEYS].join(", ")})`);
    if (typeof role.title !== "string" || !role.title.trim()) out.push(`role "${key}" needs a "title", such as "Hiring Manager"`);
  }
  for (const [table, entity] of Object.entries(r.entities ?? {})) {
    if (!entity || typeof entity !== "object") { out.push(`${table}: { "states": { … } }`); continue; }
    for (const k of Object.keys(entity)) if (!["states", "create"].includes(k)) out.push(`${table}: unknown key "${k}" (the keys are states and create)`);
    if (entity.create !== undefined && (!Array.isArray(entity.create) || !entity.create.length)) out.push(`${table}: "create" lists the roles that may create a record`);
    for (const [state, value] of Object.entries(entity.states ?? {})) {
      const where = `${table}.${state}`;
      if (typeof value === "string") {
        if (!ROLE_KEY.test(value)) out.push(`${where} names the person who moves a record into it, in snake_case: "${r.everyday ?? "<the everyday person>"}" or a key of "roles"`);
        continue;
      }
      if (!value || typeof value !== "object") { out.push(`${where} is the person who moves a record into it ("${r.everyday ?? "<person>"}"), or { "by": "<person>", … } with the gate's details`); continue; }
      for (const k of Object.keys(value)) if (!GATE_KEYS.has(k)) out.push(`${where}: unknown key "${k}" (the keys are ${[...GATE_KEYS].join(", ")})`);
      const by = value.by ?? value.takenBy;
      if (!(typeof by === "string" && by) && !(Array.isArray(by) && by.length)) out.push(`${where}: "by" names the person who moves a record into it`);
      if (value.verb !== undefined && (typeof value.verb !== "string" || !ROLE_KEY.test(value.verb))) out.push(`${where}: "verb" names the step in snake_case ("approve", "hire"); the gate is <slug>:<verb>_<singular>`);
      if (value.after !== undefined && !Array.isArray(value.after)) out.push(`${where}: "after" lists the states a record reaches only after this one`);
      if (value.notAfter !== undefined && !Array.isArray(value.notAfter)) out.push(`${where}: "notAfter" lists the states after this one that a record can also reach without it`);
    }
  }
  return out;
}

/**
 * The record with every state as `"manager"` or a full gate: the everyday person's states are no gate, another
 * person's state is a gate for that person's role, with its verb and, for an approval, its waiting state derived
 * when the record leaves them out. Problems name what the record must still say.
 */
function normalizeRecord(record: AccessRecord, fieldsOf: Map<string, FieldRow[]>, problems: string[]): AccessRecord {
  const everyday = record.everyday ?? "manager";
  const roles = record.roles ?? {};
  const persons = (value: StateSpec | undefined): string[] => (typeof value === "string" ? [value] : value ? [value.by ?? value.takenBy ?? []].flat() as string[] : []);
  const out: AccessRecord = { ...record, entities: {} };
  for (const [table, entity] of Object.entries(record.entities ?? {})) {
    const values = enumValues((fieldsOf.get(table) ?? []).find((f) => f.field_name === WS));
    const order = values.length ? values : Object.keys(entity.states ?? {});
    const states: Record<string, StateSpec> = {};
    // An approval gate's own takers also decide its rejection, so the rejection is no gate of its own.
    const approvers = new Set(order.filter((s) => gateKind(s) === "approval").flatMap((s) => persons(entity.states?.[s])));
    for (const state of Object.keys(entity.states ?? {})) {
      const value = entity.states![state];
      const where = `${table}.${state}`;
      const who = persons(value);
      for (const p of who) {
        if (p !== everyday && p !== "manager" && p !== "admin" && !roles[p]) {
          problems.push(`${where}: "${p}" is neither the everyday person ("${everyday}") nor a key of "roles"; add the person to "roles" with a "title", or give the state to "${everyday}"`);
        }
      }
      const spec = typeof value === "object" && value ? value : {};
      if (who.some((p) => p === everyday || p === "manager")) {
        const because = typeof spec.because === "string" ? spec.because.trim() : "";
        if (ROLE_CHANGE_STATES.has(state) && because.length < 12) {
          problems.push(`${where}: in the leading products the move into "${state}" usually belongs to a role other than the one doing the everyday work. Give it to that role (a key of "roles"), or write { "by": "${everyday}", "because": "<who takes this step in the leading products, and why it is the everyday work here>" }`);
        }
        states[state] = "manager";
        continue;
      }
      if (state === "rejected" && who.length && who.every((p) => approvers.has(p))) { states[state] = "manager"; continue; }
      const kind = gateKind(state);
      const verb = spec.verb ?? verbOf(state);
      if (!verb) problems.push(`${where}: give the step a "verb" in snake_case ({ "by": "${who[0] ?? "<role>"}", "verb": "<verb>" }); the gate is <slug>:<verb>_<singular>`);
      const at = order.indexOf(state);
      const waiting = spec.waiting ?? (kind === "approval" && at >= 2 ? order[at - 1] : undefined);
      const gate: GateSpec = { takenBy: who, verb: verb ?? state, after: spec.after ?? [] };
      if (waiting) gate.waiting = waiting;
      for (const k of ["namedPerson", "filledLater", "covers", "notAfter"] as const) if (spec[k] !== undefined) (gate as any)[k] = spec[k];
      states[state] = gate;
    }
    out.entities[table] = { ...entity, states };
  }
  return out;
}

/**
 * A role that does part of the work, as the generator takes it: `sees` (what it sees besides what it writes) makes
 * every other entity of the module `hidden`, and `fills` (the fields it fills in) leaves every other field it could
 * enter to the everyday workers. A record that says `hidden` or `leaves` itself keeps them.
 */
function normalizeRoles(record: AccessRecord, byTable: Map<string, EntityRow>, fieldsOf: Map<string, FieldRow[]>): AccessRecord {
  const roles: Record<string, RoleSpec> = {};
  for (const [key, role] of Object.entries(record.roles ?? {})) {
    const r: RoleSpec = { ...role };
    const writes = r.writes ?? [];
    // An empty "hidden" or "leaves" is no answer: the role then says what it sees and fills in, and the rest follows.
    if (Array.isArray(r.hidden) && !r.hidden.length) delete r.hidden;
    if (r.leaves && typeof r.leaves === "object" && !Object.values(r.leaves).some((fs) => Array.isArray(fs) && fs.length)) delete r.leaves;
    if (writes.length && Array.isArray(r.sees) && r.hidden === undefined) {
      r.hidden = [...byTable.keys()].filter((t) => !writes.includes(t) && !r.sees!.includes(t) && !Object.keys(r.limitedTo ?? {}).includes(t));
    }
    const fills = r.fills;
    if (writes.length && fills && typeof fills === "object" && r.leaves === undefined) {
      const leaves: Record<string, string[]> = {};
      for (const t of writes) {
        const e = byTable.get(t);
        const computedNames = new Set((e?.computed_fields ?? []).map((x: any) => String(x?.name ?? "").split(".")[0]));
        const own = r.limitedTo?.[t];
        const up = new Set((fieldsOf.get(t) ?? []).filter((f) => isRelationship(f) && f.reference_table && (writes.includes(f.reference_table) || Object.keys(r.limitedTo ?? {}).includes(f.reference_table))).map((f) => f.field_name));
        const kept = (fieldsOf.get(t) ?? []).filter((f) => !["id", "created_at", "updated_at", WS, REQ].includes(f.field_name) && !["id", "audit", "rollup", "computed"].includes(String(f.ctype ?? ""))
          && !f.rollup?.link_field && !computedNames.has(f.field_name) && f.field_name !== own && !up.has(f.field_name) && !(fills[t] ?? []).includes(f.field_name)
          && !/_by_user_id$/.test(f.field_name) && !(f.field_name === e?.label_column && computedNames.has(f.field_name)));
        if (kept.length) leaves[t] = kept.map((f) => f.field_name);
      }
      r.leaves = leaves;
    }
    roles[key] = r;
  }
  return { ...record, roles };
}

/**
 * A lifecycle under another name: an enum named `status`, `state` or `stage`, or `<its entity's singular>_status`,
 * `_state` or `_stage`. An entity's lifecycle is its `workflow_state` (`data-modeling.md` → "`default_value`"), which
 * the access record covers; an enum about something else keeps its domain name (`marital_status` on employees).
 */
export function lifecycleNameProblems(fields: ReadonlyArray<{ table_name?: string; field_name?: string; format?: string; enum_values?: unknown }>): string[] {
  const out: string[] = [];
  for (const f of fields) {
    const isEnum = f?.format === "enum" || (f?.format === undefined && Array.isArray(f?.enum_values) && f.enum_values.length > 0);
    if (!isEnum || typeof f.field_name !== "string" || typeof f.table_name !== "string") continue;
    const m = f.field_name.match(/^(?:(.+)_)?(status|state|stage)$/);
    if (!m || f.field_name === WS) continue;
    const stem = m[1];
    const t = f.table_name;
    // Its own lifecycle: a bare name, or a stem that is the entity's name or starts it (job_status on job_openings).
    const own = !stem || ["lifecycle", "workflow", "current", "pipeline"].includes(stem)
      || [stem, `${stem}s`, `${stem}es`, stem.endsWith("y") ? `${stem.slice(0, -1)}ies` : ""].some((p) => p && (t === p || t.endsWith(`_${p}`)))
      || t.includes(`_${stem}_`) || t.startsWith(`${stem}_`);
    if (own) out.push(`${t}.${f.field_name}: an entity's lifecycle is its enum workflow_state (data-modeling.md, "default_value"). Name this field workflow_state, and say in the access record who moves a record into each of its states (rbac.md, "The access record"); an enum about something else is named for what it is about`);
  }
  return out;
}

/** A label column that is a lifecycle: the label holds a name, title or number people call the record by (`data-modeling.md` → "Choosing the label"). */
export function labelColumnProblems(entities: ReadonlyArray<{ table_name?: string; label_column?: unknown }>): string[] {
  return entities
    .filter((e) => typeof e?.label_column === "string" && /(^|_)(workflow_state|status|state|stage)$/.test(e.label_column as string))
    .map((e) => `${e.table_name}: label_column is ${e.label_column}, but the label holds a name, title or number people call the record by (data-modeling.md, "Choosing the label"); create_entity makes the label column a locked text field, so a lifecycle there can never get its states. Name the label column for the name it holds, and create workflow_state with create_field`);
}

/** Each lifecycle field must be covered by the record, with exactly its enum's values. */
export function coverageProblems(record: AccessRecord | null | undefined, lifecycles: ReadonlyArray<{ table: string; values: string[] }>): string[] {
  const out: string[] = [];
  for (const { table, values } of lifecycles) {
    const states = record?.entities?.[table]?.states;
    if (!states) {
      out.push(`${table}.workflow_state: the access record does not say who moves a ${table} record into each state. Write it before the field: for each state "manager" or a gate (rbac.md, "Restricted steps (gates)")`);
      continue;
    }
    const listed = Object.keys(states);
    const missing = values.filter((s) => !listed.includes(s));
    const extra = listed.filter((s) => !values.includes(s));
    if (missing.length) out.push(`${table}.workflow_state: the access record does not say who moves a record into ${missing.join(", ")}`);
    if (extra.length) out.push(`${table}.workflow_state has no state ${extra.join(", ")}, which the access record lists`);
  }
  return out;
}

/** The lifecycle fields of a model: each `workflow_state` with its values. */
export const lifecyclesOf = (fields: ReadonlyArray<FieldRow>) =>
  fields.filter((f) => f.field_name === WS).map((f) => ({ table: f.table_name, values: enumValues(f) }));

type Ctx = {
  slug: string; moduleName: string; record: AccessRecord;
  byTable: Map<string, EntityRow>; fieldsOf: Map<string, FieldRow[]>; problems: string[];
};

const fieldOf = (c: Ctx, table: string, name: string) => c.fieldsOf.get(table)?.find((f) => f.field_name === name);
const isRelationship = (f: FieldRow) => f.format === "reference" || f.format === "parent";
const singularOf = (c: Ctx, table: string) => (c.byTable.get(table)?.singular_label ?? table).toLowerCase();
const pluralOf = (c: Ctx, table: string) => (c.byTable.get(table)?.plural_label ?? table).toLowerCase();
const stateLabel = (c: Ctx, table: string, state: string) => {
  const e = (fieldOf(c, table, WS)?.enum_values ?? []).find((x: any) => (typeof x === "string" ? x : x?.value) === state);
  return String((e && typeof e === "object" && e.label) || state.replace(/_/g, " ")).toLowerCase();
};
const roleTitle = (c: Ctx, key: string) => (key === "admin" ? "admin" : c.record.roles?.[key]?.title ?? key);
const takerPhrase = (c: Ctx, keys: string[]) => listOf(keys.map((k) => a(roleTitle(c, k))));

type Gate = {
  table: string; state: string; spec: GateSpec; kind: ReturnType<typeof gateKind>; perm: string;
  named?: { field: string; table: string; chain: Array<{ fk: string; table: string }> };
};

/** The tables that hang below `table` in the module: a `parent` field, or a required `reference`, pointing at it. */
function childrenOf(c: Ctx, table: string): Array<{ table: string; fk: string }> {
  const out: Array<{ table: string; fk: string }> = [];
  for (const [t, fs] of c.fieldsOf) {
    if (t === table || !c.byTable.has(t)) continue;
    const f = fs.find((x) => x.reference_table === table && (x.format === "parent" || (x.format === "reference" && x.input_type === "required")));
    if (f) out.push({ table: t, fk: f.field_name });
  }
  return out;
}
/** `table` and every table below it, each with the table and field it hangs from. */
function treeOf(c: Ctx, table: string): Array<{ table: string; parent?: string; fk?: string }> {
  const out: Array<{ table: string; parent?: string; fk?: string }> = [{ table }];
  const seen = new Set([table]);
  for (let i = 0; i < out.length; i++) {
    for (const ch of childrenOf(c, out[i].table)) {
      if (seen.has(ch.table)) continue;
      seen.add(ch.table);
      out.push({ table: ch.table, parent: out[i].table, fk: ch.fk });
    }
  }
  return out;
}

function resolveGates(c: Ctx): Gate[] {
  const gates: Gate[] = [];
  for (const [table, entity] of Object.entries(c.record.entities ?? {})) {
    if (!c.byTable.has(table)) { c.problems.push(`${table}: not an entity of this module`); continue; }
    const values = enumValues(fieldOf(c, table, WS));
    if (entity.states && !fieldOf(c, table, WS)) c.problems.push(`${table}: lists states, but the entity has no workflow_state`);
    for (const key of entity.create ?? []) if (key !== "admin" && !c.record.roles?.[key]) c.problems.push(`${table}: "create" names ${key}, which is not in "roles"`);
    let approvals = 0;
    for (const state of values) {
      const spec = entity.states?.[state];
      if (!isGate(spec)) continue;
      const where = `${table}.${state}`;
      const kind = gateKind(state);
      for (const s of spec.after ?? []) if (!values.includes(s) || s === state) c.problems.push(`${where}: "after" names ${s}, which is not another state of ${table}`);
      // Every state after the gate in the order is decided: reached only through it ("after"), or also without it ("notAfter").
      // An approval's own rejection is reached from the waiting state, and its controls already decide it.
      const later = values.slice(values.indexOf(state) + 1);
      const after = spec.after ?? [], notAfter = spec.notAfter ?? [];
      for (const s of notAfter) {
        if (!values.includes(s) || s === state) c.problems.push(`${where}: "notAfter" names ${s}, which is not another state of ${table}`);
        else if (!later.includes(s)) c.problems.push(`${where}: "notAfter" names ${s}, which comes before ${state} in the workflow_state order; only a later state is decided there`);
        if (after.includes(s)) c.problems.push(`${where}: ${s} is in both "after" and "notAfter"; it belongs in one of them`);
      }
      const undecided = later.filter((s) => !after.includes(s) && !notAfter.includes(s) && !(kind === "approval" && s === "rejected"));
      if (undecided.length) {
        const by = spec.takenBy.length === 1 ? JSON.stringify(spec.takenBy[0]) : JSON.stringify(spec.takenBy);
        c.problems.push(
          `${where}: ${listOf(undecided.map((s) => `"${s}"`), "and")} ${undecided.length === 1 ? "comes" : "come"} after "${state}" in the workflow_state order, and the record does not say whether ${a(singularOf(c, table))} reaches ${undecided.length === 1 ? "it" : "them"} only once it was ${state}. ` +
          `Put each state reached only after "${state}" in "after", and each a record can also reach without it in "notAfter", keeping the state's other keys: ` +
          `{ "by": ${by}, "after": ${JSON.stringify(after)}, "notAfter": ${JSON.stringify(notAfter)} } with ${listOf(undecided.map((s) => `"${s}"`), "and")} added to one of them (rbac.md, "Restricted steps (gates)", step 5)`,
        );
      }
      if (kind === "approval") {
        approvals++;
        if (!spec.waiting || !values.includes(spec.waiting) || spec.waiting === state) c.problems.push(`${where}: an approval gate names "waiting", the state a record waits in for the approval (it defaults to the state before this one, when a state comes before that)`);
        else if (values.indexOf(spec.waiting) < 1) c.problems.push(`${where}: "waiting" (${spec.waiting}) needs a state before it, where the record is prepared`);
      } else if (spec.waiting) c.problems.push(`${where}: "waiting" applies only to an approval gate (a move into approved, signed, posted, released or verified)`);
      for (const f of spec.filledLater ?? []) if (!fieldOf(c, table, f)) c.problems.push(`${where}: "filledLater" names ${f}, which is not a field of ${table}`);
      for (const child of spec.covers ?? []) {
        if (kind !== "approval") c.problems.push(`${where}: "covers" applies only to an approval gate`);
        else if (!(c.fieldsOf.get(child) ?? []).some((f) => isRelationship(f) && f.reference_table === table)) c.problems.push(`${where}: "covers" names ${child}, which has no relationship field to ${table}`);
      }
      const gate: Gate = { table, state, spec, kind, perm: `${c.slug}:${spec.verb}_${snake(c.byTable.get(table)?.singular_label ?? table)}` };
      const np = spec.namedPerson;
      if (np !== undefined) {
        const first = spec.takenBy?.[0];
        if (!first || first === "admin") c.problems.push(`${where}: a named person takes the step as one of its roles; the first of "takenBy" is that role`);
        const field = (typeof np === "object" && np.field) || `${first}_user_id`;
        if (np === true || (typeof np === "object" && !("via" in np))) gate.named = { field, table, chain: [] };
        else if (typeof np === "object" && "via" in np) {
          const chain: Array<{ fk: string; table: string }> = [];
          let at = table;
          for (const fk of [np.via].flat()) {
            const f = fieldOf(c, at, fk);
            if (!f || !isRelationship(f) || !f.reference_table) { c.problems.push(`${where}: "namedPerson.via" names ${fk}, which is not a relationship field of ${at}`); break; }
            chain.push({ fk, table: f.reference_table });
            at = f.reference_table;
          }
          if (np.on && np.on !== at) c.problems.push(`${where}: "namedPerson.via" ends at ${at}, not ${np.on}`);
          if (!c.byTable.has(at)) c.problems.push(`${where}: the named person sits on ${at}, which is not an entity of this module`);
          gate.named = { field, table: at, chain };
        } else c.problems.push(`${where}: "namedPerson" is true, { "via": "<relationship field>" } or { "field": "<user field>" }`);
        if (gate.named) {
          const f = fieldOf(c, gate.named.table, gate.named.field);
          if (f && !(f.format === "reference" && f.reference_table === "users")) c.problems.push(`${where}: ${gate.named.table}.${gate.named.field} is not a reference to users`);
        }
      }
      gates.push(gate);
    }
    if (approvals > 1) c.problems.push(`${table}: one approval gate per entity; its controls lock the record from the waiting state on`);
  }
  for (const [key, role] of Object.entries(c.record.roles ?? {})) {
    const takes = gates.some((g) => g.spec.takenBy.includes(key)) || Object.values(c.record.entities ?? {}).some((e) => e.create?.includes(key));
    const part = !!role.writes?.length;
    if (!takes && !part) c.problems.push(`role ${key} takes no step and writes nothing: give it a gate ("takenBy") or "writes" (a role that does part of the work), or take it out`);
    if (role.seesOnlyNamed && !gates.some((g) => g.named && g.spec.takenBy[0] === key)) c.problems.push(`role ${key}: "seesOnlyNamed" needs a gate it takes with a named person`);
    if (role.seesOnlyNamed && part) c.problems.push(`role ${key}: a role that does part of the work is limited with "limitedTo", not "seesOnlyNamed"`);
    for (const t of role.writes ?? []) if (!c.byTable.has(t)) c.problems.push(`role ${key}: "writes" names ${t}, which is not an entity of this module`);
    for (const [t, f] of Object.entries(role.limitedTo ?? {})) {
      if (!c.byTable.has(t)) c.problems.push(`role ${key}: "limitedTo" names ${t}, which is not an entity of this module`);
      if (!/_user_id$/.test(f)) c.problems.push(`role ${key}: "limitedTo" names ${t}.${f}; the field that names the person is <part>_user_id, such as requested_by_user_id or interviewer_user_id`);
      const live = fieldOf(c, t, f);
      if (live && !(live.format === "reference" && live.reference_table === "users")) c.problems.push(`role ${key}: ${t}.${f} is not a reference to users`);
      // The entity a role is limited to is that role's own list across the records above it, which a parent child cannot have.
      for (const p of (c.fieldsOf.get(t) ?? []).filter((x) => x.format === "parent")) {
        c.problems.push(`role ${key}: "limitedTo" gives the ${role.title.toLowerCase()} a list of their own ${pluralOf(c, t)} across ${pluralOf(c, String(p.reference_table))}, and a parent child has no list or menu entry of its own. Make ${t}.${p.field_name} a reference (data-modeling.md, "Choosing the Right Format", question 3)`);
      }
    }
    if ((role.limitedTo || role.hidden || role.leaves) && !part) c.problems.push(`role ${key}: "limitedTo", "hidden" and "leaves" belong to a role that does part of the work, which "writes" entities`);
    if (part && !Array.isArray(role.hidden)) c.problems.push(`role ${key}: say which entities the ${role.title.toLowerCase()} sees in the leading products besides what it writes ("sees": ["<table>", …]); every other entity of the module is hidden from them`);
    if (part && (!role.leaves || typeof role.leaves !== "object" || Array.isArray(role.leaves))) c.problems.push(`role ${key}: say which fields the ${role.title.toLowerCase()} fills in on each entity it writes ("fills": { "<table>": ["<field>", …] }); every other field stays with the people doing the everyday work`);
    for (const t of role.sees ?? []) if (!c.byTable.has(t)) c.problems.push(`role ${key}: "sees" names ${t}, which is not an entity of this module`);
    for (const [t, fs] of Object.entries(role.fills ?? {})) {
      if (!(role.writes ?? []).includes(t)) c.problems.push(`role ${key}: "fills" names ${t}, which the role does not write`);
      for (const f of fs) if (!fieldOf(c, t, f)) c.problems.push(`role ${key}: "fills" names ${t}.${f}, which is not a field`);
    }    for (const t of role.hidden ?? []) if (!c.byTable.has(t)) c.problems.push(`role ${key}: "hidden" names ${t}, which is not an entity of this module`);
    for (const [t, fs] of Object.entries(role.leaves ?? {})) {
      if (!(role.writes ?? []).includes(t)) c.problems.push(`role ${key}: "leaves" names ${t}, which the role does not write`);
      for (const f of fs) if (!fieldOf(c, t, f)) c.problems.push(`role ${key}: "leaves" names ${t}.${f}, which is not a field`);
    }
  }
  return gates;
}

/**
 * Every user field of the module that names a person is accounted for: a gate's named person, a role's `limitedTo`
 * field, the stamps the gates write, or a `userFields` entry saying whom it names. A field that names a role's
 * person is used by that role; one given to the everyday person under another person's name says `because`.
 */
function userFieldProblems(c: Ctx, raw: AccessRecord, gates: Gate[]): string[] {
  const out: string[] = [];
  const everyday = raw.everyday ?? "manager";
  const roles = raw.roles ?? {};
  const used = new Set([
    ...gates.filter((g) => g.named).map((g) => `${g.named!.table}.${g.named!.field}`),
    ...Object.values(roles).flatMap((r) => Object.entries(r.limitedTo ?? {}).map(([t, f]) => `${t}.${f}`)),
  ]);
  const stamps = new Set([REQ, ...gates.map((g) => `${g.state}_by_user_id`)]);
  for (const [table, fs] of c.fieldsOf) {
    if (!c.byTable.has(table)) continue;
    for (const f of fs) {
      if (f.reference_table !== "users" || !isRelationship(f)) continue;
      const id = `${table}.${f.field_name}`;
      if (used.has(id) || stamps.has(f.field_name)) continue;
      const entry = raw.userFields?.[id];
      if (entry === undefined) {
        out.push(`${id} names a person. Say whom in "userFields": { "${id}": "<person>" }, the everyday person ("${everyday}") or a key of "roles"; a role's person is used in that role's "limitedTo" or as a gate's "namedPerson"`);
        continue;
      }
      const by = typeof entry === "string" ? entry : entry?.by;
      const because = typeof entry === "object" && typeof entry?.because === "string" ? entry.because.trim() : "";
      const stem = f.field_name.replace(/_user_id$|_id$/, "");
      const personNamed = stem !== everyday && !GENERIC_PERSON.test(stem);
      if (roles[by] && personNamed && by !== stem) {
        out.push(`${id} is named for a kind of person, "${stem.replace(/_/g, " ")}", so it names that person, not the ${roles[by].title.toLowerCase()}. Give it to the role "${stem}" (add it to "roles" when it is missing: a person who takes some steps, or one who does only part of the work)`);
      } else if (roles[by]) {
        // A role that does part of the work is limited by the field that names its holders; a role that takes steps may simply be named.
        if (roles[by].writes?.length) out.push(`${id} names the ${roles[by].title.toLowerCase()}, who does part of the work: use it in role ${by}'s "limitedTo", so they see and write the records that name them`);
      } else if (by !== everyday && by !== "manager") out.push(`"userFields" gives ${id} to "${by}", which is neither the everyday person ("${everyday}") nor a key of "roles"`);
      else if (personNamed) {
        out.push(`${id} is named for a kind of person, "${stem.replace(/_/g, " ")}", so it names that person, not whoever fills it in. Add the role "${stem}" (a person who takes some steps, or one who does only part of the work, rbac.md "Roles that do part of the work") and give the field to it; it is the everyday person ("${everyday}") only when that is the person's name in the record`);
      } else if (stem !== everyday && because.length < 12) {
        out.push(`${id} names "${stem.replace(/_/g, " ")}": say whom, { "by": "${everyday}", "because": "<why it is the person doing the everyday work>" }, or give it to a role`);
      }
    }
  }
  return out;
}

/**
 * The module's access as the record says it should be, against the module's entities and fields (live, or a new
 * model). `problems` lists what is wrong with the record; when there is any, nothing else is filled in.
 */
export function planAccess(input: { slug: string; moduleName: string; record: unknown; entities: ReadonlyArray<EntityRow>; fields: ReadonlyArray<FieldRow>; otherRollups?: ReadonlyArray<{ id: string; table_name: string; rollup: any }> }): AccessPlan {
  const plan: AccessPlan = { problems: [], warnings: [], notes: [], permissions: [], hierarchy: [], roles: [], gated: false, fields: [], rollups: [], entities: new Map(), accessSummary: "", takers: [] };
  plan.problems.push(...shapeProblems(input.record));
  if (plan.problems.length) return plan;
  const raw = input.record as AccessRecord;
  const byTable = new Map(input.entities.map((e) => [e.table_name, e]));
  const fieldsOf = new Map<string, FieldRow[]>();
  for (const f of input.fields) {
    if (!fieldsOf.has(f.table_name)) fieldsOf.set(f.table_name, []);
    fieldsOf.get(f.table_name)!.push(f);
  }
  for (const fs of fieldsOf.values()) fs.sort((x, y) => (x.field_order ?? 0) - (y.field_order ?? 0));
  plan.problems.push(...lifecycleNameProblems(input.fields.filter((f) => byTable.has(f.table_name))), ...labelColumnProblems(input.entities));
  const record = normalizeRoles(normalizeRecord(raw, fieldsOf, plan.problems), byTable, fieldsOf);
  const c: Ctx = { slug: input.slug, moduleName: input.moduleName, record, byTable, fieldsOf, problems: plan.problems };
  plan.problems.push(...coverageProblems(record, lifecyclesOf(input.fields).filter((l) => byTable.has(l.table))));
  const gates = resolveGates(c);
  plan.problems.push(...userFieldProblems(c, raw, gates));
  if (plan.problems.length) return plan;

  const { slug } = c;
  const P = (level: string) => `${slug}:${level}`;
  const admin = P("admin"), manage = P("manage"), read = P("read");
  const roles = record.roles ?? {};
  const bundle = (key: string) => P(key);
  const partRoles = Object.entries(roles).filter(([, r]) => r.writes?.length);
  const createGate = (table: string) => `${slug}:create_${snake(byTable.get(table)?.singular_label ?? table)}`;

  // ---------- fields the gates and roles need ----------
  const addField = (f: FieldRow) => {
    if (fieldOf(c, f.table_name, f.field_name) || plan.fields.some((x) => x.table_name === f.table_name && x.field_name === f.field_name)) return;
    const own = fieldsOf.get(f.table_name) ?? [];
    const orders = [...own, ...plan.fields.filter((x) => x.table_name === f.table_name)].map((x) => x.field_order ?? 0).filter((n) => n < 900000);
    plan.fields.push({ ...f, field_order: Math.max(0, ...orders) + 10 });
  };
  const userField = (table: string, field: string, title: string, label: string, input_type?: string) =>
    addField({ table_name: table, field_name: field, title, format: "reference", reference_table: "users", reference_delete_mode: "clear", ...(input_type ? { input_type } : {}), relationship_label: label });
  const stampsOf = new Map<string, any[]>();
  const stamp = (table: string, entry: any) => {
    if (!stampsOf.has(table)) stampsOf.set(table, []);
    if (!stampsOf.get(table)!.some((x) => x.name === entry.name)) stampsOf.get(table)!.push(entry);
  };
  const requesterStamp = (table: string) => {
    userField(table, REQ, "Requested By", "requests", "readonly");
    stamp(table, { name: REQ, jsonlogic: IF(MODE("insert"), USER, V(`$old.${REQ}`)) });
  };
  for (const g of gates) {
    if (g.kind !== "transition") requesterStamp(g.table);
    if (g.named) userField(g.named.table, g.named.field, roleTitle(c, g.spec.takenBy[0]), `is the ${roleTitle(c, g.spec.takenBy[0]).toLowerCase()} of`);
    if (g.kind === "approval") {
      const label = stateLabel(c, g.table, g.state);
      const second = [g.state, ...g.spec.after];
      const keep = (f: string) => AND(MODE("insert"), IN(V(WS), second), NE(V(f), null));
      const entered = AND(CHANGED(WS), EQ(V(WS), g.state), NOT(IN(OLD_WS, second)));
      const by = `${g.state}_by_user_id`, at = `${g.state}_at`;
      userField(g.table, by, `${cap(label)} By`, third(g.spec.verb), "readonly");
      addField({ table_name: g.table, field_name: at, title: `${cap(label)} At`, format: "date-time", input_type: "readonly" });
      stamp(g.table, { name: by, jsonlogic: IF(keep(by), V(by), IF(entered, USER, V(`$old.${by}`))) });
      stamp(g.table, { name: at, jsonlogic: IF(keep(at), V(at), IF(entered, V("$now"), V(`$old.${at}`))) });
    }
  }
  for (const [key, role] of partRoles) {
    for (const [t, f] of Object.entries(role.limitedTo ?? {})) {
      if (f === REQ) requesterStamp(t);
      else userField(t, f, role.title, `is the ${role.title.toLowerCase()} of`);
    }
    void key;
  }
  const allFields = (table: string) => [...(fieldsOf.get(table) ?? []), ...plan.fields.filter((f) => f.table_name === table)];

  // ---------- the gate's check (rbac.md, "Controls on a gate") ----------
  /** Reads the named person's parent chain from `from` (a binding) or from the record, then `body`; a parent that reads as null admits only an admin. */
  const viaNamed = (g: Gate, from: string, body: L): L => {
    if (!g.named?.chain.length) return body;
    let inner = body;
    const binds = g.named.chain.map((s) => bindingOf(s.fk));
    for (let i = g.named.chain.length - 1; i >= 0; i--) {
      const id = i === 0 ? V(from ? `${from}.${g.named.chain[0].fk}` : g.named.chain[0].fk) : V(`${binds[i - 1]}.${g.named.chain[i].fk}`);
      inner = SETREC(binds[i], g.named.chain[i].table, id, IF(EQ(V(binds[i]), null), HAS(admin), inner));
    }
    return inner;
  };
  const namedPath = (g: Gate, from: string) => (g.named!.chain.length ? `${bindingOf(g.named!.chain[g.named!.chain.length - 1].fk)}.${g.named!.field}` : from ? `${from}.${g.named!.field}` : `$old.${g.named!.field}`);
  const namedOr = (g: Gate, from: string) => OR(EQ(V(namedPath(g, from)), null), EQ(USER, V(namedPath(g, from))));
  const who = (g: Gate, from = ""): L => (g.named ? viaNamed(g, from, OR(HAS(admin), AND(HAS(g.perm), namedOr(g, from)))) : HAS(g.perm));
  const notRequester: L = IF(MODE("insert"), HAS(admin), NE(V(`$old.${REQ}`), USER));
  const checkParts = (g: Gate): L[] => (g.kind === "transition" ? [who(g)] : [who(g), notRequester]);
  const check = (g: Gate): L => (g.kind === "transition" ? who(g) : AND(...checkParts(g)));
  const lockCheck = (g: Gate, from = ""): L => {
    const req = from ? `${from}.${REQ}` : `$old.${REQ}`;
    const inner = AND(HAS(g.perm), ...(g.named ? [namedOr(g, from)] : []), NE(V(req), USER));
    return OR(HAS(admin), g.named?.chain.length ? viaNamed(g, from, inner) : inner);
  };
  const whoPhrase = (g: Gate) => {
    const takers = takerPhrase(c, g.spec.takenBy);
    if (!g.named) return takers;
    const title = roleTitle(c, g.spec.takenBy[0]).toLowerCase();
    const holder = g.named.chain.length ? `the ${singularOf(c, g.named.table)}'s ${title}` : `the named ${title}`;
    return `${holder}, or ${takers} when none is named,`;
  };

  // ---------- validation rules, per entity, in rbac.md's order ----------
  const generated = new Map<string, Array<{ name: string; message: string; jsonlogic: L }>>();
  const add = (table: string, name: string, message: string, jsonlogic: L) => {
    if (!generated.has(table)) generated.set(table, []);
    generated.get(table)!.push({ name, message, jsonlogic });
  };
  const gatesOn = (table: string) => gates.filter((g) => g.table === table);
  const tables = input.entities.map((e) => e.table_name);
  for (const table of tables) {
    const sing = singularOf(c, table);
    const singSnake = snake(byTable.get(table)?.singular_label ?? table);
    const values = enumValues(fieldOf(c, table, WS));
    for (const g of gatesOn(table)) {
      const who_ = whoPhrase(g);
      const verb = words(g.spec.verb);
      if (g.kind === "approval") {
        const w = g.spec.waiting!;
        add(table, `${g.spec.verb}_${singSnake}`,
          `Only ${who_} can ${verb} ${a(`${stateLabel(c, table, w)} ${sing}`)}, and never the person who requested it.`,
          IF(changedTo(g.state), AND(OR(MODE("insert"), IN(OLD_WS, [w, ...g.spec.after])), ...checkParts(g)), true));
        if (values.includes("rejected")) {
          add(table, `reject_${singSnake}`,
            `Only ${who_} can reject ${a(`${stateLabel(c, table, w)} ${sing}`)}, and never the person who requested it.`,
            IF(AND(CHANGED(WS), EQ(V(WS), "rejected"), EQ(OLD_WS, w)), check(g), true));
        }
        const prepared = values[values.indexOf(w) - 1];
        const from = values.includes("rejected") ? [w, "rejected"] : [w];
        add(table, `recall_${singSnake}`,
          `Only the person who requested it, or an admin, can move ${a(`${listOf(from.map((s) => stateLabel(c, table, s)))} ${sing}`)} back to ${stateLabel(c, table, prepared)}.`,
          IF(AND(CHANGED(WS), IN(OLD_WS, from), EQ(V(WS), prepared)), OR(HAS(admin), AND(NE(V(`$old.${REQ}`), null), EQ(V(`$old.${REQ}`), USER))), true));
      } else {
        add(table, `${g.spec.verb}_${singSnake}`,
          `Only ${who_} can ${verb} ${a(sing)}${g.kind === "payout" ? ", and never the person who requested it" : ""}.`,
          IF(changedTo(g.state), check(g), true));
      }
    }
    const creators = record.entities?.[table]?.create;
    if (creators?.length) add(table, `create_${singSnake}`, `Only ${takerPhrase(c, creators)} can create ${a(sing)}.`, IF(MODE("insert"), HAS(createGate(table)), true));
    for (const g of gatesOn(table)) {
      if (!g.spec.after.length) continue;
      add(table, `${g.spec.verb}_${singSnake}_first`,
        `${cap(a(sing))} must be ${stateLabel(c, table, g.state)} before it is ${listOf(g.spec.after.map((s) => stateLabel(c, table, s)))}.`,
        IF(AND(CHANGED(WS), isOneOf(V(WS), g.spec.after)), OR(IN(OLD_WS, [g.state, ...g.spec.after]), check(g)), true));
    }
    for (const g of gatesOn(table).filter((x) => x.kind === "approval")) {
      const second = [g.state, ...g.spec.after];
      add(table, `${g.state}_stays_${g.state}`,
        `Only ${whoPhrase(g)} can move ${a(`${listOf(second.map((s) => stateLabel(c, table, s)))} ${sing}`)} back, and never the person who requested it.`,
        IF(AND(CHANGED(WS), IN(OLD_WS, second), NOT(IN(V(WS), second))), check(g), true));
    }
    for (const g of gatesOn(table).filter((x) => x.kind === "approval")) {
      const lock = [g.spec.waiting!, g.state, ...g.spec.after];
      const computedNames = new Set([...(byTable.get(table)?.computed_fields ?? []).map((x: any) => String(x?.name ?? "").split(".")[0]), ...(stampsOf.get(table) ?? []).map((x) => x.name)]);
      const locked = allFields(table).filter((f) => !["id", "created_at", "updated_at", WS].includes(f.field_name) && f.ctype !== "rollup" && !f.rollup?.link_field
        && !computedNames.has(f.field_name) && !(g.spec.filledLater ?? []).includes(f.field_name) && f.ctype !== "audit" && f.ctype !== "id");
      add(table, `lock_${g.spec.waiting}_${singSnake}`,
        `Only an admin, or someone who may ${words(g.spec.verb)} it, can change or delete ${a(`${listOf(lock.map((s) => stateLabel(c, table, s)))} ${sing}`)}; its requester can move ${a(stateLabel(c, table, g.spec.waiting!))} one back to ${stateLabel(c, table, values[values.indexOf(g.spec.waiting!) - 1])} to change it.`,
        IF(AND(IN(OLD_WS, lock), OR(MODE("delete"), ...locked.map((f) => CHANGED(f.field_name)))), lockCheck(g), true));
    }
    // Line locks: this table is a child an approval gate covers.
    for (const g of gates.filter((x) => (x.spec.covers ?? []).includes(table))) {
      const fk = allFields(table).find((f) => isRelationship(f) && f.reference_table === g.table)!.field_name;
      const b = bindingOf(fk), ob = `old_${b}`;
      const lock = [g.spec.waiting!, g.state, ...g.spec.after];
      const computedNames = new Set((byTable.get(table)?.computed_fields ?? []).map((x: any) => String(x?.name ?? "").split(".")[0]));
      const others = allFields(table).filter((f) => f.field_name !== fk && !["id", "created_at", "updated_at"].includes(f.field_name) && f.ctype !== "rollup" && !f.rollup?.link_field && !computedNames.has(f.field_name) && f.ctype !== "audit" && f.ctype !== "id");
      const parentSing = singularOf(c, g.table);
      add(table, `lock_${table}_of_${g.spec.waiting}_${snake(byTable.get(g.table)?.singular_label ?? g.table)}`,
        `Only an admin, or someone who may ${words(g.spec.verb)} the ${parentSing}, can change the ${pluralOf(c, table)} of ${a(`${listOf(lock.map((s) => stateLabel(c, g.table, s)))} ${parentSing}`)}.`,
        AND(
          IF(OR(MODE("insert"), MODE("delete"), CHANGED(fk), ...others.map((f) => CHANGED(f.field_name))),
            SETREC(b, g.table, V(fk), IF(EQ(V(b), null), OR(MODE("delete"), HAS(admin)), IF(IN(V(`${b}.${WS}`), lock), lockCheck(g, b), true))),
            true),
          IF(AND(MODE("update"), CHANGED(fk)),
            SETREC(ob, g.table, V(`$old.${fk}`), IF(EQ(V(ob), null), HAS(admin), IF(IN(V(`${ob}.${WS}`), lock), lockCheck(g, ob), true))),
            true)));
    }
    // A role that does part of the work: its writes stay within the records that name its holders, and it leaves some fields alone.
    for (const [key, role] of partRoles) {
      if (!(role.writes ?? []).includes(table)) continue;
      const path = namingPath(c, role, table);
      if (!path) { plan.warnings.push(`role ${key} writes ${table}, but neither ${table} nor a table above it names the role's holders in "limitedTo": its holders could write every ${table} record`); continue; }
      const title = role.title.toLowerCase();
      if (!path.length) {
        const f = role.limitedTo![table];
        add(table, `${key}_own_${table}`, `${cap(a(title))} can only write their own ${pluralOf(c, table)}.`, IF(HAS(manage), true, AND(NE(V(f), null), EQ(V(f), USER))));
      } else {
        const top = path[path.length - 1];
        const f = role.limitedTo![top.table];
        const last = bindingOf(top.fk);
        let body: L = AND(NE(V(last), null), NE(V(`${last}.${f}`), null), EQ(V(`${last}.${f}`), USER));
        for (let i = path.length - 1; i >= 0; i--) {
          const bind = bindingOf(path[i].fk);
          const id = i === 0 ? V(path[0].fk) : V(`${bindingOf(path[i - 1].fk)}.${path[i].fk}`);
          body = SETREC(bind, path[i].table, id, i === path.length - 1 ? body : AND(NE(V(bind), null), body));
        }
        add(table, `${key}_own_${table}`, `${cap(a(title))} can only write the ${pluralOf(c, table)} of their own ${pluralOf(c, top.table)}.`, IF(HAS(manage), true, body));
      }
    }
    for (const [key, role] of partRoles) {
      const leaves = role.leaves?.[table];
      if (!leaves?.length) continue;
      const fs = leaves.map((n) => fieldOf(c, table, n)!);
      const empty = (f: FieldRow): L => {
        if (f.default_value !== undefined && f.default_value !== null && f.default_value !== "") return String(f.default_value).replace(/^['"]|['"]$/g, "");
        if (["date", "date-time", "reference", "parent"].includes(f.format ?? "")) return null;
        if (["number", "float", "double", "integer", "int32", "int64", "rating"].includes(f.format ?? "")) return 0;
        if (f.format === "boolean") return false;
        return "";
      };
      const one = (parts: L[], op: (...p: L[]) => L) => (parts.length === 1 ? parts[0] : op(...parts));
      add(table, `${key}_leaves_${snake(byTable.get(table)?.singular_label ?? table)}_fields`,
        `Only a Manager can set ${a(sing)}'s ${listOf(fs.map((f) => (f.title ?? f.field_name).toLowerCase()))}.`,
        IF(HAS(manage), true, IF(MODE("insert"), one(fs.map((f) => EQ(V(f.field_name), empty(f))), AND), NOT(one(fs.map((f) => CHANGED(f.field_name)), OR)))));
    }
  }

  // ---------- codes: an existing rule keeps its code, a new one continues after the module's highest ----------
  const codeOf = (r: any) => (/^99\d{3}$/.test(String(r?.code)) ? Number(r.code) : 0);
  let next = Math.max(99000, ...input.entities.flatMap((e) => (e.validation_rules ?? []).map(codeOf)));
  for (const table of tables) {
    const e = byTable.get(table)!;
    const mine = generated.get(table) ?? [];
    const existing = Array.isArray(e.validation_rules) ? e.validation_rules : [];
    const rules = existing.map((r: any) => {
      const g = mine.find((x) => x.name === r?.name);
      return g ? { code: String(r.code), name: g.name, message: g.message, jsonlogic: g.jsonlogic } : r;
    });
    for (const g of mine) {
      if (!existing.some((r: any) => r?.name === g.name)) rules.push({ code: String(++next), name: g.name, message: g.message, jsonlogic: g.jsonlogic });
    }
    const stamps = stampsOf.get(table) ?? [];
    const computedNow = Array.isArray(e.computed_fields) ? e.computed_fields : [];
    const computed = computedNow.map((x: any) => stamps.find((s) => s.name === x?.name) ?? x);
    for (const s of stamps) if (!computedNow.some((x: any) => x?.name === s.name)) computed.push(s);
    const update: { entity_type?: string; edit_permission?: string; validation_rules?: any[]; computed_fields?: any[] } = {};
    if (mine.length) update.validation_rules = rules;
    if (stamps.length) update.computed_fields = computed;
    const hasGate = gatesOn(table).length > 0 || !!record.entities?.[table]?.create?.length;
    if (hasGate) update.entity_type = "operational_workflow";
    else if (fieldOf(c, table, WS) && e.entity_type === "operational_workflow") update.entity_type = "operational_record";
    const writers = partRoles.filter(([, r]) => (r.writes ?? []).includes(table));
    if (writers.length) {
      if ([manage, P(`write_${table}`)].includes(e.edit_permission ?? manage)) update.edit_permission = P(`write_${table}`);
      else plan.warnings.push(`${table}: a role that does part of the work writes it, but its edit_permission is ${e.edit_permission}, not ${manage}; its write tier is not the manage tier, so it was left as it is`);
    }
    if (Object.keys(update).length) plan.entities.set(table, update);
  }

  // ---------- select rules and the rollups they affect ----------
  const ors = new Map<string, L[]>();
  const narrowed = new Map<string, string>(); // the table, and the role whose rule it already holds
  const pushOr = (table: string, clause: L) => {
    if (!ors.has(table)) ors.set(table, []);
    ors.get(table)!.push(clause);
  };
  const otherBundles = (except: string) => Object.entries(roles).filter(([k, r]) => k !== except && !r.seesOnlyNamed && !r.writes?.length).map(([k]) => HAS(bundle(k)));
  for (const [key, role] of Object.entries(roles)) {
    const holders: Array<{ table: string; field: string; open: string; extra: L[] }> = [];
    if (role.seesOnlyNamed) {
      for (const g of gates.filter((x) => x.named && x.spec.takenBy[0] === key)) {
        if (holders.some((h) => h.table === g.named!.table)) continue;
        const reqClause = allFields(g.named!.table).some((f) => f.field_name === REQ) ? [EQ(V(REQ), USER)] : [];
        holders.push({ table: g.named!.table, field: g.named!.field, open: admin, extra: reqClause });
      }
    }
    for (const [t, f] of Object.entries(role.limitedTo ?? {})) holders.push({ table: t, field: f, open: manage, extra: [] });
    const others = role.seesOnlyNamed ? otherBundles(key) : [];
    for (const h of holders) {
      for (const node of treeOf(c, h.table)) {
        if ((role.hidden ?? []).includes(node.table)) continue;
        if (narrowed.get(node.table) === key) continue;
        narrowed.set(node.table, key);
        const named: L = node.parent
          ? SETREC(bindingOf(node.fk!), node.parent, V(node.fk!), NE(V(bindingOf(node.fk!)), null))
          : AND(NE(V(h.field), null), EQ(V(h.field), USER));
        pushOr(node.table, OR(NOT(HAS(bundle(key))), HAS(h.open), ...others, named, ...(node.parent ? [] : h.extra)));
      }
    }
    for (const t of role.hidden ?? []) pushOr(t, OR(NOT(HAS(bundle(key))), HAS(manage)));
  }
  const rollupsHere = input.fields.filter((f) => typeof f.rollup?.link_field === "string").map((f) => ({ id: `${f.table_name}.${f.field_name}`, table_name: f.table_name, rollup: f.rollup }));
  const allRollups = [...rollupsHere, ...(input.otherRollups ?? []).filter((r) => !rollupsHere.some((x) => x.id === r.id))];
  for (const [table, list] of ors) {
    const e = byTable.get(table)!;
    const desired = AND(HAS(e.view_permission ?? read), ...list);
    // The platform refuses this select_rule while a rollup over the table lacks the flag (90269), so each gets it.
    for (const r of allRollups.filter((x) => String(x.rollup.link_field).split(".")[0] === table && x.rollup.include_hidden_rows !== true)) {
      plan.rollups.push({ id: r.id, rollup: { ...r.rollup, include_hidden_rows: true } });
    }
    const live = e.select_rule;
    const empty = !live || (typeof live === "object" && !Object.keys(live as object).length);
    if (!empty && !isGeneratedSelect(live, slug)) {
      if (!sameJson(live, desired)) plan.warnings.push(`${table}: it already has a select_rule that this record did not write; combine the two by hand (select-rule.md) and run this again. Its select_rule was not changed`);
      continue;
    }
    const update = plan.entities.get(table) ?? {};
    update.select_rule = desired;
    plan.entities.set(table, update);
  }

  // ---------- permissions, hierarchy, roles ----------
  const perm = (permission_name: string, description: string) => { if (!plan.permissions.some((p) => p.permission_name === permission_name)) plan.permissions.push({ permission_name, description }); };
  const rel = (x: string, y: string) => { if (!plan.hierarchy.some(([p, q]) => p === x && q === y)) plan.hierarchy.push([x, y]); };
  const stepsOf = (key: string) => [
    ...gates.filter((g) => g.spec.takenBy.includes(key)).map((g) => `${words(g.spec.verb)} ${pluralOf(c, g.table)}`),
    ...Object.entries(record.entities ?? {}).filter(([, e]) => e.create?.includes(key)).map(([t]) => `create ${pluralOf(c, t)}`),
  ];
  for (const g of gates) { perm(g.perm, `${cap(words(g.spec.verb))} ${pluralOf(c, g.table)}`); rel(admin, g.perm); }
  for (const [t, e] of Object.entries(record.entities ?? {})) if (e.create?.length) { perm(createGate(t), `Create ${pluralOf(c, t)}`); rel(admin, createGate(t)); }
  for (const [key, role] of Object.entries(roles)) {
    const steps = stepsOf(key);
    const gatesTaken = [...gates.filter((g) => g.spec.takenBy.includes(key)).map((g) => g.perm), ...Object.entries(record.entities ?? {}).filter(([, e]) => e.create?.includes(key)).map(([t]) => createGate(t))];
    let description: string;
    if (role.writes?.length) {
      description = `Write your own ${listOf((role.writes ?? []).map((t) => pluralOf(c, t)), "and")}${steps.length ? `, and ${listOf(steps, "and")}` : ""}`;
      perm(bundle(key), description);
      rel(bundle(key), read);
      for (const t of role.writes ?? []) { perm(P(`write_${t}`), `Write ${pluralOf(c, t)}`); rel(manage, P(`write_${t}`)); rel(P(`write_${t}`), read); rel(bundle(key), P(`write_${t}`)); }
    } else {
      description = `Manage ${c.moduleName} data and ${listOf(steps, "and")}`;
      perm(bundle(key), description);
      rel(bundle(key), manage);
    }
    for (const gp of gatesTaken) rel(bundle(key), gp);
    plan.roles.push({ key, slug: `${slug.replace(/-/g, "_")}_${key}`, role_name: `${c.moduleName} ${role.title}`, description: `Can ${description.charAt(0).toLowerCase()}${description.slice(1)}`, bundle: bundle(key) });
  }
  plan.gated = gates.length > 0 || Object.values(record.entities ?? {}).some((e) => e.create?.length);
  if (plan.rollups.length) plan.notes.push(`include_hidden_rows on ${plan.rollups.map((r) => r.id).join(", ")}: every reader of each one's entity sees its total, also over rows they cannot open`);

  // ---------- who takes each step, and the access summary ----------
  for (const [t, e] of Object.entries(record.entities ?? {})) {
    for (const s of enumValues(fieldOf(c, t, WS))) {
      const spec = e.states?.[s];
      plan.takers.push(`${t}.${s}: ${isGate(spec) ? spec.takenBy.join("+") : "manager"}`);
    }
  }
  plan.accessSummary = accessSummary(c, gates, plan);
  return plan;
}

/** The tables from `table` up to the one that names the role's holders (`limitedTo`), each with the field that points up; [] when `table` names them itself. */
function namingPath(c: Ctx, role: RoleSpec, table: string): Array<{ table: string; fk: string }> | null {
  if (role.limitedTo?.[table]) return [];
  const seen = new Set([table]);
  const walk = (t: string): Array<{ table: string; fk: string }> | null => {
    for (const f of c.fieldsOf.get(t) ?? []) {
      if (!(f.format === "parent" || (f.format === "reference" && f.input_type === "required")) || !f.reference_table || seen.has(f.reference_table) || !c.byTable.has(f.reference_table)) continue;
      seen.add(f.reference_table);
      if (role.limitedTo?.[f.reference_table]) return [{ table: f.reference_table, fk: f.field_name }];
      const up = walk(f.reference_table);
      if (up) return [{ table: f.reference_table, fk: f.field_name }, ...up];
    }
    return null;
  };
  return walk(table);
}

/** A select_rule of the shape this file writes: `and` of the view permission and `or`s that start by testing a bundle. */
function isGeneratedSelect(rule: unknown, slug: string): boolean {
  const and = (rule as any)?.and;
  if (!Array.isArray(and) || and.length < 2 || !(and[0] as any)?.has_permission) return false;
  return and.slice(1).every((part: any) => {
    const first = Array.isArray(part?.or) ? part.or[0] : null;
    const name = first?.["!"]?.[0]?.has_permission;
    return typeof name === "string" && name.startsWith(`${slug}:`);
  });
}

/** Deep equality that ignores the order of object keys (the platform stores JSON with its own key order). */
export function sameJson(x: unknown, y: unknown): boolean {
  if (x === y) return true;
  if (Array.isArray(x) || Array.isArray(y)) return Array.isArray(x) && Array.isArray(y) && x.length === y.length && x.every((v, i) => sameJson(v, y[i]));
  if (!x || !y || typeof x !== "object" || typeof y !== "object") return false;
  const kx = Object.keys(x as object).filter((k) => (x as any)[k] !== undefined), ky = Object.keys(y as object).filter((k) => (y as any)[k] !== undefined);
  return kx.length === ky.length && kx.every((k) => sameJson((x as any)[k], (y as any)[k]));
}

/**
 * The module's access in plain words, as markdown (`rbac.md` → "The access summary"): the access level, a table of
 * what each role does and sees, the entities only an admin changes, the restricted steps, and each lifecycle with none.
 */
function accessSummary(c: Ctx, gates: Gate[], plan: AccessPlan): string {
  const plural = (t: string) => c.byTable.get(t)?.plural_label ?? t;
  const low = (t: string) => plural(t).toLowerCase();
  const title = (k: string) => cap(roleTitle(c, k));
  const out: string[] = [];
  out.push(`**Access: ${plan.gated ? "gated" : "advanced"}.** ${plan.gated ? "Some steps are restricted to a role." : "No step is restricted to a role."} Role names start with "${c.moduleName}".`);
  out.push("", "| Role | Does | Sees |", "|---|---|---|");
  out.push("| Viewer | reads only | everything |", "| Manager | the everyday work | everything |");
  out.push(`| Admin | the everyday work${plan.gated ? " and every restricted step" : ""} | everything |`);
  for (const [key, role] of Object.entries(c.record.roles ?? {})) {
    const steps = [
      ...gates.filter((g) => g.spec.takenBy.includes(key)).map((g) => `marks ${low(g.table)} ${cap(stateLabel(c, g.table, g.state))}`),
      ...Object.entries(c.record.entities).filter(([, e]) => e.create?.includes(key)).map(([t]) => `creates ${low(t)}`),
    ];
    const does = [role.writes?.length ? `writes ${listOf(role.writes.map(low), "and")} only` : "the everyday work", ...steps].join("; ");
    // The entities that name the role's holders, and those below them, are narrowed to their own; the rest stay visible.
    const hidden = role.hidden ?? [];
    const roots = role.writes?.length
      ? Object.keys(role.limitedTo ?? {})
      : role.seesOnlyNamed ? [...new Set(gates.filter((g) => g.named && g.spec.takenBy[0] === key).map((g) => g.named!.table))] : [];
    const below = [...new Set(roots.flatMap((r) => treeOf(c, r).slice(1).map((n) => n.table)))].filter((t) => !roots.includes(t) && !hidden.includes(t));
    const rest = [...c.byTable.keys()].filter((t) => !roots.includes(t) && !below.includes(t) && !hidden.includes(t));
    const sees: string[] = [];
    if (roots.length) sees.push(`only the ${listOf(roots.map(low), "and")} that name them${below.length ? `, with their ${listOf(below.map(low), "and")}` : ""}`);
    if (hidden.length) sees.push(`not ${listOf(hidden.map(low), "or")}`);
    if (rest.length) sees.push(roots.length || hidden.length ? "all other records" : "everything");
    out.push(`| ${cap(role.title)} | ${does} | ${sees.join("; ")} |`);
  }
  const adminOnly = [...c.byTable.values()].filter((e) => e.edit_permission === `${c.slug}:admin`).map((e) => e.plural_label ?? e.table_name);
  if (adminOnly.length) out.push("", `Only an admin can change ${listOf(adminOnly, "and")}.`);
  const restricted: string[] = [];
  for (const g of gates) {
    const named = g.named
      ? ` When the ${(c.byTable.get(g.named.table)?.singular_label ?? g.named.table).toLowerCase()} names ${a(roleTitle(c, g.spec.takenBy[0]).toLowerCase())}, only that person or an admin.`
      : "";
    const waiting = g.spec.waiting ? stateLabel(c, g.table, g.spec.waiting) : "";
    const controls = g.kind === "approval"
      ? ` The requester may not approve it; only ${a(waiting)} one is approved; what it covers is locked from ${waiting} on; only the requester recalls it; only the approver rejects it or moves it back; who approved it and when is recorded.`
      : g.kind === "payout" ? " The requester may not take it." : "";
    restricted.push(`- ${plural(g.table)} → ${cap(stateLabel(c, g.table, g.state))}: ${listOf(g.spec.takenBy.map(title), "or")}.${named}${controls}`);
  }
  for (const [t, e] of Object.entries(c.record.entities)) if (e.create?.length) restricted.push(`- ${plural(t)}: created only by ${listOf(e.create.map(title), "or")}.`);
  if (restricted.length) out.push("", "**Restricted steps**", ...restricted);
  const open = Object.keys(c.record.entities).filter((t) => fieldOf(c, t, WS) && !gates.some((g) => g.table === t));
  if (open.length) out.push("", `**No restricted step** on ${listOf(open.map(plural), "or")}: anyone who can edit one can move it through every state.`);
  return out.join("\n");
}
