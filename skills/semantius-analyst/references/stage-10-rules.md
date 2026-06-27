# Stage 10: Computed fields and validation rules

*Reference for `semantius-analyst` (Stage 10).*

## Stage 10: Computed fields and validation rules

> **`access_scope = basic` note.** Emit computed fields and validation rules as usual **except** any rule whose JsonLogic gates on a permission (`require_permission` / `has_permission`): under `basic` the gating permission no longer exists, so drop that rule. Pure data-integrity rules (date ordering, required-when, range checks — no permission reference) are kept; they are not access control. (See the "What basic authors" access-control contract in SKILL.md.)

Convert blueprint §8.2 business rules to JsonLogic, plus add field-level computed fields and validation rules discovered during Stage 4.

### Computed fields

A JSON array per entity. Each entry derives a value into an existing scalar field via JsonLogic, evaluated on every write.

```json
[
  {
    "name": "rice_score",
    "description": "(reach × impact × confidence) / effort.",
    "jsonlogic": {
      "/": [
        {"*": [{"var": "reach_score"}, {"var": "impact_score"}, {"var": "confidence_score"}]},
        {"max": [{"var": "effort_score"}, 0.1]}
      ]
    }
  }
]
```

Reserved variables: `$today`, `$now`, `$user_id`.

Cross-entity primitives: `{"set_record": ["<name>", "<entity>", <id_expr>, <body>]}` and `{"let": ["<name>", <value>, <body>]}` let the body read columns of a parent / referenced record. See `../../use-semantius/references/data-modeling.md` § "Cross-entity lookups inside JsonLogic".

### Validation rules

A JSON array per entity. Each rule must evaluate truthy for the write to succeed. Failures return as `{ "errors": [{ "code", "message" }, ...] }`.

```json
[
  {
    "code": "amount_positive",
    "message": "Amount must be positive.",
    "description": "Money never goes negative on this entity.",
    "jsonlogic": {">": [{"var": "amount"}, 0]}
  }
]
```

Platform-extension operators:
- `{"value_changed": "<field>"}` — true when field differs from `$old`, true on INSERT.
- `{"require_permission": "<permission_code>"}` — true when caller holds the permission, throws otherwise.
- `{"throw_error": "<message>"}` inside an `if` — raises SQL exception with the message verbatim.

Every `require_permission` argument must reference a permission declared in §8.1 Permissions catalog (Stage 8 enforces).

### Scan families

For every entity, mechanically walk these families and propose rules:

| Family | Trigger | Rule shape |
|---|---|---|
| F1 — Monetary positivity | `format: number` field with name `amount` / `price` / `cost` / `total` / `balance` / `revenue` / `fee` / `salary` / `budget` | `{">=": [{"var": "<field>"}, 0]}` |
| F2 — Date order | Two date fields `start_*` and `end_*` | `{"<=": [{"var": "start_*"}, {"var": "end_*"}]}` |
| F3 — Enum lifecycle | the `workflow_state` enum field with lifecycle states | `value_changed` + lifecycle ordering check |
| F4 — Required-when | `default: ""` required string conditional on another field's value | `if (other == X, value != "", true)` |
| F5 — Reference integrity | FK + condition that the target exists in a state | `set_record` lookup + state check |
| F6 — Submit lock | `is_submitted` boolean | `if (old.is_submitted, require_permission(:bypass_submit_lock), true)` |
| F7 — Owner edit | `owner_id` FK to users | `if (value_changed("x"), $user_id == owner_id OR require_permission(:edit_all), true)` |
| F8 — Approval gate | enum transition to `approved` | `if (workflow_state == "approved" AND old.workflow_state != "approved", require_permission(:approve), true)` |
| F9 — Terminal lock | enum terminal state | `if (old.workflow_state in terminal_states, false (no writes), true)` |
| F10 — Self-reference guard | self-FK | `id != parent_id` (no self-loops) |
| F11 — Period boundary | `*_period` field | check inside `start_*` / `end_*` |
| F12 — Conditional permission | any field whose write should require a permission | wrap the field-change check in `require_permission` |
| F13 — Owner-row gate | a row that only its owner can edit certain fields of | nested ownership check |
| F14 — FK target state | a write that depends on the FK target being in a specific state | `set_record` lookup + state check |
| F15 — Cross-entity invariant | a rule that spans two entities | `set_record` + cross-row check |

After running all 15 families, present a scan-table to the user for confirmation. Drop the rules the user rejects.
