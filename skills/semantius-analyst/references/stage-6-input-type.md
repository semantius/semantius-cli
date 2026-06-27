# Stage 6: Conditional input-type scan

*Reference for `semantius-analyst` (Stage 6).*

## Stage 6: Conditional input-type scan

For each entity, mechanically scan for fields whose displayed `input_type` should derive from the current record's state instead of staying fixed. Scan rules:

- **I1 — Hidden until lifecycle reaches a specific state.** A `*_at` or `*_by_user_id` field that only makes sense once the lifecycle reaches a value: hide until then. Example: `approved_at` on a record with a `workflow_state: enum` — hide while `workflow_state != "approved"`.
- **I2 — Readonly after terminal state.** When the entity's lifecycle has terminal states and a field shouldn't be edited once terminal: readonly.
- **I3 — Required when another field reaches a value.** An extra `comments` field becomes required when `workflow_state == "disputed"`.
- **I4 — Disabled while a guarded condition holds.** A `cancelled_at` field stays disabled while the record's `is_cancellable == false`.
- **I5 — Hidden for non-owner viewers.** Combined with `select_rule` for full row protection.
- **I6 — Default-shown otherwise.** Explicit default for clarity in complex chains.

Output: per-affected entity, an `**Input type rules**` JSON-array block.

```json
[
  {
    "field": "approved_at",
    "description": "Hidden until the record is being approved; readonly thereafter.",
    "jsonlogic": {"if": [{"==": [{"var": "workflow_state"}, "approved"]}, "readonly", "hidden"]}
  }
]
```

The platform evaluates the rule client-side at form-render; the result replaces the static `input_type` for that record. A malformed result or empty rule falls back to the static `input_type`. Anything that must be **enforced** server-side belongs in `validation_rules` — input_type_rule is UI control only. Pair an "appears at the right moment" rule with a server-side `validation_rules` entry so the field is actually populated, not just rendered editable.
