# Stage 11: Write the spec file

*Reference for `semantius-analyst` (Stage 11). The pre-save verification table is resident in SKILL.md.*

## Stage 11: Write the spec file

Write the spec file at **`semantius/specs/<system_slug>-semantic-spec.md`** in the workspace. Create the folder on demand if it doesn't exist:

```bash
mkdir -p semantius/specs
# then write the file at semantius/specs/<system_slug>-semantic-spec.md
```

Do **not** write the spec at the workspace root. The committed-artifact convention is `semantius/blueprints/` for blueprints and `semantius/specs/` for specs, so that customers can commit one folder and have all their semantic artifacts travel with their repo. If a spec already exists at the workspace root, do not move it automatically; the user can rm or `git mv` it themselves.

### Frontmatter

```yaml
---
artifact: semantic-spec
version: "5.3"
blueprint_version: "3.0"
system_name: <from blueprint>
system_slug: <from blueprint>
domain_modules:
  - <system_slug>
domain_code: <from blueprint>
related_modules: [<from blueprint>]  # advisory only
persona: [<from blueprint>]  # carry forward (OMIT under access_scope: basic)
license: <from blueprint>  # carry forward
module_kind: <from blueprint>  # informational
access_scope: <resolved by the analyst after Stage 2>  # basic | full — OMIT only on a non-interactive run that couldn't resolve it
tagline: <from blueprint>  # ≤40-char selector chip → modules.description
icon_name: <from blueprint>  # → modules.icon_name
description: <from blueprint>  # carry forward (YAML literal block)
created_at: <blueprint's created_at>
reconciled_at: <YYYY-MM-DD today>
reconciled_against_catalog_snapshot: <ISO 8601 timestamp of the catalog read in Stage 2>
source_blueprint: <relative path to blueprint .md>
promotion_decisions:
  - entity: <table_name>
    host_module: <master_slug>
    manage_option: 1 | 2 | 3 | 4
---
```

### Spec sections (mirroring `./semantic-spec-template.md`)

Use the existing spec template at `./semantic-spec-template.md` for the section structure (§1-§9). The only deltas the analyst contributes on top of that template:

1. **Every §3 entity sub-section carries a `**Reconciliation:**` line** with one of:
   - `create-new` (default — omit the line)
   - `reuse-from <module_slug>.<entity_table_name>` — no Fields block follows
   - `rename-incoming-from <existing_module>.<existing_entity> as <new_name>` — full Fields block under the new name
   - `promote-to-master <master_module_slug>.<entity_table_name>` — full Fields block; entity creates in the master module
   - `dropped (optional, user declined)` — no further content

2. **Every §3 entity flagged `reuse-from` with additive fields** carries an `**Additive fields**` table (same columns as the regular Fields table). The deployer adds these fields to the existing entity without touching existing fields.

3. **§6 Cross-model link suggestions table** has an extra column `Reconciliation` with values `proposed` / `dormant` / `ambiguous-resolved` / `skipped`. Resolved rows carry the FK column name and the resolved target.

4. **§8.1 workflow gates / row-scope overrides for `embedded_master` entities whose catalog owner is absent** carry a `**Reconciliation:** re-prefixed-from <catalog-module>.<verb>` annotation. The deployer's Stage 4n reads this annotation to identify reconciliation-eligible permissions when the catalog owner later installs.

5. **§9 governance is carry-forward.** The blueprint's §9.1 (baseline roles + permission hierarchy + RACI realization) and §9.2 (functional ownership) appear verbatim in the spec, with one transform: role slugs are normalized `-`→`_` per Stage 9.5 Step 1 (since `roles.slug` forbids the hyphens `module_slug` allows). Stage 9.5 reconciles each row against the live catalog and emits drift annotations (`✨ persona role to be created`, `✨ persona grant to be added`, `🟡 role drift on module_id`, etc.) per row.

6. **§6.2 / §6.3 handoff tables carry the `transition` column** with `<to_state> _(<event_category>)_`. The source_module column follows the entity-owning-module rule: when the source entity is an `embedded_master` whose catalog owner is absent, the source_module is the installing unit; otherwise it's the catalog owner.

