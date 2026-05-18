# Semantius Data Modeling Reference (Layer 1)

This is **Layer 1** of Semantius, the semantic data model that defines the schema for your application. It stores domain concepts, attributes, relationships, and access rules as structured data. When you define an entity here, Semantius automatically creates a real PostgreSQL table for it, which then becomes accessible via PostgREST (Layer 2) and the CubeJS API (Layer 3).

Unlike raw database DDL, the semantic model encodes:
- Human-readable labels and descriptions (used by auto-generated UIs)
- UI rendering hints (field order, width, icons)
- Reference relationships with configurable delete behavior
- Role-based access control (RBAC) per entity

The typed crud tools (`create_entity`, `create_field`, etc.) all operate on this layer. To work with actual business records once the schema is defined, use `postgrestRequest` (see `references/crud-tools.md`).

---

## Mandatory Creation Order

**Always follow this sequence, never skip steps:**

```
Module → Permissions → Entity → Fields
```

1. **Resolve/create module**, `read_module`, then `create_module` if needed
2. **Resolve/create permissions**, `read_permission`, then `create_permission` if needed
3. **Create entity**, `create_entity` with `module_id`, `view_permission`, `edit_permission`
4. **Add fields**, `create_field` for each domain attribute (not the auto-generated ones)

---

## Modules

Every entity **must** belong to a module.

A module has two name fields with distinct jobs:

- **`module_name`** is the unique, human-facing display name shown in the UI module selector and on the module landing page. Keep acronyms as acronyms (`CRM`, `ITSM`, `CMDB`), this is what users read. Matches the source model's `system_name`.
- **`module_slug`** is the lowercase, URL-safe handle (regex `^([a-z0-9_]+)?$`). Used in URLs, in the permission prefix, and by other models that reference this module. Matches the source model's `system_slug`.

> ⚠️ **`alias` is gone.** Earlier schemas had an `alias` column on modules. It has been removed. Use `module_name` for the display name and `module_slug` for the URL/permission handle.

**Check before creating** (filter on `module_slug` for the URL handle, or on `module_name` for the display name):
```bash
semantius call crud read_module '{"filters": "module_slug=eq.crm"}'
```

**Create module + baseline permissions (always both):**
```bash
semantius call crud create_module '{"data": {"module_name": "CRM", "module_slug": "crm", "description": "Customer Relationship Management"}}'
semantius call crud create_permission '{"data": {"permission_name": "crm:read", "description": "Read CRM data", "module_id": <id>}}'
semantius call crud create_permission '{"data": {"permission_name": "crm:manage", "description": "Manage CRM data", "module_id": <id>}}'
```

The `description` field is a compact tagline (≤40 chars) shown beside `module_name` in the selector chip, for acronyms, the plain English expansion (`CRM` → `Customer Relationship Management`); for non-acronyms a 2-4 word disambiguating phrase. Long-form prose belongs in §1 Overview of the source model, not on the module record.

Other optional fields on `modules`: `view_permission`, `logo_url`, `logo_color`, `home_page`, `settings`, `dashboard_config`.

Permission naming convention: **always `<module_slug>:<action>`** (e.g., `crm:read`, `crm:manage`). The permission prefix is the slug, not the display name, `crm:read`, never `CRM:read`.

---

## Entities

### Creating an Entity

```bash
semantius call crud create_entity '{
  "data": {
    "table_name": "products",
    "singular": "product",
    "plural": "products",
    "singular_label": "Product",
    "plural_label": "Products",
    "description": "A catalog product available for sale",
    "label_column": "product_name",
    "module_id": 3,
    "view_permission": "catalog:read",
    "edit_permission": "catalog:manage",
    "icon_url": "https://example.com/icon.svg",
    "audit_log": false
  }
}'
```

### Entity Naming Rules

- **`table_name` is always plural snake_case**, `products`, `orders`, `order_lines`, not `product`, `order`, `orderLine`
- **Never create a `users` entity**, Semantius has a built-in `users` table. Any module that needs to reference users must use `reference_table: "users"` pointing at the existing table. Creating a competing `users` or `user` entity will conflict with the built-in table and break authentication.

### Key Entity Fields

