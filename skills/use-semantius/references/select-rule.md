# Semantius Row-Level Security (`select_rule`) Reference

`select_rule` is declared on `create_entity` / `update_entity` (see `data-modeling.md`) and compiled into a per-row `FOR SELECT` RLS policy. Its central operator is `{"has_permission": "<permission_code>"}` — returns `true` when the caller holds the permission, `false` otherwise, never throws; the full operator vocabulary lives in `jsonlogic.md` § Platform-extension operators.

---

### Row-level read access via `select_rule` (entity-level JsonLogic)

Every entity carries a `select_rule` property: a single JsonLogic object that, when non-empty, drives a `FOR SELECT` row-level security policy on the underlying table. It is the read-side analog of `validation_rules` (which gates writes): instead of a per-row truthy check on write, it is a per-row truthy check on every read.

| Property | Type | Default | Purpose |
|---|---|---|---|
| `select_rule` | `object` (JsonLogic) | `{}` | Per-row predicate that must evaluate truthy for the row to be visible to the caller. Evaluated by the platform's RLS policy on every `SELECT`. |

**Storage and lifecycle.** JSONB object, NOT NULL, default `'{}'::jsonb`; the platform's `select_rule_is_object` constraint rejects anything that isn't a JSON object. When the rule is non-empty, the platform generates a `FOR SELECT` RLS policy function for the table; when the rule is reset to `{}` or the entity is deleted, the policy is dropped. The same `select_rule` predicate is **also** referenced in the `UPDATE` / `DELETE` `USING` clause (AND-ed with `edit_permission` — see *Relationship to `view_permission` / `edit_permission`* below), so it constrains which rows a caller may **modify** as well, not only which it may read. It is absent from `WITH CHECK`, which gates writes on `edit_permission` alone.

**Return contract.** The JsonLogic expression must return a **boolean**:

