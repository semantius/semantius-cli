# Stage 4: Elicit fields for owned entities

*Reference for `semantius-analyst`. Invoked from the 3g step (see [`stage-3-confirm.md`](stage-3-confirm.md)).*

## Stage 4: Elicit fields for owned entities

Turn each fieldless blueprint entity the spec OWNS into a fielded spec entity: draft each field's name, format, required flag, label, and (for enums) allowed values. Computed fields and validation rules are added in Stage 10; conditional input-type rules in Stage 6; row-level `select_rule` in Stage 7.

**When this runs.** This stage is invoked from the 3g confirmation step, immediately after adopted-entity drift resolution and before the plan summary is rendered, so the drafted fields appear in that summary and the user can review or change them through its "Adjust the fields for an entity" path before anything is written. It is not a silent pass that runs after the user has confirmed. The field tables below are the working representation: the plan summary shows them compactly (labels and types), and a full table is shown only when the user chooses to adjust an entity.

Apply this stage **only** to entities whose Reconciliation decision is `create-new`, `rename-incoming-from`, or `promote-to-master`. Skip `reuse-from` and `dropped`.

**Apply the Additional Requirements first (when the blueprint carried one).** Before drafting fields, fold the `additional_requirements` note (captured in Stage 1) into this stage as MUST-honor design intent, not advisory:

- **Field-level requirements** (a named field a cost / rollup view depends on, a fixed unit or currency, an externally-mandated value) → realize them as actual fields on the named OWNED entity, exactly as specified (e.g. a flat numeric figure plus its currency code). These take precedence over what you would otherwise draft from the entity description alone.
- **Cross-module / non-field intent** (a denormalization-and-dedup rule, a "must reconcile against the canonical source once module X installs" directive) cannot be a field → record it as a §7.2 Future considerations entry (and, where it constrains one field, a short field Description note) so the deployer and future installs honor it.
- **Requirement targeting a non-owned entity** (`reuse-from` / built-in) → surface it as a §7 note rather than silently dropping it; the field cannot be added here.

The Additional Requirements section is a blueprint-only channel: it is NOT copied verbatim into the spec, its content survives as the fields you draft here plus any §7.2 entries. Do not emit an Additional Requirements section in the spec.

For each owned entity, draft a field list. Present each entity as its own table with these columns:

| Field name | Format | Required | Label | Description | Reference / Notes |
|---|---|---|---|---|---|
| `contact_email` | `email` | yes | Email Address |  | unique |
| `account_id` | `reference` | yes | Account | Internal owner responsible for the account | → `accounts` (N:1), relationship_label: "owns" |
| `workflow_state` | `enum` | yes | Workflow State |  | enum_values: `lead`, `mql`, `sql`, `customer`; default: `lead` |

**Lifecycle state field — fixed name `workflow_state`.** Every entity that has a lifecycle (a `role = master` entity with §7 lifecycle states) stores that state in a field named **exactly `workflow_state`**: format `enum`, required `yes`, `enum_values` = the §7 `state_name`s in lifecycle order, `default` = the `initial?` state (the row above shows the canonical shape). This name is fixed platform-wide — never author the state field as `status`, `state`, `lifecycle_state`, or `lifecycle_stage`. The deployer (`semantius-modeler`) FAILS LOUD on any module whose lifecycle state lands in a differently-named field, so a non-`workflow_state` state field is an authoring bug, not a stylistic choice. A non-lifecycle enum that merely looks state-like (`priority`, `severity`, a CRM funnel stage that no §7 / §8.1 gate references) keeps its domain name — the rule binds only the field that drives the §7 state machine and its `workflow-gate (lifecycle)` permissions.

