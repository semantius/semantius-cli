# Semantius Data Modeling Reference (Layer 1)

This is **Layer 1** of Semantius, the semantic data model that defines the schema for your application. It stores domain concepts, attributes, relationships, and access rules as structured data. When you define an entity here, Semantius automatically creates a real PostgreSQL table for it, which then becomes accessible via PostgREST (Layer 2) and the CubeJS API (Layer 3).

Unlike raw database DDL, the semantic model encodes:
- Human-readable labels and descriptions (used by auto-generated UIs)
- UI rendering hints (field order, width, icons)
- Reference relationships with configurable delete behavior
- Role-based access control (RBAC) per entity

The typed crud tools (`create_entity`, `create_field`, etc.) all operate on this layer. To work with actual business records once the schema is defined, use `postgrestRequest` (see `references/crud-tools.md`).

This file covers the schema mechanics: modules, entities, fields, relationships, and safe evolution. Two sibling references cover the rule layers: `jsonlogic.md` (`computed_fields`, `validation_rules`, extension operators, cross-entity lookups, dynamic `input_type_rule`) and `select-rule.md` (row-level read security via `select_rule`). Subtypes and extensions (`id_type: is_a` / `has_a`) have their own reference: `entity-families.md`.

## Contents

- [Mandatory Creation Order](#mandatory-creation-order)
- [Modules](#modules)
- [Entities](#entities): naming, built-ins, key fields, auto-generated fields, provenance columns
- [Fields](#fields): naming, formats, `width`, `input_type`, fields that apply only to some enum or boolean values, `unique_value`, `default_value`, `cube_type`, all properties
- [Relationships](#relationships): relationship labels, `reference`, `parent`, junctions, relationships to other modules
- [Safe Evolution Patterns](#safe-evolution-patterns)
- [Updating and Deleting Entities](#updating-and-deleting-entities)
- [Agent Workflow Tips](#agent-workflow-tips): including full-text search
- [Runtime schema introspection](#runtime-schema-introspection-live-fk--shape-lookup)
- [Tool Priority Rule](#tool-priority-rule), [Entity Reference](#entity-reference-all-managed-tables), [Troubleshooting](#troubleshooting)

---

## Mandatory Creation Order

This section is the single source for the creation order. Other files point here; they do not restate it.

**Always follow this sequence, never skip steps:**

```
module-rbac-setup.ts (module, permissions, permission hierarchy, roles, grants, default roles) → ALL Entities (one call; one per level, bases first, with is_a / has_a) → ALL Fields (one call; rollups last in the array) → update_entity (label_parent, where an entity has one)
```

**Batch every step that writes more than one record of a kind** (Golden Rule 7): every entity of the model in one `create_entity`, every field of the model in one `create_field`. `data` is an array on every `create_*`; items may have different keys; the response is an array. And **create every entity before any field**: a field's `reference_table` (another entity of the model, or the entity itself) must exist when the field is created, which the entities-first order guarantees — no second pass for cross-references or self-references. `label_parent` is written after the fields (step 8), because the platform checks that the field it names exists.

**Exception: a model with `is_a` / `has_a` entities** creates its entities in **one `create_entity` call per level, bases first**: plain entities and family roots first, then the entities based on them, and so on. The fields still come only after every level exists. A based entity named before its base fails with `23503`. Full rules: `entity-families.md`.
<!-- Family variant: `entity-families.md` → "Creating a family". This block summarizes; that section governs families. -->

**Every `create_entity` and `create_field` goes through a file.** Run `mkdir -p .tmp_deploy` once, write the JSON to `.tmp_deploy/<name>.json`, then run `bun "<skill-folder>/references/call-file.ts" <tool> .tmp_deploy/<name>.json`, as the examples below do. Quotes and apostrophes in a description then cannot break the call. Before it sends, `call-file.ts` checks the payload and names every problem in one run: invalid JSON (with its line and column), a variable a shell emptied, a `has_permission` / `require_permission` name that is not a permission on the host, a `create_field` row for a field `create_entity` already made (the label column, `id`, `created_at`, `updated_at`; `23505`) or for any field that already exists on the host (a payload sent a second time; `23505`), a key the tool does not take, with the key to write instead (`required` → `input_type: "required"`; `PGRST204`), a value outside a key's list (`width`, `format`, `input_type`, `id_type`, …), `label_parent` on `create_entity` (`90226`), an `id_prefix` that does not fit the `id_type` (`23514`), that is not the entity's singular ("Choosing the key type"), that two entities of the payload share, or that another entity already has (`23505`), a required `reference` with `reference_delete_mode: clear` (`90257`), a rollup over rows that readers of its entity may not see, without `include_hidden_rows` (`90269`), a rollup whose `link_field` is not a relationship field of the child that points at the rollup's own entity (`90262`), an icon that is not a Lucide icon, a `computed_fields` or `validation_rules` rule that reads `_label` or `<fk>_label` ("Choosing the label"), an entity whose `edit_permission` is not the write tier of its class (`rbac.md` → "Choosing an entity's permissions"), a `workflow_state` whose states the module's access record (`access.json` beside the payload) does not cover, and a `parent` field whose entry in the relationship record (`relationships.json` beside the payload) is missing or has facts that make it a `reference` ("Choosing the Right Format"). `--check` runs the checks and sends nothing. A payload sent straight to `semantius call` gets none of these checks. The payload shapes are in this file, so do not run `semantius tools` for these tools.

**A payload with rules is built, not typed.** When entities carry `computed_fields`, `validation_rules` or a `select_rule`, or fields carry an `input_type_rule`, write one Bun builder script (`.tmp_deploy/build_<module_slug>.ts`). It imports `<skill-folder>/references/jsonlogic-kit.ts`, names each part of a rule as a `const` (a gate's check, a state list, a lock), composes the rules from those names, and writes the model with `writeModel(".tmp_deploy", { entities, fields, access, relationships })`. A model with a `workflow_state` is always written this way, because `access` is its access record: who moves a record into each state (`rbac.md` → "Restricted steps (gates)" → "The access record"). `relationships` is its relationship record: the facts that decide each relationship field's format ("Choosing the Right Format"). Its gate rules are not in the builder: `module-rbac-setup.ts --access` writes them once the entities exist (step 9). `writeModel` checks the entities, the fields and both records together and names every problem: a `workflow_state` whose states the access record does not cover, every problem of the access record itself, a `parent` field whose entry in the relationship record is missing or has facts that make it a `reference`, a key `create_entity` or `create_field` does not take and a value outside a key's list, a field its `input_type_rule` makes required in some states with no validation rule of its entity that reads it, `readonly` on a field no `computed_fields` rule fills, a computed field that fills no field, a field `create_entity` makes on its own (the label column of an entity in the payload, `id`, `created_at`, `updated_at`), the field and icon checks of `call-file.ts`, and a rollup whose `link_field` is not a relationship field of the child that points at the rollup's own entity. Only when it finds none does it write `entities.json` (one `entities-<n>.json` per level, bases first, for an `is_a` / `has_a` family), `fields.json`, with the rollups last and each field a `computed_fields` rule fills `disabled`, `labels.json`, the `update_field` that sets each label column a rule fills to `disabled`, `access.json` and `relationships.json`. Run it, then send the files with `call-file.ts` in the order it prints. Never type a nested rule on one line, and never use Python (`cli-usage.md` → "Ad-hoc JSON and file work in Bun"). To change a rule later, change the builder and run it again.

```typescript
import { all, any, changed, eq, hasPerm, iff, isIn, ne, old, rule, userId, v, writeModel } from "<skill-folder>/references/jsonlogic-kit.ts";

// rbac.md → "Controls on a gate": the recall of a purchase request, rule 99003
const isRequester = all(ne(old("requested_by_user_id"), null), eq(old("requested_by_user_id"), userId));
const backToDraft = all(changed("workflow_state"), isIn(old("workflow_state"), ["submitted", "rejected"]), eq(v("workflow_state"), "draft"));
const recall = rule("99003", "recall_purchase_request",
  "Only the person who requested it, or an admin, can move a submitted or rejected purchase request back to draft.",
  iff(backToDraft, any(hasPerm("spend:admin"), isRequester), true));
writeModel(".tmp_deploy", {
  entities: [{ table_name: "purchase_requests", /* … */ validation_rules: [recall] }],
  fields: [{ table_name: "purchase_requests", field_name: "requested_by_user_id", /* … */ }],
});
```

The kit's functions and what each takes. A field is always passed by its name, never as `v(…)`: the helpers that take a field build the `v()` themselves. A wrong argument throws with the function's signature and a right call.

| Kit function | What it builds |
|---|---|
| `v(name, fallback?)` | The value of a field, or of `$old.<field>`, `$mode`, `$user_id`, `$now`, `$today`: `v("workflow_state")` |
| `old(field)` | The stored value before this write (null on an insert): `old("workflow_state")` |
| `userId`, `now`, `today` | `$user_id`, `$now`, `$today` |
| `modeIs(mode)` | True on an `"insert"`, `"update"` or `"delete"` |
| `eq(a, b)`, `ne(a, b)`, `lt(a, b)`, `le(a, b)`, `gt(a, b)`, `ge(a, b)` | `==`, `!=`, `<`, `<=`, `>`, `>=` |
| `isIn(value, list)` | `value` is one of a literal list: `isIn(v("workflow_state"), ["approved", "closed"])` |
| `all(...parts)`, `any(...parts)`, `not(part)` | `and`, `or`, `!` |
| `iff(condition, then, otherwise)` | `if`; more condition/then pairs may come before `otherwise` |
| `cat(...parts)` | Text joined from its parts |
| `hasPerm(permission)`, `requirePerm(permission)` | `has_permission` (never throws) and `require_permission` (throws); a permission is `<module_slug>:<action>` |
| `changed(field)` | The write changes the field (always on an insert) |
| `changedTo(field, value)` | The move of a field into a value: `changedTo("workflow_state", "approved")` |
| `setRecord(name, table, id, body)` | Reads one row of `table` by `id` into `name` for `body` |
| `isSet(field, format)` | The field holds a value, by its format: `isSet("rejection_reason", "text")`, `isSet("sold_date", "date")`, `isSet("sale_price", "number")`; never for a boolean |
| `appliesIn(states, mode, field?)` | The `input_type_rule` of a field that applies only in some values: `mode` (`"required"`, `"default"` or `"readonly"`) there, hidden elsewhere; `field` defaults to `workflow_state`: `appliesIn(["rejected"], "required")` |
| `rule(code, name, message, jsonlogic, description?)` | A validation rule: a class-99 code, a snake_case name, the message the caller sees |
| `computed(name, jsonlogic, description?)` | A `computed_fields` entry: the field it fills and its value |
| `composedLabel(field, parts, separator?)` | The label of a record its related records name ("Choosing the label") |
| `writeModel(dir, { entities, fields, access?, relationships? })` | Checks a new model's entities, fields, access record and relationship record together, then writes the files `call-file.ts` sends, `access.json` and `relationships.json` |
| `writeAccess(dir, access)` | Writes the access record of a module that already has its entities as `access.json` |
| `writePayload(path, payload)` | Writes any other payload file |
| `modelProblems(entities, fields, access?, relationships?)` | The problems `writeModel` would refuse, without writing |

**Steps 1 to 5: create the module, its permissions, hierarchy, roles, grants and default roles with one command.** Never with `create_*` calls. Gates, the roles that take them and the roles that do part of the work come from the access record, written by the same script with `--access` once the entities exist (step 9; `rbac.md` → "Restricted steps (gates)" → "The access record"). One thing is created with `create_*` calls after this command: the view access to an entity of another module (`build-module.md`, step 5.7; `rbac.md` → "Viewing an entity of another module").

```bash
bun "<skill-folder>/references/module-rbac-setup.ts" --name "<Module Name>" --slug <module-slug> --description "<at most 60 characters>" --icon <icon-name>
```

- `--icon` comes from `lucide-icon-finder.ts`, `box` when no icon fits (see "Icons are Lucide icons"). `--description` is at most 60 characters (see "Modules"). The script refuses anything else before it writes.
- Leave `--color` out unless the user named a color: the script picks a dark shade from the slug. Add `--domain <CODE>` only when the module belongs to a known business domain.
- Take `module_id` for the later steps from the first line of its output.
- It sets `access_scope` to `advanced`. A gate in the access record raises it to `gated` when `--access` runs (step 9).
- On a non-zero exit, do what the last line it prints says. Exit 1 means stop and tell the user. Only exit 3, a write the platform keeps refusing, can end in manual calls, after telling the user.
- A module that already exists: `--slug <module-slug>` alone fills what it is missing and changes nothing else.

6. **Create the entities**, one `create_entity` call whose `data` array carries every entity of the model (each with `module_id`, `entity_type`, `view_permission` and `edit_permission`; classify first, see "Classifying an entity" below). First `entity-match-checker.ts` exits 0 (`SKILL.md` → "Before any new entity: compare it with the instance"), then one `read_entity` with `table_name=in.(...)`. Icons first: every entity gets an `icon_name` from `lucide-icon-finder.ts`, unless no icon fits; `call-file.ts` refuses a name that is not a Lucide icon (see "Icons are Lucide icons"). An entity whose label field should have another title than the platform's default carries `label_column_label` in this call (see "Customizing the label field's title"). Every item carries `entity_type`, `view_permission` and (except on `computed`) `edit_permission`, chosen together from the entity's class and write tier: the platform default `unclassified` is a defect, not a class. Classify without asking, state the result in the summary, and check it with the read-back in "Agent Workflow Tips" → "Verify the class and the permissions after creating entities" (`rbac.md` → "Choosing an entity's permissions" gives the tiers). With `is_a` / `has_a` entities, one call per level instead, bases first (see the exception above). Before this call, run the pass in "Fields that apply only to some enum or boolean values": its validation rules go in this call. Gate rules and their controls do not: step 9 writes them, and sets the class of an entity with a gate. Each entity carries its label column, with the rule that fills a composed label ("Choosing the label"), in this call; an entity that takes `typeid` or `is_a` also carries its `id_type` and `id_prefix` ("Choosing the key type").
7. **Add fields** in one `create_field` call whose `data` array carries every domain attribute of every entity of the model: each item names its own `table_name`. Rollup fields go at the end of the array, after the fields they read; a rollup ahead of its child's relationship or value field fails with `90264`, and nothing in the call lands. With more than about 100 fields, split the array into a few calls by entity, sent in order, with the rollups in the last one. Never the field named in `label_column` or another auto-generated one: `create_entity` already made them, and one such row fails the whole call with `23505`, so nothing lands; `call-file.ts` refuses such a row before it sends. The FK targets all exist by now. Every enum icon comes from the "Enum icons" table or `lucide-icon-finder.ts`, and `call-file.ts` refuses one that is not a Lucide icon (see "Icons are Lucide icons"). Each `input_type_rule` from the pass in step 6 goes in this call. Every `relationship_label` in this call has passed its test first (see "Relationship labels"). A `workflow_state` goes in only when the access record covers each of its states; `call-file.ts` refuses it otherwise.
8. **Set `label_parent`**, only on an entity whose records are identified through a parent (see `label_parent` under "Key Entity Fields") and never on a junction, with `update_entity` once its fields exist. `create_entity` cannot carry it: the field it names does not exist yet, and the write fails with `90226`. `update_entity` applies one `data` to every listed table, so each different field name is its own call:
   ```bash
   semantius call crud update_entity '{"table_name": "order_lines", "data": {"label_parent": "order_id"}}'
   ```
9. **Write the access** from the access record, once the entities and fields exist: the gates, the roles that take them, the roles that do part of the work, their fields, rules and `select_rule`s, and each entity's class (`rbac.md` → "Restricted steps (gates)" → "The access record"). Run it in every build that has an access record, also when it names no gate: it sets the class of each lifecycle and prints the access summary.
   ```bash
   bun "<skill-folder>/references/module-rbac-setup.ts" --slug <module-slug> --access .tmp_deploy/access.json
   ```

---

## Modules

Every entity **must** belong to a module.

A module has two name fields with distinct jobs:

- **`module_name`** is the unique, human-facing display name shown in the UI module selector and on the module landing page. Keep acronyms as acronyms (`CRM`, `ITSM`, `CMDB`), this is what users read. Matches the source model's `system_name`.
- **`module_slug`** is the lowercase, URL-safe handle. Optional in the schema (an empty value derives it from `module_name`: lowercased, every run of other characters replaced by `-`, leading and trailing `-` and `_` removed; a name with no ASCII letter or digit derives an empty slug, and a second such module collides), but always pass it explicitly (regex `^[a-z0-9][a-z0-9_-]*$`; lowercase letters, digits, `_`, and `-`, starting with a letter or digit). Used in URLs, in the permission prefix, and by other models that reference this module. Matches the source model's `system_slug` (e.g. `crm`, `itsm`, `ben-admin`). A malformed slug is rejected with `module_slug must be lowercase, start with a letter or digit, and contain only a-z, 0-9, '-' and '_'`.

**Create a module only with the script**, which checks for an existing one first (see "Mandatory Creation Order", steps 1 to 5):
```bash
bun "<skill-folder>/references/module-rbac-setup.ts" --name "CRM" --slug crm --description "Customer Relationship Management" --icon <icon-name>
```

The `description` field is a compact tagline (≤60 chars) shown beside `module_name` in the selector chip, for acronyms, the plain English expansion (`CRM` → `Customer Relationship Management`); for non-acronyms one short phrase saying what the module holds. Long-form prose belongs elsewhere, not on the module record.

Other optional fields on `modules`: `icon_name`, `domain_code`, `access_scope`, `view_permission`, `manage_permission`, `admin_permission`, `logo_color`, `home_page`, `settings`, `dashboard_config`. Three of these are top-level module classification columns (set them on `create_module` / `update_module`, not inside `settings`):

- **`icon_name`** — the module's UI icon: a Lucide icon name or an icon URL (see "Icons are Lucide icons" under the Field Format Quick Reference), like an entity's `icon_name`; distinct from the module `logo_url`. The module's `logo_color` has format `color`: leave it out unless the user named a color, and `module-rbac-setup.ts` fills an empty one with a dark shade picked from the slug.
- **`domain_code`** — short uppercase business-domain code the module belongs to (`ATS`, `HCM`, `ITSM`, `CRM`). Groups related modules; many modules — and many `catalog_module_code`s — can share one `domain_code`.
- **`access_scope`**: the permission structure of the module (its access level). `enum_values`: `custom` ("Custom permission structure"), `basic` ("Two permissions: view and edit"), `advanced` ("Three permissions: view, edit and admin."), `gated` ("Three permissions: view, edit and admin and gates on `workflow_state` transitions"), `raci` ("Three permissions: view, edit and admin and enforced process gates"); default `custom`.

Permission naming convention: **always `<module_slug>:<action>`** (e.g., `crm:read`, `crm:manage`). The permission prefix is the slug, not the display name, `crm:read`, never `CRM:read`.

---

## Entities

### Creating an Entity

`.tmp_deploy/products-entity.json`:

```json
{
  "data": {
    "table_name": "products",
    "singular_label": "Product",
    "plural_label": "Products",
    "description": "A catalog product available for sale",
    "label_column": "product_name",
    "module_id": 3,
    "view_permission": "catalog:read",
    "edit_permission": "catalog:manage",
    "entity_type": "operational_record",
    "icon_name": "package",
    "audit_log": false
  }
}
```

```bash
bun "<skill-folder>/references/call-file.ts" create_entity .tmp_deploy/products-entity.json
```

Required by the platform: `table_name` and `module_id`. Also pass `entity_type`, `view_permission` and `edit_permission` on every entity: the platform stores `unclassified` and the permission defaults (`public:read`, `admin`) when they are omitted, and the next section says how to choose all three.

### Classifying an entity

Every entity carries a **class** in `entities.entity_type`, and the class decides which permission gates its writes (its **write tier**: the permission level that gates INSERT, UPDATE and DELETE on the entity). Decide the class and the write tier before the `create_entity` call and send `entity_type`, `view_permission` and `edit_permission` together in the same payload. The platform default `unclassified` means nobody classified the entity; it is never a choice, and an entity left there is a defect to fix.

Classify without asking the user: say the result in the summary after the create (one line per class, each with its write tier in plain words, e.g. "catalog: only admins can add or edit"), and change it with `update_entity` when the user disagrees.

**The class follows from who writes the records in normal work.**

| `entity_type` | Who writes its records |
|---|---|
| `junction` | Nobody on its own: it holds only its relationship fields, a `parent` field to each entity it relates, and a row exists only to relate them |
| `computed` | Nobody: every field is derived |
| `catalog` | Only administrators: setup or reference values that other records point at |
| `operational_workflow` | The module's everyday users, and the entity has a **gated step**: a step that a role other than the module's Manager role takes, such as an approval |
| `operational_record` | The module's everyday users, and the entity has no gated step |
| `unclassified` | Never a choice: the platform default for an entity nobody classified |

**Choose in this order; the first match wins:**

1. **Its only fields are its relationship fields** (two, or more for an N-ary relationship) → `junction`. An entity that stores an n:m relationship and has fields or states of its own is not a junction: take the steps below.
2. **Nothing writes it**, every field is derived → `computed`.
3. **Only administrators write it** → `catalog`. The records the module exists to hold are never a `catalog`, however few: the module's everyday users add to them. Neither is the base of a family (`entity-families.md`) whose based entities those users write, because each of their writes also writes the base.
4. **It has a gated step** → `operational_workflow`. The test for a gate is in `rbac.md` → "Restricted steps (gates)".
5. **Otherwise** → `operational_record`.

The platform built-ins (`users`, `roles`, `permissions`) are already classified; never recreate them.

**Write tier and permissions.** The class gives the write tier, and `rbac.md` → "Choosing an entity's permissions" turns the tier into the entity's `view_permission` and `edit_permission`:

| `entity_type` | Write tier |
|---|---|
| `catalog` | `:admin` |
| `operational_workflow` | `:manage` |
| `operational_record` | `:manage` |
| `junction` | `:manage`; `:admin` only when every entity it relates is a `catalog` |
| `computed` | `:read` (nothing writes it; omit `edit_permission`) |

**Rules**
- Classify a junction `junction` in the `create_entity` call that creates it (its `parent` fields come later, with the other fields). The platform also treats an entity with two or more `parent` fields and no other fields as a junction whatever its class.
- `entity_type` is metadata, not a key: fix a wrong or missing class with `update_entity` (an array of `table_name`s takes the same value; the label function is rebuilt, no data is lost), then re-check the entity's `edit_permission` against the new tier.
- Never `create_field` it; it is a core column.
- The adjacent write-once column `catalog_entity_code` is set only for an entity that realizes a catalog identity; leave it empty on an entity built with this skill. `singular` is derived from `table_name` when blank, and `plural` is always set to `table_name`, so pass neither.

### Entity Naming Rules

- **`table_name` is always plural snake_case**, `products`, `orders`, `order_lines`, not `product`, `order`, `orderLine`
- **Name the concept in full.** A singular noun that explains itself; `table_name` is its plural. `sales_opportunity` → `sales_opportunities`, never an abbreviation such as `opp`.
- **Never end a `table_name` in `_ext`.** `<table_name>_ext` is the storage table of an `is_a` / `has_a` entity, so the platform reserves it (`90250`); see `entity-families.md`.
- **Never create a `users` entity**, Semantius has a built-in `users` table. Any module that needs to reference users must use `reference_table: "users"` pointing at the existing table. Creating a competing `users` or `user` entity will conflict with the built-in table and break authentication.
- **Never create a second entity for something the instance already holds**, under any name or prefix. `table_name` identifies an entity across the whole instance, not per module. Compare first: `SKILL.md` → "Before any new entity: compare it with the instance".

### Semantius built-in entities: shapes

The platform ships with built-in tables for authentication, RBAC, and integration. **Domain models reference these by `table_name`, never recreate them.** If a domain genuinely needs an extra field on a built-in (e.g. `users.job_title`), add it via `create_field` after dedup. Never modify or rename existing built-in fields, never change their formats, never replace built-in entities.

#### `users` — authenticated principals

| Field | Format | Notes |
|---|---|---|
| `id` | int64 | PK |
| `external_id` | text NOT NULL | Identifier from the auth provider (IdP) |
| `email` | email | The user's email (login identifier); default `''` |
| `display_name` | text | Human-readable name shown across the UI (use this — NOT `name`, `full_name`, `user_name`); default `''` |
| `first_name` | text | Given name, filled from the JWT `given_name` claim |
| `last_name` | text | Family name, filled from the JWT `family_name` claim |
| `is_agent` | boolean NOT NULL | TRUE for a service principal (agent) rather than a person; default FALSE |
| `is_disabled` | boolean | True when the account is suspended; default FALSE (inverse of "is_active" — use this name, not `is_active` or `is_enabled`) |
| `settings` | json | Per-user preferences blob |
| `last_seen` | date-time | Last activity timestamp |
| `created_at` / `updated_at` | date-time | Auto |

**Common mistakes when extending `users`: each overlaps with what the built-in table already holds or records.**

| Don't add | Reason |
|---|---|
| `name`, `full_name`, `user_name` | Use existing `display_name`. |
| `given_name`, `family_name`, `surname`, `first_name`, `last_name` | Use existing `first_name` / `last_name`. |
| `is_agent`, `is_bot`, `is_service_account` | Use existing `is_agent`. |
| `is_active`, `active`, `enabled`, `is_enabled` | Use existing `is_disabled` (inverted semantics, same concept). |
| `username`, `login` | Use existing `email`. |
| `preferences`, `config` | Use existing `settings` json. |
| `disabled_at`, `deactivated_at` | Use `is_disabled` + audit log; no separate timestamp. |

**Legitimately additive fields a domain may want:** `primary_team_id` / `department_id` / `manager_id` (FKs to domain entities), `job_title` (text), `employee_id` (text, external HRIS reference). These don't overlap with built-in fields and should be added.

#### `roles` — RBAC roles, system-managed slugs

| Field | Format | Notes |
|---|---|---|
| `id` | int64 | PK |
| `role_name` | text NOT NULL | Human-readable display name (e.g. `"CRM Manager"`) |
| `slug` | text NOT NULL UNIQUE | Stable snake_case handle (e.g. `crm_manager`); acts as a natural-key second primary key. **Regex `^[a-z0-9_]+$` — underscores only, NO hyphens.** This differs from `module_slug` (`^[a-z0-9][a-z0-9_-]*$`, which DOES allow hyphens): when you build a role slug from a hyphenated module slug, convert `-`→`_` (module `ben-admin` → role `ben_admin_manager`, never `ben-admin_manager`). A hyphen fails the regex. |
| `description` | multiline | What this role does |
| `origin` | enum NOT NULL | `system` / `model` / `model_master` / `user`. Strictly immutable after INSERT. Set by whoever creates the role; default `user`. |
| `module_id` | reference → modules | Which module owns the role |

> **Origin semantics.** `system` rows are platform built-ins (seeded at database init; only their `origin` and `slug` are locked). `model` and `model_master` rows are created only when a module is installed from a catalog design (a domain module and a master module respectively); an agent never sets them. `user` rows are admin-created via the UI/API. **Slug rename is permitted for `model` / `model_master` / `user`; locked for `system`.**

#### `permissions` — RBAC permissions, natural-key by name

| Field | Format | Notes |
|---|---|---|
| `permission_name` | text PK | Code in form `<module_slug>:<action>` (e.g. `crm:read`). The primary key (there is no numeric id): every other table names a permission by it, and `update_permission` / `delete_permission` are keyed by it |
| `description` | multiline | What this permission grants |
| `module_id` | reference → modules | Owning module |

#### `permission_hierarchy` — RBAC inclusion graph

| Field | Format | Notes |
|---|---|---|
| `id` | text PK | Generated as `"<including>.<included>"` (e.g. `"crm:manage.crm:read"`) |
| `including_permission_name` / `included_permission_name` | both → permissions (by name) | Reads as `including_permission_name` *includes* `included_permission_name`. Holding the broader (including) permission transitively grants the narrower (included) one. |
| `origin` | enum NOT NULL | `system` / `model` / `model_master` / `user`. Strictly immutable after INSERT. |

#### `user_roles`, `role_permissions` — junctions

`user_roles` carries `user_id` / `role_id` (both numeric) plus `assigned_at` / `assigned_by`, with a text `id` of `"<user_id>.<role_id>"` (e.g. `"1001.1"`). `role_permissions` carries `role_id` (numeric) / `permission_name` plus `granted_at` / `granted_by`, with a text `id` of `"<role_id>.<permission_name>"` (e.g. `"1.user:read"`). Don't redeclare; reference via FK from your domain entities only if you need to surface RBAC state in a domain query.

#### `webhook_receivers`, `webhook_receiver_logs` — inbound HTTP intake

Used by the integration runtime; domain models almost never touch these.

#### `modules`, `entities`, `fields`, `queues`, `queue_table_events`, `dashboards`

Platform meta-schema. **Never declare in a domain model.** The platform manages these as a side effect of `create_entity` / `create_field` / `create_module`.

### Key Entity Fields

| Field | Notes |
|-------|-------|
| `table_name` | **Plural** snake_case. Renaming is supported but think twice: integrations, saved queries, and external consumers reference the entity by name. |
| `singular_label` | Human-readable name for **one record** (e.g. `Product`). Must be grammatically symmetric with `plural_label`, if `plural_label` is "Products", this must be "Product", never "Product Name". Pass it: when blank it is derived from `singular`, with every word of the table name (`product` becomes "Product", but `crm_product` becomes "Crm Product"). Field-level titles like "Product Name" belong on the label field (the field named in `label_column`), not here (see Customizing the label field's title below). |
| `plural_label` | e.g. "Products" |
| `label_column` | Snake_case **field name** that identifies a record (e.g. `product_name`). NOT a human-readable title. Optional on `create_entity`, but set on every entity: the field people tell its records apart by, or `<singular>_name` composed from the records it relates (see "Choosing the label"); omit it for a junction table, whose `_label` the platform composes from its `parent` fields (see "M:N Junction Tables" below). Never set it on an `is_a` / `has_a` entity: it comes from the base (on create the platform overwrites it; an update is refused with `90242`). **Always single-line text:** `create_entity` creates this field as `text`, and as a core column its format can never change afterward (`90219`), so a label column is never an `enum`, number, date, boolean or FK. When the only identifying attribute is a type or category, the label is composed from the records it relates (see "Choosing the label"). |
| `label_column_label` | Optional title of the label field, given on `create_entity`, so no `update_field` follows. Pass it only when the platform's default does not fit (see "Customizing the label field's title"). It and the label field's `title` stay in step both ways. Never set it on an `is_a` / `has_a` entity: it comes from the base (on create the platform keeps the base's; an update is refused with `90242`). |
| `module_id` | Required on `create_entity` — must be a valid (non-null) integer module id; `null` is rejected. Find with `read_module`. On `update_entity` it stays optional, but a provided value must still be a non-null integer. |
| `entity_type` | **Required on every entity you create:** `catalog`, `operational_workflow`, `operational_record`, `junction` or `computed`. The platform default `unclassified` is never a choice. See "Classifying an entity" above. Optional on `update_entity`, where a provided value must be one of the six allowed values. |
| `view_permission` | Name string (e.g. `"catalog:read"`); defaults to `public:read` when omitted, so set it deliberately. The permission must already exist |
| `edit_permission` | Name string (e.g. `"catalog:manage"`); defaults to `admin` when omitted, so set it from the entity's write tier (`rbac.md` → "Choosing an entity's permissions"), except on a `computed` entity, where you omit it. The permission must already exist. Gates INSERT, UPDATE and DELETE alike; there is no separate delete permission. To restrict one operation (e.g. only some roles may delete), add a `validation_rules` entry that tests `$mode` (see `jsonlogic.md`, *Detecting the operation*). |
| `id_type` | Optional key type, **set on create and locked afterward**: changing it is refused with `90233`, so omit it on `update_entity`. `auto_increment` (default when omitted): a 64-bit number the database assigns. `bigint`: a 64-bit number the caller supplies on every insert. `text`: a text key the caller supplies. `uuid`: a time-ordered UUIDv7 the database assigns. `typeid`: a prefixed, sortable TypeID such as `account_01h455vb4pex5vsknk084sn02q`, assigned by the database; requires `id_prefix`. `is_a` / `has_a`: a subtype or an optional extension of another entity, sharing its key; requires `id_refentity` (and `id_prefix` for `is_a`); see `entity-families.md` before choosing either. `computed`: system tables only, refused for a new entity (`90234`). A key type missed at create means rebuilding the entity: take it from "Choosing the key type". |
| `id_prefix` | TypeID prefix: required when `id_type` is `typeid` or `is_a`, empty otherwise. The platform takes up to 63 lowercase letters and underscores, starting and ending with a letter, **unique among entities**; a new entity takes its singular (e.g. `account`; see "Choosing the key type"). A `typeid` prefix may be changed later: new ids take the new prefix, existing ids keep theirs, and an id with a former prefix can no longer be inserted. An `is_a` prefix never changes (`90245`), and a new `is_a` entity cannot take a prefix that records of its root still carry, such as one the root used before (`90254`). |
| `id_refentity` | Only with `id_type` `is_a` / `has_a`, and then required: the `table_name` of the base this entity is based on. `is_a` needs a managed `typeid` or `is_a` base; `has_a` a managed `typeid` base (`90240`). Set on create only; never send it on `update_entity` (`90241`). See `entity-families.md`. |
| `id_column` | Leave it unset: the key field is `id`. Like `id_type`, it is fixed on create; an update that changes it fails with `90253`. |
| `managed` | Optional, default `true`. When `false`, automatic DDL for table and field changes is disabled: use it only for external or legacy tables whose DDL is managed outside the platform. |
| `order_column` | Optional. Names an integer field that stores a fixed row order (drag-and-drop). Setting it creates the column, and an insert that sends no value gets the highest value below 900000 plus 10 (10 for the first record). Not available on an `is_a` / `has_a` entity (`90249`). |
| `icon_name` | The icon shown for the entity in the UI: a Lucide icon name in kebab-case or an icon URL (see "Icons are Lucide icons" under the Field Format Quick Reference). Every entity gets one, unless no icon fits. |
| `name_sort` | Optional text sort key that orders entities in navigation. Leave it unset unless the user wants a specific navigation order. |
| `edit_mode` | Optional. Controls how records open for editing: `auto` (default, system decides), `sidebar`, `modal`, or `page`. Set only when the user has a specific UX requirement. |
| `cube_mode` | Optional. OLAP cube generation: `auto` (default, include in cube) or `disabled`. Set to `disabled` to exclude the entity from cube queries. |
| `audit_log` | Optional boolean, default `false`. When `true`, every INSERT / UPDATE / DELETE on this entity is recorded by the platform. Enable on entities where change history matters (contracts, financial records, policy data); leave off for high-volume or ephemeral data where audit noise outweighs the value. |
| `label_parent` | Optional. Names the **one** FK field that is this entity's identity spine — the parent whose composed `_label` prefixes this record's `_label`. Must name a `reference`/`parent` FK; must **not** reference its own entity (`90228`), must **not** target a junction and must **not** be set on a junction or on an `is_a` / `has_a` entity (it comes from the base: overwritten on create, an update is refused with `90242`). Omit for self-identifying records (then `_label` is just the local label). Never on `create_entity`: set it with `update_entity` after the fields exist ("Mandatory Creation Order", step 8). |

### Auto-Generated Fields: NEVER Create These Manually

When `create_entity` is called, the system automatically creates:

| Field | `ctype` | Notes |
|-------|---------|-------|
| `id` | `id` | Primary key (`is_pk: true`), typed by the entity's `id_type`: format `int64` for `auto_increment` and `bigint`, `text`, `uuid`, or `string` for `typeid`, `is_a` and `has_a`. An entity has exactly one `is_pk` field; a second one is refused (`90215`). **Never** create it with `create_field` |
| `<label_column>` | `label` | The actual named field (e.g. `product_name`), created as `text`, titled with `label_column_label` or the platform's default (see "Customizing the label field's title"). Its format is locked (`90219`); it may be renamed and its default value may be changed (the default of every other core column is locked, `90220`) |
| `created_at` |, | Timestamp, auto-maintained |
| `updated_at` |, | Timestamp, auto-maintained |
| `_label` | `_label` | **Composed label** — the record's full human-readable label, folded from its parent chain (spine → … → local `label`). Read-only, read-time; **not** in the `fields` catalog. |
| `<fk>_label` | `fk_label` | Companion of every `reference`/`parent` FK named `X` → `X_label` = the referenced row's composed `_label` (e.g. `customer_id` → `customer_id_label`). Read-only, read-time; **not** in the `fields` catalog. |

> ⚠️ Calling `create_field` for any of these will fail or create duplicates. A bulk call is one transaction: one such row and nothing in the call lands.

**`ctype` marks what kind of column a field is.** It is derived, never sent: a value sent on create is ignored, and changing it on update fails with `90214`.

| `ctype` | Meaning | Protected |
|---|---|---|
| empty | Ordinary field | no |
| `id` | Primary key | yes |
| `label` | Display label | yes, but it may be renamed and its default value changed |
| `audit` | `created_at` and `updated_at` | yes |
| `core` | Other system columns | yes |
| `rollup` | Value aggregated by the database from the field's `rollup` definition (see `rollup-fields.md`) | no |
| `computed` | Value written by one of the entity's `computed_fields` rules | no |

A protected column cannot be deleted (`90217`) or renamed (`90218`), and its format (`90219`) and default value (`90220`) cannot change; the label column is the exception for renaming and for its default value. A `rollup` or `computed` field can still be renamed, deleted, or moved to another format with the same column type; `get_schema` reports these two with `is_core: false`.

> ℹ️ An `is_a` / `has_a` entity gets only `id`, `created_at` and `updated_at`. Its label field, and every other field of its base, are the base's, so create only the entity's **own** fields; a name that repeats a base field fails with `90243`. See `entity-families.md`.

> ℹ️ **`_label` / `<fk>_label` are platform-owned, read-only, read-time projections.** They are absent from the `fields` catalog (`read_field` never returns them) and are **not user-creatable**. Their names are deterministic, so agents select them by the naming convention — e.g. `select=id,_label,customer_id_label` — with **no discovery call**. Never `create_field`, write, or import into them.

> ℹ️ `searchable` and `is_child` on the entity are **read-only** and computed automatically. `searchable` becomes `true` when any field has `searchable: true`; `is_child` becomes `true` when any field uses `format: "parent"`. Never set these manually.

### Platform provenance / meta columns (core-provided; stamp VALUES only, never create)

The base schema ships a set of **core provenance columns** on `entities`, `fields`, `modules`, and `roles`. They are **registered by core with `ctype = 'core'`** — there is **no `is_core` boolean**; `is_core` is *derived* (true unless `ctype` is empty, `rollup` or `computed`) and still surfaces in `get_schema()`, so anything reading `is_core` keeps working. Every column is **NOT NULL with an empty default** (`''` for text, `'{}'` for a json object, `'[]'` for a json array, `'unclassified'` for the `entity_type` enum); "absent" is the empty value, never SQL `NULL`.

| Table | Column | Type / default | Meaning |
|---|---|---|---|
| `entities` | `catalog_entity_code` | TEXT `''`, non-unique | Canonical uber-model code (the rename / dialect / silo join key). `table_name` holds the deployed name and may drift; this does not. Empty = not installed from a catalog design. |
| `fields` | `catalog_field_code` | TEXT `''`, non-unique | Stable design-time field identity (the blueprint field name, e.g. `status`); the field-rename join key, and the field-level twin of `catalog_entity_code`. `field_name` holds the deployed name and may drift; this does not. Empty = not generated from a catalog spec. |
| `entities` | `catalog_owner_module` | TEXT `''` | Owning-module slug for an `embedded_master` placeholder. Soft pointer, not an FK. |
| `entities` | `entity_type` | TEXT `'unclassified'`, CHECK ∈ 6 (`operational_workflow` / `operational_record` / `catalog` / `junction` / `computed` / `unclassified`) | Data-class axis; the write tier derives FROM it. Set it on every `create_entity` (see "Classifying an entity"). |
| `entities` | `catalog_entity_aliases` | JSONB `'[]'`, array | Append-only `{alias_code, source_domain, source_module, decided}` reuse/merge records. |
| `modules` | `catalog_module_code` | TEXT `''`, non-unique | Catalog blueprint / `system_slug` the module was provisioned from. The coarser business-domain grouping is the separate `domain_code` column (many `catalog_module_code`s can share one `domain_code`). |
| `roles` | `catalog_role_code` | TEXT `''`, non-unique | Catalog persona the role was provisioned from. |

`use-semantius` exposes no tool to look up or install a catalog blueprint. A module built here is built by hand, and its catalog codes stay empty (`''`); only a module installed from a catalog design has them. Do not search for a catalog or deploy tool, and do not invent a `catalog_*_code` value.

**Rules for every skill that writes the catalog:**

- **Never `create_field` these columns** — core provides them. Write **values only**: a catalog install stamps the catalog codes and aliases, and every `create_entity` sets `entity_type` itself.
- **Never write `ctype`** — it is privilege-locked. There is nothing to set to mark a column "core"; that is core's job.
- The scalar codes (`catalog_entity_code` / `catalog_field_code` / `catalog_module_code` / `catalog_role_code`) are **write-once**: set on create, or filled once while empty, then never changed; a later rename touches `table_name` / `field_name` / `module_slug` only. `catalog_entity_aliases` is **append-only** (never rewrite or drop prior elements).
- Test emptiness as `= ''` / `= '{}'::jsonb` / `= '[]'::jsonb` / `= 'unclassified'`, **never `IS NULL`**.

### Choosing the key type

An entity's key is `auto_increment` (omit `id_type`): a number the database assigns, 1, 2, 3. An entity takes `id_type: "typeid"` in two cases only:

- **It is in an `is_a` / `has_a` family.** The base of a family is `typeid`, because the platform refuses any other base (`90240`), and an `is_a` subtype takes its own prefix; a `has_a` extension takes its base's key (`entity-families.md`).
- **The user asked for it,** in their own words, for an entity or for the records whose ids leave Semantius.

A TypeID such as `vendor_contract_01h455vb4pex5vsknk084sn02q` is opaque and unique among all entities, like a Salesforce record Id or a ServiceNow `sys_id`, so it can appear in a URL, an email or another system. A number is unique only within its entity, and the next one can be guessed. The key is fixed at creation: `id_type` is locked (`90233`), so an entity with an `auto_increment` key that is asked to take `typeid` is rebuilt, with its records. When a request meets an existing entity, say so before anything is changed.

**The prefix** is the entity's singular, leaving out any digit (`vendor_contract` for `vendor_contracts`). An `is_a` entity's prefix follows the same rule. `call-file.ts` and `writeModel` refuse a prefix that is not the singular and one prefix on two entities of a payload, and `call-file.ts` also refuses a prefix another entity on the host already has.

The prefixes in use are read with one `read_entity` (`id_prefix=in.(…)`) for the entities that take one, when the outline is compared with the instance (`build-module.md`, step 1). A prefix that is taken is settled with the user like a name clash, before anything is written. The key type is modeled, never asked.

### Choosing the label

`label_column` names the field people tell the records apart by. Every entity has one, except a junction and an `is_a` / `has_a` entity (see `label_column` under "Key Entity Fields"). A label never copies the id: a list whose names repeat its ids tells people nothing, and every `<fk>_label` that points at the record repeats them. Take the first case that fits:

1. **The record carries its own name, title or number,** one people already call it by outside this form: a product's name, a contract's title, a supplier's invoice number. That text field is the label column. A field added only so the record has something to show is not one: when people would not name the record unless the form asked them to, take case 2. When the name repeats across the records of a parent (a section titled "Introduction" in many documents), that parent is its `label_parent` ("Mandatory Creation Order", step 8).
2. **Otherwise the records it relates name it.** An enrollment is a student in a course: "Ana Silva – Calculus I". The label column is `<singular>_name` (`enrollment_name`), and a `computed_fields` rule fills it. The rule reads each related record with `set_record` and joins their label columns with " – ", in the order people say them. When the same related records can appear on several records, it adds the record's own fields that tell those apart, such as a date. The builder script makes the rule with `composedLabel` (`jsonlogic-kit.ts`; `jsonlogic.md` → "Canonical patterns", Pattern 3, shows what it returns):

   ```typescript
   const enrollmentName = composedLabel("enrollment_name", [
     { via: "student_id", table: "students", column: "student_name" },
     { via: "course_id", table: "courses", column: "course_title" },
   ]);
   ```

   A field of the record itself is a part too: `{ field: "start_date" }`, or for an enum `{ field: "enrollment_type", labels: { audit: "Audit", credit: "Credit" } }`, so the label shows the enum's words, not its stored value.

   - `set_record` reads a related record's stored columns, never its `_label` or `<fk>_label`. Name that record's label column, which is its `<singular>_name` when its own label is composed.
   - The record being written has no `_label` or `<fk>_label` either: a read adds them. A `computed_fields` or `validation_rules` rule that reads one gets null, so `writeModel` and `call-file.ts` refuse it and print the `composedLabel` call to use.
   - On an update where a relationship field is set but its record reads as `null` (the writer may not see it), the rule keeps the stored label.
   - The label is stored when the record is written: a renamed student shows in an enrollment's label after the enrollment's next write.
   - The rule already names the related records, so the entity takes no `label_parent` to any of them.
The platform titles the label field when it creates it, so a composed `<singular>_name` reads "Name" ("Customizing the label field's title"). The label is modeled, never asked.

### Customizing the label field's title

`create_entity` creates the label field (the field named in `label_column`) with its title. Without `label_column_label`, the title is the label column in words, each word capitalized, with the entity's singular or plural left out where the column starts with it:

| Entity | `label_column` | Title |
|---|---|---|
| `products` | `product_name` | Name |
| `job_openings` | `job_opening_title` | Title |
| `cars` | `license_plate` | License Plate |
| `offers` | `offer_number` | Offer Number |

A column ending in `_number`, `_no`, `_id` or `_code` keeps the entity's word, as `offer_number` does. Take the default unless another title fits better. In that case pass `label_column_label` in the same `create_entity` item (`{"table_name": "offers", "label_column": "offer_number", "label_column_label": "Offer #"}`): the field is created with that title, and no `update_field` follows.

An `is_a` / `has_a` entity takes its base's label field, title included: send it no `label_column_label`. The title can change later with `update_field` on the `<label_column>` field, and `entities.label_column_label` follows it. Keep `singular_label` the bare noun (`Car`) and the field's title on the field: a title such as `"Car License Plate"` in `singular_label` breaks plural/singular symmetry and shows up everywhere the entity's name appears.

### Computed fields and validation rules (entity-level JsonLogic)

Every entity carries optional `computed_fields` / `validation_rules` JSON arrays
(default `[]`; set on `create_entity`, replaced wholesale on `update_entity`: send the full list, a partial list deletes the rest)
that derive values and enforce invariants on every write. Caller-supplied values
for a computed field are silently overwritten with the rule's result, unless the rule
returns the field itself (an approval stamp on an import: `rbac.md` → "Controls on a gate", control 5).
→ Full reference (evaluation semantics, reserved variables, platform-extension
operators, cross-entity lookups): `jsonlogic.md`.

### Row-level read access via `select_rule` (entity-level JsonLogic)

Every entity carries a `select_rule` JsonLogic object (default `{}`); when non-empty it
drives a per-row `FOR SELECT` RLS policy. **A non-empty rule REPLACES `view_permission`
for reads — a rule without a `has_permission` disjunct locks out admins.** The same
predicate is also AND-ed into the `UPDATE` / `DELETE` row filter (`edit_permission` AND
rule), so it constrains which rows can be modified, not only read. Adding, modifying,
or removing a rule is medium-risk.
→ Full reference: `select-rule.md`.

---

## Fields

> ⚠️ **The #1 field-creation trap: there is no `required` column.** To make a field mandatory, set **`input_type: "required"`** — never `"required": true`. To make it unique, set **`unique_value: true`**. Sending a `required` key to `create_field` fails: the live tool schema has no such field. Likewise **never send `is_nullable`** — the platform computes nullability from `format`. These are the most common "wrote it from memory" errors; the rest of this section gives the full property list.

### Field Naming Rules

- **snake_case, descriptive, no abbreviations:** `customer_email_address`, not `cust_email`.
- **Include the noun the field describes:** `invoice_total_amount`, not `total`.
- **A field that holds a relationship is `<target_singular>_id`, or names the record's part in the relationship and ends in `_id`:** `account_id`, `assigned_user_id`, `parent_case_id`, `manager_id`.
- **Fixed names win:** the lifecycle state field is `workflow_state` (see `default_value` below); reserved names are in the 🛑 note under "Field Format Quick Reference".
- **Only when the user asks to follow a product's names** (to move data to and from it): spell each name the way the product does and convert it with `vendor-names.ts` (`SKILL.md` → Reference Files), never by hand. When your knowledge of the product falls short, read its own API or data-export reference, and use only names those pages confirm.

### Field Format Quick Reference

Choose `format` carefully. Format **can** be changed after creation on a managed entity, but **only to a format that maps to the same physical Postgres column type**. Such transitions are allowed (`text → multiline → html`, all `TEXT`); any other is refused with `90223` (`text → date`, `integer → number`, `int32 → int64`, `date → boolean`): drop and recreate the field instead. The mapping is visible in the format-to-type table later in this reference (under `default_value`). A reference takes the type of the key it points at, so `text → reference` of a TEXT-keyed entity is allowed. **Core columns are the exception:** a field with a core `ctype` (the key, the label column, `created_at` / `updated_at`) never changes format, not even to a format with the same type (`90219` "Cannot change format of core system field"), and its default value is locked too (`90220`), except the label column's. So a label column can never become an `enum`, even though both are `TEXT`. Still pick the format deliberately on the first pass: a later change re-renders the form (input shape) and may require republishing UI surfaces, even though the column data survives.

| Category | `format` values |
|----------|----------------|
| Text | `string`, `text`, `multiline`, `html`, `code` |
| Numbers | `integer`, `int32`, `int64`, `number`, `float`, `double`, use `number` (stored as `NUMERIC(18, scale)`) for every amount of money. Pair with `precision` (digits after the decimal; default `2` suits money, set `4`–`6` for tax/FX rates, `0` for integer-like NUMERIC counts). `float`/`double` are binary IEEE-754 and lose cents on rounding, only use them when the user explicitly requests them or the value is inherently imprecise (scientific measurements, ML scores, GPS coordinates) |
| Dates/Time | `date`, `time`, `date-time`, `duration` |
| Boolean | `boolean` |
| Choice | `enum` (also set `enum_values`: each entry is a value or a `{"value", "label"}` object that may also carry an optional `description`, `color` and `icon`, e.g. `[{"value": "draft", "label": "Draft", "color": "#64748b"}, {"value": "on_hold", "label": "On hold", "color": "#f59e0b"}]`; see "Enum values and labels" below). Never for a date, a real number or an amount, however few distinct values it has: those are `date` / `date-time` or `number` |
| Display | `color` (an HTML color), `icon` (a Lucide icon name or an icon URL, see below), `rating` (an integer 0–5, `0` = not rated; use for star ratings and 5-point scores, never for general integers) |
| Structured | `json`, `object`, `array`, `jsonlogic` |
| Identifiers | `uuid`, `email`, `uri`, `url` |
| Binary | `binary` (stored as `BYTEA`) |
| Other text formats | `jsonata`, `password`, `uri-reference`, `iri`, `iri-reference`, `uri-template`, `idn-email`, `hostname`, `idn-hostname`, `ipv4`, `ipv6`, `regex`, `json-pointer`, `json-pointer-uri-fragment`, `relative-json-pointer`, `byte` |
| A record that stands on its own | `reference` + `reference_table` |
| A part of its parent | `parent` + `reference_table` |

> ℹ️ **The other text formats are plain `TEXT` columns.** Each one chooses the form control; the database does not check the shape of the value. `password` only masks the input: the value is not hashed and reads return it like any other field, so never describe it as secure storage.

> ℹ️ **Colors are written as hex.** A `color` field, the `color` of an enum entry and a module's `logo_color` accept any HTML color; write lowercase `#rrggbb` (e.g. `#22c55e`). A value read back from the platform is kept as it is.

> ℹ️ **Icons are Lucide icons.** An `icon` field, the `icon` of an enum entry and the `icon_name` of a module or entity take a Lucide icon name in kebab-case (e.g. `circle-check`, `users`, `shopping-cart`; never the PascalCase React component name `CircleCheck`), or an icon URL. The UI always uses the latest Lucide release, so every current icon is available.
>
> - **Find every name in one call.** Put every label in one `--batch -` call. Each label maps to an array of up to five queries of one or two words each, most specific first:
>
>   ```bash
>   echo '{"Vendors":["store","building"],"Contracts":["file signature","file text"]}' | bun "<skill-folder>/references/lucide-icon-finder.ts" --batch -
>   ```
>
> - **Take the first icon, in query order, that fits the meaning.** A query of several words matches only icons that have them all. If every query of a label returned `(none)`, run that label once more with other single words. If none fits, an enum entry and an entity get no icon and a module icon is `box`.
> - Plain arguments (`lucide-icon-finder.ts "user plus" user person "contact card"`) are alternatives for **one** meaning. Each icon is listed only once across them, so several labels never go in plain arguments.
> - **Names are checked where they are written.** `call-file.ts` refuses an `icon_name` or an enum entry's `icon` that is not a Lucide icon, `writeModel` refuses it before it writes, and `module-rbac-setup.ts` refuses such an `--icon`; a URL always passes. An icon written any other way (a value in an `icon` field of a record) is confirmed with `bun "<skill-folder>/references/lucide-icon-checker.ts" <name…>` (exit 1 names the unknown ones).
> - From another skill the folder is `"<skill-folder>/../use-semantius/references/"`.
>
> Both scripts need no network: they read `lucide-icon-tags.json`, a snapshot of a Lucide release bundled next to them, so an icon added to Lucide after that release is reported unknown, as is a deprecated Lucide alias such as `building-2` (use `building-complex`); pick another name.

> 🛑 **Any field with `reference_table` MUST use `format: "reference"` or `format: "parent"`. Never combine `reference_table` with scalar formats (`integer`, `uuid`, `string`, etc.). This will always fail.**

**Picking between text formats.** All five resolve to a Postgres `TEXT` column; the format selects the UI input shape. Because they share a primitive, the format **can be changed among them after creation** — `text → multiline → html` is safe and accepted by `update_field`. The choice still matters up front because flipping later re-renders the form and may force a UI republish. Cross-primitive changes (e.g. `text → date`) are rejected by the platform.

- `string` and `text` are **single-line** inputs — names, titles, labels, email-like identifiers, short tags. The form renders a single-line `<input>`. Use these for any field that holds a short value displayed on a single row.
- `multiline` is the **multi-line** input for prose. The form renders a `<textarea>`. Pick `multiline` whenever the field holds prose the user might paste a paragraph into; pick `text` / `string` when the value is a single line.
- `html` renders a rich-text editor on top of HTML storage; reserve for fields that need formatted output (release notes, marketing copy).
- `code` renders a monospace code editor; reserve for stored source / configuration snippets.

> 🛑 **Reserved field names.** A `field_name` must **not** start with `_` (reserves the entity's own `_label`); the platform rejects it on create and on rename (`90224`). A name ending in `_id_label` is accepted, but it shadows the generated `<fk>_label` companion of the FK `<fk>` when both exist, so avoid it. Plain `*_label` names (e.g. `status_label`) remain allowed.

### `width` Values

| Value | Use |
|-------|-----|
| `default` | **Default, always use this** unless a specific layout requirement exists |
| `s` | Small (short text, booleans, status badges) |
| `m` | Medium |
| `w` | Wide (long text, descriptions) |

### `input_type` Values

| Value | Meaning |
|-------|---------|
| `default` | Standard editable input, use for most fields |
| `required` | Editable and mandatory, enforced by the platform, not only in the UI |
| `readonly` | Displayed but not editable, **never import into this** |
| `disabled` | Grayed out, not editable, **never import into this**, except an approval stamp on a record created past its step (`rbac.md` → "Controls on a gate", control 5) — this is the canonical mode for **computed fields** (platform owns the value, caller payloads are silently overwritten on every write unless the rule returns the field itself; see `jsonlogic.md`) |
| `hidden` | Not shown in forms |

> ℹ️ The composed-label columns `_label` / `<fk>_label` are **always** platform-owned and read-only regardless of `input_type` — they are read-time projections, never authored fields, so this table does not apply to them. Never write or import into them.

### Dynamic `input_type` via `input_type_rule` (field-level JsonLogic)

Every field carries an optional `input_type_rule` JsonLogic object that overrides the
static `input_type` per record at form-render time. UI-only and fails open — a field
rendered `hidden` / `readonly` is still writable via API; server-side enforcement
belongs in `validation_rules` (see `jsonlogic.md`). A non-empty rule also removes the
database check of `required` for that field, because the rule can turn `required` off per record.
Use it whenever a field's input mode depends on the record: required, readonly, disabled or hidden in some states and editable in others (for example `rejection_reason`, needed while `workflow_state` is `rejected`: the rule returns `required` in that state and `hidden` otherwise, as the next section says). The `input_type_rule` only shapes the form, so also add a `validation_rules` entry on the entity that enforces the same condition for every caller, unless the user says the restriction is cosmetic. For `rejection_reason`: `{"code": "99010", "name": "rejection_reason_when_rejected", "message": "A rejected request needs a rejection reason.", "jsonlogic": {"if": [{"==": [{"var": "$mode"}, "delete"]}, true, {"if": [{"==": [{"var": "workflow_state"}, "rejected"]}, {"!=": [{"var": "rejection_reason"}, ""]}, true]}]}}`, and the field's `input_type_rule` is `{"if": [{"==": [{"var": "workflow_state"}, "rejected"]}, "required", "hidden"]}`. Read a field with `{"var": "<field>"}`, never as a bare string.
→ Full reference: `jsonlogic.md`.

### Fields that apply only to some enum or boolean values

A required pass before the write, in a build and whenever a field, an enum or a boolean is added to an entity. For every `enum` and `boolean` of the entity, `workflow_state` first, name the fields that make sense only for some of its values: `sold_date` and `sale_price` when the record is `sold`, `rejection_reason` when it is `rejected`, `recurrence_interval` when `is_recurring` is on. A field that applies to every value, or that is useful before the value is reached (`target_close_date`), stays plain. List every value where the field applies, later states included: `approved_at` still applies once the record is `closed`.

Each such field gets an `input_type_rule`, by how it is filled in those values. Its static `input_type` stays `default`, never `required`.

| In those values the field is | The rule returns there | The rule returns otherwise | Validation rule |
|---|---|---|---|
| Needed, filled in by the user | `required` | `hidden` | Yes |
| Optional, filled in by the user | `default` | `hidden` | No |
| Filled by a `computed_fields` rule | `readonly` | `hidden` | No |

The rule is `{"if": [{"==": [{"var": "workflow_state"}, "sold"]}, "required", "hidden"]}`, or with several values `{"if": [{"in": [{"var": "workflow_state"}, ["approved", "closed"]]}, "readonly", "hidden"]}`, or on a boolean `{"if": [{"==": [{"var": "is_recurring"}, true]}, "required", "hidden"]}`.

An `input_type_rule` never blocks a write, so the validation rule on the entity is what refuses a missing value. Write one per set of values, naming every field needed there, guarded with `$mode` so a record written before the rule can still be deleted. A new entity carries it on `create_entity`; an existing one takes `update_entity` with its full list. Hiding needs no validation rule: a value left behind when the record moves on stays stored, and a form cannot clear a hidden field.

What counts as empty depends on the format, because only three formats can be `NULL` (see "`default_value`"):

| Format | Empty value | The value is set when |
|---|---|---|
| `date`, `date-time`, `reference` | `NULL` | `{"!=": [{"var": "<field>"}, null]}` |
| `number`, `float`, `double`, the integer formats, `rating` | `0` | `{"!=": [{"var": "<field>"}, 0]}` |
| Text formats and `enum` | `''` | `{"!=": [{"var": "<field>"}, ""]}` |

A needed number for which 0 is a real value and a needed `boolean` cannot be told from empty, so they stay out of the validation rule. Worked example: `jsonlogic.md` → "Dynamic `input_type` via `input_type_rule`".

### `unique_value`

Set `unique_value: true` only when duplicates would cause data integrity issues (e.g., `email` on contacts, external system keys).

It creates a partial unique index: for string formats, `NULL` and `''` are exempt, so any number of records can leave the field empty. To refuse an empty value as well, set `input_type: "required"`.

> ⚠️ Adding `unique_value: true` to an **existing** field is medium-risk, will fail if duplicates exist. Warn the user and suggest deduplication first.

### `default_value`: auto-filled by the platform; authors only override

When `default_value` is blank, the column-add trigger gives a NOT NULL column the zero value of its type, chosen by `format`:

| Format | PostgreSQL type | Auto-default when `default_value` is blank |
|---|---|---|
| `string`, `text`, `multiline`, `email`, `url`, `color`, `icon`, …  | `TEXT` | `''` |
| `int32`, `int64`, `integer` | `INTEGER` / `BIGINT` | `0` |
| `rating` | `INTEGER` | `0` (not rated). The database does not check the 0–5 range (a client library does) and refuses only `0` on a required rating; a required rating needs a value from 1 to 5 |
| `number` | `NUMERIC(18, scale)` | `0.0` |
| `float` | `REAL` | `0.0` |
| `double` | `DOUBLE PRECISION` | `0.0` |
| `boolean` | `BOOLEAN` | `FALSE` |
| `json`, `jsonlogic`, `object` | `JSONB` | `'{}'` |
| `array` | `JSONB` | `'[]'` |
| `uuid`, `time`, `duration`, `binary` | `UUID` / `TIME` / `INTERVAL` / `BYTEA` | none: no zero value, so every insert must send one |
| `date-time`, `date`, `reference` | `TIMESTAMPTZ` / `DATE` / key type | none: the column allows NULL |
| `enum` | `TEXT` (with CHECK) | `''`: a required enum refuses it (`90258`), so give it a `default_value` |

Nullability is also computed by format (via the platform's `is_nullable()` rule): **only `reference`, `date`, and `date-time` allow NULL**. Every other format is `NOT NULL`, with the zero value above when `default_value` is blank. Non-required fields accept `''`/null as a backfill.

**Rule:** `default_value` is optional on `create_field`. Set it when the zero value is wrong for the domain (a non-zero starting balance, a specific seed string) and always on a required `enum`.

- **A required enum has no automatic default.** With no `default_value` the default is `''`, which a required enum refuses (`90258`): every write must send a value, and adding the field to a table with rows fails (`90259`). Pass `default_value` (the value, never the label). The order of `enum_values` only affects display; list values in lifecycle order (`draft`, `pending`, `new`, `open`, `active` first) for that reason.
- **The lifecycle state field is named exactly `workflow_state`.** An entity with a lifecycle (an ordered set of states a record moves through, such as `draft` → `submitted` → `approved`) stores it in one required `enum` field named `workflow_state`: `enum_values` are the states in order, `default_value` is the initial state. Never `status`, `state` or `lifecycle_state`. Gates, `value_changed` rules and `process_gates.state_column` refer to this name. Every other enum keeps its domain name, even one whose values look like states. Before creating it, read the entity's fields and do not add a second state field when `workflow_state` exists.
- **Title it with the domain's word for the state.** The name is fixed; the title is not: the word people in the domain use for where a record stands, such as "Stage" or "Status". "Workflow State" is the title when no domain word fits.
- **Limits and SQL expressions.** A `default_value` has at most 200 characters, with no `;`, `--` or `/*`. It is evaluated only when it exactly matches (case-insensitive) one of `CURRENT_TIMESTAMP`, `CURRENT_DATE`, `CURRENT_TIME`, `LOCALTIMESTAMP`, `LOCALTIME`, `now()`, `clock_timestamp()`, `statement_timestamp()`, `transaction_timestamp()`, `gen_random_uuid()`, `CURRENT_USER`, `SESSION_USER`. Any other text is a literal cast to the column's type, never evaluated.
- **`default_value` is stored as text**, whatever the format. A number or boolean is converted (`1` is stored as `"1"`, `true` as `"true"`), and a JSON array or object as its JSON text. Give a value that fits the format: a whole number for an integer field, `true` or `false` for a boolean, valid JSON for a JSON field. Example: a required `integer` field `seats_purchased` with a `>= 1` rule takes `"default_value": "1"` (or `1`), because the auto-default `0` would break the rule.
- **There is no settable `is_nullable` flag** — nullability is computed purely from `format` (the `is_nullable()` rule above): only `reference`, `date`, and `date-time` are nullable. For every other format the column is NOT NULL regardless of `input_type`; declaring the field optional doesn't make it nullable.

A required enum on a possibly-non-empty entity always includes `default_value`. `.tmp_deploy/departments-fields.json`:

```json
{
  "data": {
    "table_name": "departments",
    "field_name": "workflow_state",
    "title": "Status",
    "format": "enum",
    "enum_values": [
      {"value": "active", "label": "Active", "color": "#3b82f6", "icon": "circle-play"},
      {"value": "inactive", "label": "Inactive", "color": "#64748b", "icon": "circle-slash"}
    ],
    "default_value": "active",
    "input_type": "required",
    "width": "default"
  }
}
```

```bash
bun "<skill-folder>/references/call-file.ts" create_field .tmp_deploy/departments-fields.json
```

### Enum values and labels

An `enum_values` entry is either a plain value (`"draft"`) or a `{"value", "label"}` object (`{"value": "on_hold", "label": "On hold"}`), and the two forms can be mixed. An object may also carry an optional `description`, `color` (an HTML color) and `icon` (a Lucide icon name); these are UI hints only. **Records store the value; the label, description, color and icon are only what the UI shows.** Rules:

- Write every entry as an object with a `label` and a `color`. The label is the value in words, in sentence case (`{"value": "checked_out", "label": "Checked out"}`), or the full term for a code or an abbreviation (`{"value": "nda", "label": "Non-disclosure agreement"}`); an entry without a label shows its raw value. The color follows "Enum colors" below. An object always carries `label`.
- **Give every entry of every enum an `icon` that fits its meaning.** Take it from "Enum icons" below; put every label that fits no row there in one `lucide-icon-finder.ts --batch -` call ("Icons are Lucide icons"). When the finder finds nothing that fits, the entry has no icon. Never write an icon name from memory: `call-file.ts` refuses one that is not a Lucide icon.
- `description` is the exception: add it only when the label is not self-describing (an internal code, a term of art, two choices a user could confuse). A label like "Approved" needs none.
- Never an object map like `{"draft": "Draft"}`: `enum_values` is always an array.
- Writes, filters, `default_value` and JsonLogic compare against the **value**, never the label. Only the value reaches the CHECK constraint and the column default.
- Reading `enum_values` back (or the `enum` list of a property in `get_schema`) returns the entries as defined, so an object comes back as an object with any `description`, `color` and `icon` it carries: take its `value`. `get_schema` also lists `""` for an enum that is not required.
- Changing only a label, description, color or icon is cosmetic (records keep their values); adding, removing or renaming a value is a schema change (see Safe Evolution).
- `update_field` replaces the whole `enum_values` array, so send every entry back with all of its keys; an entry sent without its `color` loses it. Removing a value still in use is refused (`23514`).

`.tmp_deploy/contracts-fields.json`:

```json
{"data": [
  {"table_name": "contracts", "field_name": "contract_type", "title": "Contract Type", "format": "enum",
   "enum_values": [
     {"value": "msa", "label": "Master services agreement", "color": "#3b82f6", "icon": "handshake"},
     {"value": "nda", "label": "Non-disclosure agreement", "color": "#ec4899", "icon": "lock"},
     {"value": "sow", "label": "Statement of work", "color": "#14b8a6", "icon": "clipboard-list"}
   ],
   "default_value": "msa", "input_type": "required", "width": "default"},
  {"table_name": "contracts", "field_name": "workflow_state", "title": "Status", "format": "enum",
   "enum_values": [
     {"value": "draft", "label": "Draft", "color": "#64748b", "icon": "file-pen"},
     {"value": "on_hold", "label": "On hold", "color": "#f59e0b", "icon": "circle-pause", "description": "Waiting for the counterparty to countersign"},
     {"value": "signed", "label": "Signed", "color": "#22c55e", "icon": "circle-check"}
   ],
   "default_value": "draft", "input_type": "required", "width": "default"}
]}
```

```bash
bun "<skill-folder>/references/call-file.ts" create_field .tmp_deploy/contracts-fields.json
```

#### Enum icons

Take the icon of the row whose meaning the entry's label carries. Put every label that fits no row in one `lucide-icon-finder.ts --batch -` call and take the first hit that clearly matches the meaning.

| Entry meaning | `icon` | Entry meaning | `icon` |
|---|---|---|---|
| draft, new | `file-pen` | approved, done | `circle-check` |
| submitted | `send` | completed | `check-check` |
| in review, pending, waiting | `clock` | active, in use | `circle-play` |
| upcoming | `calendar-clock` | on hold, suspended, idle | `circle-pause` |
| renegotiated | `refresh-cw` | blocked | `ban` |
| trial | `hourglass` | canceled, failed | `circle-x` |
| rejected | `x` | expired, retired, revoked, inactive, void | `circle-slash` |
| overdue | `circle-alert` | on leave | `tree-palm` |
| disputed | `scale` | left | `log-out` |
| low (level) | `signal-low` | medium (level) | `signal-medium` |
| high (level) | `signal-high` | critical (level) | `siren` |
| paid | `circle-dollar-sign` | | |

#### Enum colors

Write each hex in lowercase, exactly as listed. No two entries of one enum share a color.

**Enums whose values are states or levels**, `workflow_state` among them, take each entry's color by its meaning. When two or more entries share a meaning (`submitted` and `in_review` are both waiting), the first takes the `color`, the next ones the shades in order:

| Entry meaning | `color` | Shades |
|---|---|---|
| draft, new, initial | `#64748b` | `#475569` · `#94a3b8` |
| active, open, in progress | `#3b82f6` | `#2563eb` · `#60a5fa` |
| waiting, on hold, pending | `#f59e0b` | `#d97706` · `#fbbf24` |
| done, approved, closed as success | `#22c55e` | `#16a34a` · `#4ade80` |
| canceled, failed, rejected | `#ef4444` | `#dc2626` · `#f87171` |
| levels: low · medium · high · critical | `#64748b` · `#3b82f6` · `#f59e0b` · `#ef4444` | |

Past the listed shades, a further entry of that meaning gets another shade of the same hue that the enum does not use yet.

**Every other enum:** an entry whose label carries one of the meanings above takes that color (`approved` → `#22c55e`). Red, amber and green go only to such entries, never to an entry whose label does not relate to them (never red for `approved`). Every other entry takes the next color of this set that the enum does not use yet, in order:

| # | Color | `color` |
|---|---|---|
| 1 | blue | `#3b82f6` |
| 2 | pink | `#ec4899` |
| 3 | teal | `#14b8a6` |
| 4 | slate | `#64748b` |
| 5 | cyan | `#06b6d4` |
| 6 | purple | `#a855f7` |

Purple is last because next to blue it is easy to miss; an enum with few entries never gets it. Once the set is used up, each further entry gets a new hex that is not red, amber or green in hue.

### `cube_type` Values

Controls how a field participates in OLAP cube generation (only relevant when the entity has `cube_mode: "auto"`).

| Value | Meaning |
|-------|---------|
| `disabled` | Field excluded from cube |
| `auto` | **Default.** System infers dimension or measure from `format` |
| `dimension` | Explicit grouping axis (e.g. category, region, status) |
| `measure` | Explicit numeric aggregation (e.g. revenue, count) |

When to set `cube_type` explicitly:

- `dimension`: categorical fields the user will group or filter by (status, country, product type)
- `measure`: numeric fields the user will aggregate (amount, quantity, duration)
- `disabled`: fields that should be excluded from cube queries even if `cube_mode: "auto"` is set on the entity (e.g. internal audit fields, raw foreign keys)
- `auto`: default; leave unset unless the system inference is incorrect

### Example: Add Fields to an Entity

All new fields of an entity go into **one** `create_field` call — `data` is an array, and the items may carry different keys (`searchable` on one, `precision` on another, `enum_values` + `default_value` on a third; a key omitted from an item takes the column default). One request, one transaction, one array back. `.tmp_deploy/products-fields.json`:

```json
{
  "data": [
    {
      "table_name": "products",
      "field_name": "description",
      "title": "Description",
      "format": "multiline",
      "width": "default",
      "input_type": "default",
      "searchable": true
    },
    {
      "table_name": "products",
      "field_name": "price",
      "title": "Price",
      "format": "number",
      "precision": 2,
      "width": "default",
      "input_type": "default"
    },
    {
      "table_name": "products",
      "field_name": "workflow_state",
      "title": "Status",
      "format": "enum",
      "enum_values": [
        {"value": "draft", "label": "Draft", "color": "#64748b", "icon": "file-pen"},
        {"value": "active", "label": "Active", "color": "#3b82f6", "icon": "circle-play"},
        {"value": "discontinued", "label": "Discontinued", "color": "#475569", "icon": "circle-slash"}
      ],
      "default_value": "draft",
      "width": "default",
      "input_type": "required"
    }
  ]
}
```

```bash
bun "<skill-folder>/references/call-file.ts" create_field .tmp_deploy/products-fields.json
```

No `field_order`: the platform places each new field after the entity's existing fields, in array order, so list the items in the order they should display.

Three separate `create_field` calls for the three fields would be three round trips with no atomicity — the failure the batching rule (Golden Rule 7) names. Duplicate check first, in one read: `read_field '{"filters": "table_name=eq.products&field_name=in.(description,price,workflow_state)"}'`.

### All Field Properties

| Property | Type | Notes |
|----------|------|-------|
| `table_name` | string | Target entity, required |
| `field_name` | string | Snake_case identifier. Renaming is supported but think twice: views, integrations, and saved queries reference the field by name. |
| `title` | string | Human-readable label shown in UI |
| `description` | string | Explains what the field represents |
| `format` | string | Changeable only to a format with the same physical database type (e.g., one string format can swap to another string format; `int32` to `int64` is refused with `90223`). See format table above. |
| `width` | string | `default` (default), `s`, `m`, `w` |
| `input_type` | string | `default`, `required`, `readonly`, `disabled`, `hidden` |
| `field_order` | integer | Display position in the UI. **Omit it on create**: the platform gives each new field the next position after the entity's existing fields, in array order. Set it only to put a field at a specific position (on create, or later with `update_field`), and read the entity's live `field_order` values first: the auto-created fields already hold positions (the label field sits at 20), and a tie is not an error, the UI just renders the tied fields in an unpredictable order. Choose a value strictly between the two live neighbors the field should sit between (e.g. 25 between 20 and 30), or above the highest value below 900000 to put it last. The automatic numbering ignores values from 900000 up (`created_at` and `updated_at` sit at 999998 and 999999); keep every other field below 900000. |
| `searchable` | boolean | Adds this field to the entity's full-text search index |
| `unique_value` | boolean | Enforces uniqueness at database level through a partial unique index: for string formats, `NULL` and `''` are exempt. See `### unique_value` above. |
| `enum_values` | array | Required when `format: "enum"`: the allowed entries, each a value or a `{"value", "label"}` object with an optional `description`, `color` and `icon`. Records and `default_value` hold the value, never the label; never an object map. See "Enum values and labels" above. |
| `precision` | integer (0–18) | For `format: "number"` only, number of digits after the decimal point in the generated `NUMERIC` column. Defaults to `2` (suits money and most measured quantities). Set higher (e.g. `4`–`6`) for tax rates, FX rates, or scientific values; `0` for integer-like counts that still want NUMERIC semantics. |
| `default_value` | string | Override for the platform's auto-default. Only set when the auto-default is wrong for the domain. See `### default_value` above for the auto-default table per format, the 200-character limit and the SQL expressions it evaluates. Stored as text: a number or boolean is converted (`1` → `"1"`, `true` → `"true"`), a JSON array or object to its JSON (`{}` → `"{}"`). |
| `reference_table` | string | Target entity's `table_name` for `reference`/`parent` fields |
| `reference_delete_mode` | string | `restrict`, `clear`, or `cascade`. On an `is_a` entity never `cascade` (`90249`): set `restrict` or `clear` explicitly, on `parent` fields too. |
| `relationship_label` | string | Verb for the relationship, set on every `reference` and `parent` field in the same `create_field` call that creates it; omitted, the platform writes `has`. Read it as `<Referenced Entity> <label> <Holding Entity>` (e.g. `"employs"` on `employees.department_id`). Used as the arrow label in module diagrams and in navigation labels. See "Relationship labels". |
| `singular_label_parent` | string | `parent` fields only. The noun in the add button of this field's child list on the parent's page: `"Permission"` gives "Add Permission". |
| `plural_label_parent` | string | `parent` fields only. The title of the button on the parent's page that opens this field's child list: `"Permissions"` gives "Permissions…". Empty, the button uses the child entity's plural label (an Entity page shows "Fields…"). Set the pair on every `parent` field of a junction, and when one child has two or more `parent` fields to the same parent. See "Relationship labels". |
| `cube_type` | string | OLAP cube participation: `disabled`, `auto` (default), `dimension`, `measure`. See `### cube_type Values` above. |
| `catalog_field_code` | string | Core provenance column: stable design-time field identity (the blueprint field name, e.g. `status`), the field-rename join key. Write-once: set on create or filled once while empty, then never changed. Empty = not generated from a catalog spec. See "Platform provenance / meta columns" above. |

---

## Relationships

### Choosing the Right Format

**What the format does in the app.** A `parent` child is a part of its parent. It has no menu entry: people see, add and change it only on its parent's page, and a role that cannot open the parent cannot reach it. A `reference` record stands on its own. It has its own menu entry and list, and it is not listed on the page of the record it points at. A rollup works over either format; when the child's `view_permission` differs from the parent's, see `rollup-fields.md` → "Hidden child rows".

**The format also sets nullability.** A `parent` column is NOT NULL in every state, whatever its delete mode. A `reference` column allows NULL; it becomes mandatory with `input_type: required` and delete mode `restrict`, and `required` with `clear` is refused (`90257`). There is no `is_nullable` flag to pass.

**A relationship is a `parent` only when all three of these hold. Otherwise it is a `reference`.** Answer them for each relationship field on its own, from how the leading products handle these records:

1. **The child never exists without its parent.** No path saves it without one, in any state: not a form, a draft, an import or an integration. It never has to outlive its parent either.
2. **The child is created as part of the work on its parent.** From how the leading products split the work, name the people who create the child and the people who work the parent. A `parent` child is created by the people working on the parent, as part of that work. A child that other people create as their own work, looking the parent up, is a `reference`.
3. **The child is reached and run only through its parent.** Nobody, whether they write it or read it, needs to reach it without opening the parent first: nobody cites it by its own number, and nobody works or reads these records in a list across parents (a queue, a board, a list of their own items). It has no life of its own either: its states only move its parent forward. A role that the access record limits to the records that name it (`"limitedTo"`, `rbac.md` → "Roles that do part of the work") works them in such a list, so the entity it is limited to is never a `parent` child: `writeModel` and `call-file.ts` refuse one that is.

The answers are written as facts in the relationship record, `relationships.json` beside the payloads (`build-module.md`, step 5.6, has its keys), and the format follows from them: `writeModel` and `call-file.ts` refuse a `parent` field with no entry, or with an entry whose facts make it a `reference`. When you cannot tell, it is a `reference`. An order line is a `parent` of its order: it is only ever added and handled inside the order. The same line is a `reference` to its product, which exists on its own.

A junction (its only fields are its relationship fields; see "Classifying an entity") has a `parent` field to each entity it relates.

A child that must have its parent only from some state on is a `reference`, required from that state through an `input_type_rule` and a validation rule ("Fields that apply only to some enum or boolean values").

**Then the delete mode.** It decides what deleting the record the field points at does:

- **`cascade`** deletes the children with their parent. Use it only on a `parent` whose children have no value of their own once the parent is gone, and that everyone who may delete the parent may also delete. A cascade does not check the child's own permission or rules (a database referential action skips row-level security), so a child whose `edit_permission` differs from the parent's, or whose validation rule admits fewer people than the parent's own rules (`has_permission` / `require_permission`, see `jsonlogic.md`), takes `restrict`. Use `cascade` there only when the user accepts that deleting the parent deletes those children without that check.
- **`restrict`** refuses to delete the parent while a child points at it, so each child is removed first, through its own permission. Use it on every other `parent`, on every required `reference`, and on every record kept for audit or by law, whichever its format: such a record is closed or voided instead of deleted.
- **`clear`** empties the field. Use it only on an optional `reference`. Never on a `parent`: its column is NOT NULL, so every delete of the parent would fail.
- **On an `is_a` entity, never `cascade`** (`90249`): set `restrict`, or `clear` on an optional `reference`, explicitly. See `entity-families.md`.
<!-- Family variant: `entity-families.md` → "Creating a family". This rule summarizes; that section governs families. -->

### Relationship labels

Set `relationship_label` on every `reference` and `parent` field, in the same `create_field` call that creates the field. A field created without one gets `has`, and a module whose arrows all read `has` shows nothing about its relationships.

- **Voice.** The referenced entity speaks. Read the label as `<Referenced Entity> <label> <Holding Entity>`, the direction of the arrow in the module diagram: `accounts` → `opportunities` is `owns`, `users` → `tasks` (the owner) is `manages`. A sentence that does not parse, or that parses but is not true, means the label is written from the wrong side.
- **Specific verbs.** `has`, `references`, `belongs to` and `relates to` add nothing; use a domain verb such as `owns`, `employs` or `supports`. A self-reference takes `is parent of` or `manages`.
- **One verb per field.** Fields from one entity to the same entity take different verbs: `tasks.creator_id` → `users` is `created`, `tasks.assignee_id` → `users` is `works on`.
- **Test every label before the field write.** Write each field's sentence, `<Referenced Entity> <label> <Holding Entity>`. `<Referenced Entity>` is the record in `reference_table`, called by the part the field names, if any (`manager_id`: Manager). `<Holding Entity>` is the record in `table_name`; on a junction's `parent` field, the entity at the other end instead. Rewrite the label unless the sentence is true of that field: `places` on `order_lines.product_id` gives "Product places Order Line", which is false; `is ordered in` passes.
- **Junctions.** Read each `parent` field's label through the junction to the other end, and set `singular_label_parent` and `plural_label_parent` to the other end's name. On `product_tags`, `product_id` is `is tagged with` with `Tag` / `Tags`, so the Product page shows "Tags…" and "Add Tag"; `tag_id` is `is applied to` with `Product` / `Products`.
- **Same parent twice.** When one child has two or more `parent` fields to the same parent, give each its own pair, or the parent's page shows two identical buttons. `permission_hierarchy` does this with `Includes` and `Included in`.

### `reference`: a record that stands on its own

Use it when any of the three questions in "Choosing the Right Format" fails. The record has its own menu entry and list, and is not listed on the page of the record it points at.

An order has an optional assigned sales rep. `.tmp_deploy/orders-fields.json`:

```json
{
  "data": {
    "table_name": "orders",
    "field_name": "sales_rep_id",
    "title": "Sales Rep",
    "format": "reference",
    "reference_table": "users",
    "reference_delete_mode": "clear",
    "relationship_label": "manages",
    "width": "default",
    "input_type": "default"
  }
}
```

```bash
bun "<skill-folder>/references/call-file.ts" create_field .tmp_deploy/orders-fields.json
```

### `parent`: a part of its parent

Use it only when all three questions in "Choosing the Right Format" hold. The child has no menu entry: people reach it from its parent's page. Its entry in `relationships.json` beside the payload comes first, with facts that make it a parent; `call-file.ts` refuses the field without one. `.tmp_deploy/relationships.json`, where the sales rep is the module's everyday person and it has no role:

```json
{
  "order_lines.order_id": { "format": "parent", "delete": "cascade", "savedWithout": false, "createdBy": ["sales_rep"], "parentWorkedBy": ["sales_rep"], "reachedBy": { "sales_rep": "parent" }, "citedByNumber": false, "label": "Order contains Order Line" }
}
```

An order line belongs to an order. `.tmp_deploy/order-lines-fields.json`:

```json
{
  "data": {
    "table_name": "order_lines",
    "field_name": "order_id",
    "title": "Order",
    "format": "parent",
    "reference_table": "orders",
    "reference_delete_mode": "cascade",
    "relationship_label": "contains",
    "width": "default",
    "input_type": "default"
  }
}
```

```bash
bun "<skill-folder>/references/call-file.ts" create_field .tmp_deploy/order-lines-fields.json
```

### M:N Junction Tables

Create a junction entity and add a `parent` field to **each** entity it relates (two for a binary junction, three or more for an N-ary one):

First the junction entity, written like any other with `"entity_type": "junction"` (`products` and `tags` already exist: entities before fields). Then all its `parent` fields in **one** `create_field` call, each labeled through to the other end, each with its entry in `relationships.json` beside the payload: people reach a junction's rows only from the records it relates, so the facts of each make it a parent. `.tmp_deploy/product-tags-fields.json`:

```json
{"data": [
  {"table_name": "product_tags", "field_name": "product_id", "format": "parent", "reference_table": "products", "reference_delete_mode": "cascade", "relationship_label": "is tagged with", "singular_label_parent": "Tag", "plural_label_parent": "Tags", "width": "default", "input_type": "default"},
  {"table_name": "product_tags", "field_name": "tag_id", "format": "parent", "reference_table": "tags", "reference_delete_mode": "cascade", "relationship_label": "is applied to", "singular_label_parent": "Product", "plural_label_parent": "Products", "width": "default", "input_type": "default"}
]}
```

```bash
bun "<skill-folder>/references/call-file.ts" create_field .tmp_deploy/product-tags-fields.json
```

> **Do not set `label_column` on a junction.** `label_column` is optional — `create_entity` requires only `table_name` and `module_id` — and a junction has no natural label field: the platform composes `_label` from its `parent` fields automatically. Setting `label_column` to `id` (or any auto-generated column — `created_at`, `updated_at`) makes `create_entity` fail with *column 'id' specified more than once*, because that column already exists. Omit `label_column` (as the example above does), and likewise omit `label_parent`.

> **Junctions aren't binary-only.** `entity_type = junction` combines **all** its `parent` fields, so an N-ary relationship works the same way — e.g. `(user, role, tenant)`. Whether an entity that stores an n:m relationship is a junction is decided in "Classifying an entity" above.

### Relationships to entities of other modules

A module is installed on its own. It never needs another module installed first, and a relationship never makes another entity or module install.

- A relationship to an entity that is neither live nor created in the same build creates **no field and no constraint**.
- When both entities exist, the field is optional: `input_type: "default"` with `reference_delete_mode: "clear"`. It is required (`input_type: "required"` with `reference_delete_mode: "restrict"`) only when every record must have it once both entities exist.

A module can also hold an entity that another module owns in the catalog (an embedded master: `catalog_owner_module` names the owner). The entity lives in this module until its owner module is installed, and then moves to the owner with no data migration.

### Embedded-entity governance follows the catalog

An entity's permissions are named by the catalog, never by what is installed. A module that embeds an entity (`held_as = embedded_master`) keeps its owner's names, even when the owner module is not installed yet, and holds them through its own bundles:

- **Read and write:** `<owner>:read_<entity>` and `<owner>:write_<entity>`, named after the entity's master. The entity's `view_permission` and `edit_permission` point at them and never change.
- **Workflow gates:** `<owner>:<verb>`, named after the module that realizes the state if the catalog names one, otherwise the entity's master.
- **Overrides** (`view_all_<plural>` / `manage_all_<plural>` / `submit_<singular>` / `bypass_submit_lock`) and matching business rules: named after the entity's master.
- **Bundles** (`<unit>:read`, `<unit>:manage`, `<unit>:admin`, a role that does part of the work, a role that takes gates): named after the module that declares them. They include the rows above through `permission_hierarchy`, so the module's roles keep holding bundles. `rbac.md` § *Per-entity permissions and bundles* has the full table.
- **Boundary-crossing handoffs:** the module still emits the events the embedded entity publishes to or reacts from modules the embedding unit doesn't "play".

When the owner module is installed later and the entity moves to it, nothing is renamed. The permission rows already exist: they move to the owner and take the owner's description. Entity columns, grants and rules don't change, and the owner adds its own bundle rows. **Once the same modules are installed, every order ends with the same permission names, entity columns, hierarchy rows and grants.** A second module that embeds the same entity uses the same rows and adds only its own bundle rows.

Three cases keep other names:

- **A separate table kept on purpose** under its own name: keeps the local prefix, because a shared name would make a grant on one table open the other.
- **Entity already live with other permission names** (reused or built by hand): the live names win, and the module's bundle rows include them.
- **`access_scope: custom`:** the module keeps its hand-made permissions.

This holds for every module and every install order.

---

## Safe Evolution Patterns

### ✅ Low-Risk (do freely)
- Add new fields
- Update descriptions, labels, UI hints (`width`, `field_order`, `icon_name`, `name_sort`)
- Add `searchable: true` to fields
- Create new entities in new or existing modules
- Add new permissions/roles/assignments
- Add a new `input_type_rule` to a field that is not `required` (pure UI behavior, fails open) — see `jsonlogic.md`

### ⚠️ Medium-Risk (warn user first)
- Changing `reference_delete_mode`
- Adding `view_permission`/`edit_permission` to previously open entities
- Changing `enum_values` (values; a change to only labels, descriptions, colors or icons is cosmetic, since records store values)
- Adding `unique_value: true` to an existing field (fails if duplicates exist)
- Adding, modifying, or removing a `select_rule` on an entity (it replaces `view_permission` for reads: rows may suddenly disappear or reappear for current users, and a rule without a permission test shows its rows to every user who can reach the table) — see `select-rule.md`
- Adding an `input_type_rule` to a `required` field (the database stops enforcing `required` for it)
- Adding or changing a `rollup` definition or `computed_fields` (recalculates existing records with no audit row; the tables written take no other writes until the save commits) — see `rollup-fields.md`
- Modifying or removing an existing `input_type_rule` (forms suddenly show, hide, or unlock a field mid-workflow) — see `jsonlogic.md`

### 🛑 High-Risk (require explicit confirmation)
- Renaming `table_name` or `field_name`, breaks all references
- Deleting entities or fields, permanent data loss
- Removing permissions still in use by roles
- Changing primary key fields (`id_type` cannot change at all, `90233`; a record's key value cannot change either, `90236`)
- Choosing `is_a` or `has_a` (`id_refentity` and an `is_a` prefix are fixed at creation; a record's type cannot change later)
- Deleting an entity that others are based on (refused with `90248`; check `id_refentity=eq.<table_name>` first)
- Deleting an entity that fields of other entities reference (refused with `90260`; check `reference_table=eq.<table_name>` first)
- Always check dependencies before deletion

---

## Updating and Deleting Entities

```bash
# Update entity metadata (safe — low risk)
semantius call crud update_entity '{
  "table_name": "products",
  "data": {
    "description": "Updated description",
    "view_permission": "catalog:read"
  }
}'

# Update a field (only changed attributes needed)
semantius call crud update_field '{
  "id": "<field-id>",
  "data": {
    "title": "New Title",
    "searchable": true
  }
}'

# Delete field — requires explicit user confirmation first
semantius call crud delete_field '{"id": "<field-id>"}'

# Delete entity — check all dependencies first!
# 1. Check for fields referencing this entity
semantius call crud read_field '{"filters": "reference_table=eq.<table_name>"}'
# 2. Check for entities based on this one (is_a / has_a); a base with dependents is refused (90248)
semantius call crud read_entity '{"filters": "id_refentity=eq.<table_name>", "select": "table_name,id_type"}'
# 3. Only proceed if no references or dependents were found and user has confirmed
semantius call crud delete_entity '{"table_name": "<table_name>"}'
```

An entity cannot be deleted while a field of another entity references it (`90260`), whatever that field's `reference_delete_mode`: the mode governs deleting records, not the entity. Delete those fields or point them at another entity first. It is also refused while a rollup of another entity aggregates over it (`90266`). An `is_a` / `has_a` entity, or the base of one, cannot be deleted while it has records (`90247`): delete the records through the entity first. See `entity-families.md`.

`delete_module` removes the module with all its entities, fields and records in one request, so do not delete its entities first; confirm with the user and back up with `export_module` first. It is refused with `90260` while a field of another module references one of its entities, and with `90266` while a rollup of another module aggregates over one; references between its own entities do not count. Two modules that reference each other need one such field removed first. While an `is_a` / `has_a` entity in the module has records it is refused with `90247`; entities of the same module that are based on each other do not block it.

---

## Agent Workflow Tips

1. **Always read before writing**, Before any `create_*`, call `read_*` to check for existing records. E.g., always call `read_entity` filtering by `table_name` before `create_entity`, and compare a new entity with the whole instance first (`SKILL.md` → "Before any new entity: compare it with the instance"). For a bulk create, one `read_*` with an `in.(...)` filter covers all items.
2. **Resolve prerequisites in order**, as given in "Mandatory Creation Order".
3. **Batch related writes**, Put all fields of one entity, all entities of one model (one call per level when it has `is_a` / `has_a` entities), or all `role_permission` rows of one role into a single `create_*` call with an array in `data`; use an id array for `update_*` / `delete_*` across several records. Fewer calls, one transaction. N single-record calls where one array call would do is a mistake.
4. **Be conversational**, Explain what you're creating and why, especially for module/permission scaffolding the user may not have explicitly requested.
5. **Validate semantic correctness**, Does the model make sense for the user's domain?
6. **Ask for clarification when needed**, If a user says "add contacts", confirm what fields they need before creating anything. In a request to build a whole module, model fields, lifecycle states and classes from the user's description and the leading products of the domain instead of asking about them. Ask the questions `build-module.md` names, plus any other that only the user can answer and where a wrong guess is costly to undo, such as a choice locked at creation (`is_a` / `has_a`, `entity-families.md`) or a concept the instance may already hold. The key type is locked at creation too, but it and the label are modeled, never asked ("Choosing the key type", "Choosing the label").
7. **Warn before risky changes**, Alert the user to medium/high-risk changes and wait for confirmation before executing.
8. **Suggest next steps**, After creating an entity, suggest related entities, missing fields, or useful roles.
9. **Provide link to UI**, After creating or updating entities/fields, provide: `{ui_baseurl}/{module_slug}/{table_name}` (get `ui_baseurl` from `getCurrentUser` — never hardcode the org host; URL paths use the lowercase `module_slug`, never the display `module_name`). For a specific record, append the id: `{ui_baseurl}/{module_slug}/{table_name}/{id}`. A build's final response and a review's close-out give only the module's link (`build-module.md` → "Final response", `review-module.md`).
10. **Verify the class and the permissions after creating entities**, one `read_entity '{"filters": "table_name=in.(...)", "select": "table_name,entity_type,view_permission,edit_permission,computed_fields,validation_rules,select_rule"}'`. `unclassified` is a defect: classify it with `update_entity` (an array of `table_name`s takes the same value) and re-check its `edit_permission` against the write tier before reporting the module as done. Run the same read on an existing module you work on, and classify what is missing. A build reads the same values from the `report` lines of its one `module-rbac-setup.ts --slug` run instead (`build-module.md` → "Verify, then stop").

Use `wfts(simple)` on the `search_vector` column when the entity is searchable:

```bash
# Check if entity is searchable
semantius call crud read_entity '{"filters": "table_name=eq.contacts"}'
# Look for searchable: true in response

# Full-text search
semantius call crud postgrestRequest '{
  "method": "GET",
  "path": "/contacts?search_vector=wfts(simple).Monica"
}'
```

> Always use `wfts(simple)`, the `simple` text search configuration is language-agnostic and required for multilingual content. Never use bare `wfts` or `fts`. Only fall back to field-specific filters (`ilike`, `eq`) when the user specifies a particular column or when the table is not searchable.

> For an `is_a` / `has_a` entity, `search_vector` covers the searchable fields of its base as well as its own. That search cannot use an index, so on large tables add a narrowing filter.

---

## Runtime schema introspection (live FK / shape lookup)

`read_entity` and `read_field` are not just schema-setup tools. They are the live source of truth for the current shape of any entity, and they are cheap to call mid-flight from a business CRUD recipe. Two distinct use cases:

1. **Schema setup** (covered above). Before `create_entity` / `create_field`, check the entity or field doesn't already exist; before `delete_entity`, check what references it.

2. **Runtime drift recovery**. A baked recipe in a domain skill (e.g. one generated by `semantius-skill-maker`) assumes a particular FK shape, junction uniqueness, or audit-log flag. The live schema can drift. When a recipe gets a `409 Conflict`, `422 Unprocessable Entity`, or any write failure it didn't predict, **query the live shape** before deciding how to recover:

```bash
# Which relationship fields does the entity have right now?
semantius call crud read_field '{"filters": "table_name=eq.<table_name>&reference_table=neq.&select=field_name,format,reference_table,reference_delete_mode"}'

# What does this specific field reference today?
semantius call crud read_field '{"filters": "table_name=eq.<table_name>&field_name=eq.<field_name>"}'

# Is this entity audit-logged today?
semantius call crud read_entity '{"filters": "table_name=eq.<table_name>&select=table_name,audit_log"}'
# Look for audit_log: true in response
```

**A based entity's fields span its family.** `read_field` lists only the fields an entity owns; an `is_a` / `has_a` entity's record also carries every field of its base. To see the whole shape, walk `id_refentity` up with `read_entity` (until it is null), then read every level in one call:

```bash
semantius call crud read_entity '{"filters": "table_name=eq.emails", "select": "table_name,id_type,id_refentity"}'
semantius call crud read_field '{"filters": "table_name=in.(emails,activities)"}'
```

> **Combine multiple filter conditions with `&`, never a comma.** `entity=eq.<id>&name=eq.<f>` ANDs two columns (PostgREST query-string syntax). A comma is only a value-list separator *inside* `in.(...)` / `or=(...)`; a top-level `col1=eq.a,col2=eq.b` does **not** mean AND — it silently matches nothing, which reads as "not found" and then triggers a duplicate create on the next write.

If the live shape contradicts the recipe's assumption, abort the recipe with a clear message naming the drift, do not silently "fix it up" with extra writes. Recommend the user regenerate the affected domain skill via `semantius-skill-maker`.

This separation matters because the two contexts have different defaults: schema-setup reads precede a *write to the model*; runtime introspection precedes a *recovery decision* about a stuck business write. Same tools, different guardrails.

---

## Tool Priority Rule

**Always use typed CRUD tools** (`create_*`, `read_*`, `update_*`, `delete_*`) for standard operations — including bulk ones: `create_*` takes an array in `data`, `update_*` / `delete_*` take an array in `id` (`table_name` for entities).

Only use `postgrestRequest` or `sqlToRest` for:
- Complex multi-filter or aggregation queries not expressible through typed tools
- A bulk mutation that must be selected by an arbitrary **filter** (not by a list of ids), e.g. `PATCH /fields?table_name=eq.products&format=eq.string`
- An update where each row needs **different** values in one request (typed `update_*` applies the same `data` to every id)
- Business-record rows in your own entity tables (Layer 2), where the array-body POST is the bulk form

---

## Entity Reference: All Managed Tables

| Table | Purpose | Key Relationships |
|-------|---------|-------------------|
| `entities` | Domain concept definition | Parent of fields; references module; uses permissions |
| `fields` | Entity attributes/columns | Belongs to entity; may reference other entities |
| `modules` | Domain grouping | Referenced by entities, roles, permissions |
| `permissions` | Atomic capabilities | Used by entities; granted to roles; can inherit |
| `permission_hierarchy` | Permission inheritance | Relates including/included permissions (broader includes narrower) |
| `roles` | Permission bundles | Granted permissions; assigned to users |
| `role_permissions` | Role ↔ Permission M:N | Junction with audit fields |
| `users` | Actor identities | Assigned roles via `user_roles` |
| `user_roles` | User ↔ Role M:N | Junction with audit fields |
| `webhook_receivers` | Integration endpoints for external systems | Scoped to a target table |
| `webhook_receiver_logs` | Audit log of webhook calls | Belongs to a receiver |

---

## Troubleshooting

### "Permission denied" errors
```bash
# 1. Get current user and their effective permissions
semantius call crud getCurrentUser '{}'

# 2. Check entity's required permissions
semantius call crud read_entity '{"filters": "table_name=eq.<table>"}'

# 3. Trace: user → user_roles → role_permissions → permission_hierarchy
```

### Fields not displaying correctly
- Check `label_column` is set and matches a real field with `ctype='label'`
- Check `field_order` for display sequence
- Check `input_type` is appropriate
- Ensure `width: "default"` unless a specific override is needed