- `true` — the row is visible to the current caller.
- `false` — the row is filtered out of the result set (the caller can neither read nor see its existence via this entity's table; FK joins from other tables that surface the row will hit the same gate).

A non-boolean result is treated as falsy, so the row is hidden — that fails closed, which is the safer direction, but the rule is malformed and should be corrected.

**Reserved variables** (same vocabulary as `computed_fields` / `validation_rules`, available via `{"var": "$name"}`):

| Var | Type | Meaning |
|---|---|---|
| `$today` | `date` | Server date at evaluation time. |
| `$now` | `date-time` | Server timestamp at evaluation time. |
| `$user_id` | `uuid` | Authenticated user performing the read (`null` for system-initiated reads). |
| `$old` | `object` or `null` | Not meaningful on reads; present for vocabulary parity with validation_rules. Do not rely on it in `select_rule`. |

**Platform-extension operators usable in `select_rule`.** The `has_permission` operator (documented in `jsonlogic.md` § Platform-extension operators) is the canonical way to broaden row visibility for elevated roles. It returns boolean (never throws), which is essential — a throwing operator like `require_permission` would fail per-row during a SELECT scan and is not the right shape for read context. `value_changed` and `$old` are also available syntactically but are not meaningful for read rules.

**Relationship to `view_permission` (reads) and `edit_permission` (writes) — reads REPLACE, writes AND (frozen design decision D8).** The two sides are deliberately asymmetric; do not generalize one onto the other.

- **Reads (`SELECT`) — REPLACE.** A non-empty `select_rule` **is the complete read predicate**; it *replaces* `view_permission` rather than being AND-ed with it. `view_permission` is only the **default rule applied when no `select_rule` is set**:

  ```
  can_read(row) = select_rule(row)                 when select_rule is non-empty
                = has_permission(view_permission)   when select_rule is empty (the default rule)
  ```

  Once a rule exists, `view_permission` is **never consulted** for reads: a caller who **lacks `view_permission` but matches the rule sees the row**, and a caller who **holds `view_permission` but fails the rule does not**. (Enforced by `build_select_rule_policy`: `USING (select_rule_<table>(row))` when a rule exists, falling back to `USING (has_permission(view_permission))` only when it doesn't; the DEFINER read helper `get_record_by_id` mirrors this with an explicit mutually-exclusive `IF/ELSE`.)

- **Writes (`UPDATE` / `DELETE`) — AND.** Genuinely layered: `USING (has_permission(edit_permission) AND select_rule(row))`, with `WITH CHECK (has_permission(edit_permission))`. Here `edit_permission` is a real coarse gate **and** the row must pass `select_rule`. `validation_rules` / `require_permission` add per-record gates on top via a separate trigger (see `jsonlogic.md`).

**Authoring consequence (the part that bites).** Because a read rule owns the *entire* read predicate, you cannot rely on `view_permission` to "still let people in." Encode **every** audience that should read the rows *inside* the rule:

- elevated / admin audiences → a `{"has_permission": "<slug>:view_all_<plural>"}` disjunct (not an external grant);
- "anyone holding baseline read" → a `{"has_permission": "<slug>:read"}` disjunct, when you want to preserve that behavior;
- a restrictive rule with no such disjunct **locks out admins and managers** — even holders of every permission — because they simply don't match and `view_permission` is no longer there to admit them.

**Performance note.** `select_rule` is evaluated on every read of every row of this entity. Keep the expression simple: direct column comparisons, `$user_id` matches, enum / boolean checks. Avoid deeply nested arithmetic. `set_record` (the cross-entity lookup operator — see `jsonlogic.md` § Cross-entity lookups) *is* technically callable from `select_rule` (the JsonLogic engine is the same as `validation_rules`), but it runs an extra `SELECT` per row of every read and quickly dominates query cost; prefer column-encoded broadening (a `visibility` enum the row carries) or `has_permission` for tiered audiences. Reserve `set_record` for the rare case where the FK target is small, indexed, and read traffic on this entity is light.

**Example — owner-or-public visibility:**

```json
{
  "or": [
    { "==": [{ "var": "owner_id" }, { "var": "$user_id" }] },
    { "==": [{ "var": "visibility" }, "public" ] }
  ]
}
```

A caller sees a row when they own it OR when the row is marked public.

**Example — case-management shape (uniform per-row filter).** A ticket is visible to its submitter, its assignee, or every caller when it's unassigned:

```json
{
  "or": [
    { "==": [{ "var": "submitter_user_id" }, { "var": "$user_id" }] },
    { "==": [{ "var": "assignee_user_id" }, { "var": "$user_id" }] },
    { "==": [{ "var": "assignee_user_id" }, null] }
  ]
}
```

**Broadening visibility for elevated roles — `has_permission` is the canonical mechanism.** The previous version of this section claimed permission-based visibility could not be encoded inside `select_rule`; that was wrong. The platform exposes `{"has_permission": "<code>"}` (documented in `jsonlogic.md` § Platform-extension operators) specifically so a per-row SELECT rule can check the caller's permissions and broaden the visible row set without throwing. The two patterns:

**Example — tiered audience (uniform per-row OR elevated-permission bypass):** A ticket is visible to its submitter, its assignee, unassigned tickets are visible to everyone, AND holders of `helpdesk:view_all_tickets` see every row regardless:

```json
{
  "or": [
    { "==": [{ "var": "submitter_user_id" }, { "var": "$user_id" }] },
    { "==": [{ "var": "assignee_user_id" }, { "var": "$user_id" }] },
    { "==": [{ "var": "assignee_user_id" }, null] },
    { "has_permission": "helpdesk:view_all_tickets" }
  ]
}
```

A regular caller sees only the rows the first three clauses cover; a `helpdesk:view_all_tickets` holder sees every row because the fourth clause shortcuts to truthy. This is the standard way to encode "regular sees own; manager sees all" — the rule body is the single source of truth.

**Example — visibility column with conditional elevation:**

```json
{
  "or": [
    { "==": [{ "var": "visibility" }, "public" ] },
    { "==": [{ "var": "author_user_id" }, { "var": "$user_id" }] },
    { "and": [
      { "==": [{ "var": "visibility" }, "team" ] },
      { "has_permission": "roadmap:view_team_notes" }
    ]},
    { "has_permission": "roadmap:view_all_notes" }
  ]
}
```

**Use `has_permission`, not `require_permission`, in `select_rule`.** Both are documented in `jsonlogic.md` § Platform-extension operators. The throwing semantics of `require_permission` are wrong for SELECT: a throw per row of a scan would fail the whole query for any caller missing the permission, even when other clauses of the rule would have admitted some rows. `has_permission` returns boolean, which composes correctly with `or` to broaden visibility.

**Out-of-rule alternatives are still useful when in-rule encoding doesn't fit.** Some access patterns are easier or cleaner outside the rule body:

- Provide a separate cube view or entity surface for the broader audience, with its own `view_permission`, when the elevated read returns a different *shape* (aggregates, redacted columns) than the row-level read.
- Configure a Postgres role with the `BYPASSRLS` attribute (DBA-side, outside Semantius) when an operational role legitimately needs unconstrained read across many entities — adding `has_permission` clauses to every entity's `select_rule` is correct but tedious.
- Accept a uniform filter without elevation when nobody actually needs broader access; not every entity needs a tiered read.

The first instinct should still be: encode the broadening inside the rule with `has_permission`. The out-of-rule paths are for cases where in-rule encoding is awkward, not for cases where it is impossible — it isn't.

**Setting and removing.** Pass `select_rule` on `create_entity` to declare it at creation, or on `update_entity` to attach / replace / remove it later. Sending `{}` (or omitting the property on `create_entity`) leaves the rule disabled.

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

# Remove the rule and drop the RLS policy function:
semantius call crud update_entity '{
  "table_name": "tickets",
  "data": { "select_rule": {} }
}'
```

**Risk.** Adding a `select_rule` to an entity that previously had none is **medium-risk**, and because reads use REPLACE semantics the change is sharper than it looks: before the rule, every `view_permission` holder saw every row; the instant the rule exists, `view_permission` is no longer consulted and **only** rule-matching rows are visible — so any caller the rule does not explicitly admit (including admins and managers holding every permission) is locked out unless the rule carries a `has_permission` disjunct for them. Always warn the user, enumerate the roles/users that must still see everything, confirm each is admitted by a clause of the rule, and confirm the rollout. Modifying or removing a `select_rule` is also medium-risk (visibility change can surprise downstream consumers, dashboards, integrations).