**Field format vocabulary** (Semantius values, never invent new):
- Text: `string`, `text`, `multiline`, `html`, `code`. `string` / `text` = single-line input; `multiline` = `<textarea>`; `html` = rich-text; `code` = monospace.
- Numbers: `integer`, `int32`, `int64`, `number`, `float`, `double`. Use `number` (arbitrary-precision, Postgres `NUMERIC`) for money / prices / amounts / totals / balances / revenue / fees / rates / salaries / budgets / discounts. Pair with `precision` (default `2` for money).
- Date/time: `date`, `time`, `date-time`, `duration`.
- Boolean: `boolean`.
- Choice: `enum` (always declare `enum_values` in lifecycle order; for required enums add explicit `default: "<value>"`).
- Structured: `json`, `object`, `array`.
- Identifier: `uuid`, `email`, `uri`, `url`.
- Relationship: `reference` (+ target table) for independent lifecycle; `parent` (+ target table) for ownership / master-detail.

**Choosing `reference` vs `parent`** — `reference` is the default. Use `parent` only when:
1. **Master-detail children.** Child is a constituent part of the parent and has no meaning outside it: `order_lines.order_id → orders`, `comments.post_id → posts`.
2. **Junction-table FKs.** **Every** leg of a junction is `parent` — a binary junction has two (`feature_votes.feature_id`, `feature_votes.user_id`); an N-ary junction `(user, role, tenant)` has three. But an N-ary link that carries **its own attributes or a lifecycle** is an association class, not a junction: classify it `operational_record` / `operational_workflow` and give it a single `label_parent` spine plus flat discriminator FKs, rather than `entity_type = junction`.

   In §4 each junction leg is one row with `Kind = junction` and `fk_format = parent` — the two columns differ (see the §4 template's "`Kind` vs `fk_format`" rule). Do not collapse the leg's `Kind` down to `parent`.

   **Preserve the M:N verb — don't drop it on decomposition.** When a junction materializes an `A <verb> B` many-to-many edge from the blueprint (e.g. `asset_contracts covers saas_applications`), the relationship's verb is a real detail that must survive. Stamp `relationship_label: "<verb>"` on the junction leg pointing back to the **source** entity of that edge — the blueprint §5 `from` side (`asset_contract_id → asset_contracts` carries `relationship_label: "covers"`). Leave the other leg (`saas_application_id → saas_applications`) bare: its inverse verb isn't declared anywhere and would be an invention. The §2 diagram emitter then renders `asset_contracts -->|covers| asset_contract_saas_applications`, so the verb is not lost when the M:N is normalized into a junction. Pure master-detail ownership `parent` legs (an order line's `order_id`) stay bare unless the blueprint declared a verb for them.

Everything else is `reference`. `parent` implies cascade-on-delete; `reference` is non-owning (`clear` or `restrict`).

**Naming a field that holds a relationship:** `<target_singular>_id` for references/parents (`account_id`, `assigned_user_id`, `parent_case_id`). The Reference column expresses target and cardinality: `→ accounts (N:1)`.

**Automatic fields, omit them**: `id`, `created_at`, `updated_at`, `label`, plus the platform-generated composed-label columns `_label` and every `<fk>_label` companion — never specify these, the platform owns them. Declare the `label_column` field as a normal row.

