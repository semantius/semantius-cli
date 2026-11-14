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

Both are first-class entity properties: read with `read_entity`, set on `create_entity`, replaced on `update_entity`. The platform compiles them into `BEFORE INSERT OR UPDATE OR DELETE` triggers, so a rule can refuse a delete as well as an insert or update; when both arrays are empty (or the entity is deleted) the trigger is dropped.

#### `computed_fields` element shape

```json
{
  "name":        "rice_score",
  "jsonlogic":   { /* JsonLogic expression */ },
  "description": "Optional human note"
}
```

- `name` (string, required) — the scalar field of the same entity that receives the result. It is not checked when the rule is saved: a rule may name a field that does not exist yet, and it fills the field in once the field is added. May reference a JSONB sub-property via dotted notation (e.g. `"metadata.rice"`).
- `jsonlogic` (object, required) — evaluated against the merged record (caller payload + values written by earlier `computed_fields` entries). That record holds stored columns only: `_label` and every `<fk>_label` are added by a read, so a rule that reads one gets null. `writeModel` and `call-file.ts` refuse such a rule; to use a related record's label, read its stored label column with `set_record` (below), as `composedLabel` does.
- `description` (string, optional) — human note for future readers and agents.

#### `validation_rules` element shape

```json
{
  "code":        "99001",
  "name":        "release_only_when_committed",
  "message":     "A release can only be assigned once the feature is planned, in_progress, or shipped.",
  "jsonlogic":   { /* JsonLogic expression */ },
  "description": "Optional human note explaining why this rule exists"
}
```

