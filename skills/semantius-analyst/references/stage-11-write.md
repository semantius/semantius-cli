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
version: "5.4"
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
logo_color: <hex>  # v5.4+; OPTIONAL → modules.logo_color. Placed after naming_mode: in the template. Emit only when set; omit the key entirely when unset (the modeler random-fills only when ABSENT).
home_page: <path>  # v5.4+; OPTIONAL → modules.home_page. Emit only when set (non-empty/non-null); omit the key entirely otherwise.
created_at: <blueprint's created_at>
reconciled_at: <YYYY-MM-DD today>
reconciled_against_catalog_snapshot: <ISO 8601 timestamp of the catalog read in Stage 2>
source_blueprint: <relative path to blueprint .md>
# deploy provenance (v5.4+) — MODELER-owned (Stage 5b); analyst carries forward VERBATIM, never computes; all omitted until first deploy
deployed_version: <carried forward from the spec being edited, else omit>
deployed_version_date: <carried forward, else omit>
deployed_related_versions: <carried forward, else omit>
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

   **Entity descriptions are carry-forward, not re-authored.** Copy each entity's blueprint §2 `Description` **verbatim** into that entity's §3 `**Description:**` line — byte-for-byte, the same discipline as §9 governance and the §9.1 Processes catalog descriptions. Do NOT paraphrase, expand, shorten, singularize, or add a "when created" clause the blueprint lacks: the blueprint's `Description` is the single authoritative text and the modeler deploys it to `entities.description`. Then set the §2 `Purpose` cell to the **first sentence** of that §3 Description (a mechanical truncation). This keeps one wording end-to-end (blueprint → §3 → `entities.description`, with §2 a truncation) instead of three drifting variants. If a blueprint `Description` is a bare field-list rather than a product-facing sentence, that is an architect-side gap — flag it as a §7.2 note, do not silently rewrite it here.

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

10. **Optional v5.4 entity property lines (round-trip carriers; the analyst rarely authors them, `semantius-optimizer` emits them from live state).** Five new OPTIONAL `**Xxx:**` lines may appear in an entity block, each with an omit-when-default rule — so a hand-authored spec normally omits all five and lets the platform defaults stand. Positions and rules match `./semantic-spec-template.md` exactly:
   - **`**Order column:** `<field_name>``** — after `**Label column:**`. Backticked `field_name`. Omit when empty/null. → `entities.order_column`.
   - **`**Id column:** `<field_name>``** — after `**Order column:**`. Backticked `field_name`. Omit when `id` (the platform default) or empty. → `entities.id_column`.
   - **`**Edit mode:** <edit_mode>`** — after `**Edit permission:**`. Bare enum value, NO backticks. Omit when the platform default (`auto`). → `entities.edit_mode`.
   - **`**Cube mode:** <cube_mode>`** — after `**Edit mode:**`. Bare enum value, NO backticks. Omit when the platform default. → `entities.cube_mode`.
   - **`**Icon URL:** <icon_url>`** — after `**Cube mode:**`, before `**Catalog entity code:**`. Plain URL value, NO backticks. Omit when empty/null. → `entities.icon_url`.

   A `reuse-from` / built-in entity carries none of these (referenced, not provisioned). The modeler parses and stamps each when present, and does not fail when they are absent (older 5.3 specs omit them all).

11. **Deploy-provenance keys are carried forward, never computed (v5.4+).** `deployed_version`, `deployed_version_date`, and `deployed_related_versions` are written **only by the modeler** at the end of a clean deploy (Stage 5b), recording the live `modules.version` the deploy produced. The analyst NEVER computes or refreshes them — it copies them verbatim from the spec it read and re-emits them unchanged. A fresh Reconcile from a blueprint has none (nothing deployed yet), so omit all three. An Extend / Rebuild / re-Reconcile of a spec that was previously deployed carries them through as-is. They intentionally describe the **last deploy**, so they stay stable across analyst edits and are refreshed only when the modeler next deploys — that stability is what lets the 2a.1 gate compare live `modules.version` against `deployed_version` to detect prod drift. Omit any key the source spec did not carry.

### Order §3 entities canonically (§2 inherits it)

