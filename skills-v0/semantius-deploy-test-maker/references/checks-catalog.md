# Checks Catalog

This is the canonical specification for the assertions the generated `<slug>-deploy-test.ts` script must implement. Read this end-to-end before writing the script; treat each row as a check the script registers.

Each row gives:

- **Group**: where the check belongs in the report.
- **Natural key**: how the live row is looked up (so the failure message can quote it).
- **`semantius` call shape**: the exact CLI invocation the script wraps.
- **Compared properties**: the property pairs to assert (model side ↔ live side).
- **Failure type**: how to phrase the failure line (see SKILL.md "Failure-message format").

The script's `runSemantius` helper wraps all CLI calls and enforces the exit-code contract from `use-semantius`. Reads that must yield exactly one row pass `--single`; multi-row reads do not.

### PostgREST filter syntax (load-bearing)

Single-column filters use the bare form: `module_id=eq.<id>`.

**Multi-column AND filters MUST use the PostgREST `and=()` grouping form**, not comma-joined `key=eq.X,key2=eq.Y`. The latter is parsed as a single filter whose value contains commas and produces `(22P02) invalid input syntax for type integer`. Correct form:

```
and=(including_permission_id.eq.<id>,included_permission_id.eq.<id>)
```

Note the operator separator inside `and=()` is `.` (PostgREST RPC form), not `=`.

### Platform sentinel values (treat as "model-silent")

Several live columns carry platform-chosen defaults whenever the model declares nothing. The script must **not** fail when the model is silent about that column and the live row carries the platform default. Enumerated here for the generator's reference:

| Live column | Platform default | Meaning |
|---|---|---|
| `entities.cube_mode` | `"auto"` | "no cube semantics chosen" |
| `entities.edit_mode` | `"auto"` | "default edit affordances" |
| `fields.description` | `""` | model declared no description |
| `fields.default_value` | `""` | model declared no default |
| `fields.relationship_label` | `"has"` | model declared no relationship label (non-FK fields carry this anyway) |
| `fields.reference_table` | `""` | non-FK field |
| `fields.reference_delete_mode` | `"restrict"` | non-FK field (the column is non-null) |
| `fields.singular_label_parent` | `""` | non-parent-FK field |
| `fields.plural_label_parent` | `""` | non-parent-FK field |
| `fields.cube_type` | `"auto"` | model declared no cube_type |
| `fields.input_type_rule` | `{}` | model declared no rule |
| `entities.computed_fields` | `[]` | model declared none |
| `entities.validation_rules` | `[]` | model declared none |
| `entities.select_rule` | `{}` | model declared none |

The rule is symmetric: when the model declares a value, assert byte-equality; when the model is silent, skip the comparison even if live carries one of these defaults.

### Built-in entities (platform-owned; relaxed field-existence + rule-name check)

Semantius ships with a small set of built-in entities (currently `users`; potentially `roles`, `permissions`, and similar in future builds). The deployer's analyst-skill convention (implementation note 6 in every model that touches `users`) is to skip the create and reuse the built-in, optionally adding fields like `is_agent` and `primary_team_id` additively.

Because these entities are **platform-owned** (the deployer reuses the live row as-is and does not write its entity metadata), the verifier intentionally narrows its check surface for entities in `BUILT_IN_TABLES = ["users"]`:

