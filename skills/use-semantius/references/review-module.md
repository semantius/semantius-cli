# Reviewing an existing module

_Read this when the user asks to review, audit or check a module that already exists, asks whether it is built correctly, or asks what it is missing or how to improve it. It reviews what is live; a design file is not a module._

A review reads the whole module, verifies it against the rules of this skill, and suggests what could be added. It reads the model, not the records in it, and it writes nothing until the user picks what to apply.

A platform module, whose entities are the built-ins in `data-modeling.md`, is not reviewed: say so and stop.

## Order of a review

`preflight.md` runs first (`SKILL.md` → "Environment Setup").

1. Find the module. When the request does not name it, ask as `SKILL.md` → "Asking the user to pick a value" says.
2. Read it (next section).
3. Read `data-modeling.md`, `rbac.md` and `jsonlogic.md`, and each reference the module calls for: `select-rule.md` when an entity has a `select_rule`; `rollup-fields.md` when a field has a `rollup`; `entity-families.md` when an entity is `is_a` or `has_a`.
4. Go through every row of "What to verify".
5. Work out the additions ("Suggest what could be added").
6. Report, ask which to apply, and end the turn ("Report").

## Read the module

One call per kind of record, never one per record. These catalog reads are the source of the review; `generate_spec` leaves out properties it needs.

```bash
semantius call crud read_module '{"filters": "module_slug=eq.<slug>"}'
semantius call crud read_entity '{"filters": "module_id=eq.<module_id>", "select": "table_name,singular_label,plural_label,description,icon_name,entity_type,view_permission,edit_permission,id_type,id_refentity,label_column,label_parent,audit_log,computed_fields,validation_rules,select_rule,catalog_entity_code"}'
semantius call crud read_field '{"filters": "table_name=in.(<tables>)", "select": "table_name,field_name,title,format,input_type,input_type_rule,default_value,enum_values,precision,width,field_order,ctype,searchable,unique_value,reference_table,reference_delete_mode,relationship_label,singular_label_parent,plural_label_parent,rollup"}'
semantius call crud read_field '{"filters": "reference_table=in.(<tables>)&table_name=not.in.(<tables>)", "select": "table_name,field_name,format,reference_table,input_type,reference_delete_mode"}'
semantius call crud read_permission '{"filters": "module_id=eq.<module_id>", "select": "permission_name,description,module_id"}'
semantius call crud read_permission_hierarchy '{"filters": "including_permission_name=ilike.<slug>:*", "select": "including_permission_name,included_permission_name"}'
semantius call crud read_role '{"filters": "module_id=eq.<module_id>", "select": "id,role_name,slug,module_id,origin"}'
semantius call crud read_role_permission '{"filters": "role_id=in.(<role ids>)", "select": "role_id,permission_name"}'
semantius call crud read_entity '{"select": "table_name,plural_label,module_id,entity_type", "order": "table_name.asc"}'
```

