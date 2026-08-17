# Semantius JsonLogic Reference

Semantius evaluates JsonLogic expressions on four surfaces:

- **`computed_fields`** (entity-level) — derive stored values on every write.
- **`validation_rules`** (entity-level) — enforce record invariants on every write.
- **`select_rule`** (entity-level, read side) — per-row visibility; documented in `select-rule.md`.
- **`input_type_rule`** (field-level) — dynamic form-input mode at render time.

This file documents the write-side rules (`computed_fields`, `validation_rules`), the shared operator vocabulary, cross-entity lookups, and `input_type_rule`. Where each property is declared (`create_entity` / `update_entity` / `create_field`) and how it interacts with the rest of the schema is covered in `data-modeling.md`.

---

### Computed fields and validation rules (entity-level JsonLogic)

Every entity carries two optional JSON-array properties that let the platform derive values and enforce invariants on every write, without per-model service code:

| Property | Type | Default | Purpose |
|---|---|---|---|
| `computed_fields` | `array` | `[]` | Ordered list of fields whose values are derived from the same record via JsonLogic. |
| `validation_rules` | `array` | `[]` | Ordered list of record-level invariants that must hold for a write to succeed. |

Both are first-class entity properties: read with `read_entity`, set on `create_entity`, replaced on `update_entity`. The platform compiles them into `BEFORE INSERT / UPDATE` triggers; when both arrays are empty (or the entity is deleted) the trigger is dropped.

#### `computed_fields` element shape

```json
{
  "name":        "rice_score",
  "jsonlogic":   { /* JsonLogic expression */ },
  "description": "Optional human note"
}
```

- `name` (string, required) — must reference an existing scalar field on the same entity. The result is written into this field. May reference a JSONB sub-property via dotted notation (e.g. `"metadata.rice"`).
- `jsonlogic` (object, required) — evaluated against the merged record (caller payload + values written by earlier `computed_fields` entries).
- `description` (string, optional) — human note for future readers and agents.

#### `validation_rules` element shape

```json
{
  "code":        "release_only_when_committed",
  "message":     "A release can only be assigned once the feature is planned, in_progress, or shipped.",
  "jsonlogic":   { /* JsonLogic expression */ },
  "description": "Optional human note explaining why this rule exists"
}
```

- `code` (string, required) — snake_case, unique within the entity. Stable identifier for UI / i18n binding.
- `message` (string, required) — default English text returned to the caller on failure.
- `jsonlogic` (object, required) — must evaluate truthy for the record to be valid.
- `description` (string, optional) — human note explaining *why* this rule exists.

#### Evaluation semantics (per write)

1. **Compute pass.** Iterate `computed_fields` in array order. For each entry, evaluate `jsonlogic` against the merged record (caller payload + previously-computed values), then write the result into `name`. If the expression throws, the platform surfaces a structured error naming the offending entry's `name` plus the inner error. Caller-supplied values for a computed field are silently overwritten.
2. **Validate pass.** Iterate `validation_rules` in array order against the post-compute record. A rule passes when the result is truthy. The platform collects *all* failing rules (no short-circuit) and rejects the write with `{ "errors": [ { "code": "...", "message": "..." }, ... ] }`. If `jsonlogic` throws on a rule, the error names the rule's `code` plus the inner error.
3. **Atomicity.** Compute and validate run inside the same transaction as the write — either the record lands with all derivations applied and all rules passing, or nothing changes.

#### Reserved variables

JsonLogic expressions may read these injected variables via `{"var": "$name"}`:

| Var | Type | Meaning |
|---|---|---|
| `$today` | `date` | Server date at evaluation time. |
| `$now` | `date-time` | Server timestamp at evaluation time. |
| `$user_id` | `uuid` | Authenticated user performing the write (`null` for system writes). |
| `$old` | `object` or `null` | Previous row as JSON on UPDATE; `null` on INSERT. Use to express transition rules ("the workflow state cannot move from `released` back to `planned`") and "set-once" invariants ("`account_number` is immutable after first save"). |

`$old` is the only window into prior state; everything else outside the post-write record (cross-row lookups, aggregates, FK traversal) is out of scope and belongs in cube/views.