1. **Lookup**: look up the built-in by `table_name` **unscoped by `module_id`** (the built-in's `module_id` is the platform's identity module, not the current model's module). Without this the entity would be reported as missing.
2. **Field existence only**: for each field declared in the model, assert one live `fields` row exists with the same `field_name`. **Skip** every per-field property comparison (`format`, `title`, `description`, `unique_value`, `enum_values`, `default_value`, `relationship_label`, `reference_table`, `reference_delete_mode`, `input_type_rule`, and any other field-level property).
3. **Rule-name presence**: when the model declares `computed_fields` or `validation_rules` with non-empty arrays, assert each entry's identifier (`name` for `computed_fields`, `code` for `validation_rules`) is present in the live entity's corresponding JSON array. Live may carry extra entries (additive). JsonLogic content and the entry's other metadata are **not** compared. `select_rule` has no identifier and is skipped.
4. **Skip every other entity-level property**: no checks on `module_id`, `singular_label`, `plural_label`, `description`, `label_column`, `audit_log`, `view_permission`, `edit_permission`, `edit_mode`, `cube_mode`, `select_rule`.

This is a deliberate departure from the verifier's general "over-check, never under-check" rule. The justification is asymmetric ownership: the deployer never writes any of the built-in's entity-level metadata, so the model's declaration of those properties is documentation of the model's own assumption about the platform, not a deploy assertion. Reporting them as drift would produce permanent false positives on every run. The deployer is responsible for the *fields* the model writes (which is why field existence is still asserted) and for registering the *workflow rules* the model relies on (which is why rule-name presence is still asserted); the rest is platform-owned and out of scope.

This rule applies to every entity in `BUILT_IN_TABLES = ["users"]`. When a future major bump adds more, extend the constant.

---

## 1. Module

### 1.1 Module row exists with the right shape

| Field | Detail |
|---|---|
| Group | `module` |
| Natural key | `module_slug = <system_slug>` |
| Call | `semantius call crud read_module --single '{"filters":"module_slug=eq.<slug>"}'` |
| Compared | `module_name`, `module_type` (`domain` or `master`), `description` |
| Failure | `expected: "<value>"  actual: "<value>"  why: module property differs` |

Missing module ⇒ single high-severity failure tagged `module not found in live state`; the rest of the checks short-circuit (no point continuing if the module is absent, every downstream lookup will fail).

### 1.2 Module FK / permission columns resolve correctly

The `modules` row's view-permission column is **asymmetric**: `view_permission` is a string column (carrying the permission name verbatim, e.g. `"itsm:read"`), while `manage_permission` and `admin_permission` are exposed as FK id columns (`manage_permission_id`, `admin_permission_id`). Resolve expected ids by natural key for the FK columns; for the string column compare names directly. When the model has no admin tier, the admin FK is accepted as null **or** as a non-null pointing at a real `<slug>:admin` permission (additive rule).

| Module column | Kind | Expected (admin tier present) | Expected (no admin tier) |
|---|---|---|---|
| `view_permission` | string | `<slug>:read` | `<slug>:read` |
| `manage_permission_id` | FK id | id of `<slug>:manage` | id of `<slug>:manage` |
| `admin_permission_id` | FK id | id of `<slug>:admin` | null OR id of `<slug>:admin` |
| `default_viewer_role_id` | FK id | id of role `<slug>_viewer` | id of role `<slug>_viewer` |
| `default_manager_role_id` | FK id | id of role `<slug>_manager` | id of role `<slug>_manager` |
| `default_admin_role_id` | FK id | id of role `<slug>_admin` | null OR id of role `<slug>_admin` |

A null where a value is expected ⇒ failure. A wrong id or string (resolves to the wrong natural key) ⇒ failure.

There is no `view_permission_id` column on the live `modules` table; do not query it. Earlier versions of this catalog listed one — that was incorrect.

---

## 2. Permissions

For every row in the §2 Permissions summary table, plus the implicit baseline (`<slug>:read`, `<slug>:manage`, and `<slug>:admin` when the table carries a `baseline-admin` row), assert one permission exists.

| Field | Detail |
|---|---|
| Group | `permission` |
| Natural key | `permission_name = <name>` |
| Call | `semantius call crud read_permission --single '{"filters":"permission_name=eq.<name>"}'` |
| Compared | `description` (model row's Description cell), `module_id` (must resolve to the module from Check 1.1) |
| Failure | `expected: "<value>"  actual: "<value>"  why: permission description differs` / `permission missing` |

The script must resolve the module id once (from 1.1) and reuse it; do not re-read the module for every permission check.

**Look up each permission individually by its unique `permission_name`, scoped globally (no `module_id` filter).** A permission row that exists with the right name but a null or mismatched `module_id` must be found by this lookup and reported as a `module_id` property difference, not as `permission missing`. Do **not** batch-read all permissions with `module_id=eq.<id>` and filter client-side; that pattern hides rows whose `module_id` is null and produces misleading "missing" failures for permissions that actually exist. Build the `permission_name → id` map from these per-permission `--single` reads.

---

## 3. Permission hierarchy

For every row in the §2 Permissions summary table whose `Hierarchy parent` is **not** `—`, plus the implicit baseline edges, assert one `permission_hierarchy` row exists.

**Implicit baseline edges:**

- `<slug>:manage → <slug>:read` (always, when both permissions exist)
- `<slug>:admin → <slug>:manage` (only when the model declares a `baseline-admin` row)

The edge convention is *including → included*, i.e. `including_permission` is the broader permission (`manage`) and `included_permission` is the narrower one (`read`) that the broader permission implicitly grants. Read as `including_permission` ── *includes* ──▶ `included_permission`.

| Field | Detail |
|---|---|
| Group | `permission_hierarchy` |
| Natural key | `<including_permission_name> → <included_permission_name>` |
| Call | `semantius call crud read_permission_hierarchy '{"filters":"and=(including_permission_id.eq.<id>,included_permission_id.eq.<id>)"}'` (array read; expect exactly one row) |
| Compared | row count == 1 |
| Failure | `expected: present  actual: missing  why: hierarchy edge declared in model is not in live state` |

Multiple matching rows ⇒ failure (`why: duplicate hierarchy edge`), even though the deployer would not write a duplicate. Defense-in-depth.

---

## 4. Roles (the three defaults)

Assert the three default roles exist for the module. The admin role is only required when the model carries an admin tier; the script must check the `baseline-admin` flag from parsing before asserting `<slug>_admin`.

| Default role (slug) | Required when |
|---|---|
| `<slug>_viewer` | always |
| `<slug>_manager` | always |
| `<slug>_admin` | only when the model has a `baseline-admin` permission row |

The live `roles` table's natural key is the **`slug`** column (snake_case machine name), not `name`/`role_name`. The display name (`role_name`, e.g. `"ITSM Viewer"`) is deployer-chosen and decorative; only the slug is the contract.

| Field | Detail |
|---|---|
| Group | `role` |
| Natural key | `slug = <role_slug>` |
| Call | `semantius call crud read_role --single '{"filters":"slug=eq.<role_slug>"}'` |
| Compared | `module_id` matches the module from 1.1 |
| Failure | `expected: present  actual: missing  why: default role missing` |

Roles' `role_name` and `description` are deployer-chosen defaults that the deployer may evolve; do **not** assert them. Only `slug`, `module_id`, and existence are load-bearing.

**Look up each role individually by its unique `slug`, scoped globally (no `module_id` filter).** A role row that exists with the right slug but a null or mismatched `module_id` must be found by this lookup and reported as a `module_id` property difference, not as `default role missing`. Do **not** batch-read all roles with `module_id=eq.<id>` and filter client-side. Build the `slug → id` map from these per-role `--single` reads.

---

## 5. Role-permission links

For each default role from check 4, assert the role carries its baseline permission via a `role_permissions` row.

| Role | Required permission |
|---|---|
| `<slug>_viewer` | `<slug>:read` |
| `<slug>_manager` | `<slug>:manage` |
| `<slug>_admin` (when present) | `<slug>:admin` |

| Field | Detail |
|---|---|
| Group | `role_permission` |
| Natural key | `<role_name> ⇒ <permission_name>` |
| Call | `semantius call crud read_role_permission '{"filters":"and=(role_id.eq.<id>,permission_id.eq.<id>)"}'` (array; expect ≥ 1) |
| Compared | row count ≥ 1 |
| Failure | `expected: present  actual: missing  why: default role is missing its baseline permission` |

Zero rows ⇒ failure. Extra rows are fine (additive rule).

---

## 6. Entities

For every entity in the model's §2 table, assert the live `entities` row exists in this module.

| Field | Detail |
|---|---|
| Group | `entity` |
| Natural key | `table_name = <table>` AND `module_id = <module_id from 1.1>` |
| Call | `semantius call crud read_entity --single '{"filters":"table_name=eq.<table>"}'` |
| Compared | see below |
| Failure | `expected: "<value>"  actual: "<value>"  why: entity property differs` |

### Compared properties (one assertion per pair)

| Live column | Model source |
|---|---|
| `module_id` | resolved id from 1.1 (skip for built-in entities, see below) |
| `singular` | model `singular` (when the §3 prose carries it explicitly, otherwise derived; treat absence in the model as "skip this comparison") |
| `plural` | model `plural` (same rule) |
| `singular_label` | model `singular_label` from §2 / §3 sub-heading |
| `plural_label` | model `plural_label` from §3 |
| `description` | model `description` from §3 (skip if model description is blank) |
| `label_column` | model `label_column` from §3 |
| `audit_log` | model `**Audit log:**` line: `yes` ⇒ `true`, `no`/absent ⇒ `false` |
| `edit_mode` | model `**Edit mode:**` line (default `auto`); skip comparison when the model is silent and live is `auto` |
| `cube_mode` | model `**Cube mode:**` line; skip comparison when model is silent (the platform default is `auto`, so live `auto` always means model-silent) |
| `view_permission` | always `<slug>:read` |
| `edit_permission` | resolved per the model's `**Edit permission:**` line (default `<slug>:manage`) |
| `computed_fields` | deep-equal the model's parsed JSON array; canonicalize keys before compare; live `[]` matches model `[]` |
| `validation_rules` | deep-equal the model's parsed JSON array; canonicalize keys before compare |
| `select_rule` | deep-equal the model's parsed JSON object; an empty `{}` matches absence-of-the-heading |

A missing entity is one failure (`entity missing`); do not cascade into field checks for that entity (skip its fields with a single "entity missing, skipping field checks" note).

### Built-in entity handling (relaxed branch)

When the entity's `table_name` is in `BUILT_IN_TABLES` (currently `["users"]`), the verifier takes the relaxed branch described in "Built-in entities" at the top of this catalog. Concretely:

1. Look up the entity with `read_entity --single '{"filters":"table_name=eq.<table>"}'`, unscoped by `module_id`. A missing row is a single `entity missing` failure with no downstream checks.
2. **Skip** every entity-property comparison (`module_id`, `singular_label`, `plural_label`, `description`, `label_column`, `audit_log`, `view_permission`, `edit_permission`, `edit_mode`, `cube_mode`, `select_rule`).
3. For the entity's JSON rule arrays: when the model declares `computed_fields` with non-empty entries, assert each entry's `name` is present in `live.computed_fields`. When the model declares `validation_rules` with non-empty entries, assert each entry's `code` is present in `live.validation_rules`. Otherwise skip. Do not deep-equal the rule bodies.
4. For each field in the model: assert the live `fields` row with the matching `field_name` exists. **Skip every per-field property check** (format, title, description, unique_value, enum_values, default_value, relationship labels, references, input_type_rule).

Built-in entities are documented in the model for the model's own consumption (so the analyst/skills downstream of the model know which columns the model relies on). The verifier confirms that load-bearing subset and intentionally leaves the rest to the platform.

---

## 7. Fields

For every field row in every entity's §3 table, **after** auto-field stripping, assert the live `fields` row exists.

**Auto-field stripping:** the model never declares `id`, generic `label`, `created_at`, `updated_at`. The named `label_column` field (e.g. `product_name`) **is** in the model and is checked normally.

| Field | Detail |
|---|---|
| Group | `field` |
| Natural key | `<table_name>.<field_name>` (also the live `fields.id`: rows are keyed by the composite string `"<table_name>.<field_name>"`, not a numeric id) |
| Call | `semantius call crud read_field '{"filters":"table_name=eq.<table_name>"}'` once per entity to batch-load every field; build a `Map<field_name, row>` from the result. The `fields` table FKs to its entity via `table_name` (a string column), not `entity` or `entity_id` — earlier versions of this catalog hedged between those names, but neither is correct on the current platform build. For single-field lookups during ad-hoc debugging the composite-id form works: `read_field --single '{"filters":"id=eq.<table_name>.<field_name>"}'`. |
| Compared | see below |
| Failure | `expected: "<value>"  actual: "<value>"  why: field property differs` |

### Compared properties (one assertion per pair, skip those where the model is silent)

| Live column | Model source | Skip-when-silent rule |
|---|---|---|
| `format` | model `Format` cell | never skip — but **alias the label-column field's `string` to live `text`** (the deployer rewrites the entity's label-column field format from `string` to `text` at create time; this is the only known format-string rewrite) |
| `title` | model `Label` cell | skip if model cell is blank |
| `description` | model `Description` cell (the §3 fifth column) | skip if model cell is blank; live `""` is the platform's silent default |
| `reference_table` | parsed from the Reference / Notes cell for `reference` / `parent` rows | never skip on FK rows; on non-FK fields live carries `""` and the script must skip |
| `reference_delete_mode` | from the §4 Delete mode column for this FK | never skip on FK rows; on non-FK fields live carries `"restrict"` as a platform-default placeholder (the column is non-null) — skip on non-FK rows |
| `relationship_label` | from the `relationship_label: "<verb>"` annotation | skip if absent; live carries `"has"` as the platform default on every row (FK and non-FK alike) |
| `singular_label_parent` | from the `parent label: "<sing>" / "<plur>"` annotation (parent FKs only) | skip if absent; live `""` is the platform default on non-parent-FK rows |
| `plural_label_parent` | from the same annotation | skip if absent; live `""` is the platform default |
| `cube_type` | from the `cube_type: <value>` annotation (default `auto`) | skip if absent (live carries `"auto"` as the platform default) |
| `default_value` | from the `default: "<value>"` annotation | skip if absent; live `""` is the platform default for "no default" |
| `unique_value` | `true` when the Notes cell contains the bare token `unique`; otherwise `false` | always check |
| `enum_values` | the §5 sub-section the Notes cell references (only for `format: enum`) | always check on enum fields |
| `input_type_rule` | the **`jsonlogic` sub-object** of the entity's `Input type rules` entry matched by `field` name (NOT the full `{field, description, jsonlogic}` entry — the deployer drops the wrapping `field` and `description` keys and only stores the `jsonlogic` body on `fields.input_type_rule`) | skip if the entity has no entry for this field; live carries `{}` (empty object) as the platform default |

The "platform sentinel values" table at the top of this catalog is the canonical list of "live values that mean model-silent". Cross-reference it when in doubt; the per-column rules here are derived from it.

### Enum value comparison

For `format: enum` fields, the model declares a value list in §5. The live `enum_values` array must contain **every** model value with matching ordering and casing. Additional live values are accepted, but they must appear after the model's last value (the order of the model's values must match the prefix of the live array).