- `module_id` does not list every permission a module uses. When the hierarchy rows include a permission with another prefix, read the rows of that permission too (`including_permission_name=in.(<names>)`) and read the permission itself by name.
- When `id_refentity` names a base outside the module, read that base's entity row and fields as well: a based entity's record carries them.
- A read too long for one output goes to a file (redirect stdout) and is read in parts; every row is still verified.
- Check every icon the module uses in one call: `bun "<skill-folder>/references/lucide-icon-checker.ts" <names>` (the module's, each entity's and each enum entry's).

## What to verify

Verify every row for every entity, field and relationship of the module, not a sample. A row names what the platform accepts but this skill's rules do not; what the platform refuses cannot be live. The rule is in the section the row names.

Settle two things first:

- **Which permission shape the module has.** Entity permissions named `<owner>:read_<entity>` and `<owner>:write_<entity>` are the per-entity shape of a module deployed from a spec; `<slug>:read` and `<slug>:manage` are the module-wide shape of a hand-built one. Both are valid (`rbac.md` → "Per-entity permissions and bundles"), so check each module against its own shape.
- **What is not the module's own.** A built-in or an entity of another module is read only for the relationships into it. `id`, `created_at`, `updated_at`, `_label`, `<fk>_label`, `ctype`, `origin` and the `catalog_*` columns are the platform's, and are never findings.

### The module

| Verify | Rule in |
|---|---|
| `icon_name` is set (`box` when no icon fits) and passes the checker | `data-modeling.md` → "Mandatory Creation Order" |
| `description` is a tagline of at most 60 characters | `data-modeling.md` → "Modules" |
| `view_permission`, `manage_permission` and `admin_permission` name this module's permissions, not `user:read` or nothing | `data-modeling.md` → "Mandatory Creation Order" |
| `access_scope` fits: `advanced` with no gate, `gated` with one, a `raci` module stays `raci`, never `basic` with a `catalog` entity. `custom` goes under To confirm | `rbac.md` → "Choosing an entity's permissions", "Restricted steps (gates)" |
| `default_viewer_role_id`, `default_manager_role_id` and `default_admin_role_id` are set, each to a role of this module | `data-modeling.md` → "Mandatory Creation Order" |

### Permissions and roles

| Verify | Rule in |
|---|---|
| `<slug>:read`, `<slug>:manage` and `<slug>:admin` exist, and every name is `<module>:<action>` | `rbac.md` → "Naming Convention", "Create Permissions" |
| `<slug>:manage` includes `<slug>:read`, and `<slug>:admin` includes `<slug>:manage` | `rbac.md` → "Set Up Permission Hierarchy" |
| In the per-entity shape, every row of the bundle table exists: each `<unit>:read`, `<unit>:manage`, `<unit>:admin` inclusion, and `write_<entity>` includes `read_<entity>` | `rbac.md` → "Per-entity permissions and bundles" |
| A viewer, a manager and an admin role exist, each with `module_id`, granted `<slug>:read`, `<slug>:manage` and `<slug>:admin` | `rbac.md` → "Create Roles", "Grant Permissions to Roles" |
| Every gate is named `<slug>:<verb>_<noun>`, is included by `<slug>:admin`, and a validation rule enforces it. Outside a `raci` module, no role holds a gate directly | `rbac.md` → "Restricted steps (gates)" |
| In a `raci` module, each gate follows the module's matrix for its mode | `rbac.md` → "A gate in a `raci` module" |
| A role that writes a based entity can also edit its base | `entity-families.md` → "Reading" |

### Entities

| Verify | Rule in |
|---|---|
| `entity_type` is not `unclassified` and follows "Choose in this order": a `junction` has no attributes or lifecycle of its own; a family base is never `catalog`; the entity the module exists to hold is never `catalog`; `operational_workflow` has a gate, and an entity with a gate is `operational_workflow`; a status enum alone is no gate | `data-modeling.md` → "Classifying an entity" |
| `view_permission` and `edit_permission` follow the write tier of the class. `public:read`, or `admin` on anything but a `computed` entity, is a platform default nobody set | `rbac.md` → "Choosing an entity's permissions" |
| `table_name` is plural snake_case and names the concept in full; no entity is a competing `users` or `user` table or recreates another built-in | `data-modeling.md` → "Entity Naming Rules" |
| `singular_label` and `plural_label` are symmetric, and `singular_label` is not a field title such as "Product Name" | `data-modeling.md` → "Key Entity Fields" |
| `label_column` is set on every entity with a natural label and unset on a junction. A based entity shows its base's value, which is correct | `data-modeling.md` → "Key Entity Fields" |
| `label_parent` is set where a record is identified through a parent, and never on a junction. A based entity shows its base's value, which is correct | `data-modeling.md` → "Key Entity Fields" |
| The label field's `title` says what identifies the record when that is more specific than `Name` | `data-modeling.md` → "Customizing the label field's title" |
| `icon_name` is set, unless no icon fits, and passes the checker | `data-modeling.md` → "Key Entity Fields" |
| A family is the right tool: a classification that can change is an enum, kinds that differ by a few fields stay one entity, and entities that only share field names are not a family | `entity-families.md` → "Choose the right tool" |

### Fields

| Verify | Rule in |
|---|---|
| Names are snake_case, with no abbreviations, and include the noun they describe; none ends in `_id_label` | `data-modeling.md` → "Field Naming Rules", "Field Format Quick Reference" |
| An entity with a lifecycle has one required `enum` named `workflow_state` with a `default_value`, and no second state field (`status`, `state`, `lifecycle_state`). An enum that is not the lifecycle keeps its domain name | `data-modeling.md` → "`default_value`" |
| The format fits the value: `number` for money, never `float` or `double`; `precision` of 4 to 6 for tax and FX rates; `multiline` for prose, `text` or `string` for one line; `rating` only for star ratings and 5-point scores | `data-modeling.md` → "Field Format Quick Reference" |
| A required `enum` has a `default_value`, and `enum_values` are in lifecycle order | `data-modeling.md` → "`default_value`" |
| Every enum entry is an object with a `label`, a `color` and, where one fits, an `icon`; `description` only when the label is not self-describing | `data-modeling.md` → "Enum values and labels" |
| Enum colors and icons follow their tables: lowercase hex, no two entries of an enum share a color, red, amber and green only on entries with that meaning, and icons pass the checker | `data-modeling.md` → "Enum colors", "Enum icons" |
| A field that applies only to some values of an enum or boolean (`sold_date` beside a `sold` state) has an `input_type_rule` for those values and, when it is needed there, a validation rule that refuses a missing value, tested by the field's format. A field with no `input_type_rule` for them goes under To confirm | `data-modeling.md` → "Fields that apply only to some enum or boolean values" |
| No two fields of an entity share a `field_order`, and only `created_at` and `updated_at` are at 900000 or above | `data-modeling.md` → "All Field Properties" |
| `width` is `default` unless a layout needs another value | `data-modeling.md` → "`width` Values" |
| `unique_value` is set only where duplicates would harm integrity, and is set on a natural key that must not repeat | `data-modeling.md` → "`unique_value`" |
| A value aggregated from child records is a rollup, never a rule or a number kept by hand | `SKILL.md` Golden Rule 8; `rollup-fields.md` |
| A `sum` rollup is a `number` unless overflow cannot happen, and `include_hidden_rows: true` goes under To confirm | `rollup-fields.md` |

### Relationships

| Verify | Rule in |
|---|---|
| `format` and `reference_delete_mode` match the table, tier divergence first: optional `reference` with `clear`, required `reference` with `restrict`, owned `parent` with `cascade`, and `parent` with `restrict` when the child has a permission gate of its own or a junction or association class leg's tier differs. A child that must survive its parent is not a `parent` | `data-modeling.md` → "Choosing the Right Format" |
| A `parent` passes both tests: the people who work on the parent create the child as part of that work (an unknown creator or a different `edit_permission` from the parent's makes it a `reference`), the child is not self-identifying, people do not open and work on it by itself from its own list, and its states drive no work unrelated to completing the parent. A `workflow_state` alone, a gated step on the child, who moves it through its states, or a later creation date proves nothing. Junction and association class legs skip the tests, and an association class with its own `workflow_state` has `restrict` on every leg. A record with retention value of its own (an invoice, a payment, a signed document) never has `cascade` | `data-modeling.md` → "Choosing the Right Format" |
| Every field that refers to another record is a relationship. `vendor_name` beside a `vendors` entity, or a `*_id` with no `reference_table`, is a missing relationship; an external system's identifier stays text | `data-modeling.md` → "Field Naming Rules" |
| A relationship field is `<target_singular>_id`, or names the record's part in the relationship and ends in `_id` (`assigned_user_id`, `manager_id`). A name with no `_id`, such as `owner`, fails | `data-modeling.md` → "Field Naming Rules" |
| `relationship_label` is set and is a domain verb, not `has`, `references`, `belongs to` or `relates to`. Write each one out as the sentence `<Referenced Entity> <label> <Holding Entity>`: one that is not true is written from the wrong side ("Employee is held by License"). Fields from one entity to the same target take different verbs | `data-modeling.md` → "Relationship labels" |
| Every junction leg is a `parent`, labeled through to the other end, with `singular_label_parent` and `plural_label_parent` naming the other end | `data-modeling.md` → "Relationship labels", "M:N Junction Tables" |
| A many-to-many held in an array or JSON field, or in numbered fields (`owner_1_id`, `owner_2_id`), is a missing junction | `data-modeling.md` → "M:N Junction Tables" |
| Two or more `parent` fields from one child to the same parent each carry their own label pair | `data-modeling.md` → "Relationship labels" |
| A required relationship to another module's entity makes this module depend on that one; it goes under To confirm | `data-modeling.md` → "Cross-module references and required relationships" |
| An entity with no relationship in or out goes under To confirm | `data-modeling.md` → "Agent Workflow Tips" (does the model make sense for the domain) |

### Rules

Only for the entities and fields that carry one.

| Verify | Rule in |
|---|---|
| Each validation rule has a `message` and a snake_case `name` unique within the entity; `code` is distinct within the module | `jsonlogic.md` → "`validation_rules` element shape" |
| A rule that reads `$today`, `$now` or `$user_id` is guarded with `$mode`, unless it should refuse deletes too | `jsonlogic.md` → "Evaluation semantics (per write)" |
| An update-only test uses `$mode`, not `$old != null` | `jsonlogic.md` → "Detecting the operation" |
| Every `has_permission` argument names a permission that exists | `rbac.md` → "Restricted steps (gates)" |
| Each `computed_fields` `name` is a field that exists (a rename does not rewrite the rule); a `$user_id` or `$now` stamp is insert-only; no stored value is computed from `$today` or `$now` | `jsonlogic.md` → "Computed fields and validation rules" |
| A restriction in an `input_type_rule` is also enforced by a validation rule, unless the user said it is cosmetic; an `input_type_rule` on a `required` field goes under To confirm, because the database stops enforcing `required` | `data-modeling.md` → "Dynamic `input_type` via `input_type_rule`" |
| A `select_rule` has a `has_permission` clause for everyone who must still read, admins included; uses `has_permission`, never `require_permission`; reads neither `$old` nor `$mode`; returns a boolean; and shows a bare `null` clause only on rows that are not sensitive | `select-rule.md` |

### To fix or to confirm

A row that fails is **To fix**, unless it may be deliberate. It is **To confirm** when the row says so, when it rests on a judgment about meaning (a class, a `label_parent`, a family, a name that may be fine), or when the difference comes from a choice someone made: names from a catalog spec (`catalog_*_code` set) or from a product the user asked to follow, or hand-made permissions. A problem no row names goes under To confirm.

## Suggest what could be added

Additions are suggestions. The module is correct without them, so they are never findings.

Compare the module with its domain the way `build-module.md` → "Model it like the leading products" says: the same choice of two or three products, the same rule on when to search, and a product is called verified only when a search in this session returned it. The products are the benchmark for structure, not a feature checklist: leave out what only one has, unless the user's goal turns on it. When the domain is not well known, skip the comparison and take suggestions from the module itself.

**Optional entities come first:** up to six, most useful first, that the products agree on and that relate to what the module already holds.

- Look for each one in the instance-wide list first. When another module already holds it, suggest a relationship to that entity instead of a new one. Never suggest a copy of a built-in.
- Say what it holds, which entities it relates to and how ("each Subscription has many Invoices"), and what the user gets from it.

**Then anything else the module would gain:**

- fields the products agree on that it lacks
- an enum repeated on several entities, which could be one `catalog` entity
- a total or count on a parent that a rollup could keep current
- a step only some users should take, as a gate
- `audit_log` on an entity where change history matters (contracts, financial records, policy data)
- `searchable` on an entity users look up by name
- a `select_rule` where only some users should see some rows

## Report

One message with one question, then end the turn. Write for the person who owns the module: plural labels and field titles in plain words, with the technical name in backticks only where a fix needs it. A junction is a connecting record, and a family is described by its business facts (`entity-families.md` → "Vocabulary").

> **Review of \<Module\>:** \<n\> to fix, \<n\> to confirm, \<n\> optional additions. Compared with \<products\>, \<from knowledge of the category | checked with a search\>.

Then the three tables, numbered in one sequence across them, leaving out a table with no rows.

| Table | Columns |
|---|---|
| To fix | #, What, Why it matters, Fix, Risk |
| To confirm | #, What, Why it may be deliberate, Fix if it is not, Risk |
| Optional additions | #, Addition, What it gives you, Relates to, Risk |

- List every finding, never a sample or a top few.
- **Risk** is the tier in `data-modeling.md` → "Safe Evolution Patterns": low, medium or high.
- **Needs a rebuild** replaces the fix when the property cannot change in place: `id_type`, `id_refentity`, an `is_a` prefix, the format of a core column, or a format that changes the column type. It is high risk, because the field or entity is dropped and recreated.
- End with one line naming the areas verified with no findings.
- No diagram, spec or export unless the user asked for one (`SKILL.md` Golden Rule 9).

Then ask, in the question format the preflight sets, with the numbers free to type in:

> Which of these should I apply?
>
> - **All the fixes** (\<numbers of the To fix rows\>)
> - **Nothing for now**

When nothing is to fix, to confirm or to add, say the module is verified and ask nothing.

Only what the user names is applied:

- "All the fixes" covers the To fix table. A To confirm row or an addition is applied only when named.
- An ambiguous reply, `continue`, `proceed`, silence or a non-interactive run writes nothing.

## After the user picks

Each change runs under the rules that govern it (`SKILL.md` → Quick Decision Guide); this file adds no second set.

- A medium-risk change the user named is confirmed: the report's Risk column was the warning. A **high-risk** change gets its own question first, one at a time, saying what it breaks (`SKILL.md` Golden Rule 5).
- A new entity follows `data-modeling.md` → "Mandatory Creation Order" from the entities on: class and permissions, icon, fields, relationship labels, `label_parent`. It starts empty: applying a review is not a build, so the sample-data question is not asked.
- `computed_fields`, `validation_rules` and `enum_values` are replaced whole: read the current list and send it back in full with the change.
- Before a change that depends on the records (adding `unique_value`, removing an enum value, making a field required), read the records it touches. When they block it, say so and leave it for the user to decide.

Then read back only what changed, and close with what was applied, what was left, and the UI links of the changed entities (`SKILL.md` → "Linking to the web UI").