> **Reserved field names.** Never draft a `field_name` that starts with `_` (reserves the entity's own `_label`) or ends with `_id_label` (reserves the `<fk>_label` FK companions). The platform rejects both on create and rename. Plain `*_label` names (e.g. `status_label`) remain allowed.

> **`label_column` must be a string field, never a FK.** When `create_entity` runs, Semantius auto-creates a field whose `field_name` equals the `label_column`. Setting `label_column` to a FK field name causes a conflict. Junction tables: the platform auto-combines a junction's parent legs into its composed `_label` (`Alice Chen › Admin`), so a dedicated `string` label field (e.g. `product_tag_label`) is **optional** — add one only when you want a distinct local label beyond the combined legs.

> **Derive `label_parent` — the entity's identity spine.** Each owned entity also gets an optional `**Label parent:**` line in §3 (omit when none). `label_parent` names the one FK whose composed `_label` prefixes this record's `_label`, so a relational record reads as its full parent chain (an interview scorecard shows the candidate, not just "Scorecard 6"). Derive it by this rule:
>
> 1. **`entity_type = junction`?** → NONE — the platform auto-combines the parent legs; never set `label_parent` on a junction.
> 2. **Self-identifying?** → NONE. The `label_column` is an intrinsic name (`*_name`, `*_title`, `*_code`, `email`); `_label` is then just the local label.
> 3. **Otherwise (relational / dependent):** exactly one `parent`-format FK → that FK (the default spine); multiple FKs, or no `parent` FK → the FK to the **principal subject** (the architect may flag which parent is the spine in the §5 relationship notes; the other legs are flat discriminators, each already carrying its own `<fk>_label` companion).
>
> A `parent` FK is the strongest spine signal, but a `reference` FK can be the spine — `job_applications.candidate_id` is `reference` + `restrict` yet is the identity spine. Validate immediately: the named field must be a real `reference`/`parent` FK on this entity and must not target a junction. Emit `**Label parent:** `<fk_field_name>`` in §3; the modeler stamps it into `entities.label_parent`.

**Defaults**:
- Required enum → declare `default: "<value>"` explicitly (auto-fallback would use `enum_values[0]`).
- Other formats → only add explicit `default` when auto-fallback would violate a validation rule (e.g. required integer with `>= 1` rule auto-defaults to `0`, fails the rule — declare `default: "1"`).
- Nullability: only `reference`, `date`, `date-time` are DB-nullable. Other formats are NOT NULL with the auto-default. `Required = yes` on a nullable format means UI-required, not DB-NOT-NULL.

**Set `relationship_label` for every FK field.** Specific verb in parent voice: `accounts → opportunities` is `"owns"`; `users → tasks` (owner) is `"manages"`. Avoid filler (`"has"`, `"references"`). Self-references: pick `"parent of"` / `"manages"` / `"reports to"`. When same parent has multiple FKs from the same child, verbs must differentiate (`"created"` vs `"assigned"`). Annotate as `relationship_label: "<verb>"` in §3 Notes. §2 Mermaid edge label and this annotation must agree byte-for-byte.

**Optional v5.4 Notes markers (round-trip carriers; author rarely, `semantius-optimizer` emits them from live).** Two field-presentation markers may appear in the Notes cell; both are OPTIONAL with an omit-when-default rule, so a hand-authored spec normally leaves them off and lets the platform defaults stand:
- `width: <s|m|w>` — the field's display width. Bare value, NOT backticked, exactly like `precision: 2`. Emit ONLY when non-default; omit when the platform default (`default`).
- `` `searchable` `` — backticked bare marker, exactly like `` `unique` ``. Emit ONLY when the field's live `searchable` is true.

Keep the deterministic Notes marker order so a forward-authored spec and a reverse-engineered one stay byte-identical (this is the order `semantius-optimizer` emits, so match it exactly). For the label-column field: `` `label_column` `` (then `, `unique`` when it is a natural key). For every other field: `` `unique` `` · `` `searchable` `` · `enum_values` (with inline `default`) · FK (`→ table (N:1)`, `relationship_label`) · `precision` · `cube_type` · `parent label` · `width` · `default`.

**Fill the §3 Description column only when structured metadata can't convey the meaning.** Fill when units are not in the type (`effort_score` → *"RICE effort in person-months"*), ranges not encoded as a validation rule, direction-mattering semantics, sign / polarity conventions, freeform-string shape hints, or jargon titles a non-specialist couldn't parse cold. Leave blank when title is plain English, restates field_name, or the FK/enum/validation already encodes the meaning.

**No identifier leakage in Description.** Use Labels, not `field_name`s, when referring to sibling fields. Use Singular/Plural Labels, not `table_name`s, when referring to other entities. Enum values stay backticked as data (`"Null until Match Status reaches `auto_matched`"`). No backticks around identifiers in prose.

For deep field-format and built-in field-shape rules (when extending `users`, `roles`, etc.), see `../../use-semantius/references/data-modeling.md`.

After the field tables, present for each entity a short **Relationships** section in prose. Write it with the template's canonical forms, referencing every entity and FK by its unique `table_name` / `field_name` (never a display label or a name-derived noun), so it round-trips byte-for-byte with the `semantius-optimizer` reverse pass. The user reviews and confirms or changes these fields through the 3g confirmation widget's "Adjust the fields for an entity" path, not through a separate per-entity prompt here.