| Failure shape | Reported as |
|---|---|
| A model value is missing from live | `why: model enum value missing from live state` |
| Model values appear in a different relative order | `why: enum value order differs` (display order matters) |
| Casing differs | `why: enum value casing differs` |

### JSON property comparison

`computed_fields`, `validation_rules`, `select_rule` (all entity-level) and `input_type_rule` (field-level) are compared by deep value-equality after canonicalization:

1. Recursively sort object keys.
2. Leave arrays in declared order (order is significant for `computed_fields`, `validation_rules`, and the visible enum-value list; not for object keys).
3. Compare via `JSON.stringify` of the canonicalized form.

A whitespace-only difference is **not** a failure (canonicalization removes it). A semantic difference (extra key, missing key, different value) is.

For `input_type_rule` specifically, the expected value is the entry's **`jsonlogic` sub-object**, not the full `{field, description, jsonlogic}` entry from the entity's `Input type rules` array. The deployer drops the wrapping `field` (redundant with the row's `field_name`) and `description` (analyst-only documentation) keys when writing the field row. Comparing the full entry against the live value produces guaranteed false-positive drift for every field with an input type rule; the script must lift `entry.jsonlogic` out of the model entry before comparing.

### Batch reads (performance)

The naive approach reads `fields` once per field, which is slow on large modules. The script may batch by reading `read_field '{"filters":"entity=eq.<entity_id>"}'` once per entity, building a `Map<field_name, row>`, and consuming entries from the map. This is identical from a correctness standpoint and saves one CLI round trip per field. Use it when an entity has more than five fields; keep the simple per-field read when it has fewer (the code is easier to read).

---

## 8. Webhook receivers (only when the model declares any)

If the model carries a `## Webhook receivers` section (or equivalent block), for each declared receiver:

| Field | Detail |
|---|---|
| Group | `webhook_receiver` |
| Natural key | `name = <receiver_name>` |
| Call | `semantius call crud read_webhook_receiver --single '{"filters":"name=eq.<name>"}'` |
| Compared | `event`, `url` (if declared), `description` (if declared), `module_id` |
| Failure | `expected: "<value>"  actual: "<value>"  why: webhook receiver property differs` |

`webhook_receiver_logs` are **not** asserted; they're operational data, not schema.

---

## Execution order in the generated script

```
1. Module                   (1.1, 1.2)
2. Permissions              (2)
3. Permission hierarchy     (3)
4. Roles                    (4)
5. Role-permissions         (5)
6. Entities                 (6)   — per-entity batch
   └─ For each entity:
       └─ Fields            (7)
7. Webhook receivers        (8)
8. Summary + exit code
```

Group failures so the report reads top-down without backtracking: every entity's fields appear right after the entity row, every permission appears before any role-permission that references it.

The script **continues on failure**. Do not short-circuit on the first failed check; a single failing run should report **every** drift, not just the first one. The only exception is check 1.1 (module not found): if the module itself is missing, the rest of the checks have no resolved `module_id` to filter by, and continuing produces noisy "missing" failures for every downstream entity. In that one case, print the module failure, then exit 1 immediately with a message naming the missing module slug.

---

## What the script does NOT check (intentional)

- **No "extra is bad" assertions.** Live state may carry fields, entities, permissions, roles, role-permission links, or hierarchy edges the model does not declare. The deployer is additive; admin customizations are expected. The script asserts the model's surface, not the absence of customization.
- **No row counts.** The deployer's Stage 5 reports "247 records intact"; this script does not. Business data is out of scope.
- **No user-role assignments.** Who carries which role is operational state, not schema.
- **No physical-table existence probes.** The `entities` row IS the schema; if the row exists with the right shape, the platform guarantees the underlying Postgres table matches.
- **No semantic checks on JsonLogic content.** `computed_fields`, `validation_rules`, `select_rule`, and `input_type_rule` are compared structurally. The deployer trusts the analyst to write correct expressions; this script verifies the round-trip didn't lose data.
- **No master-promotion-specific checks** (master FK repointing, intra-master hierarchy edges originating from `model_master`, master-steward seed counts). Those are deployer-internal invariants; the generated script verifies the user-visible end state, not the deployer's intermediate state.

If the user asks for any of these, they belong in a separate script, not this one. Confusion of scope leads to false positives that train the user to ignore failures.

---

## Re-using natural-key resolutions

The script does the following lookups exactly once and caches them in local maps:

- `moduleId`: from check 1.1.
- `permissionIds`: a `Map<permission_name, id>` built by reading all permissions for this module once at the start of check 2.
- `roleIds`: a `Map<role_name, id>` built once at the start of check 4.
- `entityIds`: a `Map<table_name, id>` built once before check 6 (single `read_entity` call filtered by `module_id`).
- `fieldsByEntity`: a `Map<table_name, Map<field_name, fieldRow>>` built once before check 7 when the per-entity batch path is taken.

Caching is not premature optimization; it's the difference between a script that takes 2 seconds and one that takes 5 minutes on a real module. The deployer's Stage 5 inspires the same pattern.