**Detecting INSERT vs UPDATE:** `$old` is `null` on INSERT, an object on UPDATE. A rule that should fire only on UPDATE wraps its body in `{"if": [{"!=": [{"var": "$old"}, null]}, <update-only-check>, true]}` so the INSERT path passes trivially. Conversely, transition rules that compare current vs prior values (e.g. `{"var": "release_status"}` against `{"var": "$old.release_status"}`) read `null` from `$old.<field>` on INSERT and naturally pass — no extra guard needed unless the INSERT path needs distinct handling.

**Example transition rule** (a release that's reached `released` cannot regress):

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

The rule passes on INSERT (no prior row), passes when the prior status was anything but `released`, and on UPDATE from `released` only passes when the new status is still `released`.

#### Platform-extension operators

In addition to standard JsonLogic operators, the platform provides three extension operators usable in `computed_fields`, `validation_rules`, `select_rule` (see `select-rule.md`), and `input_type_rule`:

| Operator | Shape | Returns | Use in |
|---|---|---|---|
| `{"value_changed": "<field>"}` | unary, takes a field name string | boolean — `true` when the field's value differs from `$old.<field>` (always `true` on INSERT) | `validation_rules`, `computed_fields`. Scope a rule to the moment a specific column changes (e.g. an approval gate fires only on the transition into `approved`, not on every subsequent edit). |
| `{"require_permission": "<permission_code>"}` | unary, takes a permission code string | boolean — returns `true` when the caller holds the permission, **throws** otherwise (surfacing the throw as a validation failure with the rule's `code` / `message`) | `validation_rules`. Use only inside `if` so the throw is conditional, not unconditional. Wrong shape for `select_rule` (a per-row throw during SELECT would be a disaster) — use `has_permission` there instead. |
| `{"has_permission": "<permission_code>"}` | unary, takes a permission code string | boolean — `true` when the caller holds the permission, `false` otherwise (never throws) | `select_rule` (see `select-rule.md`; primary use — added specifically so `select_rule` can broaden visibility for elevated roles without throwing per row), `input_type_rule`, and `validation_rules` (when a non-throwing check is preferable, e.g. composing with `or` to allow the permission *or* an ownership match). |

**Choosing between `require_permission` and `has_permission` in `validation_rules`.** Both work on the write side. `require_permission` throws on miss, surfacing the rule's `message` to the caller — the right shape when the permission is a hard requirement and the failure message *is* the explanation ("Only an approver can move an offer to `approved`"). `has_permission` returns boolean — the right shape when the permission is one branch of a wider predicate ("the caller is the owner *or* holds the override permission"), because `or([owner_match, require_permission(...)])` would throw on every non-owner, defeating the disjunction; `or([owner_match, has_permission(...)])` correctly returns truthy whenever either branch matches.

**Example — conditional approval gate (uses `value_changed` + `require_permission`):**

```json
{
  "code": "approve_offer_requires_approver_permission",
  "message": "Only users with the offer-approver permission can mark an offer approved.",
  "jsonlogic": {
    "if": [
      { "and": [
        { "value_changed": "workflow_state" },
        { "==": [{ "var": "workflow_state" }, "approved"] }
      ]},
      { "require_permission": "ats:approve_offer" },
      true
    ]
  }
}
```

**Example — owner-or-elevated edit scope (uses `has_permission`):**

```json
{
  "code": "edit_restricted_to_author_or_manager",
  "message": "Only the note's original author or a user with the manage-all-notes permission can edit this note.",
  "jsonlogic": {
    "if": [
      { "==": [{ "var": "$old" }, null] },
      true,
      { "or": [
        { "==": [{ "var": "$old.author_user_id" }, { "var": "$user_id" }] },
        { "has_permission": "ats:manage_all_notes" }
      ]}
    ]
  }
}
```

INSERT passes trivially (no `$old`); UPDATE / DELETE passes when the caller is the original author or holds the override permission. Using `has_permission` here (not `require_permission`) is essential — the `or` needs a non-throwing branch so the owner-match path works for callers without the override.

#### String concatenation (`concat`)

`concat` joins any number of arguments into a single string, mimicking SQL `CONCAT` semantics. Available in `computed_fields`, `validation_rules`, `select_rule` (see `select-rule.md`), and `input_type_rule`.

**Shape:** `{"concat": [arg1, arg2, ...]}`

**Behavior:**

- Accepts any number of arguments of any JSON type.
- `null` / missing values → treated as the empty string (no error, no `"null"` literal).
- Strings → appended as-is (unquoted).
- Numbers, booleans, arrays, objects → converted via their JSON text representation (e.g. `42`, `true`, `[1,2]`, `{"k":"v"}`).
- Returns a JSON string.

**Examples:**

```json
{"concat": ["Hello ", {"var": "name"}, "!"]}
// data {"name": "World"} → "Hello World!"

{"concat": ["Order #", {"var": "id"}, " - ", {"var": "status"}]}
// data {"id": 42, "status": "shipped"} → "Order #42 - shipped"

{"concat": ["a", null, "b"]}
// → "ab"  (null becomes empty, not "null")
```

**Difference from `cat`.** `cat` is the standard JsonLogic string operator and also concatenates, but uses `jl_to_text` coercion (which returns `''` for null and the raw text for strings). `concat` is functionally similar for most inputs; the explicit distinction is the SQL-`CONCAT`-style framing and explicit handling of all JSON types via `::text` for non-strings. Reach for `concat` when the intent is "build a label or message" with mixed-type inputs and predictable null handling; `cat` remains fine for plain string-only joins.

#### Cross-entity lookups inside JsonLogic (`let`, `set_record`, `throw_error`)

`computed_fields` and `validation_rules` are no longer limited to the post-write record. The platform exposes three additional JsonLogic operators that bind values into the data context **before** the rest of the expression evaluates, opening the door to FK traversal, parent-state gates, inherited values, and merged labels that previously had to live in cube views or per-model service code.

| Operator | Shape | Effect |
|---|---|---|
| `let` | `{"let": ["<name>", <value-expression>, <body-expression>]}` | Evaluates `<value-expression>`, binds it under `<name>` for the duration of `<body-expression>`, returns the body's result. Nest `let` calls to bind several names. Useful for naming a sub-expression you reference more than once. |
| `set_record` | `{"set_record": ["<name>", "<entity_name>", <id-expression>, <body-expression>]}` | Resolves `<id-expression>` against the data context, calls `get_record_by_id(<entity_name>, <id>)`, binds the resulting row (JSONB object, or `null` when no row matches) under `<name>` for the duration of `<body-expression>`, returns the body's result. Inside the body, `{"var": "<name>.<column>"}` reads any column of the loaded row, exactly like `$old.<column>` for the post-write record. |
| `throw_error` | `{"throw_error": "<message>"}` | Raises a PostgreSQL exception with SQLSTATE `23514` and the supplied message. The platform surfaces the message back to the caller verbatim, bypassing the rule's static `message` field. Place inside an `if` so the throw is conditional. |

`let` and `set_record` are evaluated before the bulk argument-evaluation pass inside `evaluate_json_logic`, so the body sees an augmented data context. The bindings disappear when the body returns.

**Supporting Postgres function (advanced).** The operators are implemented on top of `get_record_by_id(entity_name TEXT, id TEXT) RETURNS JSONB`, which looks up the entity's `id_column` from the `entities` meta-table, queries the physical table, and returns the row as JSONB (or `NULL` when nothing matches). You normally never call it directly — `set_record` is the authoring surface — but the function is callable from SQL when a query or other trigger needs the same lookup.

**Where they run.** `let`, `set_record`, and `throw_error` are evaluated by the same JsonLogic engine that powers `computed_fields` and `validation_rules`, so they are usable wherever the engine runs:

- ✅ `computed_fields` — derive a value from a parent / referenced record.
- ✅ `validation_rules` — gate a write on the state of a parent or sibling record.
- ⚠️ `select_rule` (see `select-rule.md`) — *technically* available, but `set_record` runs an extra `SELECT` per row of every read. Use only when the FK target is small and indexed AND the entity sees light read traffic. For tiered visibility, column-encoded broadening (a `visibility` enum) or `has_permission` is almost always the right shape. Default answer: do not use `set_record` in `select_rule`.
- ⚠️ `input_type_rule` (documented below in this file) — evaluated client-side at form render, so `set_record` cannot fetch a row. Don't use `set_record` here; `let` / `throw_error` are also pointless in a UI control. Stick to record-local variables.

**`throw_error` vs the rule's `message`.** A `validation_rules` entry that returns falsy is rejected with its `code` and `message` packaged into the standard error response. A `throw_error` raises a SQL exception immediately, so:

- The caller receives the `throw_error` argument verbatim as the error text (Postgres `23514` `check_violation`).
- The rule's static `message` is moot when the throw fires — the throw wins.
- Only one rule's throw surfaces (the platform's collect-all-failures pass stops at the first SQL exception). If you want every failing rule listed, prefer falsy-returns with rule-specific `message`s; reach for `throw_error` when one specific failure must surface a different, hand-tailored message than the rule's default (e.g. a multi-language string, a deep-link to the conflicting record, an actionable instruction).

**When to reach for these vs leave them off.** The three operators add real expressiveness, but every `set_record` costs one extra `SELECT` per evaluation. Treat them as the right tool for:

- **Parent-state gates** — refuse to modify an `order_line` when the parent `order.workflow_state = 'shipped'`. Without `set_record`, this rule had no way to read the parent's workflow_state; the gate had to live in application code.
- **Inherited values on a child** — compute `country` on `addresses` from the customer record; copy `currency` from the parent `order` onto every line; pull `discount_pct` from the customer's contract.
- **Merged labels** — derive a `label_column` value that combines fields from the current record AND a parent (`"Line 3 — INV-2025-0042"`, `"<order_number> / <line_no>"`).
- **Conditional cross-entity throw** — a parent record in a specific state should reject the child write with a domain-specific error: `{"throw_error": "Cannot modify a shipped order"}` rather than a generic `"validation failed"`.

They are **not** the right tool for cross-row aggregates ("≤ 5 high-priority features per release", "Σ child amounts ≤ parent total"); those still belong in cube views with downstream alerts, or in dedicated triggers if true synchronous enforcement matters. `set_record` reads one row by id; it does not aggregate, scan, or filter.

#### Canonical patterns

**Pattern 1 — Parent-state gate (the user's example, expanded).** Forbid mutating an `order_lines` row when the parent `orders` is already shipped:

```json
{
  "set_record": ["order", "orders", {"var": "order_id"}, {
    "if": [
      {"==": [{"var": "order.workflow_state"}, "shipped"]},
      {"throw_error": "Cannot modify a shipped order"},
      true
    ]
  }]
}
```

Read: *"bind the parent order under `order`; if the order's workflow_state is `shipped`, raise a domain-specific exception; otherwise the rule passes."*  Placed in `order_lines.validation_rules`; the gate fires on every INSERT, UPDATE, and DELETE on a child line.

**Pattern 2 — Cross-entity computed field (inherited value).** `order_lines.currency_code` mirrors the parent order's currency, so analytics and reports never have to join to find the line's currency:

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

Placed in `order_lines.computed_fields`. Even when the caller supplies `currency_code` directly, the platform silently overwrites it with the parent's value — that's the standard `computed_fields` contract.

**Pattern 3 — Merged label.** `order_lines.label_column = line_label`, computed from the parent order number and the line's own sequence number:

```json
{
  "name": "line_label",
  "description": "'<order_number> · line <line_no>'.",
  "jsonlogic": {
    "set_record": ["order", "orders", {"var": "order_id"}, {
      "cat": [
        {"var": "order.order_number"},
        " · line ",
        {"var": "line_no"}
      ]
    }]
  }
}
```

Reads display as `"INV-2025-0042 · line 3"` everywhere a Semantius UI surface or saved query asks for the line's label, no extra join required.

**Pattern 4 — Use `let` to avoid recomputing a sub-expression.** When the same value appears more than once inside an expression, bind it under `let` so the engine evaluates it only once and the body is easier to read:

```json
{
  "let": ["margin",
    {"-": [{"var": "amount"}, {"var": "cost"}]},
    {"if": [
      {"<": [{"var": "margin"}, 0]},
      {"throw_error": "Margin would go negative — review pricing before saving."},
      {"var": "margin"}
    ]}
  ]
}
```

In `computed_fields`, this writes the margin into a derived field while throwing if the value would be negative. In `validation_rules`, drop the final `{"var": "margin"}` and return `true` from the success branch.

**Pattern 5 — Parent discount applied to a child line.** A child `order_lines.line_total` derives the line subtotal and applies the parent order's `discount_pct`:

```json
{
  "name": "line_total",
  "description": "(unit_price × qty) × (1 - parent_order.discount_pct / 100).",
  "jsonlogic": {
    "set_record": ["order", "orders", {"var": "order_id"}, {
      "let": ["gross",
        {"*": [{"var": "unit_price"}, {"var": "quantity"}]},
        {"*": [
          {"var": "gross"},
          {"-": [1, {"/": [{"var": "order.discount_pct"}, 100]}]}
        ]}
      ]
    }]
  }
}
```

**Pattern 6 — Customer country pulled through two hops.** When the link is a chain (`address → customer.country_code`), nest `set_record` calls; the inner body has access to both bindings:

```json
{
  "name": "country_code",
  "description": "Country of the address's customer, snapshotted on the address row.",
  "jsonlogic": {
    "set_record": ["customer", "customers", {"var": "customer_id"}, {
      "set_record": ["country", "countries", {"var": "customer.country_id"}, {
        "var": "country.iso_code"
      }]
    }]
  }
}
```

#### Null-handling and error shape

`get_record_by_id` returns `NULL` when no row matches (the FK is null, or the id points at a deleted row). Inside `set_record`'s body:

- `{"var": "<name>"}` returns `null` (the row is null).
- `{"var": "<name>.<column>"}` returns `null` (you're reading a column off a null object).

That `null` flows through the expression's comparisons and arithmetic naturally — `{"==": [{"var": "order.workflow_state"}, "shipped"]}` is `false` when `order` is null, so the gate passes. If the rule's intent is "block writes whose FK is unresolved", guard explicitly:

```json
{
  "set_record": ["order", "orders", {"var": "order_id"}, {
    "if": [
      {"==": [{"var": "order"}, null]},
      {"throw_error": "Order not found — cannot write child line."},
      <rest-of-rule>
    ]
  }]
}
```

A `throw_error` raises a SQL exception, which the platform surfaces back as a check-violation (SQLSTATE `23514`). The error body the caller sees is the message string verbatim, so the message is the user-facing error text — keep it short, actionable, and in the same language conventions as the rule's `message` field.

#### Deploy-time guarantees

When `create_entity` / `update_entity` accepts these properties, the platform verifies:

- Both values are arrays (objects of any other shape are rejected).
- Every `computed_fields[].name` resolves to an existing field on the entity.
- Every `validation_rules[].code` is unique within the entity.
- Every `jsonlogic` expression parses; malformed expressions are rejected.

JsonLogic-level column references (`{"var": "<name>"}`) are NOT checked against the entity's field list at parse time when they live under a `set_record` / `let` binding — the binding name is known only at evaluation time. A typo in `{"var": "order.staus"}` (a missing `t`) returns `null` at runtime rather than failing the deploy. Test cross-entity rules end-to-end before relying on them; the platform catches grosser malformations (the operator name itself, the binding name shape) at parse time.

Errors at evaluation time point at the offending entry's index so authoring agents can correct in place.

#### Example: pass both on `create_entity`

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
              { "*": [
                { "var": "reach_score" },
                { "var": "impact_score" },
                { "var": "confidence_score" }
              ]},
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
            { "in": [
              { "var": "feature_status" },
              ["planned", "in_progress", "shipped"]
            ]}
          ]
        }
      }
    ]
  }
}'
```

Both arrays default to `[]` and may be omitted entirely. To remove a rule or recompute, send the full replacement array on `update_entity` — the platform replaces, not merges.

#### Out of scope

- Per-field computed expressions (kept entity-level for now).
- Cross-row aggregates (`Σ child.amount ≤ parent.total`, `≤ 5 high-priority features per release`). `set_record` reads a single row by id; it does not scan, aggregate, or filter. Use a cube view + downstream alert, or a dedicated trigger when synchronous enforcement is required.
- Per-locale `message`s (single string; i18n binds via `code`). `throw_error` lets the rule body emit one alternate message at runtime, but the static `message` is still single-string.
- Conditional rule activation (no `when: insert|update|both` yet).

---

### Dynamic `input_type` via `input_type_rule` (field-level JsonLogic)

Every field carries an optional `input_type_rule` property: a JsonLogic object that overrides the static `input_type` per-record at form-render time. It is the read-side analog of `computed_fields` for UI shape: instead of deriving a stored value on write, it derives the field's visible mode on read.

| Property | Type | Default | Purpose |
|---|---|---|---|
| `input_type_rule` | `object` (JsonLogic) | `{}` | Per-record predicate that returns the effective `input_type` for this field in the current record. Evaluated client-side at form render. |

**Storage.** JSONB object, NOT NULL, default `'{}'::jsonb`. The static `input_type` column is still the field's declared baseline; `input_type_rule` is the dynamic override applied to that baseline. The baseline values table lives in `data-modeling.md` § `input_type` Values.

**Return contract.** The JsonLogic expression must return **one of the valid `input_type` enum values**: `"default"`, `"required"`, `"readonly"`, `"disabled"`, `"hidden"`. The returned value replaces the static `input_type` for this field when the form renders this record.

**Fallback.** If the rule is empty (`{}`), if the expression throws, or if it returns a value that is not a valid `input_type`, the static `input_type` column is used. This is fail-open in the UI-mode sense: a malformed rule degrades to the declared baseline rather than locking or hiding the field unexpectedly.

**Where it runs.** Evaluated **client-side against the current form record** at render time. Server-side reads / writes still respect the field's actual nullability and validation rules — `input_type_rule` is purely a UI control. A field rendered `hidden` is still writable via API; a field rendered `readonly` is still mutable via API. Anything that must be enforced server-side belongs in `validation_rules`, not `input_type_rule`.

**Reserved variables** (where the client supplies them):

| Var | Type | Meaning |
|---|---|---|
| `$today` | `date` | Client date at evaluation time. |
| `$now` | `date-time` | Client timestamp at evaluation time. |
| `$user_id` | `uuid` | The user viewing the form. |

`$old` is not meaningful here (there's no prior-row context client-side); do not reference it in `input_type_rule`.

**Example — lock `approved_at` once the record is approved:**

```json
{
  "if": [
    { "==": [{ "var": "workflow_state" }, "approved"] },
    "readonly",
    "default"
  ]
}
```

When the current record's `workflow_state` is `approved`, the form renders `approved_at` as `readonly`; otherwise as the standard editable input.

**Example — show `approved_at` only when workflow_state crosses into approved.** The classic "housekeeping field appears at the right moment" pattern: `approved_at` starts hidden, surfaces as a required input once the user is moving the record into `approved`, and locks to readonly after the record is saved approved:

```json
{
  "if": [
    { "==": [{ "var": "workflow_state" }, "approved"] },
    "readonly",
    "hidden"
  ]
}
```

If you need a third state ("required while transitioning"), nest:

```json
{
  "if": [
    { "==": [{ "var": "workflow_state" }, "approved"] },
    "readonly",
    { "if": [
      { "==": [{ "var": "$old.workflow_state" }, "approved"] },
      "readonly",
      "hidden"
    ]}
  ]
}
```

Be aware that `$old` is not reliably available in the client-side render context per the contract above; if the form library does supply it, the pattern works, otherwise prefer a simpler two-state rule (`approved` → `readonly`, else `hidden`) and let `validation_rules` enforce "must be set on the approve transition" server-side.

**Setting and removing.** Pass `input_type_rule` on `create_field` or `update_field` under `data`. Sending `{}` removes the rule and the static `input_type` resumes.

```bash
semantius call crud update_field '{
  "id": "tickets.approved_at",
  "data": {
    "input_type_rule": {
      "if": [
        { "==": [{ "var": "workflow_state" }, "approved"] },
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

**Risk.** Adding an `input_type_rule` is **low-risk** — it changes UI behavior only, no data effect, fails open. Modifying or removing one is **medium-risk** in the user-experience sense: forms suddenly show, hide, or unlock a field, which can surprise users mid-workflow. Coordinate the change with whoever owns the forms.
