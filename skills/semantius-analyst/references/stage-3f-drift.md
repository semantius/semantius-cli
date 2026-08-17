# Stage 3f: Adopted-entity drift resolution

*Reference for `semantius-analyst`. Invoked from the 3g step (see [`stage-3-confirm.md`](stage-3-confirm.md)). Its "Policy path:" lines depend on [`customizations-consultation.md`](customizations-consultation.md).*

### 3f. Adopted-entity drift resolution (run from the 3g confirmation step, before field drafting)

**Fires when** a per-entity comparison surfaced any drift between the live entity and the **intended** definition, on ANY property: field-name (3f.1), enum-value (3f.2), permission-tier (3f.3), format/required-ness (3f.4), every other scalar property (3f.6), and every JsonLogic rule block (3f.7). The scan is property-exhaustive (see 2h) — no property is skipped. One widget fires per drift kind per affected entity. Resolution is recorded as either an annotation that the analyst applies to the spec being drafted, or as a 🔴 §7.1 blocker that the user must accept before the spec is written.

**Two comparison sources feed this stage — the widgets and mappings below are identical for both:**

1. **Adopted-entity path (Reconcile from a blueprint).** Stage 2h built a non-empty `adopted_entity_index`; the **intended** side is the blueprint's declared fields for `promote-to-master` / `rename-incoming-from` / `reuse-from` entities. This is the original path.
2. **Owned-entity path (Extend / edit of a deployed spec, after the 2a.1 version gate found a mismatch).** The **intended** side is the spec's own current Fields blocks for its OWNED entities; live has drifted underneath since the last deploy. Same 2h deep-inspect, same widgets — read "the spec" wherever a widget below says "the spec/blueprint declares".

The principle: **the live catalog is the truth-source for what already exists; the spec/blueprint is the truth-source for what's intended. When they disagree on an existing thing, the user decides.** The safe default for every widget is "keep the live state and align the spec to it" — that path has zero risk to existing data.

#### 3f.1 Field-name drift (same concept, different name)

**Policy path:** `.drift.field_name.<entity>.<field>`.

**Fires when** the blueprint declares a field `<spec_field>` on an adopted entity, that name doesn't exist in the live entity, AND a live field `<live_field>` is a strong same-concept candidate (same format family, similar role). Heuristic for candidate detection: live field's `format` matches the blueprint's intended format AND one of the field-naming pairs below applies. Common pairs:

| Spec might use | Live often has |
|---|---|
| `workflow_state` (the fixed lifecycle state field) | `status`, `state`, `lifecycle_state`, `lifecycle_stage` |
| `display_name`, `full_name` | `name`, `label` |
| `description` | `notes`, `body`, `details` |
| `is_active`, `is_enabled` | `active`, `enabled` |
| `created_at` (manual) | `created_at` (auto, platform-managed — skip; this is platform plumbing, not drift) |

Use both the naming-pair heuristic AND format / lifecycle-stamp / required-ness alignment to confirm the candidate before firing the widget.