Before generating §2, put the §3 entities (and the `entities:` frontmatter list) in the **canonical order** (`entity_type` tier, then `table_name` A->Z within each tier). Tiers: (1) `catalog`, (2) `operational_record` / `operational_workflow` / `computed` / `unclassified`, (3) `junction`, then (4) reuse-from built-ins (`users`, …) last (the spec template's §2 "Entity order (canonical)" note). Because §2 is derived from §3 below, ordering §3 fixes §2, §4, and §5 too. This is the same order `semantius-optimizer` reproduces from live state, so a forward-authored spec and a reverse-engineered one match.

### Generate §2, never hand-author it

**Write §3 and §4 first, then derive §2 from them mechanically. Do not compose the mermaid diagram by hand.** §3's per-field `relationship_label` and §4's `From`/`Field`/`To`/`Cardinality`/`Kind` are already fully resolved by the time §2 is written — freely re-authoring an arrow direction and verb from that same data a second time is pure duplicated, error-prone work, and it is exactly how a spec ends up self-contradictory (§3 declares `relationship_label: "owns"` while the hand-drawn §2 edge says `"owned by"` and points the wrong way — a real failure this guards against, not a hypothetical one).

**Hard procedural gate (not just guidance): the first `Write` of the spec file must NOT contain a hand-typed mermaid block.** It is not enough to state the rule in prose and trust it will be followed — an agent under time pressure will draft the whole file (including a plausible-looking §2) in one `Write` call and only discover the drift when the consistency gate fails, which is strictly worse: the diagram is already wrong once, a hand-edit is needed to patch it, and that hand-edit is itself another hand-authored diagram, repeating the exact mistake. Follow this sequence instead, every time, no exceptions:

1. `Write` the full spec file with every section EXCEPT the mermaid block populated. Leave the `### Entity-relationship diagram` heading in place with a literal placeholder body (e.g. a single line `<!-- generated below, do not hand-author -->` inside the ` ```mermaid ` fence) — never a guessed diagram, not even a "close enough" draft.
2. Run the generator (below) against that file.
3. `Edit` the placeholder block, replacing it with the generator's exact output, byte-for-byte. Do not retype it, reformat it, add node text the generator didn't emit, or otherwise touch what it printed.
4. Only then run the mandatory consistency gate (no `--emit-mermaid`) as the pre-save check.

If you find yourself about to type `-->` or `|verb|` directly into a `Write` or `Edit` call for §2, stop — that is the bug this gate exists to prevent, not an efficient shortcut.

Once §3 and §4 are written, generate the block and paste its output as §2 verbatim:

```bash
bun ".claude/skills/semantius-architect/references/consistency-check.ts" --emit-mermaid "semantius/specs/<slug>-semantic-spec.md"
```

This reads the file's own §3/§4 and prints a ready-to-paste ` ```mermaid ` block: arrow direction from `Cardinality` (`N:1` → the `To` side is the parent, arrow runs `To --> From`; `1:N` → arrow runs `From --> To`; `1:1` → flat `---`), verb from §3's `relationship_label` for that field (a `parent`-kind row — a junction FK — is always a bare arrow with no verb, per the junction convention, even though §3 may declare a `relationship_label` for that field), `builtin`/`master` classDef lines from entity role, and a bare node line for any entity with no edges. Re-run it whenever §3 or §4 changes after the fact (an added field, a renamed verb, a cardinality fix) — never hand-patch §2 to keep it in sync.

The mandatory consistency gate (`consistency-check.ts`, no `--emit-mermaid` flag, run per SKILL.md "Verification gates") then re-derives the same diagram internally and diffs it against what's actually in §2, so a hand-edit that drifts back out of sync fails the gate rather than shipping silently.

*(The pre-save verification gates run at this point; they are resident in SKILL.md under "Verification gates", not repeated here.)*

After a successful save, narrate the close-out. Its shape (admin-orchestrated vs stand-alone wording, the plain-English translation table, and the bans on raw summary dumps and skill-name mentions) is the resident **Closing message** section in SKILL.md, which also covers the Audit and Rebuild close-outs. Follow it.
