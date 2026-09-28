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

**Based entities (`**Key type:** is_a` / `has_a`).** Before drafting the first one, **read [`../../use-semantius/references/entity-families.md`](../../use-semantius/references/entity-families.md)** (mandatory). Then, for each based entity:

1. Draft **only its own fields**. Every field its base (or any level above) already holds belongs to that base: never repeat a base field name (the platform refuses it, `90243`; `consistency-check.ts` fails the save). Siblings (calls and emails) may share names.
2. Emit **no** `**Label column:**`, `**Label parent:**` or `**Order column:**` line: the label comes from the base.
3. A lifecycle (`workflow_state`) sits on the base when every kind shares it, otherwise on the kinds; never on both.
4. On an **`is_a`** entity every `reference` / `parent` field gets `restrict` or `clear`, never `cascade`, written explicitly (`↳ <target> (N:1, restrict)`), because `parent` defaults to cascade.
<!-- DUPLICATE of canonical copy in ../../use-semantius/references/entity-families.md ("Creating a family"). Edit both. -->

**Type enum from the design.** When a §2 Description carries the architect's fixed sentence **"Each <Singular> is one of: A, B, or C."** (or "A or B"), turn it into one enum field on that entity:

| Situation | Action | What to write | Example | Not this |
|---|---|---|---|---|
| The sentence is present | One required enum field `<singular>_type` | Notes: `` enum_values: `a`, `b`, `c`; default: "a" `` (values in snake_case, in the sentence's order); §5 block with a label bullet only where a value is a code | "Each Expense is one of: mileage or receipt." → `expense_type`, `` enum_values: `mileage`, `receipt` `` | A family, or one entity per kind |
| Some fields belong to only some kinds | `input_type_rule` per such field (Stage 6) showing it for its kinds | `{"if": [{"==": [{"var": "expense_type"}, "mileage"]}, "required", "hidden"]}` on `distance_km` | Separate entities |
| Always | A validation rule (Stage 10) that blocks changing the type after creation | `{"or": [{"==": [{"var": "$old"}, null]}, {"==": [{"var": "expense_type"}, {"var": "$old.expense_type"}]}]}`, name `type_fixed_after_creation` | A lifecycle on the type |

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

Everything else is `reference`. `parent` implies cascade-on-delete; `reference` is non-owning (`clear` or `restrict`). **Exception:** on an `is_a` entity, `parent` and `reference` fields use `restrict` or `clear`, never cascade (`90249`).

**Naming a field that holds a relationship:** `<target_singular>_id` for references/parents (`account_id`, `assigned_user_id`, `parent_case_id`). The Reference column expresses target and cardinality: `→ accounts (N:1)`.

**Automatic fields, omit them**: `id`, `created_at`, `updated_at`, `label`, plus the platform-generated composed-label columns `_label` and every `<fk>_label` companion — never specify these, the platform owns them. Declare the `label_column` field as a normal row.

> **Reserved field names.** Never draft a `field_name` that starts with `_` (reserves the entity's own `_label`) or ends with `_id_label` (reserves the `<fk>_label` FK companions). The platform rejects both on create and rename. Plain `*_label` names (e.g. `status_label`) remain allowed.

> **`label_column` must be a string field, never a FK.** When `create_entity` runs, Semantius auto-creates a field whose `field_name` equals the `label_column`. Setting `label_column` to a FK field name causes a conflict. Junction tables: the platform auto-combines a junction's parent legs into its composed `_label` (`Alice Chen › Admin`), so a dedicated `string` label field (e.g. `product_tag_label`) is **optional** — add one only when you want a distinct local label beyond the combined legs. When a junction has no local label, **omit the `**Label column:**` line** from its §3 block (template rule); never invent a synthetic label field just to fill the line. Every non-junction entity still carries the line, **except a based entity (one with `**Based on:**`), which carries none**: its label comes from its base.

> **Derive `label_parent` — the entity's identity spine.** Each owned entity also gets an optional `**Label parent:**` line in §3 (omit when none). `label_parent` names the one FK whose composed `_label` prefixes this record's `_label`, so a relational record reads as its full parent chain (an interview scorecard shows the candidate, not just "Scorecard 6"). Derive it by this rule:
>
> 0. **Based entity (`**Based on:**`)?** → NONE — its label and label parent come from the base (`90242`).
> 1. **`entity_type = junction`?** → NONE — the platform auto-combines the parent legs; never set `label_parent` on a junction.
> 2. **Self-identifying?** → NONE. The `label_column` is an intrinsic name (`*_name`, `*_title`, `*_code`, `email`); `_label` is then just the local label.
> 3. **Otherwise (relational / dependent):** exactly one `parent`-format FK → that FK (the default spine); multiple FKs, or no `parent` FK → the FK to the **principal subject** (the architect may flag which parent is the spine in the §5 relationship notes; the other legs are flat discriminators, each already carrying its own `<fk>_label` companion).
>
> A `parent` FK is the strongest spine signal, but a `reference` FK can be the spine — `job_applications.candidate_id` is `reference` + `restrict` yet is the identity spine. Validate immediately: the named field must be a real `reference`/`parent` FK on this entity and must not target a junction. Emit `**Label parent:** `<fk_field_name>`` in §3; the modeler stamps it into `entities.label_parent`.

**Defaults**:
- Required enum → declare `default: "<value>"` explicitly (auto-fallback would use `enum_values[0]`, the first entry's value). The default is always a **value**, never a label.
- **Enum values and labels.** The Notes `enum_values:` annotation lists **values only** (`` enum_values: `msa`, `nda` ``). A label goes only in the §5 block, and only when the value is a code or an abbreviation: `` - `nda` - Non-disclosure agreement ``; a readable value gets a plain `` - `draft` `` bullet. The modeler sends a labeled bullet as a `{"value", "label"}` pair. `consistency-check.ts` enforces the bullet grammar, Notes = §5, and a value default (platform rules: `data-modeling.md` → "Enum values and labels").
- Other formats → only add explicit `default` when auto-fallback would violate a validation rule (e.g. required integer with `>= 1` rule auto-defaults to `0`, fails the rule — declare `default: "1"`).
- Nullability: only `reference`, `date`, `date-time` are DB-nullable. Other formats are NOT NULL with the auto-default. `Required = yes` on a nullable format means UI-required, not DB-NOT-NULL.

**Set `relationship_label` for every FK field.** Specific verb in parent voice: `accounts → opportunities` is `"owns"`; `users → tasks` (owner) is `"manages"`. Avoid filler (`"has"`, `"references"`). Self-references: pick `"parent of"` / `"manages"` / `"reports to"`. When same parent has multiple FKs from the same child, verbs must differentiate (`"created"` vs `"assigned"`). Annotate as `relationship_label: "<verb>"` in §3 Notes. §2 Mermaid edge label and this annotation must agree byte-for-byte.

**Optional Notes markers (round-trip carriers; author rarely, `semantius-optimizer` emits them from live).** Two field-presentation markers may appear in the Notes cell; both are OPTIONAL with an omit-when-default rule, so a hand-authored spec normally leaves them off and lets the platform defaults stand:
- `width: <s|m|w>` — the field's display width. Bare value, NOT backticked, exactly like `precision: 2`. Emit ONLY when non-default; omit when the platform default (`default`).
- `` `searchable` `` — backticked bare marker, exactly like `` `unique` ``. Emit ONLY when the field's live `searchable` is true.

Keep the deterministic Notes marker order so a forward-authored spec and a reverse-engineered one stay byte-identical (this is the order `semantius-optimizer` emits, so match it exactly). For the label-column field: `` `label_column` `` (then `, `unique`` when it is a natural key). For every other field: `` `unique` `` · `` `searchable` `` · `enum_values` (with inline `default`) · FK (`→ table (N:1)`, `relationship_label`) · `precision` · `cube_type` · `parent label` · `width` · `default`.

**Fill the §3 Description column only when structured metadata can't convey the meaning.** Fill when units are not in the type (`effort_score` → *"RICE effort in person-months"*), ranges not encoded as a validation rule, direction-mattering semantics, sign / polarity conventions, freeform-string shape hints, or jargon titles a non-specialist couldn't parse cold. Leave blank when title is plain English, restates field_name, or the FK/enum/validation already encodes the meaning.

**No identifier leakage in Description.** Use Labels, not `field_name`s, when referring to sibling fields. Use Singular/Plural Labels, not `table_name`s, when referring to other entities. Enum values stay backticked as data (`"Null until Match Status reaches `auto_matched`"`). No backticks around identifiers in prose.

For deep field-format and built-in field-shape rules (when extending `users`, `roles`, etc.), see `../../use-semantius/references/data-modeling.md`.

After the field tables, present for each entity a short **Relationships** section in prose. Write it with the template's canonical forms, referencing every entity and FK by its unique `table_name` / `field_name` (never a display label or a name-derived noun), so it round-trips byte-for-byte with the `semantius-optimizer` reverse pass. The user reviews and confirms or changes these fields through the 3g confirmation widget's "Adjust the fields for an entity" path, not through a separate per-entity prompt here.

## Keep each fact once: the N-checks

Run these over every drafted entity after its fields exist (the field-level backstop to the architect's entity-level `normalization.md`). The one test: **"If this fact changed, would it need changing in more than one place?"** A snapshot passes: it is kept and described "as of <event>". Named N so they never collide with Stage 10's F1-F15 rule families.

| Check | Field pattern | Example | Not this (negative) | Auto-fix or ask | Plan-summary text |
|---|---|---|---|---|---|
| N1 | A copy of a referenced entity's data (`<ref>_name` next to `<ref>_id`, a customer's phone on an order) | `orders.customer_phone` next to `orders.customer_id` | A price at sale, a billing address at issue (snapshots: keep, described "as of <event>") | **Auto-fix:** drop the copy | "Took out <Field Label> on <Plural Label>: it is read from <Other Plural Label>." |
| N2 | Numbered or delimited repeats (`phone_1`, `phone_2`; a comma-separated list) | `contacts.phone_1`, `contacts.phone_2` | Two different facts that happen to share a stem (`start_date`, `end_date`) | **Ask** (structural): a child entity or a junction | per the 4.N answer |
| N3 | A junction field about only one side | `project_members.member_email` (a fact about the person) | A member's role on the project (a fact about the pair: stays) | **Auto-fix:** move it to that side | "Moved <Field Label> from <Junction Plural Label> to <Plural Label>." |
| N4 / N5 | A value decided by another field, or a hand-entered total | `order_total` typed in next to its lines | A total the user overrides on purpose | Point to Stage 10 (a computed field) | per Stage 10 |
| N6 | Family placement: a field every kind carries | `calls.subject` and `emails.subject` | A field only some kinds carry | **Auto-fix:** move it to the base | "Kept <Field Label> once on <Base Plural Label>." |
| N7 | A type enum that switches more than 3 exclusive fields | `expense_type` hiding 5 fields per value | 3 or fewer (Q3 of the decision table: stays an enum) | **Ask** (structural): a family | per the 4.N answer |
| N8 | Drafted fields repeat a live entity's identifying facts (2e.1's identifying lists) | a drafted `payees` with name, tax id and bank account next to a live `business_partners` | A reference field to that live entity | **Ask** via 4.N with the 3c.1 widgets | per the 4.N answer |

List every auto-fix in the plan summary with its plain text (3g authoring rule 11).

## Step 4.N: keep-each-fact-once questions

Runs **after every owned entity is drafted and before the 3g plan render**, as a ledger step (every widget a `Q:` task).

1. **Collect** the open findings: N8 pairs (a drafted entity and a live entity), N2 and N7 findings. **Loop guard:** skip any pair already answered this run or held in `.shared_bases`, and any finding already answered this run.
2. **Ask** through the ledger, up to four question objects per call:
   - **N8:** exactly the 3c.1 widgets and outcomes ([`stage-3-shared-base.md`](stage-3-shared-base.md), Case A or C); the answer lands in `.shared_bases`.
   - **N2:** question `"<Plural Label> can hold several <Field Label plural>. Should each be its own record?"`, header `"Several"`, options `"Yes, a list of them (Recommended)"` (description `"Each <Field Label> becomes its own record, so there's no limit and nothing numbered."`) and `"No, keep the fixed fields"` (description `"<Plural Label> keeps <Field Label> 1 and 2 as they are."`).
   - **N7:** question `"Each kind of <Singular> asks for quite different details. Keep the kinds as separate lists that share one overview?"`, header `"Kinds"`, options `"Keep one list with a type (Recommended)"` (description `"One <Singular> list; the type decides which details are asked."`) and `"Separate lists, one shared overview"` (description `"Each kind gets its own list and details, and one overview lists them all."`). On the second option: an `is_a` family (a `typeid` base carrying the shared fields), per `entity-families.md`.
3. **Re-draft only the affected entities, once**, then render the plan. Never re-run 4.N after the re-draft.