- `code` (string, required): a class-99 SQLSTATE code of exactly five characters, `99` followed by three digits (`^99[0-9]{3}$`, e.g. `"99001"`). It is the error code the caller receives and branches on. The platform does not require it to be unique, but by convention codes are assigned sequentially per module starting at `99001` in spec order, so every rule in a module has a distinct code. (The platform's own rules use class-90 codes such as `"90201"` and carry `source_module: "platform"`; never author those.)
- `name` (string, required by convention): snake_case, unique within the entity. The rule's stable natural key: agents diff and merge rules on `name`, never on `code`.
- `message` (string, required) — default English text returned to the caller on failure.
- `hint` (string, optional) — extra text added to the error hint of the failure.
- `jsonlogic` (object, required) — must evaluate truthy for the record to be valid.
- `description` (string, optional) — human note explaining *why* this rule exists.

#### Evaluation semantics (per write)

1. **Compute pass.** Iterate `computed_fields` in array order. For each entry, evaluate `jsonlogic` against the merged record (caller payload + previously-computed values), then write the result into `name`. If the expression throws, the platform surfaces a structured error naming the offending entry's `name` plus the inner error. Caller-supplied values for a computed field are silently overwritten with the rule's result; only a rule that returns the field itself keeps the value sent (an approval stamp on a record created past its step, below).
2. **Validate pass.** Iterate `validation_rules` in array order against the post-compute record. A rule passes when the result is truthy. The first rule that fails stops the write; the rules after it are not evaluated. A falsy rule raises its own `code` as the SQLSTATE, with its `message` as the error text. If `jsonlogic` throws instead (`throw_error`, `require_permission`), the caller gets that error's own SQLSTATE and message. Except for platform `90xxx` errors, the error's hint also names the entity (`hint.entity`) and the rule's code (`hint.rule`).
3. **Atomicity.** Compute and validate run inside the same transaction as the write — either the record lands with all derivations applied and all rules passing, or nothing changes.
4. **DELETE.** Both passes run against the row being deleted: the record and `$old` are the same row, so `value_changed` is `false` for every field. Computed results are discarded, but a failing rule or a throwing computed field aborts the delete. Every rule therefore also runs on delete unless it is guarded with `$mode` (below): a rule that reads `$today`, `$now` or `$user_id` ("the due date must be in the future") can refuse the delete of an old row.

**Saving `computed_fields` recalculates existing records.** A validation rule added later is not applied retroactively; it checks later writes only. Adding or changing `computed_fields` recalculates every record whose value moves. A record that cannot take its new value (a validation rule refuses it, the rule fails on it, or a constraint does) refuses the whole save with `90908`, whose `record_id` and `problem` say why. The pass moves no `updated_at` and writes no audit row, queue message or RACI event, and the tables it writes take no other writes until the save commits. On the pass `$mode` is `"update"` and `$old` is the stored row. The pass writes each new value through the entity's trigger, so the rule runs a second time with the new value in the record and the stored row still in `$old`, and the second result is the one kept. A rule must therefore give the same result when it reads its own output. A rule that tests its own field returns that field: `{"if": [{"!=": [{"var": "approved_at"}, null]}, {"var": "approved_at"}, <fill>]}` fills an empty `approved_at` on the pass, while the same rule returning `{"var": "$old.approved_at"}` in that branch puts back the stored empty value and undoes the change. A rule that stamps `$user_id` or `$now` unconditionally moves on this pass, as on any update; make such a stamp insert-only: `{"if": [{"==": [{"var": "$mode"}, "insert"]}, {"var": "$user_id"}, {"var": "$old.created_by"}]}`. Removing a rule keeps the last values as ordinary data.

**A stamp on a record created past its step.** A stamp set when the record moves into a state (`approved_at` when `workflow_state` becomes `approved`) stays empty on a record created straight into a later state (`ordered`) by an import, a restore or a seed, because that record never makes the move. Such an insert sends the stamp itself, and the rule keeps it: `{"if": [{"and": [{"==": [{"var": "$mode"}, "insert"]}, {"in": [{"var": "workflow_state"}, ["approved", "ordered"]]}, {"!=": [{"var": "approved_at"}, null]}]}, {"var": "approved_at"}, <the stamp rule>]}`. On a draft insert and on every update the value sent is ignored. Only an admin creates a record past an approval (`rbac.md` → "Controls on a gate", control 5, has the complete rules).

**Derived marker.** A field a rule names gets `ctype: "computed"`, and its `input_type` `default` or `readonly` becomes `disabled` (and stays `disabled` when the rule goes). The label column keeps `ctype: "label"`. Rules match fields by name and a rename does not rewrite them, so a renamed field loses the marker: update the rule too. A rule cannot name a rollup field (`90907`), and a computed field cannot become a rollup (`90261`); a value aggregated from child records is a rollup (see `rollup-fields.md`).

During an UPDATE, rules run before `updated_at` is refreshed, so `updated_at` still holds the stored value unless the caller sent one.

#### Reserved variables

JsonLogic expressions may read these injected variables via `{"var": "$name"}`:

| Var | Type | Meaning |
|---|---|---|
| `$today` | `date` | Current date in UTC at evaluation time. |
| `$now` | `date-time` | Current timestamp in UTC at evaluation time. |
| `$user_id` | number (`int64`) | The `users.id` of the authenticated user performing the write (`null` for system writes). |
| `$old` | `object` or `null` | Stored row as JSON on UPDATE and DELETE; `null` on INSERT. Use to express transition rules ("the workflow state cannot move from `released` back to `planned`") and "set-once" invariants ("`account_number` is immutable after first save"). |
| `$mode` | `string` | The operation being evaluated: `"insert"`, `"update"` or `"delete"`. Always present. Use it to gate one operation without constraining the others. |

`$old` is the only window into prior state; everything else outside the post-write record (cross-row lookups, aggregates, FK traversal) is out of scope and belongs in cube/views.

**Detecting the operation.** Test `$mode`; it is the only variable that tells all three operations apart:

| Operation | `$mode` | `$old` | Record under evaluation |
|---|---|---|---|
| INSERT | `"insert"` | `null` | the incoming row |
| UPDATE | `"update"` | the stored row | the stored row merged with the changes |
| DELETE | `"delete"` | the stored row | the stored row, identical to `$old` |

A rule that should fire only on UPDATE wraps its body in `{"if": [{"==": [{"var": "$mode"}, "update"]}, <update-only-check>, true]}`. Testing `$old != null` instead matches DELETE too, and "nothing changed" is no delete test either, because a no-op save matches it. Transition rules that compare current vs prior values (e.g. `{"var": "release_status"}` against `{"var": "$old.release_status"}`) read `null` from `$old.<field>` on INSERT and naturally pass, and see equal values on DELETE; no extra guard is needed unless one of those paths needs distinct handling.

**Example transition rule** (a release that's reached `released` cannot regress):

```json
{
  "code": "99001",
  "name": "released_is_terminal",
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

The rule passes on INSERT (no prior row), passes when the prior status was anything but `released`, and on UPDATE from `released` only passes when the new status is still `released`. A DELETE passes because the status is unchanged.

**Example — delete-only gate.** An entity has only `view_permission` and `edit_permission`, and `edit_permission` gates INSERT, UPDATE and DELETE alike; there is no delete permission column, and `select_rule` applies the same predicate to UPDATE and DELETE (see `select-rule.md`), so neither can separate a delete from an update. To restrict deletes alone, create a permission, grant it only to the roles that may delete, and check it under `$mode`:

```json
{
  "code": "99003",
  "name": "delete_requires_delete_permission",
  "message": "Only an order manager can delete an order.",
  "jsonlogic": {
    "if": [
      { "==": [{ "var": "$mode" }, "delete"] },
      { "has_permission": "sales:delete_order" },
      true
    ]
  }
}
```

Inserts and updates pass untouched; a delete passes only for holders of `sales:delete_order`, and anyone else gets the rule's `code` and `message`. For "the owner or a permission holder", replace the `has_permission` branch with `{"or": [{"==": [{"var": "$old.owner_user_id"}, {"var": "$user_id"}]}, {"has_permission": "sales:delete_order"}]}`.

#### Platform-extension operators

In addition to standard JsonLogic operators, the platform provides extension operators usable in `computed_fields`, `validation_rules` and `select_rule` (see `select-rule.md`). An `input_type_rule` runs in the browser, which has `has_permission`, `is_match`, `concat`, `let` and the date operators. It does not have `value_changed`, `require_permission`, `is_raci_actor` or `has_consultation`, which need the database or a previous row, or `set_record`; a rule using one of them falls back to the static `input_type`.

| Operator | Shape | Returns | Use in |
|---|---|---|---|
| `{"value_changed": "<field>"}` | unary, takes a field name string | boolean — `true` when the field's value differs from `$old.<field>` (always `true` on INSERT) | `validation_rules`, `computed_fields`. Scope a rule to the moment a specific column changes (e.g. an approval gate fires only on the transition into `approved`, not on every subsequent edit). |
| `{"require_permission": "<permission_code>"}` | unary, takes a permission code string | boolean — returns `true` when the caller holds the permission, **throws** otherwise. The throw is the platform's permission error, not the rule's: SQLSTATE `42501` (HTTP 403), message `Permission denied: ${permission} required`, with `hint.code` `90101` and the permission name in `hint.permission` (plus `hint.entity` and `hint.rule`). The `${permission}` placeholder is a template the client fills from the hint; the server never interpolates it. The rule's own `code` and `message` are not used | `validation_rules`. Use only inside `if` so the throw is conditional, not unconditional. Wrong shape for `select_rule` (a per-row throw during SELECT would be a disaster) — use `has_permission` there instead. |
| `{"has_permission": "<permission_code>"}` | unary, takes a permission code string | boolean — `true` when the caller holds the permission, `false` otherwise (never throws) | `select_rule` (see `select-rule.md`; primary use — added specifically so `select_rule` can broaden visibility for elevated roles without throwing per row), `input_type_rule`, and `validation_rules` (when a non-throwing check is preferable, e.g. composing with `or` to allow the permission *or* an ownership match). |
| `{"is_raci_actor": ["<entity>", "<to_state>", "<letter>"]}` | three strings: the entity's `table_name`, the target state, and a RACI letter as stored in `raci_assignments.raci` (`responsible`, `accountable`, `consulted`, `informed`) | boolean: resolves the process through the `process_gates` row for `(<entity>, <to_state>)` and returns `true` when the caller holds a role assigned that letter for that process in `raci_assignments`, `false` otherwise (never throws) | `validation_rules`: the approval gate (A-gate) of a module whose RACI matrix runs live in the `processes` / `raci_assignments` / `process_gates` tables. Compose it with `has_permission` in an `or` so a holder of the gate permission can take the step too (example below). |

**Choosing between `require_permission` and `has_permission` in `validation_rules`.** Both work on the write side. `require_permission` throws on miss with the platform's generic permission error (above), so the caller learns which permission is missing but never sees the rule's `message`. `has_permission` returns boolean, so a rule that returns it from the gated branch fails with its own `code` and `message`: the right shape whenever the failure text should explain the business rule ("Only an approver can move an offer to `approved`"). `has_permission` is also the right shape when the permission is one branch of a wider predicate ("the caller is the owner *or* holds the override permission"), because `or([owner_match, require_permission(...)])` throws `42501` for a non-owner without the permission, so the rule's own `code` and `message` never surface; `or([owner_match, has_permission(...)])` returns truthy whenever either branch matches and otherwise fails with the rule's own `code` and `message`.

**Example — conditional approval gate (uses `value_changed` + `has_permission`):**

```json
{
  "code": "99001",
  "name": "approve_offer_requires_approver_permission",
  "message": "Only users with the offer-approver permission can mark an offer approved.",
  "jsonlogic": {
    "if": [
      { "and": [
        { "value_changed": "workflow_state" },
        { "==": [{ "var": "workflow_state" }, "approved"] }
      ]},
      { "has_permission": "ats:approve_offer" },
      true
    ]
  }
}
```

A caller without `ats:approve_offer` gets `99001` and the rule's message. With `require_permission` in the same place the gate holds just as well, but the caller gets `42501` `Permission denied: ${permission} required` instead.

**Example — owner-or-elevated edit scope (uses `has_permission`):**

```json
{
  "code": "99002",
  "name": "edit_restricted_to_author_or_manager",
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

**Example: live RACI approval gate (uses `value_changed` + `is_raci_actor` + `has_permission`):** the conditional approval gate above, in a module whose RACI matrix runs live. The usual `workflow_state` transition `if` stays; its gated branch admits the Accountable role or a holder of the gate permission:

```json
{
  "code": "99001",
  "name": "approve_offer_requires_accountable_or_approver",
  "message": "Only the hiring manager or an admin can approve an offer.",
  "jsonlogic": {
    "if": [
      { "and": [
        { "value_changed": "workflow_state" },
        { "==": [{ "var": "workflow_state" }, "approved"] }
      ]},
      { "or": [
        { "is_raci_actor": ["offers", "approved", "accountable"] },
        { "has_permission": "ats:approve_offer" }
      ]},
      true
    ]
  }
}
```

The role assigned `accountable` for the process that gates `offers` → `approved` passes, and so does any holder of `ats:approve_offer` (for example an admin role whose permission includes it); anyone else gets `99001` and the rule's message. The permission branch is `has_permission`, not `require_permission`, for the same reason as the owner-or-elevated example above: the `or` needs a non-throwing branch so the Accountable path works for a caller who lacks the gate permission, and a refused caller gets the rule's own `code` and `message`.

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

#### Date operators

Six operators compute with dates. They work in `computed_fields`, `validation_rules`, `select_rule` and `input_type_rule`, and as values in a rollup filter (see `rollup-fields.md` for what a filter allows as their arguments).

**Everything is UTC**, whatever the session's or the browser's time zone. Results that carry a time are written with an explicit `+00:00`.

| Operator | Returns |
|---|---|
| `{"date_add": [date, amount, unit]}` | The date moved by a whole `amount` of `unit`, the same type as the input. A negative amount subtracts. |
| `{"date_add": [date, duration]}` | The date moved by an ISO 8601 duration such as `P1M2DT3H`, or a `duration` field. Months apply first, then days, then time. |
| `{"date_diff": [end, start, unit]}` | Whole elapsed units as an integer, truncated toward zero, in the argument order of `-`. |
| `{"date_part": [date, part]}` | One field as an integer. |
| `{"date_trunc": [date, unit]}` | The start of the period, the same type as the input. A week starts on Monday. |
| `{"to_date": value}` | An ISO date. `value` is a date, a date-time or an epoch number, read as UTC. |
| `{"date_format": [date, pattern]}` | Text. |

- **Units:** `year`, `quarter`, `month`, `week`, `day`, `hour`, `minute`, `second`.
- **Parts:** `year`, `iso_year`, `quarter`, `month`, `week` (ISO), `day`, `weekday` (Monday is 1), `day_of_year`, `hour`, `minute`, `second`, `epoch`.
- **Pattern tokens:** `YYYY`, `YY`, `Q`, `MM`, `Mon`, `Month`, `DD`, `Dy`, `Day`, `HH24`, `MI`, `SS`, separated by nothing or by a space or any of `- / . : ,`. Names are English.

**Values.**

- Null or `""` for the date, the amount or the duration gives `null`, so a record with no date saves and has no result.
- Dates are ISO 8601 only: `2026-12-31`, `2026-12-31T10:00:00Z`, `2026-12-31T10:00:00+02:00`. A date-time with no offset is read as UTC. Fractions of a second are dropped.
- A date-only value has no time of day, so `date_add`, `date_trunc`, `date_part` and `date_format` refuse sub-day units, parts and tokens on it. `date_diff` reads it as midnight UTC and allows every unit.
- An amount is a whole JSON number or a numeric string.

**Month ends.** `date_add` clamps to the end of the month: Jan 31 + 1 month is Feb 28. `date_diff` counts a month only when the day of the month has been reached again, so Jan 31 to Feb 28 is 0 months. For the last day of a month, truncate to the month, add a month and subtract a day.

**Example: a stored renewal deadline.** A computed `date` field that depends only on the row's own fields can be filtered and sorted, and it cannot go stale.

```json
{
  "name": "notice_deadline",
  "jsonlogic": {"date_add": [{"var": "term_end"}, {"-": [0, {"var": "notice_period_days"}]}, "day"]}
}
```

**Do not store a value computed from `$today` or `$now`.** Computed fields run only when the row is written, so a stored "days until the deadline" is wrong from the next day until something touches the row. Store the date and compare it with `$today` where it is read, in a filter, a `select_rule` or a validation rule. A stamp that records when something happened (`approved_at` = `$now` when the record is approved) is not such a value: it stays true.

| Error | Raised for |
|---|---|
| `90915` | A value that is not an ISO 8601 date, including `today` and locale formats. |
| `90916` | An unknown or missing unit or part, or a sub-day unit, part or duration on a date-only value. |
| `90917` | A `date_format` pattern outside the token list, or a time-of-day token on a date-only value. |
| `90918` | An amount or duration that is not valid. |
| `22008` | A well-formed date that does not exist, such as `2026-02-30`. |

The error fails the write. In a `select_rule` it hides the row instead. In the browser the form keeps what it had, and the server refuses the save.

**Dates without these operators.** Arithmetic and a comparison with a number read a date as epoch seconds: `{"-": [{"var": "term_end"}, 86400]}` is an integer, and a date column refuses it with `22008`. Wrap the result in `to_date` to get a date back, or use `date_add`, because in the browser arithmetic on a date string gives `NaN`. Arithmetic also reads a null date as 0, which is 1970, so `{"<": [{"var": "term_end"}, {"var": "$today"}]}` is `true` when `term_end` is null: guard for null first. Two date strings compare as text, which is correct for dates and for date-times in UTC. A literal with another offset is not converted, so write literals in UTC.

#### Cross-entity lookups inside JsonLogic (`let`, `set_record`, `throw_error`)

Three JsonLogic operators bind values into the data context **before** the rest of the expression evaluates, so `computed_fields` and `validation_rules` can reach beyond the post-write record: FK traversal, parent-state gates, inherited values, and merged labels.

| Operator | Shape | Effect |
|---|---|---|
| `let` | `{"let": ["<name>", <value-expression>, <body-expression>]}` | Evaluates `<value-expression>`, binds it under `<name>` for the duration of `<body-expression>`, returns the body's result. Nest `let` calls to bind several names. Useful for naming a sub-expression you reference more than once. |
| `set_record` | `{"set_record": ["<name>", "<entity_name>", <id-expression>, <body-expression>]}` | Resolves `<id-expression>` against the data context, calls `get_record_by_id(<entity_name>, <id>)`, binds the resulting row (JSONB object, or `null` when no row matches or the caller may not read the row) under `<name>` for the duration of `<body-expression>`, returns the body's result. Inside the body, `{"var": "<name>.<column>"}` reads any column of the loaded row, exactly like `$old.<column>` for the post-write record. The row holds the stored columns only: `_label` and every `<fk>_label` read as `null`. |
| `throw_error` | `{"throw_error": "<message>"}` | Raises a PostgreSQL exception with SQLSTATE `99000` and the supplied message. A long form `{"throw_error": [message, code, [name, value, ...]]}` takes its own class-99 `code` (`90911` otherwise) and a flat list of named parameters (`90914` if nested; names `90912` and `90913` are reserved). The platform surfaces the message back to the caller verbatim, bypassing the rule's static `message` field. Place inside an `if` so the throw is conditional. |

`let` and `set_record` are evaluated before the bulk argument-evaluation pass inside `evaluate_json_logic`, so the body sees an augmented data context. The bindings disappear when the body returns.

**Supporting Postgres function (advanced).** The operators are implemented on top of `get_record_by_id(entity_name TEXT, id TEXT) RETURNS JSONB`, which looks up the entity's `id_column` from the `entities` meta-table, queries the physical table, and returns the row as JSONB (or `NULL` when nothing matches). You normally never call it directly — `set_record` is the authoring surface — but the function is callable from SQL when a query or other trigger needs the same lookup.

**Where they run.** `let`, `set_record`, and `throw_error` are evaluated by the same JsonLogic engine that powers `computed_fields` and `validation_rules`, so they are usable wherever the engine runs:

- ✅ `computed_fields` — derive a value from a parent / referenced record.
- ✅ `validation_rules` — gate a write on the state of a parent or sibling record.
- ⚠️ `select_rule` (see `select-rule.md`) — *technically* available, but `set_record` runs an extra `SELECT` per row of every read. Use only when the FK target is small and indexed AND the entity sees light read traffic. For tiered visibility, column-encoded broadening (a `visibility` enum) or `has_permission` is almost always the right shape. Default answer: do not use `set_record` in `select_rule`.
- ⚠️ `input_type_rule` (documented below in this file) — evaluated client-side at form render, so `set_record` cannot fetch a row. Don't use `set_record` here; `let` / `throw_error` are also pointless in a UI control. Stick to record-local variables.

**`throw_error` vs the rule's `message`.** A `validation_rules` entry that returns falsy is rejected with its `code` and `message` packaged into the standard error response. A `throw_error` raises a SQL exception immediately, so:

- The caller receives the `throw_error` argument verbatim as the error text, with SQLSTATE `99000` rather than the rule's `code`.
- The rule's static `message` is moot when the throw fires — the throw wins.
- Only one error surfaces either way: the write stops at the first failing rule. Reach for `throw_error` when one specific failure must surface a different, hand-tailored message than the rule's default (e.g. a multi-language string, a deep-link to the conflicting record, an actionable instruction).

**When to reach for these vs leave them off.** The three operators add real expressiveness, but every `set_record` costs one extra `SELECT` per evaluation. Treat them as the right tool for:

- **Parent-state gates** — refuse to modify an `order_line` when the parent `order.workflow_state = 'shipped'`. Without `set_record`, this rule had no way to read the parent's workflow_state; the gate had to live in application code.
- **Inherited values on a child** — compute `country` on `addresses` from the customer record; copy `currency` from the parent `order` onto every line; pull `discount_pct` from the customer's contract.
- **Merged labels** — derive a `label_column` value from the records a record relates, and from its own fields where those repeat (`"Ana Silva – Calculus I"`, `"<order_number> · line <line_no>"`); see `data-modeling.md` → "Choosing the label".
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

**Pattern 3 — Merged label.** `order_lines.label_column = order_line_name`, computed from the parent order number and the line's own sequence number:

```json
{
  "name": "order_line_name",
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

**A record two related records name.** An enrollment is a student in a course. `composedLabel` (`jsonlogic-kit.ts`) builds its label from both:

```typescript
composedLabel("enrollment_name", [
  { via: "student_id", table: "students", column: "student_name" },
  { via: "course_id", table: "courses", column: "course_title" },
]);
```

Do not write the label by hand over `<fk>_label`: `{"concat": [{"var": "student_id_label"}, " – ", {"var": "course_id_label"}]}` stores only the separator on every record, because the record being written has no `student_id_label`. `writeModel` and `call-file.ts` refuse it.

The `computed_fields` entry of `enrollments` it returns:

```json
{
  "name": "enrollment_name",
  "jsonlogic": {
    "set_record": ["student", "students", {"var": "student_id"},
      {"set_record": ["course", "courses", {"var": "course_id"},
        {"if": [
          {"and": [
            {"==": [{"var": "$mode"}, "update"]},
            {"or": [
              {"and": [{"!=": [{"var": "student_id"}, null]}, {"==": [{"var": "student"}, null]}]},
              {"and": [{"!=": [{"var": "course_id"}, null]}, {"==": [{"var": "course"}, null]}]}
            ]}
          ]},
          {"var": "$old.enrollment_name"},
          {"cat": [{"var": "student.student_name"}, " – ", {"var": "course.course_title"}]}
        ]}
      ]}
    ]
  }
}
```

It reads `"Ana Silva – Calculus I"`. The `if` keeps the stored label on an update where a relationship field is set but its record reads as `null` (the writer may not see it). A field of the record itself goes in as `{ field: "start_date" }`, and an enum as `{ field: "enrollment_type", labels: { audit: "Audit", credit: "Credit" } }`, so the label shows the enum's words, not its stored value.

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

**Pattern 6 — Customer country pulled through two hops.** When the relationship is a chain (`address → customer.country_code`), nest `set_record` calls; the inner body has access to both bindings:

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

`get_record_by_id` returns `NULL` when no row matches (the FK is null, or the id points at a deleted row) and also when the caller may not read the row (`view_permission` and the entity's `select_rule` apply), so a parent the writer cannot read looks like a missing parent. Inside `set_record`'s body:

- `{"var": "<name>"}` returns `null` (the row is null).
- `{"var": "<name>.<column>"}` returns `null` (you're reading a column off a null object).

That `null` flows through the expression's comparisons and arithmetic naturally — `{"==": [{"var": "order.workflow_state"}, "shipped"]}` is `false` when `order` is null, so the gate passes. With `null`, `in` is `false` unless the list holds `null`, `==` is `true` only against `null`, and `!=` is `true` against any other value: `{"in": [null, ["a"]]}` is `false`, `null != 5` is `true`, `null != null` is `false`.

If the rule's intent is "block writes whose FK is unresolved", guard explicitly:

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

A `throw_error` raises a SQL exception, which the platform surfaces back with SQLSTATE `99000`. The error body the caller sees is the message string verbatim, so the message is the user-facing error text — keep it short, actionable, and in the same language conventions as the rule's `message` field.

#### Deploy-time guarantees

When `create_entity` / `update_entity` accepts these properties, the platform verifies:

- Both values are arrays (objects of any other shape are rejected).
- Every `computed_fields[]` entry carries a `name` and a `jsonlogic`, and none names a rollup field (`90907`). The field need not exist yet: a rule may name a field that is added later, and it fills the field in then.
- Every `validation_rules[].code` is a class-99 code matching `^99[0-9]{3}$`; anything else (`"9900A"`, `"990010"`, a snake_case string) is rejected with `90905` (`validation_rules[i] on <table> must carry a class 99 code`). Uniqueness is not enforced; keep `name` unique within the entity and `code` distinct within the module by convention.
- Extra keys on a rule entry (such as `name`) are preserved as written.
- A `jsonlogic` expression is stored as written. Its operators are checked when it is evaluated: an unknown operator raises `90910` on the first write that reaches it.

JsonLogic-level column references (`{"var": "<name>"}`) are NOT checked against the entity's field list at parse time when they live under a `set_record` / `let` binding — the binding name is known only at evaluation time. A typo in `{"var": "order.staus"}` (a missing `t`) returns `null` at runtime rather than failing the deploy. Test cross-entity rules end-to-end before relying on them.

Errors at evaluation time name the entity and the rule (`hint.entity`, `hint.rule`) or the computed field (`hint.field`), so authoring agents can correct in place.

#### Testing a rule

Test a rule's logic before writing it to an entity with the `evaluate_json_logic` RPC. It runs the same engine and changes nothing. Write the case from the builder script that built the rule (`data-modeling.md` → "A payload with rules is built, not typed"), so the rule is the same object that goes to the entity, then send the file:

```typescript
// in the builder script, after deleteGate = rule("99003", "delete_requires_delete_permission", …)
writePayload(".tmp_deploy/test-delete-gate.json", { method: "POST", path: "/rpc/evaluate_json_logic", body: {
  rule: deleteGate.jsonlogic,
  data: { $mode: "delete", status: "open", $old: { status: "open" } },
} });
```

```bash
bun "<skill-folder>/references/call-file.ts" postgrestRequest .tmp_deploy/test-delete-gate.json
```

- It prints the rule's result (`false` above for a caller without the permission); a truthy result means the write would pass. A throw comes back as the error the write would get, e.g. `(99000) <message>` or `(42501) Permission denied: ${permission} required`.
- `data` is only what you send. No reserved variable is added, so include every one the rule reads: `$mode`, `$old`, `$today`, `$now`, `$user_id` (your own is `user_id` from `getCurrentUser`). For a DELETE, send the stored row as both the record and `$old`.
- `has_permission` and `require_permission` check your own permissions, `set_record` reads real rows, and `value_changed` compares against the `$old` you pass.
- Several cases: write one file per case from the builder and send each, so no shell parses the JSON. Test a rule that maps values on every combination of its inputs, and a rule that guards with `$mode` on the delete path too.

#### Example: pass both on `create_entity`

`.tmp_deploy/features-entity.json`:

```json
{
  "data": {
    "table_name": "features",
    "singular_label": "Feature",
    "plural_label": "Features",
    "label_column": "feature_title",
    "module_id": 12,
    "entity_type": "operational_record",
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
        "code": "99001",
        "name": "release_only_when_committed",
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
}
```

```bash
bun "<skill-folder>/references/call-file.ts" create_entity .tmp_deploy/features-entity.json
```

Both arrays default to `[]` and may be omitted entirely. To add, change or remove a rule, or to recompute, read the current list with `read_entity` and send the full list on `update_entity` — the platform replaces, not merges.

#### Out of scope

- Per-field computed expressions (kept entity-level for now).
- Cross-row aggregates (`Σ child.amount ≤ parent.total`, `≤ 5 high-priority features per release`). `set_record` reads a single row by id; it does not scan, aggregate, or filter. Use a cube view + downstream alert, or a dedicated trigger when synchronous enforcement is required.
- Per-locale `message`s (single string; i18n binds via `code`). `throw_error` lets the rule body emit one alternate message at runtime, but the static `message` is still single-string.
- A rule-level activation key (no `when: insert|update|delete`); scope a rule to an operation inside its expression with `$mode`.

---

### Dynamic `input_type` via `input_type_rule` (field-level JsonLogic)

Every field carries an optional `input_type_rule` property: a JsonLogic object that overrides the static `input_type` per-record at form-render time. It is the read-side analog of `computed_fields` for UI shape: instead of deriving a stored value on write, it derives the field's visible mode on read.

| Property | Type | Default | Purpose |
|---|---|---|---|
| `input_type_rule` | `object` (JsonLogic) | `{}` | Per-record predicate that returns the effective `input_type` for this field in the current record. Evaluated client-side at form render. |

**Storage.** JSONB object, NOT NULL, default `'{}'::jsonb`. The static `input_type` column is still the field's declared baseline; `input_type_rule` is the dynamic override applied to that baseline. The baseline values table lives in `data-modeling.md` § `input_type` Values.

**Return contract.** The JsonLogic expression must return **one of the valid `input_type` enum values**: `"default"`, `"required"`, `"readonly"`, `"disabled"`, `"hidden"`. The returned value replaces the static `input_type` for this field when the form renders this record.

**Fallback.** If the rule is empty (`{}`), if the expression throws, or if it returns a value that is not a valid `input_type`, the static `input_type` column is used. This is fail-open in the UI-mode sense: a malformed rule degrades to the declared baseline rather than locking or hiding the field unexpectedly.

**Where it runs.** Evaluated **client-side against the current form record** at render time. Server-side reads / writes still respect the field's actual nullability and validation rules — `input_type_rule` is a UI control that never blocks a write. One exception: a non-empty rule removes the database check of `input_type: "required"` for that field, because the rule can turn `required` off per record, so `required` is then enforced by the client only. A field rendered `hidden` is still writable via API; a field rendered `readonly` is still mutable via API. Anything that must be enforced server-side belongs in `validation_rules`, not `input_type_rule`.

**Reserved variables** (where the client supplies them):

| Var | Type | Meaning |
|---|---|---|
| `$today` | `date` | Current date in UTC, not the user's local date, so near midnight the two can differ. |
| `$now` | `date-time` | Current timestamp in UTC. |
| `$user_id` | number (`int64`) | The `users.id` of the user viewing the form. |

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

**Example — show a field only in one state and require it there.** `sold_date` and `sale_price` stay hidden until the record is sold, then become required. The form re-evaluates the rule after each change, so choosing the state shows the fields before the record is saved. Both fields keep the static `input_type` `default`, and each carries this rule:

```json
{
  "if": [
    { "==": [{ "var": "workflow_state" }, "sold"] },
    "required",
    "hidden"
  ]
}
```

The rule only shapes the form, so the entity also carries a validation rule that refuses the state without the values. What counts as empty depends on the format (`data-modeling.md` → "Fields that apply only to some enum or boolean values"): here a `date` is `null` and a `number` is `0`. The `$mode` guard keeps a record written before the rule deletable:

```json
{
  "code": "99010",
  "name": "sold_needs_date_and_price",
  "message": "A sold record needs a sold date and a sale price.",
  "jsonlogic": {
    "if": [
      { "and": [
        { "!=": [{ "var": "$mode" }, "delete"] },
        { "==": [{ "var": "workflow_state" }, "sold"] }
      ]},
      { "and": [
        { "!=": [{ "var": "sold_date" }, null] },
        { "!=": [{ "var": "sale_price" }, 0] }
      ]},
      true
    ]
  }
}
```

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

**Risk.** Adding an `input_type_rule` is **low-risk** — it changes UI behavior only, fails open, with one data effect: on a `required` field it stops the database from refusing a missing value. Modifying or removing one is **medium-risk** in the user-experience sense: forms suddenly show, hide, or unlock a field, which can surprise users mid-workflow. Coordinate the change with whoever owns the forms.