| Field | Notes |
|-------|-------|
| `table_name` | **Plural** snake_case. Renaming is supported but think twice: integrations, saved queries, and external consumers reference the entity by name. |
| `singular_label` | Human-readable name for **one record** (e.g. `Product`). Must be grammatically symmetric with `plural_label`, if `plural_label` is "Products", this must be "Product", never "Product Name". Field-level titles like "Product Name" belong on the auto-created `label` field, not here (see Customizing the `label` field's title below). |
| `plural_label` | e.g. "Products" |
| `label_column` | Snake_case **field name** that identifies a record (e.g. `product_name`). NOT a human-readable title |
| `module_id` | Required, find with `read_module` |
| `view_permission` | Required, name string (e.g. `"catalog:read"`) |
| `edit_permission` | Required, name string (e.g. `"catalog:manage"`) |
| `icon_url` | Optional, URL to an icon representing this entity in the UI |
| `edit_mode` | Optional. Controls how records open for editing: `auto` (default, system decides), `sidebar`, `modal`, or `page`. Set only when the user has a specific UX requirement. |
| `cube_mode` | Optional. OLAP cube generation: `disabled` (default) or `auto` (include in cube). Set to `auto` when the entity should be included in cube queries. |
| `audit_log` | Optional boolean, default `false`. When `true`, every INSERT / UPDATE / DELETE on this entity is recorded by the platform. Enable on entities where change history matters (contracts, financial records, policy data); leave off for high-volume or ephemeral data where audit noise outweighs the value. |

### Auto-Generated Fields: NEVER Create These Manually

When `create_entity` is called, the system automatically creates:

| Field | `ctype` | Notes |
|-------|---------|-------|
| `id` | `id` | Primary key (`is_pk: true`) |
| `label` | `label` | Display field reading computed value from `label_column` |
| `<label_column>` | `label` | The actual named field (e.g. `product_name`) with title from `singular_label` |
| `created_at` |, | Timestamp, auto-maintained |
| `updated_at` |, | Timestamp, auto-maintained |

> ⚠️ Calling `create_field` for any of these will fail or create duplicates.

> ℹ️ `searchable` and `is_child` on the entity are **read-only** and computed automatically. `searchable` becomes `true` when any field has `searchable: true`; `is_child` becomes `true` when any field uses `format: "parent"`. Never set these manually.

### Customizing the `label` field's title

The auto-created `label` field's `title` defaults to `singular_label`. If the record's identifying value is more specific than the entity name, follow up with `update_field` on the `label` field to set its `title`. Example: an entity `cars` where each record is identified by its license plate, keep `singular_label: "Car"` / `plural_label: "Cars"` (symmetric), then update the `label` field's title to `"License Plate"`. See "Updating and Deleting Entities" below for the `update_field` call shape. Do **not** smuggle the field-level title into `singular_label` (e.g. `"Car License Plate"`), that breaks plural/singular symmetry and propagates "Name"/"License Plate" into every UI surface that renders the entity name.

### Computed fields and validation rules (entity-level JsonLogic)

Every entity carries two optional JSON-array properties that let the platform derive values and enforce invariants on every write, without per-model service code:

| Property | Type | Default | Purpose |
|---|---|---|---|
| `computed_fields` | `array` | `[]` | Ordered list of fields whose values are derived from the same record via JsonLogic. |
| `validation_rules` | `array` | `[]` | Ordered list of record-level invariants that must hold for a write to succeed. |

Both are first-class entity properties: read with `read_entity`, set on `create_entity`, replaced on `update_entity`. The platform compiles them into `BEFORE INSERT / UPDATE` triggers; when both arrays are empty (or the entity is deleted) the trigger is dropped.

**`computed_fields` element shape** — `{ "name": <existing-scalar-field-on-this-entity>, "jsonlogic": <expr>, "description"?: <string> }`. The expression's result is written into `name`; `name` may use dotted notation to target a JSONB sub-property (e.g. `metadata.rice`). Earlier entries in the array are visible to later ones.

**`validation_rules` element shape** — `{ "code": <snake_case-unique-within-entity>, "message": <default-English>, "jsonlogic": <expr>, "description"?: <string> }`. The rule passes when `jsonlogic` evaluates truthy.

**Per-write semantics.** On every INSERT/UPDATE: (1) compute pass writes derived values in array order; if an expression throws, the platform errors with the entry's `name` and the inner error. (2) Validate pass evaluates rules in array order against the post-compute record; the platform collects every failure and rejects the write with `{ "errors": [{ "code", "message" }, ...] }`. Compute and validate run in the write's own transaction, so the record either lands fully derived and rule-clean or not at all.

**Reserved variables** that JsonLogic may read via `{"var": "$name"}`:

| Var | Type | Meaning |
|---|---|---|
| `$today` | `date` | Server date at evaluation time. |
| `$now` | `date-time` | Server timestamp at evaluation time. |
| `$user_id` | `uuid` | Authenticated user performing the write (`null` for system writes). |
| `$old` | `object` or `null` | Previous row as JSON on UPDATE; `null` on INSERT. Use to express transition rules ("status cannot move from `released` back to `planned`") and "set-once" invariants ("`account_number` is immutable after first save"). |

`$old` is the only window into prior state; cross-row lookups, aggregates, and FK traversal stay out of scope (use cube/views).

**Detecting INSERT vs UPDATE:** `$old` is `null` on INSERT, an object on UPDATE. A rule that should fire only on UPDATE wraps its body in `{"if": [{"!=": [{"var": "$old"}, null]}, <update-only-check>, true]}` so the INSERT path passes trivially. Transition rules that compare current vs prior (e.g. `{"var": "release_status"}` against `{"var": "$old.release_status"}`) read `null` from `$old.<field>` on INSERT and naturally pass, no extra guard needed unless INSERT needs distinct handling.

**Platform-extension operators** (Semantius adds these on top of standard JsonLogic):

| Operator | Shape | Meaning |
|---|---|---|
| `value_changed` | `{"value_changed": "<field_name>"}` | Returns `true` when the named field's new value differs from `$old.<field_name>`. On INSERT (where `$old` is `null`) it returns `true` (every field is "changed" from nothing). Sugar for `{"or": [{"==": [{"var": "$old"}, null]}, {"!=": [{"var": "<field>"}, {"var": "$old.<field>"}]}]}`. Use it to scope a transition-only check (gate the rule body to "only fires when this field moved"). |
| `require_permission` | `{"require_permission": "<permission_code>"}` | Returns `true` when the authenticated user (`$user_id`) holds the named permission. **Throws** otherwise, which the platform reports back as a validation failure on this rule's `code` and `message`. This is the only JsonLogic primitive that has side effects, so it is the mechanism for *conditional permissions*: pair it with an `if` whose test detects the sensitive transition, and use the success branch to invoke `require_permission`. The trivial branch must still return `true` so the rule passes when the transition isn't happening. |

**Conditional-permission pattern.** The two operators compose into the standard recipe for workflow-gated authorization:

```json
{
  "code": "approve_offer_requires_approver_permission",
  "message": "Only users with the offer-approver permission can mark an offer approved.",
  "description": "Moving an offer into `approved` is the budget commitment step. The static edit_permission on the entity lets recruiters draft and send offers; this rule layers the approval gate on top so only designated approvers can flip the status field itself.",
  "jsonlogic": {
    "if": [
      {
        "and": [
          { "value_changed": "status" },
          { "==": [{ "var": "status" }, "approved"] }
        ]
      },
      { "require_permission": "ats:approve_offer" },
      true
    ]
  }
}
```

The body reads: *"if the status field changed and its new value is `approved`, require the caller to hold `ats:approve_offer`; otherwise the rule passes trivially."* The wrap pattern is **`{"if": [<trigger>, {"require_permission": "..."}, true]}`**, the `true` fallback is mandatory; dropping it makes the rule fail whenever the trigger is false.

Three guidelines for `require_permission`:

1. **The permission code must be declared in §8 step 1 of the model.** The deployer cross-checks every `require_permission` argument against §8's permission list; an undeclared code is a deploy-time blocker, not a runtime surprise. Workflow-specific permissions (`<slug>:approve_<noun>`, `<slug>:close_<noun>`, `<slug>:sign_<noun>`) belong alongside the baseline `<slug>:read` / `<slug>:manage` / `<slug>:admin` triple.
2. **Use it inside `if`, never as a top-level rule body.** A bare `{"require_permission": "..."}` at the rule root throws on *every* write by anyone without the permission, which is what `edit_permission` is for (and `edit_permission` is the cheaper, static gate). The point of this operator is to gate *conditional* writes: the rule body's `if` condition decides when authorization is on the hook.
3. **Composition with `or`/`and` short-circuits.** `{"or": [<cheap-check>, {"require_permission": "..."}]}` only invokes the permission check when the cheap check failed. That's the canonical owner-or-elevated pattern (see below): owners pass the cheap check, non-owners hit the permission gate. Throws still propagate as rule failures, so the rule's `message` is what the user sees if neither leg holds.

**Owner-or-elevated pattern.** A second common composition restricts writes to the record's creator unless the caller has an elevated permission:

```json
{
  "code": "edit_restricted_to_owner_or_manager",
  "message": "Only the note author or a manager can edit or delete this note.",
  "description": "Notes are personal commentary; the author owns their own edits. Anyone else needs the elevated permission, which is granted to leads and HR partners.",
  "jsonlogic": {
    "if": [
      { "==": [{ "var": "$old" }, null] },
      true,
      {
        "or": [
          { "==": [{ "var": "$old.created_by" }, { "var": "$user_id" }] },
          { "require_permission": "ats:manage_all_notes" }
        ]
      }
    ]
  }
}
```

Read: *"on INSERT, pass; on UPDATE, pass if the caller is the original creator OR holds the elevated permission."* `require_permission` is only invoked when the owner-equality check failed; the rule's `message` surfaces the throw to the user. The `$old` null-check at the top makes the rule INSERT-safe.

**When NOT to reach for `require_permission`.** The static `edit_permission` on the entity (set from the §3 `**Edit permission:**` annotation) remains the right tool for coarse "who can write this table at all". Use `require_permission` only when the gate is *conditional* on record state, a transition, or row-ownership, the kind of policy that can't be expressed by a static role-to-table grant. If every write of the entity is equally sensitive, push the permission to `edit_permission` instead and skip the rule.

**Example transition rule** (a release that has reached `released` cannot regress):

```json
{
  "code": "released_is_terminal",
  "message": "A release that has been released cannot move back to planned or in_progress.",
  "jsonlogic": {
    "or": [
      { "==": [{ "var": "$old" }, null] },
      { "!=": [{ "var": "$old.release_status" }, "released"] },
      { "==": [{ "var": "release_status" }, "released"] }
    ]
  }
}
```

**Cross-entity lookups inside JsonLogic (`let`, `set_record`, `throw_error`).** `computed_fields` and `validation_rules` are no longer limited to the post-write record. The platform exposes three additional JsonLogic operators that bind values into the data context **before** the rest of the expression evaluates, opening FK traversal, parent-state gates, inherited values, and merged labels that previously had to live in cube views or per-model service code.

| Operator | Shape | Effect |
|---|---|---|
| `let` | `{"let": ["<name>", <value-expr>, <body-expr>]}` | Evaluates `<value-expr>`, binds the result under `<name>` for the body, returns the body's value. Nest to bind several names. |
| `set_record` | `{"set_record": ["<name>", "<entity_name>", <id-expr>, <body-expr>]}` | Resolves `<id-expr>`, loads that row from `<entity_name>` via the platform's `get_record_by_id(entity_name, id)` function, binds the JSONB row (or `null`) under `<name>` for the body. Inside the body, `{"var": "<name>.<column>"}` reads any column of the loaded row, exactly like `$old.<column>` for the post-write record. |
| `throw_error` | `{"throw_error": "<message>"}` | Raises a PostgreSQL exception (SQLSTATE `23514`) with the supplied message. The caller sees `<message>` verbatim, bypassing the rule's static `message`. Place inside an `if` so the throw is conditional. |

`let` and `set_record` evaluate before the bulk argument-evaluation pass inside the JsonLogic engine, so the body sees an augmented data context. Bindings disappear when the body returns.

**Where they run.**

- ✅ `computed_fields` — derive a value from a parent / referenced record (inherited currency, country, discount; merged label combining parent and child columns).
- ✅ `validation_rules` — gate a write on the state of a parent or sibling record ("reject if parent is shipped"); raise a domain-specific error message instead of the rule's generic `message` via `throw_error`.
- ⚠️ `select_rule` — *technically* available, but `set_record` runs an extra `SELECT` per row of every read. Default answer: do not use `set_record` here. For tiered visibility, column-encoded broadening or `has_permission` is the right shape.
- ⚠️ `input_type_rule` — runs client-side at form render, so `set_record` cannot fetch a row. Don't use the cross-entity operators here.

**`throw_error` vs the rule's static `message`.** A falsy rule returns `{ "code", "message" }` in the standard collect-all-failures pass. `throw_error` raises a SQL exception immediately, surfacing the throw argument as the caller-visible error and bypassing the rule's `message`. Reach for `throw_error` when one specific failure needs a different message than the rule's default (a deep-link to the conflicting record, an actionable instruction, or a domain-specific phrasing); stay with `message` when "validation failed because <code>" is enough and you want every failing rule listed.

**When to reach for these vs leave them off.** Every `set_record` costs one extra `SELECT` per evaluation. Use them for:

- **Parent-state gates** — refuse a write on a child row when the parent is in a specific state (an `order_lines` mutation against a shipped order).
- **Inherited values on a child** — copy `country`, `currency`, `discount_pct` from a parent record onto every child write.
- **Merged labels** — derive `label_column` from a parent's identifying field combined with a column on the current record.
- **Hand-tailored errors** — `throw_error` to surface a domain-specific message that the rule's default `message` can't carry.

They are **not** the right tool for cross-row aggregates ("Σ child.amount ≤ parent.total", "≤ 5 high-priority features per release"); those still belong in cube views with downstream alerts, or in a dedicated trigger when synchronous enforcement is non-negotiable. `set_record` loads one row by id; it does not scan or aggregate.

**Canonical patterns.**

Parent-state gate (the validation pattern that motivated the operators):

```json
{
  "set_record": ["order", "orders", {"var": "order_id"}, {
    "if": [
      {"==": [{"var": "order.status"}, "shipped"]},
      {"throw_error": "Cannot modify a shipped order"},
      true
    ]
  }]
}
```

Inherited value (parent currency mirrored onto every line):

```json
{
  "name": "currency_code",
  "description": "Mirrors the parent order's currency on every write.",
  "jsonlogic": {
    "set_record": ["order", "orders", {"var": "order_id"}, {
      "var": "order.currency_code"
    }]
  }
}
```

Merged label (`'INV-2025-0042 · line 3'`):

```json
{
  "name": "line_label",
  "description": "'<order_number> · line <line_no>'.",
  "jsonlogic": {
    "set_record": ["order", "orders", {"var": "order_id"}, {
      "cat": [{"var": "order.order_number"}, " · line ", {"var": "line_no"}]
    }]
  }
}
```

Nested lookup with `let` (parent discount applied to line subtotal):

```json
{
  "name": "line_total",
  "jsonlogic": {
    "set_record": ["order", "orders", {"var": "order_id"}, {
      "let": ["gross",
        {"*": [{"var": "unit_price"}, {"var": "quantity"}]},
        {"*": [{"var": "gross"}, {"-": [1, {"/": [{"var": "order.discount_pct"}, 100]}]}]}
      ]
    }]
  }
}
```

Two-hop traversal (`address → customer → country`):

```json
{
  "name": "country_code",
  "jsonlogic": {
    "set_record": ["customer", "customers", {"var": "customer_id"}, {
      "set_record": ["country", "countries", {"var": "customer.country_id"}, {
        "var": "country.iso_code"
      }]
    }]
  }
}
```

**Null handling.** `set_record`'s lookup returns `null` when the id is null or points at a deleted row. Inside the body, `{"var": "<name>"}` is `null` and `{"var": "<name>.<col>"}` is `null`. That flows naturally through comparisons (`{"==": [null, "shipped"]}` is `false`), so a parent-state gate quietly passes when the parent is missing. If "unresolved FK" should itself be a failure, guard explicitly with `{"if": [{"==": [{"var": "<name>"}, null]}, {"throw_error": "..."}, ...]}`.

**Deploy-time validation:** the platform rejects non-array values, names that don't resolve to a field on this entity, duplicate `code`s within an entity, and malformed `jsonlogic`. Column references via `{"var": "<binding>.<column>"}` inside `set_record` / `let` bodies are NOT checked at parse time (the binding name is known only at evaluation time); test cross-entity rules end-to-end before relying on them. Errors point at the offending array index.

**Example: passing both on `create_entity`** (a `features` entity that auto-derives `rice_score` and refuses to attach a release until the feature is committed):

```bash
semantius call crud create_entity '{
  "data": {
    "table_name": "features",
    "singular_label": "Feature",
    "plural_label": "Features",
    "label_column": "feature_title",
    "module_id": 12,
    "view_permission": "product_roadmap:read",
    "edit_permission": "product_roadmap:manage",
    "computed_fields": [
      {
        "name": "rice_score",
        "description": "(reach × impact × confidence) / effort, null when effort is missing or 0.",
        "jsonlogic": {
          "if": [
            { "and": [
              { "!=": [{ "var": "effort_score" }, null] },
              { ">":  [{ "var": "effort_score" }, 0] }
            ]},
            { "/": [
              { "*": [{ "var": "reach_score" }, { "var": "impact_score" }, { "var": "confidence_score" }] },
              { "var": "effort_score" }
            ]},
            null
          ]
        }
      }
    ],
    "validation_rules": [
      {
        "code": "release_only_when_committed",
        "message": "A release can only be assigned once the feature is planned, in_progress, or shipped.",
        "jsonlogic": {
          "or": [
            { "==": [{ "var": "release_id" }, null] },
            { "in": [{ "var": "feature_status" }, ["planned", "in_progress", "shipped"]] }
          ]
        }
      }
    ]
  }
}'
```

Both arrays default to `[]` and may be omitted entirely. `update_entity` **replaces**, not merges, the arrays — to remove a rule send the new full array; to drop all rules send `[]`.

### Row-level read access via `select_rule` (entity-level JsonLogic)

Every entity also carries an optional `select_rule` property — a single JsonLogic *object* (not an array) that, when non-empty, drives a `FOR SELECT` row-level security policy on the underlying table. It is the read-side analog of `validation_rules`: instead of a per-row truthy check on writes, it is a per-row truthy check on every read.

| Property | Type | Default | Purpose |
|---|---|---|---|
| `select_rule` | `object` (JsonLogic) | `{}` | Per-row predicate that must evaluate truthy for the row to be visible to the caller. Evaluated by the platform's RLS policy on every `SELECT`. |

**Storage and lifecycle.** JSONB object, NOT NULL, default `'{}'::jsonb`; the platform's `select_rule_is_object` constraint rejects anything that isn't a JSON object. When the rule is non-empty, the platform generates a `FOR SELECT` RLS policy function for the table; when the rule is reset to `{}` or the entity is deleted, the policy is dropped.

**Return contract.** The expression must return a **boolean**:

- `true` — the row is visible to the current caller.
- `false` — the row is filtered out of the result set (the caller sees neither the row nor its existence; FK joins from other tables that surface the row hit the same gate).

A non-boolean result is treated as falsy. The rule fails closed (rows hide), which is the safer direction, but a non-boolean result indicates an authoring bug and should be corrected.

**Reserved variables.** Same vocabulary as `computed_fields` / `validation_rules`: `$today`, `$now`, `$user_id` are server-injected; `$old` is not meaningful in a select context (no prior row to compare against) and should not be referenced.

**Relationship to `view_permission`.** Both apply, layered.

- `view_permission` is the **coarse table-level gate** ("does the caller have read access to this entity at all?"). A caller without `view_permission` sees nothing regardless of `select_rule`.
- `select_rule` is the **per-row filter** layered on top. A caller with `view_permission` still sees only rows where `select_rule` evaluates truthy.

The split is the right shape for the common pattern: every operational user has `view_permission` on the entity (so the entity is listed in their UI), and `select_rule` then narrows the per-user result set to "rows that belong to me / are visible to my tier". **Critical: `select_rule` applies uniformly to every caller with `view_permission`.** The platform evaluates the JsonLogic body per row with `$today` / `$now` / `$user_id` as reserved variables; there is no documented mechanism by which holding a specific permission causes the rule to be skipped for that caller. **Tiered visibility ("manager sees more than recruiter") cannot be encoded inside a single `select_rule`.** When the design wants a broader audience for some roles, the broadening goes through one of: (option B) a column on the row whose value the broader-audience predicate reads, (option C) a separate cube view / entity surface for the broader audience, (option D) a Postgres role with `BYPASSRLS` provisioned outside Semantius. The analyst surfaces this as a §7.1 architectural decision and the user picks; the `select_rule` body itself never promises a permission bypass it cannot implement.

**Performance.** Evaluated on every read of every row of this entity. Keep the expression simple: direct column comparisons, `$user_id` matches, enum / boolean checks. Avoid deeply nested arithmetic. `set_record` *is* technically callable from `select_rule` (the JsonLogic engine is the same as `validation_rules`), but it runs an extra `SELECT` per row of every read and quickly dominates query cost; prefer column-encoded broadening (a `visibility` enum the row carries) or `has_permission` for tiered audiences. Reserve `set_record` for the rare case where the FK target is small, indexed, and the entity sees light read traffic.

**Example — owner-or-public visibility:**

```json
{
  "or": [
    { "==": [{ "var": "owner_id" }, { "var": "$user_id" }] },
    { "==": [{ "var": "visibility" }, "public" ] }
  ]
}
```

The caller sees a row when they own it OR when the row is marked public.

**Example — case-management shape (uniform per-row filter).** Tickets are visible to their submitter, their assignee, and every caller with `view_permission` when unassigned:

```json
{
  "or": [
    { "==": [{ "var": "submitter_user_id" }, { "var": "$user_id" }] },
    { "==": [{ "var": "assignee_user_id" }, { "var": "$user_id" }] },
    { "==": [{ "var": "assignee_user_id" }, null] }
  ]
}
```

**This rule applies uniformly to every caller with `view_permission`** — including managers. A manager calling the API sees only the tickets they submitted, are assigned to, or that are unassigned. If the design wants managers to see every ticket regardless, that is a **§7.1 architectural decision**, not something the rule can encode. The four options the analyst surfaces to the user:

- **A. Accept the uniform filter.** Managers query the same data the rule allows; "see all tickets" becomes a cube view or a different reporting surface.
- **B. Encode broadening in a column.** Add a `visibility` enum with a `team` value; the rule reads it (`visibility==team OR submitter==$user OR assignee==$user`). Author-controlled, per-row, no permission bypass involved.
- **C. Separate entity / cube view.** Managers read tickets through `manager_ticket_overview` (a cube view exposing all tickets), not through the `tickets` entity directly. The view has its own `view_permission` granted only to manager roles.
- **D. Postgres `BYPASSRLS` role.** A specific Postgres role (often the one Semantius provisions for `<slug>:admin` holders) is configured with the `BYPASSRLS` attribute and skips the RLS policy entirely. Requires platform / DBA confirmation that the role attribute is set; analyst NEVER assumes it without explicit user sign-off.

**Never write a rule that promises a `<slug>:view_all_<plural>` permission bypass without one of these mechanisms being explicitly resolved.** The platform does not honor permission-based bypass of `select_rule` as a documented feature; the rule's JsonLogic is the only thing the platform evaluates per row, and a prose claim that the bypass exists does not make the platform implement it.

**Setting and removing.**

```bash
semantius call crud update_entity '{
  "table_name": "tickets",
  "data": {
    "select_rule": {
      "or": [
        { "==": [{ "var": "submitter_user_id" }, { "var": "$user_id" }] },
        { "==": [{ "var": "assignee_user_id" }, { "var": "$user_id" }] },
        { "==": [{ "var": "assignee_user_id" }, null] }
      ]
    }
  }
}'

# Remove and drop the generated RLS policy function:
semantius call crud update_entity '{
  "table_name": "tickets",
  "data": { "select_rule": {} }
}'
```

**Risk.** Adding a `select_rule` to an entity that previously had none is **medium-risk** (read access pattern changes; rows that callers used to see suddenly disappear). Always warn the user, name the roles/users that should still see everything, and confirm rollout. Modifying or removing is also medium-risk (visibility change can surprise downstream consumers, dashboards, integrations).

---

## Fields

### Field Format Quick Reference

Choose `format` carefully. Format **can** be changed after creation, but **only within the same Postgres primitive type**. Same-primitive transitions are allowed (`text → multiline → html`, all `TEXT`); cross-primitive transitions are rejected by the platform (`text → date`, `integer → number`, `date → boolean`). The primitive groupings are visible in the format-to-primitive table later in this reference (under `default_value`). Still pick the format deliberately on the first pass: a later change re-renders the form (input shape) and may require republishing UI surfaces, even though the column data survives.

| Category | `format` values |
|----------|----------------|
| Text | `string`, `text`, `multiline`, `html`, `code` |
| Numbers | `integer`, `int32`, `int64`, `number`, `float`, `double`, use `number` (arbitrary-precision, maps to Postgres `NUMERIC`) for all monetary/currency/amount fields (`price`, `cost`, `amount`, `total`, `balance`, `revenue`, `fee`, `rate`, `salary`, `budget`, `discount`). Pair with `precision` (digits after the decimal; default `2` suits money, set `4`–`6` for tax/FX rates, `0` for integer-like NUMERIC counts). `float`/`double` are binary IEEE-754 and lose cents on rounding, only use them when the user explicitly requests them or the value is inherently imprecise (scientific measurements, ML scores, GPS coordinates) |
| Dates/Time | `date`, `time`, `date-time`, `duration` |
| Boolean | `boolean` |
| Choice | `enum` (also set `enum_values: ["a","b","c"]`) |
| Structured | `json`, `object`, `array` |
| Identifiers | `uuid`, `email`, `uri`, `url` |
| Cross-entity link (independent) | `reference` + `reference_table` |
| Ownership/composition | `parent` + `reference_table` |

> 🛑 **Any field with `reference_table` MUST use `format: "reference"` or `format: "parent"`. Never combine `reference_table` with scalar formats (`integer`, `uuid`, `string`, etc.). This will always fail.**

**Picking between text formats.** All five resolve to a Postgres `TEXT` column; the format selects the UI input shape. Because they share a primitive, the format **can be changed among them after creation** — `text → multiline → html` is safe and accepted by `update_field`. The choice still matters up front because flipping later re-renders the form and may force a UI republish. Cross-primitive changes (e.g. `text → date`) are rejected by the platform.

- `string` and `text` are **single-line** inputs — names, titles, labels, email-like identifiers, short tags. The form renders a single-line `<input>`. Use these for any field that holds a short value displayed on a single row.
- `multiline` is the **multi-line** input — descriptions, notes, comments, free-form prose, journal entries, scorecard commentary. The form renders a `<textarea>`. Pick `multiline` whenever the field holds prose the user might paste a paragraph into; pick `text` / `string` when the value is a single line. The distinction lives in the column metadata, so the choice is made up front and migrating between them later means dropping and recreating the field.
- `html` renders a rich-text editor on top of HTML storage; reserve for fields that need formatted output (release notes, marketing copy).
- `code` renders a monospace code editor; reserve for stored source / configuration snippets.

Heuristic: field names like `*_name`, `*_title`, `*_label`, `*_code`, `email_address`, `phone_number`, `url` → single-line (`string` or `text`). Field names like `description`, `notes`, `body`, `comment`, `concerns`, `strengths`, `feedback`, `summary`, `details`, `rationale`, `instructions` → multi-line (`multiline`).

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
| `required` | Editable but marked mandatory in UI |
| `readonly` | Displayed but not editable, **never import into this** |
| `disabled` | Greyed out, not editable, **never import into this** — this is the canonical mode for **computed fields** (the platform owns the value; caller payloads are silently overwritten on every write) |
| `hidden` | Not shown in forms |

### Dynamic `input_type` via `input_type_rule` (field-level JsonLogic)

Every field carries an optional `input_type_rule` — a JsonLogic *object* (not an array) that overrides the static `input_type` per-record at form-render time. It is the read-side analog of `computed_fields` for UI shape: instead of deriving a stored value on write, it derives the field's visible mode on read.

| Property | Type | Default | Purpose |
|---|---|---|---|
| `input_type_rule` | `object` (JsonLogic) | `{}` | Per-record predicate that returns the effective `input_type` for this field in the current record. Evaluated client-side at form render. |

**Storage.** JSONB object, NOT NULL, default `'{}'::jsonb`. The static `input_type` column is still the declared baseline; `input_type_rule` is the dynamic override.

**Return contract.** The expression must return **one of the valid `input_type` enum values**: `"default"`, `"required"`, `"readonly"`, `"disabled"`, `"hidden"`. The returned value replaces the static `input_type` for this field when the form renders the current record.

**Fallback.** If the rule is empty (`{}`), if the expression throws, or if it returns a value outside the enum, the static `input_type` is used. Fail-open in the UI-mode sense: a malformed rule degrades to the declared baseline rather than unexpectedly hiding or locking the field.

**Where it runs.** Evaluated **client-side against the current form record** at render time. Server-side reads and writes still respect the field's actual nullability and validation rules — `input_type_rule` is purely a UI control. A field rendered `hidden` is still writable via API; a field rendered `readonly` is still mutable via API. Anything that must be enforced server-side belongs in `validation_rules`, not `input_type_rule`.

**Reserved variables** (where the client supplies them): `$today`, `$now`, `$user_id`. `$old` is not meaningful in the client render context.

**Example — lock `approved_at` once the record is approved:**

```json
{
  "if": [
    { "==": [{ "var": "status" }, "approved"] },
    "readonly",
    "default"
  ]
}
```

**Example — show `approved_at` only when the record is being approved.** The "housekeeping field appears at the right moment" pattern: starts hidden, surfaces as editable when the user moves the record into `approved`, locks readonly after save. The simplest two-state expression (always works, no `$old` dependency):

```json
{
  "if": [
    { "==": [{ "var": "status" }, "approved"] },
    "readonly",
    "hidden"
  ]
}
```

Pair this with a `validation_rules` entry on the server side that requires `approved_at` to be non-null whenever `status` is `approved`; together they give the analyst both the "field appears at the right time" UX and the "the field is actually populated" data invariant.

**Setting and removing.**

```bash
semantius call crud update_field '{
  "id": "tickets.approved_at",
  "data": {
    "input_type_rule": {
      "if": [
        { "==": [{ "var": "status" }, "approved"] },
        "readonly",
        "default"
      ]
    }
  }
}'

# Remove and revert to the static input_type:
semantius call crud update_field '{
  "id": "tickets.approved_at",
  "data": { "input_type_rule": {} }
}'
```

**Risk.** Adding an `input_type_rule` is **low-risk** (UI behavior only, no data effect, fails open). Modifying or removing one is **medium-risk** in the UX sense (forms suddenly show, hide, or unlock a field mid-workflow); coordinate the change with whoever owns the forms.

### `unique_value`

Set `unique_value: true` only when duplicates would cause data integrity issues (e.g., `email` on contacts, external system keys).

> ⚠️ Adding `unique_value: true` to an **existing** field is medium-risk, will fail if duplicates exist. Warn the user and suggest deduplication first.

### `default_value`: auto-filled by the platform; authors only override

The Semantius column-add trigger picks a sensible default automatically based on `format` and whether the field is required (`input_type: "required"`):

| Format | PostgreSQL type | Auto-default when required |
|---|---|---|
| `string`, `text`, `multiline`, `email`, `url`, …  | `TEXT` | `''` |
| `int32`, `int64`, `integer` | `INTEGER` / `BIGINT` | `0` |
| `number`, `float`, `double` | `NUMERIC` / `REAL` | `0.0` |
| `boolean` | `BOOLEAN` | `FALSE` |
| `json`, `object`, `array` | `JSONB` | `'{}'` |
| `date-time` | `TIMESTAMPTZ` | `CURRENT_TIMESTAMP` |
| `date` | `DATE` | `CURRENT_DATE` |
| `enum` | `TEXT` (with CHECK) | first value in `enum_values` |

Nullability is also computed by format (via the platform's `is_nullable()` rule): **only `reference`, `date`, and `date-time` allow NULL**. Every other format is `NOT NULL` with the auto-default above when required. Non-required fields accept `''`/null as a backfill.

**Rule:** authors do **not** need to declare `default_value`. Only set it explicitly when the auto-default is wrong for the domain, e.g. a non-zero starting balance, a non-initial enum state (`archived` instead of `draft`), a specific seed string.

- **Enum lifecycle ordering matters.** The auto-default for a required enum is `enum_values[0]`, so list values in lifecycle order (`draft`, `pending`, `new`, `open`, `active` first). If the natural starting value isn't first, either reorder the list or set `default_value` explicitly.
- **`Required = "no"` only changes DB behavior for `reference`, `date`, `date-time`.** For other formats the column is NOT NULL with the auto-default regardless of `input_type`; marking the field optional doesn't make it nullable.

```bash
# Required enum on a possibly-non-empty entity — always include default_value
semantius call crud create_field '{
  "data": {
    "table_name": "departments",
    "field_name": "status",
    "title": "Status",
    "format": "enum",
    "enum_values": ["active", "inactive"],
    "default_value": "active",
    "input_type": "required",
    "width": "default",
    "field_order": 5
  }
}'
```

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

```bash
# Searchable text field
semantius call crud create_field '{
  "data": {
    "table_name": "products",
    "field_name": "description",
    "title": "Description",
    "format": "text",
    "width": "default",
    "input_type": "default",
    "field_order": 2,
    "searchable": true
  }
}'

# Numeric field
semantius call crud create_field '{
  "data": {
    "table_name": "products",
    "field_name": "price",
    "title": "Price",
    "format": "number",
    "precision": 2,
    "width": "default",
    "input_type": "default",
    "field_order": 3
  }
}'

# Enum/dropdown — required, so include default_value to backfill existing rows
semantius call crud create_field '{
  "data": {
    "table_name": "products",
    "field_name": "status",
    "title": "Status",
    "format": "enum",
    "enum_values": ["draft", "active", "discontinued"],
    "default_value": "draft",
    "width": "default",
    "input_type": "required",
    "field_order": 4
  }
}'
```

### All Field Properties

| Property | Type | Notes |
|----------|------|-------|
| `table_name` | string | Target entity, required |
| `field_name` | string | Snake_case identifier. Renaming is supported but think twice: views, integrations, and saved queries reference the field by name. |
| `title` | string | Human-readable label shown in UI |
| `description` | string | Explains what the field represents |
| `format` | string | Changeable only within the same underlying database base type (e.g., one string format can swap to another string format). Cannot cross base-type families (string, number, date, boolean, reference). See format table above. |
| `width` | string | `default` (default), `s`, `m`, `w` |
| `input_type` | string | `default`, `required`, `readonly`, `disabled`, `hidden` |
| `field_order` | integer | Controls display order in the UI |
| `searchable` | boolean | Adds this field to the entity's full-text search index |
| `unique_value` | boolean | Enforces uniqueness at database level |
| `enum_values` | array | Required when `format: "enum"`, list of allowed values |
| `precision` | integer (0–18) | For `format: "number"` only, number of digits after the decimal point in the generated `NUMERIC` column. Defaults to `2` (suits money and most measured quantities). Set higher (e.g. `4`–`6`) for tax rates, FX rates, or scientific values; `0` for integer-like counts that still want NUMERIC semantics. |
| `default_value` | string | Override for the platform's auto-default. Only set when the auto-default is wrong for the domain. See `### default_value` below for the auto-default table per format. |
| `reference_table` | string | Target entity's `table_name` for `reference`/`parent` fields |
| `reference_delete_mode` | string | `restrict`, `clear`, or `cascade` |
| `relationship_label` | string | Optional verb describing the relationship (e.g. `"employs"`, `"contains"`). Applies to `reference` and `parent` fields. Used as the edge label in ER diagrams and in navigation breadcrumbs. Always optional, omit when the direction is obvious from the field name. |
| `singular_label_parent` | string | Optional override for the parent entity's singular label, used by `parent` fields only. Useful when one entity has multiple `parent` fields pointing at the same table (e.g. `billing_address_id` vs `shipping_address_id`, both → `addresses`) and the default labels are ambiguous. |
| `plural_label_parent` | string | Optional override for the parent entity's plural label, used by `parent` fields only. Pair with `singular_label_parent`. |
| `cube_type` | string | OLAP cube participation: `disabled`, `auto` (default), `dimension`, `measure`. See `### cube_type Values` below. |
| `icon_url` | string | Optional icon URL for this field in the UI |

---

## Relationships

### Choosing the Right Format

The platform manages nullability internally based on format and delete-mode, do not pass an `is_nullable` flag. A `reference` with `clear` is optional (can be null); a `parent` with `cascade` is required.

**Read order:** the divergent-permission-scope rule (last two rows) **overrides** the "child is owned by parent" and "M:N junction FK" rows whenever the child's edit tier differs from the parent's. Always evaluate divergence first; fall through to the same-tier rows only when tiers match.

| Scenario | `format` | `reference_delete_mode` |
|----------|----------|------------------------|
| Optional link to independent entity | `reference` | `clear` |
| Required link to independent entity | `reference` | `restrict` |
| Child is owned by parent (**shared permission scope** — child tier == parent tier) | `parent` | `cascade` |
| M:N junction FK, **both parents share the junction's tier** (per-leg test, not table-wide) | `parent` | `cascade` |
| **Lifecycle-bound child with divergent permission scope** (analyst v1.13+) — overrides the two rows above | `reference` | `restrict` (default) or `clear` |
| Lifecycle-bound child with divergent permission scope, accepting silent cascade-delete (high-risk) — overrides the two rows above | `reference` | `cascade` |

**Divergent-permission-scope rule (analyst v1.13+).** `format: parent` semantically asserts that the child shares the parent's permission model. When a child has its own conditional permission gate (a `validation_rules` rule whose JsonLogic invokes `require_permission` against a workflow permission that the parent does not require, or a §3 `**Edit permission:**` annotation that differs from the parent's tier), `parent` is the wrong shape. Use `format: reference` instead. Pick the delete mode by lifecycle behavior: `restrict` when children must be explicitly cleaned up before the parent (recommended default for audit-logged decision evidence like scorecards or signed offers), `clear` when orphan-survival is acceptable (e.g. an authored note may survive its application being deleted), `cascade` only when the user explicitly accepts the silent cascade-delete trade-off (the shape says "permission scope is divergent" but the platform deletes anyway when the lifecycle owner goes).

### `reference`: Cross-Entity Link (Independent Lifecycle)

Use when the child record is **created independently** and then associated with the parent, it exists and makes sense on its own. Example: a Task is created on its own and linked to a Lead; a Product exists independently of any category. The child can outlive or be reassigned away from the parent.

```bash
# Order has an optional assigned sales rep
semantius call crud create_field '{
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
}'
```

### `parent`: Ownership/Composition (Bound Lifecycle)

Use when the child record is **always created in the context of the parent** and has no meaning outside it, master-detail. Example: an Order Line is created within an Order; a Meeting Attendee is created within a Meeting. You would never create the child record first and link it later.

```bash
# Order line belongs to an order
semantius call crud create_field '{
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
}'
```

### M:N Junction Tables

Create a junction entity and add two `parent` fields:

```bash
# Create junction entity
semantius call crud create_entity '{"data": {"table_name": "product_tags", ...}}'

# FK to products
semantius call crud create_field '{"data": {"table_name": "product_tags", "field_name": "product_id", "format": "parent", "reference_table": "products", "reference_delete_mode": "cascade", "width": "default", "input_type": "default"}}'

# FK to tags
semantius call crud create_field '{"data": {"table_name": "product_tags", "field_name": "tag_id", "format": "parent", "reference_table": "tags", "reference_delete_mode": "cascade", "width": "default", "input_type": "default"}}'
```

---

## Safe Evolution Patterns

### ✅ Low-Risk (do freely)
- Add new fields
- Update descriptions, labels, UI hints (`width`, `field_order`, `icon_url`)
- Add `searchable: true` to fields
- Create new entities in new or existing modules
- Add new permissions/roles/assignments
- Add a new `input_type_rule` to a field (pure UI behavior, fails open)

### ⚠️ Medium-Risk (warn user first)
- Changing `reference_delete_mode`
- Adding `view_permission`/`edit_permission` to previously open entities
- Changing `enum_values`
- Adding `unique_value: true` to an existing field (fails if duplicates exist)
- Adding, modifying, or removing a `select_rule` on an entity (changes read visibility; rows may suddenly disappear or reappear for current users)
- Modifying or removing an existing `input_type_rule` (forms suddenly show, hide, or unlock a field mid-workflow)

### 🛑 High-Risk (require explicit confirmation)
- Renaming `table_name` or `field_name`, breaks all references
- Deleting entities or fields, permanent data loss
- Removing permissions still in use by roles
- Changing primary key fields
- Always check dependencies before deletion

---

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
# 2. Only proceed if no references found and user has confirmed
semantius call crud delete_entity '{"table_name": "<table_name>"}'
```

---

## Agent Workflow Tips

1. **Always read before writing**, Before any `create_*`, call `read_*` to check for existing records. E.g., always call `read_entity` filtering by `table_name` before `create_entity`.
2. **Resolve prerequisites in order**, Module → Permissions → Entity → Fields. Never skip steps.
3. **Be conversational**, Explain what you're creating and why, especially for module/permission scaffolding the user may not have explicitly requested.
4. **Validate semantic correctness**, Does the model make sense for the user's domain?
5. **Ask for clarification when needed**, If a user says "add contacts", confirm what fields they need before creating anything.
6. **Warn before risky changes**, Alert the user to medium/high-risk changes and wait for confirmation before executing.
7. **Suggest next steps**, After creating an entity, suggest related entities, missing fields, or useful roles.
8. **Provide link to UI**, After creating or updating entities/fields, provide: `https://tests.semantius.app/{module_slug}/{table_name}` (URLs use the lowercase `module_slug`, never the display `module_name`).

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

---

## Tool Priority Rule

**Always use typed CRUD tools** (`create_*`, `read_*`, `update_*`, `delete_*`) for standard operations.

Only use `postgrestRequest` or `sqlToRest` for:
- Complex multi-filter or aggregation queries not expressible through typed tools
- Bulk updates across many existing records

---

## Entity Reference: All Managed Tables

| Table | Purpose | Key Relationships |
|-------|---------|-------------------|
| `entities` | Domain concept definition | Parent of fields; references module; uses permissions |
| `fields` | Entity attributes/columns | Belongs to entity; may reference other entities |
| `modules` | Domain grouping | Referenced by entities, roles, permissions |
| `permissions` | Atomic capabilities | Used by entities; granted to roles; can inherit |
| `permission_hierarchy` | Permission inheritance | Links including/included permissions (broader includes narrower) |
| `roles` | Permission bundles | Granted permissions; assigned to users |
| `role_permissions` | Role ↔ Permission M:N | Junction with audit fields |
| `users` | Actor identities | Assigned roles via `user_roles` |
| `user_roles` | User ↔ Role M:N | Junction with audit fields |
| `webhook_receivers` | Import/integration endpoints | Scoped to a target table |
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