- **question**: `"`<Entity Plural Label>`'s spec declares a field called `<spec_field>`, but the live entity already has `<live_field>` (`<format>`, `<n>` records using it). They look like the same concept. Which name should we use?"`
- **header**: `"Field name drift"`
- **multiSelect**: `false`
- **options** (exactly 3 + Cancel):
  1. label: `"Keep the live name `<live_field>` (Recommended)"`
     description: `"Aligns the spec to `<live_field>`. Existing records keep their column. All references in computed fields, validation rules, write-side rules, and read-side rules get rewritten to `<live_field>` automatically (the analyst walks every JsonLogic tree in the spec and replaces every `{\"var\": \"<spec_field>\"}` with `{\"var\": \"<live_field>\"}` before save). No data movement, no migration."`
  2. label: `"Rename to `<spec_field>` (requires manual SQL migration)"`
     description: `"The platform cannot do an in-place column rename. You'd have to: (1) add `<spec_field>` as a new column, (2) copy data from `<live_field>` to `<spec_field>` via SQL, (3) drop `<live_field>`, (4) re-run the deploy. The spec gets a 🔴 §7.1 blocker documenting the migration. Pick this only if you're committed to running the SQL."`
  3. label: `"Treat as different fields, keep both"`
     description: `"`<live_field>` stays as it is; `<spec_field>` gets added as a brand-new column. The two are independent. Usually wrong — pick this only if you genuinely need both fields."`
  4. label: `"Cancel"`
     description: `"Stop without writing the spec. Fix the blueprint to match the live name, then re-run."`

**Internal mapping:**
- Option 1 → in the spec being drafted, rename `<spec_field>` → `<live_field>` on the entity's Fields table; cascade the rename through all JsonLogic on the entity (see "JsonLogic cascade" below) AND on every OTHER entity whose JsonLogic references `<entity>.<spec_field>` (cross-entity lookups). Record an `**Additive fields**` annotation if the spec doesn't already redeclare `<live_field>`.
- Option 2 → keep `<spec_field>` in the spec; add a 🔴 §7.1 blocker: *"Field-name migration required on `<Entity Plural Label>`: rename column `<live_field>` to `<spec_field>` before deploy. The deployer cannot do this in-place."*
- Option 3 → keep both `<spec_field>` and `<live_field>` in the spec; add a 🟡 §7.2 note flagging the unusual choice.
- Option 4 → halt the run, no spec written.

**Lifecycle state field exception.** When `<spec_field>` is `workflow_state` (the fixed lifecycle state field, see Stage 4) and the live entity holds the state under a legacy name (`status` / `state` / `lifecycle_state` / `lifecycle_stage`), do **not** offer Option 1 ("keep the live name"): the deployer rejects any lifecycle state stored outside `workflow_state`, so keeping `status` would only produce a spec the modeler refuses to deploy. Offer the rename-to-`workflow_state` migration (Option 2) as the recommended path. When the live entity already uses `workflow_state`, there is no name drift to resolve.

#### 3f.2 Enum-value drift (with live records in use)

**Policy path:** `.drift.enum.<entity>.<field>`.

**Fires when** the blueprint declares `enum_values` for a field that already exists live, AND any of these conditions hold: (a) live has values the blueprint doesn't list, (b) blueprint introduces values that re-classify existing live values, (c) live `default` differs from blueprint `default`. Especially urgent when live records actually use any value the blueprint would drop (`live_distinct_enum_values_in_use` includes a value missing from the blueprint's list).

- **question**: `"The `<entity>.<field>` enum has different values in the live model vs the spec. Live has `<live_vals>` (`<n>` records using these values, including `<at-risk vals>` which the spec would drop). Spec wants `<spec_vals>`. What should we do?"`
- **header**: `"Enum drift"`
- **multiSelect**: `false`
- **options** (3 + Cancel):
  1. label: `"Keep live values + add new spec values (Recommended, additive)"`
     description: `"The spec's enum becomes the union of live + spec values. Existing records keep their values. New records can use the additional values from the spec. No data migration."`
  2. label: `"Use the spec's mapping (requires data migration)"`
     description: `"Maps live values to spec values where it can (`<live_val_x>` → `<spec_val_y>`, etc.) and adds a 🔴 §7.1 blocker documenting which records need migration before deploy. The deployer cannot migrate records automatically — you'd need a SQL or CLI pass to update the rows first. Pick this only if you've planned the migration."`
  3. label: `"Keep live values exactly, drop the spec changes"`
     description: `"The spec's enum is replaced with live values verbatim. Any spec-only values are discarded. The spec is updated; deploy proceeds without enum changes."`
  4. label: `"Cancel"`
     description: `"Stop without writing the spec."`

**Internal mapping:**
- Option 1 → spec carries the union enum (`live_vals + new_spec_vals`); cascade default to live default if it's in the union; otherwise pick the recommended new default and document via §7.2.
- Option 2 → spec carries spec-only enum; add 🔴 §7.1 blocker listing affected records and required migration.
- Option 3 → spec carries live enum verbatim; spec-only values dropped silently with a §7.2 note for traceability.
- Option 4 → halt.

#### 3f.3 Permission-tier drift

**Policy path:** `.drift.permission.<entity>.edit_permission`.

**Fires when** the live entity's `edit_permission` differs from the spec's intended `edit_permission`, AND the tier comparison shows a downgrade (admin → manage, manage → narrow), an upgrade (manage → admin), or a cross-module rename (e.g., `hiring_starter:admin` → `ats-candidate-crm:manage`).

- **question**: `"`<Entity Plural Label>` is currently edit-gated by `<live_perm>` in the live model. The spec proposes `<spec_perm>` (which is a `<change kind: downgrade | upgrade | rename>`). What should we do?"`
- **header**: `"Permission tier drift"`
- **multiSelect**: `false`
- **options** (3 + Cancel; rendered conditionally on change kind — downgrade shows the warning, upgrade is mostly safe, rename is informational):
  1. label: `"Keep live `<live_perm>` (Recommended)"`
     description: `"Preserves existing access. The spec is updated to reference `<live_perm>` in §3 and in every JsonLogic that named `<spec_perm>`. Pick this when the live tier is correct or you're not sure."`
  2. label: `"Apply the spec's `<spec_perm>`"`
     description: `"Updates the entity's edit_permission to `<spec_perm>`. If this is a downgrade, users who hold `<live_perm>` but not `<spec_perm>` will lose edit access. If this is an upgrade, users will need `<spec_perm>` to edit going forward. The deployer will issue an `update_entity` for the permission change."`
  3. label: `"Pin to both (cross-module inclusion edge)"`
     description: `"Keeps `<live_perm>` as the column value AND adds a `permission_hierarchy` row so anyone holding `<spec_perm>` also gains edit rights. Use when the spec's intent is a broader access pattern, not a direct replacement."`
  4. label: `"Cancel"`
     description: `"Stop without writing the spec."`

**Internal mapping:**
- Option 1 → spec aligns to `<live_perm>`; cascade through any §3 / §7 / §8 references.
- Option 2 → spec carries `<spec_perm>`; add an `update_entity edit_permission_id` step to the modeler's plan with a 🟡 §7.2 note describing the access change.
- Option 3 → spec carries `<live_perm>` + an extra §8.2 permission-hierarchy row (`<spec_perm> → <live_perm>`).
- Option 4 → halt.

#### 3f.4 Format / required-ness drift (informational widget, not blocking)

**Policy path:** `.drift.format.<entity>.<field>`.

**Fires when** the blueprint declares a different `format` or `required` value than the live entity for a field that already exists. Distinguish two cases:

- **Same-primitive format variation** (text ↔ string ↔ multiline ↔ html, integer ↔ int32 ↔ int64): the platform usually accepts these via `update_field`. The widget is informational — recommends aligning to spec (live can be updated) with a "keep live" escape hatch.
- **Cross-primitive format change** (text → integer, text → date, integer → number, etc.): this is a 🔴 hard blocker. The widget surfaces it AS a blocker, not as a choice — the only options are "add a 🔴 §7.1 blocker and let the user decide whether to migrate" or "cancel."

For same-primitive variation:

- **question**: `"`<entity>.<field>` is `<live_format>` in the live model; the spec wants `<spec_format>`. They're compatible. Which?"`
- **options**:
  1. `"Apply the spec's `<spec_format>` (Recommended)"` — `update_field` to switch format.
  2. `"Keep live `<live_format>`"` — spec aligns to live.

For cross-primitive change: surface as a 🔴 §7.1 blocker in the spec, no widget. User must fix the blueprint or plan a migration manually before re-running.

#### 3f.5 JsonLogic cascade (mandatory after any rename in 3f.1 or 3f.3)

When any 3f decision causes a field rename (3f.1 option 1: `<spec_field>` → `<live_field>`) or a permission rename (3f.3 option 1: `<spec_perm>` → `<live_perm>`), the analyst MUST **recursively walk every JsonLogic structure in the spec being drafted** and replace references to the renamed token. This is not optional; the modeler's verification will reject the spec on any unresolved reference, and the user's deploy will halt.

**JsonLogic surfaces to walk** (per entity):

- `computed_fields[].logic` — every entry on every entity (including cross-entity computed fields whose logic references the renamed entity/field)
- `validation_rules[].logic` — same
- `input_type_rules[].logic` — same
- `select_rule.logic` — same (one per entity)
- Same surfaces on `users` and other built-ins when the spec has `**Additive fields**` blocks for them.

**Walk algorithm** (recursive; reference implementation in pseudocode — implement in whatever Bun/TS the analyst uses for spec assembly):

```
function rename_in_jsonlogic(node, renames):
  # renames is { "<old_token>": "<new_token>", ... }
  # tokens are either bare field names ("workflow_state") or qualified ("entity.field")
  if node is null or scalar:
    return node
  if node is an array:
    return [rename_in_jsonlogic(item, renames) for item in node]
  if node is an object:
    for each key, value in node:
      if key == "var" and value is a string:
        # Handle both bare and dotted forms. JsonLogic "var" can carry "field" or "entity.field".
        if value in renames:
          node[key] = renames[value]
        elif "." in value:
          parts = value.split(".", 1)
          if parts[1] in renames:
            node[key] = parts[0] + "." + renames[parts[1]]
          elif (parts[0] + "." + parts[1]) in renames:
            node[key] = renames[parts[0] + "." + parts[1]]
      else:
        node[key] = rename_in_jsonlogic(value, renames)
    return node
```

**Where the renames apply** (cascade scope):

| Rename kind | Apply across |
|---|---|
| Field rename on entity E | Every JsonLogic on E. Also every JsonLogic on any OTHER entity that references `E.<old_field>` (the dotted form). |
| Permission code rename | Every JsonLogic across all entities (permission codes are global). Also every §8.1 Permissions catalog row, §3 `Edit permission:` annotation, §7 lifecycle states' `requires_permission?` column, §8 hierarchy rows. |
| Enum value rename (3f.2 option 1 won't trigger this; option 2's migration table might) | Every JsonLogic that compares against the renamed enum literal (`{"==": [{"var": "field"}, "<old_value>"]}` patterns). Also the field's `enum_values` and `default`. |

**Post-cascade verification** (catches incomplete walks, runs as part of Stage 11):

For every renamed `<old_token>`, grep the entire assembled spec text for `"<old_token>"` (with quotes). Any remaining match is a 🔴 blocker: *"Stage 3f.1 rename `<old_token>` → `<new_token>` did not fully cascade. Remaining references found at: [list of line numbers]. Re-run the cascade."*

**For 3f.3 option 3** (pin to both — adds hierarchy row, no actual rename): no cascade needed.

**For 3f.2 option 2 / option 3** (enum changes): walk JsonLogic for literal value comparisons against the changed enum values, plus update each entity's `enum_values` and `default` lists.

#### 3f.6 Generic per-property drift (every scalar property NOT covered by 3f.1–3f.4)

**Policy path:** `.drift.property.<entity>.<field|entity>.<property>`.

**This is the catch-all that guarantees EVERY property is validated, not just the specialized five.** Fires when any captured property outside 3f.1–3f.4 differs between live and intended. Covers, at minimum: `description`, `title`, `default_value`, `precision`, `scale`, `unique_value`, `reference_delete_mode`, `view_permission`, `label_column`, `label_parent`, `order_column`, `id_column`, `edit_mode`, `cube_mode`, `icon_url`, `width`, `searchable` — entity- or field-level as applicable. Grade each divergence by risk, then resolve; **nothing is auto-applied silently — every drifted property is shown and decided.**

- **Cosmetic / zero-data-risk** (`description`, `title`, `width`, `searchable`, `order_column`, `id_column`, `label_column`, `icon_url`, `edit_mode`, `cube_mode`, `unique_value` true→false, `precision`/`scale` INCREASE, `default_value` on a field with **no** live records): batch ALL of these for the entity into ONE consolidated review widget (multiSelect) so the user isn't clicking through dozens, while still seeing the full set. Each row: `"<Entity>.<field>.<property>: live=<L> / spec=<S>"`. Pre-checked = adopt the live value into the spec (the safe align-to-live default); unchecked = keep the spec value (written to prod on deploy).
- **Value-change with a consequence** (`default_value` change on a field WITH live records, `unique_value` false→true with no live duplicates, `view_permission` tier change, `reference_delete_mode` change): one keep-live / apply-spec widget PER property (same 3-option shape as 3f.3), spelling out the consequence (new records get a different default; a read-visibility change; a delete-cascade change).
- **Potentially destructive** (`precision`/`scale` REDUCTION where live values exceed the new precision, `unique_value` false→true where live duplicates exist): 🔴 §7.1 blocker, no silent apply — same posture as the cross-primitive format blocker in 3f.4. Document the required data reconciliation.

**Internal mapping:** adopt-live → the spec property aligns to the live value; keep-spec → the spec retains its value and the modeler's plan carries the `update_*` (or a §7.1 blocker for the destructive tier). Every resolved property is recorded so the Stage 11 completeness gate passes.

#### 3f.7 Rule-block drift (JsonLogic: `select_rule`, `computed_fields`, `validation_rules`, `input_type_rule`)

**Policy path:** `.drift.rule.<entity>.<rule_key>`.

**Fires when** a JsonLogic block differs between live and intended, matched by its natural key:
- `select_rule` — one per entity; compare the whole logic object + its `description`.
- `computed_fields[]` — matched by `.name`; compare `.logic` + `.title` / `.description`.
- `validation_rules[]` — matched by `.code`; compare `.logic` + `.message` / `.description`.
- `input_type_rule` — one per field; compare the logic object.

A rule present on ONLY one side (live carries one the spec dropped, or the spec adds one live lacks) is also drift.

- **question**: `"`<Entity>` has a <rule kind> that differs between your live model and the spec. Live: `<short gloss of live logic>`. Spec: `<short gloss of spec logic>`. Which should win?"`
- **header**: `"Rule drift"`  **multiSelect**: `false`
- **options** (3 + Cancel):
  1. label: `"Keep the live rule (update the spec) (Recommended)"` — the spec's rule block aligns to live verbatim.
  2. label: `"Keep the spec rule (apply it to prod on deploy)"` — the spec retains its rule; the modeler writes it. **Callout**: a `select_rule` or `validation_rule` change alters read visibility or write gating — name the effect (mirrors the modeler's read-visibility callout).
  3. label: `"Keep both"` — only offered for `computed_fields` / `validation_rules` when the two entries have distinct `name` / `code`; both survive.
  4. label: `"Cancel"`.

**Internal mapping:** option 1 → spec rule = live; option 2 → spec rule kept, modeler applies; option 3 → union (distinct keys only); option 4 → halt. If keeping either side indirectly references a field or permission that a 3f.1 / 3f.3 decision renamed, run the 3f.5 JsonLogic cascade afterward.

---

**Completeness mandate (the guarantee behind this whole stage).** 3f.1–3f.5 handle the properties with special consequences; **3f.6 and 3f.7 are the catch-alls that make coverage total.** Every property the 2h index captured is compared, and every divergence lands in exactly one of 3f.1–3f.7 (or a §7.1 blocker). "I only checked the obvious ones" is the bug this stage exists to prevent — the Stage 11 pre-save gate fails the save if any drift the 2h scan surfaced was left without a decision.
