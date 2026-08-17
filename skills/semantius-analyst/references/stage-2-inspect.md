# Stage 2: Inspect the live catalog

*Reference for `semantius-analyst` (Stage 2). Loaded on demand.*

## Stage 2: Inspect the live catalog

**Read before writing, always.** (use-semantius Golden Rule #1)

Four sub-steps in order: (2a) resolve the module, (2b) inspect built-ins, (2c) load the full catalog, (2d) classify every blueprint entity.

### 2a. Resolve the module

Look up the module by `system_slug`:

```bash
semantius call crud read_module --single '{"filters": "module_slug=eq.<system_slug>"}'
```

- **Exit 0 (exists)**: capture the `id` **and the `version` / `version_date`** (used by the 2a.1 drift gate below), treat as re-reconcile. The spec will write `update_module` to refresh name / description if they drifted; entities below diff against live.
- **Exit 1 (missing)**: plan a `create_module` with `module_name = <system_name>`, `module_slug = <system_slug>`, `description = <tagline>`, `icon_name = <icon_name>`, `domain_code = <domain_code>`, `module_type = "domain"`.
- **Exit 2 (duplicate)**: hard catalog bug — surface and stop.

> **Module schema note.** Modules carry `module_name` (display, e.g. `CRM`), `module_slug` (URL handle, e.g. `crm`), `description` (≤40-char selector chip, sourced from frontmatter `tagline`), `icon_name`, the top-level columns `domain_code` and `access_scope`, `module_type` (`"domain"` default), and the platform-maintained `version` (monotonic integer, bumped on any schema change to the module's owned entities / fields / enum values / permissions) + `version_date`. The §1 Overview prose does NOT go on the module record.

### 2a.1. Version-match gate: has prod drifted since the last deploy?

**Runs whenever 2a hit Exit 0 (the module already exists) AND the spec carries a `deployed_version`** in its front-matter (the modeler stamps `deployed_version` / `deployed_version_date` / `deployed_related_versions` at the end of a clean deploy — modeler Stage 5b). This is the O(1) drift gate that decides whether a deeper owned-entity reconcile is needed; it is the owned-entity analog of the adopted-entity safety net in 2h.

Compare the live `.version` captured in 2a against the spec's front-matter `deployed_version`:

- **Match** (`live.version == deployed_version`): nothing in this module has changed since the spec was last deployed. There is no prod-side drift on the owned entities — **skip the owned-entity deep inspection** and let Stage 3f stay silent for them. This is the whole point of the stamp: the common "nobody touched prod since deploy" case costs a single read.
- **Mismatch** (`live.version != deployed_version`): the module's schema changed in prod since the last deploy (edited via the UI or a direct `use-semantius` call the modeler did not make). The spec's owned entities may now be stale, and applying an edit blindly could propose reverting a prod change. **Deep-inspect the owned entities the same way 2h inspects adopted ones** — capturing the COMPLETE property set (every entity- and field-level column plus every JsonLogic block; see the 2h index), not a subset — but build the comparison index **against the spec's own current Fields blocks and rule blocks: the spec is the "intended" side here, standing in for the blueprint that 2h/3f normally compare against.** Then drive every divergence through Stage 3f: it fires **one widget per difference**, each offering *"keep the live value (update the spec to match prod)"* vs *"keep the spec value (migrate prod on deploy)"* vs both/cancel — exactly the per-delta choice. Surface it plainly before any field work: *"Your live model changed since this was last deployed; reconciling N differences before applying your edit."*
- **Spec has no `deployed_version`** (never deployed through a version-aware modeler, or an older spec): treat as **unknown** — fall back to existing behavior (no owned-entity short-circuit; adopted-entity 2h runs exactly as today). The gate never skips a needed check; it only *optimizes* the runs where it can prove nothing changed.

Also compare each entry in the spec's `deployed_related_versions` map against the live `version` of that source module (a `reuse-from` / `promote-to-master` owner). A mismatch there means an entity this spec REUSES — owned by another module — drifted; deep-inspect that reused entity via 2h and route through Stage 3f as usual.

**Graceful degradation.** If the live module row carries no `version` column (the platform predates it), skip the gate and fall back to full inspection. The gate is an optimization and an early-warning net, never a substitute for 2h's per-entity checks when drift is possible.

### 2b. Inspect Semantius built-ins

The blueprint may reference platform built-ins via §5.2: `users`, `roles`, `permissions`, `permission_hierarchy`, `role_permissions`, `user_roles`, `webhook_receivers`, `webhook_receiver_logs`, `modules`, `entities`, `fields`. **These tables control the platform. They must never be replaced.**

For each built-in:

- **Skip `create_entity`** in the spec plan. The spec writes a `**Reconciliation:** reuse-from semantius_builtin.<table>` annotation.
- **Reuse as `reference_table` target** for any FK pointing at it.
- **Additive fields only.** If the blueprint requests extra scalar fields on a built-in, the spec records them under that entity's `**Additive fields**` block — never replacing existing built-in fields. Use the existing built-in field names for concepts already covered (`users.display_name`, not `name`; `users.is_disabled`, not `is_active`).

### 2c. Load the full entity catalog

Ambiguity detection requires every entity in the instance:

```bash
semantius call crud read_entity '{}'
```

Build an index keyed by `table_name`, carrying `{module_id, module_name, module_slug, module_type, singular_label, plural_label, description, label_column}` **plus the provenance columns** `{catalog_entity_code, catalog_owner_module, entity_type, catalog_entity_aliases}`. These are returned by `read_entity` / `read_field` like any other column.

**The catalog provenance columns are the authoritative source for authoring intent.** Each authoring fact is a platform read on this index:

| Authoring fact | Read from |
|---|---|
| Is this live entity the catalog's X under a renamed table? | `catalog_entity_code` (the catalog code; equality-join across dialects / silos) |
| Is this an `embedded_master` placeholder awaiting a catalog owner (and which)? | `catalog_owner_module` (non-empty = the catalog-owner-arrival signal) |
| Did my domain's X get unified into this entity by a reuse/merge? | `catalog_entity_aliases` (JSON array, matched on the `(alias_code, source_domain)` pair) |

Test emptiness as `= ''` / `= '[]'::jsonb` / `= 'unclassified'`, **never `IS NULL`** (the columns are NOT NULL with empty defaults). An empty `catalog_entity_code` means "created outside the pipeline" (a genuine custom / pre-provenance entity) — that is the **only** case where the Stage 3 placement falls back to the workspace blueprint/spec scan.

### 2c.5. Apply customizations

**This sub-stage is what makes policy actually shape the spec.** Before classifying any blueprint entity (2d), load `$CUSTOMIZATIONS_FILE` if present and apply its standing rules to the blueprint's in-memory representation. If the file is absent, skip 2c.5 entirely.

Apply, in this order:

1. **`aliases`** — for every `{old_slug: {slug, singular_label, plural_label}}` entry, rewrite the matching blueprint entity's `table_name` / labels and rewire every §5.1 / §5.3 edge that targeted the old slug. The downstream 2d classification works against the rewritten blueprint, so an aliased entity is never asked about as "similar to" or "collides with" its prior name.

2. **`optionals_decided`** — for every blueprint entity with `necessity = optional`:
   - Verdict `excluded` → drop from the in-memory entity list. Stamp `**Reconciliation:** dropped (policy-excluded)` in the spec write. Never reaches 2d / 3a.
   - Verdict `included` → mark as auto-included so 3a's multiSelect skips it.
   - No entry → continue; 3a will fire as today.

3. **`collisions`** — for every `{entity: {outcome, host_module?, rename_to?, new_owner?}}` entry, note the override. Stage 3b sub-stages consult this map before firing widgets:
   - `outcome: share` → auto-resolve as `reuse-from <host_module>.<entity>` (or `promote-to-master` for the first-mover case). No widget fires.
   - `outcome: silo` → auto-resolve as `rename-incoming-from <existing_module>.<entity> as <rename_to>`. No widget fires.
   - `outcome: claim` → auto-resolve as transferring ownership to `<new_owner>`. No widget fires.

4. **`adoption_consent`** — read once; gates whether Stage 3b.0 fires a confirmation widget or auto-consents.

5. **`module_display_names`** — populate the display-name lookup used by every user-facing string in Stage 3 (`<Existing Module Display Name>` substitutions and similar).

6. **`shared_master_managers`**, **`slug_collision_naming`**, **`on_missing_owner`** — read into memory; consulted by the matching Stage 3 sub-widget before firing.

7. **`drift.*`**, **`links.*`** — read into memory; consulted by Stage 3e / 3f before firing.

One-line narration after applying: *"Applied N rules from your customizations: <plain English summary>."* (e.g. *"Applied 3 rules from your customizations: renamed suppliers to vendors, excluded locations, shared vendors via the Parties module."*). Do NOT enumerate paths or yq syntax in the narration; Convention 8 applies.

### 2d. Classify every blueprint entity

For each entity in the blueprint's §3 catalog, determine which bucket it falls into. **Buckets marked 🛑 are ambiguity gates** — the user must make an explicit decision in Stage 3.

| Bucket | Condition | Default annotation |
|---|---|---|
| 🔒 Built-in | `table_name` matches a Semantius built-in | `reuse-from semantius_builtin.<table>` |
| ♻️ Same-module match | Entity exists and its `module_id` equals our module's id | `create-new` (already covered; the spec will diff) |
| 🟢 Shared-master match (Branch A) | Entity exists, same `table_name`, owning module is `module_type = "master"` | `reuse-from <master_slug>.<table>` — auto-wire as consumer |
| 🛑 Cross-module exact (Branch B) | Same `table_name` in another `module_type = "domain"` module | Gatekeeper decision required (see Stage 3) |
| 🛑 Similar name | Live entity's `table_name` is *near* a blueprint entity's name (see 2e heuristic) | Gatekeeper decision required |
| 🟡 Optional | Blueprint §3 `necessity = optional` | User confirms in Stage 3 multiSelect |
| ✨ New | No match of any kind | `create-new` |

### 2e. Similarity heuristic: when to flag

Flag any pair where:

- One name is a prefix or suffix of the other: `contracts` ↔ `saas_contracts`, `orders` ↔ `sales_orders`.
- They share a singular root or lemma: `contract` ↔ `contracts`, `vendor` ↔ `vendors`.
- They differ only by a domain qualifier: `vendor_contracts` ↔ `saas_contracts`.
- They are obvious synonyms: `customers` ↔ `clients`, `employees` ↔ `staff`, `products` ↔ `items`.
- Edit distance is small and the tokens look related.

If you're uncertain whether two names refer to the same concept, **flag it**. A false positive costs the user one click; a missed collision pollutes the catalog permanently.

### 2f. Build comparison blocks for every 🛑

For every flagged pair, pull the existing entity's fields:

```bash
semantius call crud read_field '{"filters": "table_name=eq.<existing_table_name>"}'
```

Note for each: owning module, singular/plural labels, description, label_column, field names + formats + required-ness, conceptual overlap, format conflicts on conceptually-same fields. This comparison goes into the Stage 3 widget so the user decides on informed grounds.

### 2g. Resolve §5.3 cross-scope edges + §6 cross-model links against the live catalog

For every row in blueprint §5.3a (outbound from this scope's masters / contributors) and every implied FK from §6.2 / §6.3 handoffs:

- **Exact match** (one entity has `table_name == <target>`): mark ✨ **Proposed**. Auto-generate FK column name as `<target_singular>_id`. If that name already exists on `from_table`, mark 🛑 **Field-name collision**.
- **No match**: mark 💤 **Dormant**. Skip in the plan; record in the verification summary.
- **Multiple plausible matches** (exact + near-name candidates): mark 🟡 **Ambiguous**. Stage 3 asks the user.
- **Unresolved source**: if `from_table` is neither in this blueprint's §3 nor in the catalog, mark 🛑 (route back to architect to fix the blueprint).

**Presence-conditional resolution for §5.3b context edges:**

§5.3b carries the catalog owner's view of edges that touch this scope's embedded shells / consumed entities. The `delete_mode` column drives resolution:

- `none` — fully optional; never emit a FK column. Verification summary records as 💤 dormant.
- `none (required-if-present)` — **presence-conditional**: check the target entity in the live catalog. Target present → mark ✨ Proposed (mandatory FK at deploy time, `delete_mode = restrict` by default unless §5 names a different mode). Target absent → mark 💤 dormant (no column, no constraint). **No thinned-entity stubs** — if the target isn't there, the edge is simply not realized.
- `⚠ audit: <reason>` — the catalog owner declared a required composed child whose target sits outside the installable closure. Mark 🛑 **soft data-quality flag**: surface verbatim in the spec's §7.2 with the architect's reason text; do NOT auto-resolve. The user is expected to fix the source data upstream.

For §6.2 / §6.3 handoff rows with `event_category = lifecycle`, validate that `to_state` exists in the source entity's §7 lifecycle table. Mismatch → 🛑 (the architect should have caught it via pre-save verification; if it reached the analyst the blueprint is corrupt).

For §6.2 / §6.3 handoff rows whose source entity is `embedded_master` and whose catalog owner module is absent in the live catalog: this is a **boundary-crossing handoff** (per Writing Convention 10 on the architect). Carry the row into the spec verbatim; the deployer's Stage 4m wires the handoff using the entity's current owning module as the source.

Build a `link_proposals` list for Stage 3.

**FK shape consumption:** §5.1 / §5.2 / §5.3a carry `delete_mode` and `fk_format` per row. The analyst **consumes verbatim** — do NOT re-derive at spec-write time. If the live catalog's field for the resolved edge has a different `format` or `reference_delete_mode`, flag as drift in Stage 3f.4. Cross-primitive `fk_format` flip (`parent ↔ reference`) is a 🔴 blocker (same posture as cross-primitive format drift).

### 2h. Deep-inspect adopted entities (for 3b.0 / 3b.1 / 3b.2 paths)

**This sub-stage is the analyst's safety net against modeler-time drift halts.** Whenever the placement table or sub-stage decisions in 3a-3e mark an entity as `promote-to-master`, `rename-incoming-from`, or `reuse-from <module>.<entity>` for a non-built-in target, the analyst MUST load the live entity's full field set and build a per-field comparison index against the blueprint's intent. The modeler refuses to deploy on field-name renames, enum-value drops with live records, format changes across primitives, and permission tier flips; the analyst catches these here and either resolves them via Stage 3f widgets or surfaces them as 🔴 blockers in §7.1.

**Required reads (per adopted entity):**

```bash
# Existing entity record
semantius call crud read_entity --single '{"filters": "table_name=eq.<entity>"}'

# Existing field set, with full format / enum_values / required / etc.
semantius call crud read_field '{"filters": "table_name=eq.<entity>"}'

# Existing permission tier for the entity's edit_permission column
semantius call crud read_permission --single '{"filters": "id=eq.<entity.edit_permission_id>"}'

# Live record count + sample of distinct values per enum field (to catch "drop value that's in use" drift)
# For each enum field on the entity:
semantius call cube query '{"measures": ["<entity>.count"], "dimensions": ["<entity>.<enum_field>"]}'
```

**Build per-adopted-entity index — capture the COMPLETE comparable property set, not a subset.** Every column `read_entity` / `read_field` returns is a drift axis EXCEPT the platform-managed / auto columns the analyst never authors (`id`, `created_at`, `updated_at`, `field_order`, `ctype` / `is_core`, `module_id`). A divergence on ANY captured property is drift the user must resolve in Stage 3f. Shape (used by Stage 3f and Stage 11 verification):

```
adopted_entity_index[<entity_slug>] = {
  live_module_slug, live_module_name,
  // entity-level properties — every one is a drift axis:
  entity: {
    description, singular_label, plural_label,
    label_column, label_parent, order_column, id_column,
    view_permission, edit_permission, edit_mode, cube_mode, icon_url,
    select_rule,                       // JsonLogic object (whole)
    computed_fields,                   // JsonLogic array, keyed by .name
    validation_rules,                  // JsonLogic array, keyed by .code
  },
  fields: {
    <field_name>: {
      // EVERY field column is a drift axis:
      format, input_type (required), unique_value,
      default_value, enum_values,
      precision, scale,                          // numeric precision / scale
      description, title,
      reference_table, reference_delete_mode,    // FK shape
      width, searchable,                         // v5.4 UI columns
      input_type_rule,                           // JsonLogic object
      // live-usage signals, to grade risk (not compared, used to classify):
      live_records_using_field, live_distinct_enum_values_in_use,
    },
    ...
  },
}
```

The index is the truth-source for Stage 3f drift detection. **Compare EVERY captured property (entity-level and field-level) live-vs-intended by name — the categories below are exhaustive, not illustrative. No property is exempt from the scan.** The first five categories have specialized handling (rename migration, live-record data risk, JsonLogic cascade); **every remaining scalar property falls to the generic resolver 3f.6, and every JsonLogic block to the rule-block resolver 3f.7** — so `description`, `default_value`, `precision`/`scale`, `title`, `unique_value`, `reference_delete_mode`, `view_permission`, the UI columns, and every `select_rule` / `computed_fields` / `validation_rules` / `input_type_rule` are validated, never silently kept. Compare:

- **Field-name drift candidate**: the spec declares `<spec_field>` that doesn't exist live, AND there exists a live field with similar semantic role (same format family, same general purpose). Common case: the lifecycle state field — the spec always names it `workflow_state` (fixed; see Stage 4), but a legacy live entity may hold the same state under `status` / `state` / `lifecycle_state`. Both are conceptually "where in the lifecycle this record is." Flag as a 🛑 for Stage 3f resolution; because the deployer requires the canonical `workflow_state` name, that resolution is a rename/migration to `workflow_state`, not "keep the live name" (see 3f.1).
- **Enum-value drift**: a live field's `enum_values` and the blueprint's `enum_values` differ in either direction (live has values the blueprint doesn't, or blueprint introduces values that re-classify live values). When `live_distinct_enum_values_in_use` includes any value the blueprint *drops*, this is high-risk drift. Flag for Stage 3f.
- **Format drift**: blueprint declares a different `format` than live (e.g., live `text`, blueprint `string`). Cross-primitive changes (text → integer, text → date) are 🔴 blockers; same-primitive variations (text ↔ string ↔ multiline, integer ↔ int32 ↔ int64) are 🟡 warnings the modeler can auto-resolve.
- **Required-ness drift**: blueprint requires a field the live entity has as optional, or vice versa. Often safe; flag for Stage 3f when the change would leave live records violating the new constraint.
- **Permission-tier drift**: blueprint's intended `edit_permission` differs from live `edit_permission`. Tier downgrades (admin → manage) need explicit confirmation; tier upgrades (manage → admin) are usually safe but still surfaced. The blueprint's intended tier is consumed from the §3 `write tier` column verbatim; the analyst does not re-derive it via its own Stage 9 classification (Stage 9 is validation-only).
- **Any-other-scalar-property drift (the catch-all — this is what makes the scan exhaustive)**: the live value differs from the intended value on ANY remaining property not covered above — `description`, `title`, `default_value`, `precision`, `scale`, `unique_value`, `reference_delete_mode`, `view_permission`, `label_column`, `label_parent`, `order_column`, `id_column`, `edit_mode`, `cube_mode`, `icon_url`, `width`, `searchable` (entity- or field-level as applicable). Route every one to **Stage 3f.6**. None is auto-kept.
- **Rule-block drift**: a JsonLogic block differs, matched by natural key — `select_rule` (per entity), `computed_fields[]` (by `.name`), `validation_rules[]` (by `.code`), `input_type_rule` (per field). A body / message / `title` / `description` difference, OR a rule present on only one side, is drift. Route to **Stage 3f.7**.

Any drift found here drives Stage 3f. No drift = Stage 3f is silent. **Completeness is mandatory:** every property in the index is compared, and every divergence gets a 3f decision or a §7.1 blocker — the Stage 11 pre-save gate ("adopted-entity drift resolution complete") fails the save if any detected drift is left unresolved.