7. **Empty canonical sections carry the canonical placeholder, never an omitted heading or a bare string.** Every canonical top-level / numbered spec section is **always present**. When §4 Relationship summary, §5 Enumerations, §6 Cross-model link suggestions, §7.1 🔴 Decisions needed, or §7.2 🟡 Future considerations has no rows, **keep the heading and write the canonical empty-section placeholder `_(none: <short reason>)_`** (lowercase `none`, colon not em-dash; bare `_(none)_` allowed) — matching `./semantic-spec-template.md`. Do **not** emit the bare strings `None.` / `No enumerations defined.` / `No cross-model link suggestions.`, do not omit the section, and do not leave a bare empty heading. The §7.1 deploy gate keys on unresolved 🔴 *items*, not on any literal placeholder string, so the `_(none: …)_` form is safe. **Sole exception:** the §3 per-entity sub-blocks (Computed fields / Validation rules / Input type rules / Select rule) **stay omit-when-empty** — they carry no placeholder.

8. **Every §3 entity sub-section carries the provenance carriers the modeler stamps.** Two lines per OWNED entity (every `create-new`, `rename-incoming-from`, `promote-to-master` — i.e. every entity the deployer provisions), plus a `**Catalog owner:**` line for placeholder masters, carried through from the blueprint §3:
   - **`**Catalog entity code:** `<catalog_code>``** — the catalog uber-model code from the blueprint's §3 `catalog code` column (defaults to the entity's `table_name` for agent-optimized naming). The deployer stamps it into `entities.catalog_entity_code` (the **catalog** code, NOT the deployed `table_name`), write-once.
   - **`**Entity type:** <entity_type>`** — the closed 6-way class from the blueprint's §3 `entity_type` column (`operational_workflow` / `operational_record` / `catalog` / `junction` / `computed`). The deployer stamps it into `entities.entity_type`. When the blueprint left it absent (pre-3.0 fallback), write `unclassified` and the deployer treats it as derive-locally — do not invent a value outside the closed set.
   - **`**Catalog owner:** <owner_module_slug>`** (placeholder masters only) — for an `embedded_master` entity that lands locally as a placeholder because its catalog owner module is not deployed (a first-mover `create-new`, or a silo `rename-incoming-from`), the blueprint's `mastered_in` slug. The deployer stamps it into `entities.catalog_owner_module`, so the catalog-owner-arrival signal is a platform read instead of a file scan. Omit the line when this module owns the entity (`role = master`), when the entity is local/custom, and on `reuse-from` / `promote-to-master` (the owner is already present, or the entity moves into it).

   A **`reuse-from` / built-in** entity is referenced, not provisioned, so it carries neither line (the existing entity already holds its own stamped provenance; the deployer does not restamp it).

   On a **reuse/merge reconciliation that renames an incoming entity onto an existing host** (the analyst chose `reuse-from <host>` for a blueprint entity whose own catalog code differs from the host's — the cross-domain merge case), the spec records the alias mapping on the **host** entity's sub-section so the deployer can APPEND it to `catalog_entity_aliases`:
   - **`**Catalog alias:** {alias_code: <incoming_catalog_code>, source_domain: <incoming_domain_code>, source_module: <incoming_system_slug>}`** — one line per absorbed identity (repeat the line if a host absorbs several). `alias_code` is the **incoming** blueprint entity's catalog code (what *this* domain called the concept); `source_domain` is this blueprint's `domain_code`; `source_module` is its `system_slug`. The deployer APPENDS this element to the host's `catalog_entity_aliases` array — it never rewrites or drops prior elements. Omit the line entirely when no merge renamed an incoming entity onto a host (the common case).

9. **Every §3 owned entity that has an identity spine carries a `**Label parent:**` line.** Names the one FK that is the entity's identity spine (derived in Stage 4 via the label_parent decision rule). The deployer stamps it into `entities.label_parent`; re-pointing it changes the composed `_label` with no data migration. **Omit the line** for `junction` entities (the platform auto-combines their parent legs), self-identifying entities (intrinsic `label_column`), and `reuse-from` / built-in entities (referenced, not provisioned). The modeler parses and stamps it.

*(The pre-save verification gates run at this point; they are resident in SKILL.md under "Verification gates", not repeated here.)*

After a successful save, narrate the close-out. Its shape (admin-orchestrated vs stand-alone wording, the plain-English translation table, and the bans on raw summary dumps and skill-name mentions) is the resident **Closing message** section in SKILL.md, which also covers the Audit and Rebuild close-outs. Follow it.
