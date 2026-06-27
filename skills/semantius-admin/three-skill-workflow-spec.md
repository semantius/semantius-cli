# Semantius Three-Skill Workflow — Architecture Spec

This is the contract between three Claude skills that turn a domain idea into a deployed Semantius module:

```
semantius-architect  →  semantius-analyst  →  semantius-modeler
   (blueprint)            (spec)              (live catalog)
```

Each skill produces one artifact for the next. Each artifact has a frozen shape and an explicit version stamp. The whole pipeline is **rerunnable at any stage** — if the catalog drifts or the user changes their mind, you go back to the previous skill and regenerate.

**Use this spec when:**

- You're debugging a problem somewhere in the pipeline and need to know which skill owns which decision.
- You're writing a new test or audit harness against one of the artifacts.
- You're explaining the workflow to an agent that hasn't loaded any of the skills.
- You're considering a change to one of the skills and need to check the cross-skill contracts.

---

## 1. Goals and non-goals

**Goals:**

1. Produce a single deterministic deploy from a domain idea, with all interactive decisions captured in artifact files (not in agent memory).
2. Allow ~100 curated blueprints to be cloned and customized as starting points.
3. Detect and resolve catalog ambiguity (cross-module collisions, similar names, shared-master candidates) **before** any writes hit Semantius.
4. Make the pipeline **resumable** — a user can iterate on the blueprint, regenerate the spec, redeploy, all without losing context.
5. Eliminate the "non-deterministic naming" drift that plagued the old two-skill flow: blueprints define stable names at design time; the analyst harmonizes them against live names at reconciliation time; the modeler executes without re-deciding.

**Non-goals:**

- UI layouts, API endpoints, analytics dashboards, workflow engines beyond lifecycle states + permissions. (Out of scope; handled by other skills.)
- Auto-cleanup of stale catalog entries. Nothing in this pipeline deletes anything from Semantius. Ever.
- Automatic catalog discovery. The user provides the blueprint catalog source explicitly.

---

## 2. Artifacts

Two artifact types travel between the three skills.

### 2.1 Blueprint (`*-semantic-blueprint.md`)

**Produced by:** `semantius-architect`
**Consumed by:** `semantius-analyst`
**Format version key:** `blueprint_version` (currently `"2.0"`)
**Architect skill stamp:** `version: "<architect CURRENT_VERSION>"` (currently `"4.0"`)

**Reference example:** `ats-candidate-crm-semantic-blueprint.md`
**Template:** `.claude/skills/semantius-architect/references/semantic-blueprint-template.md`

**Sections (fixed order, fixed columns):**

| Section | Purpose |
|---|---|
| frontmatter | YAML block with `artifact`, `blueprint_version`, `system_name`, `system_slug`, `icon_name`, `domain_modules`, `domain_code`, `related_modules`, `created_at` |
| §1 Overview | 2-3 sentence catalog narrative. No §-references, no snake_case identifiers, no platform plumbing words. |
| §2 Entity summary | Per-entity table (Name + Description) followed by a Mermaid `flowchart LR` diagram with `classDef master / contributor / consumer / platform_builtin` |
| §3 Entities catalog | Columns: `# / data_object / role / mastered_in / necessity / notes` |
| §4 Aliases | Industry / vendor / domain synonyms for entities (optional; "no aliases" stub allowed) |
| §5.1 Intra-scope edges | FK/relationship rows where both endpoints are owned/co-located in this module |
| §5.2 Built-in edges | Rows where one endpoint is a Semantius platform built-in (`users`, `roles`, …) |
| §5.3 Cross-scope edges | Rows touching other modules — sparse in greenfield mode, populated in catalog-clone |
| §6.1 Master consumers | Other modules embedding this scope's masters |
| §6.2 Outbound handoffs | Events this scope publishes (`source / target / trigger_event / payload / integration / friction / description`) |
| §6.3 Inbound handoffs | Events this scope reacts to |
| §6.4 Master providers | Entities this scope embeds from other modules |
| §7 Lifecycle states | One sub-section per `role = master` entity; columns `order / state_name / initial? / terminal? / requires_permission? / derived gate / description` |
| §8.1 Permissions | Tiered table: `permission / tier / description / included in :admin?`. Tiers: `baseline-read`, `baseline-manage`, `baseline-admin`, `workflow-gate (lifecycle)`, `workflow-gate (rule)`, `override`, `narrow` |
| §8.2 Business rules | High-level rule intents: `rule_name / data_object / source flag / intent` |

**Key constraint:** **no fields anywhere**. No `Format`, `Required`, or `Label` columns on §3. No JSON sub-blocks for computed fields, validation rules, input-type rules, or select rules. The blueprint is entity-level only.

**Role vocabulary in §3:**

- `master` — owned and lifecycle-mastered by this module
- `contributor` — mastered in another module per `mastered_in`, but participates in this module's workflows
- `consumer` — read by this module, never written
- `embedded` — declared here for self-containment until the catalog owner module is installed (e.g. `locations` in `ats-candidate-crm` until `iwms` is present)

**Necessity vocabulary in §3:** `required` (always created in the spec) or `optional` (the analyst presents a multiSelect prompt at reconciliation time and skips declined ones).

**No §3 behavior flags.** §3 carries no pattern/behavior flags. Row-scope visibility and field locks are authored by the analyst as field-level JsonLogic (`select_rule` / `validation_rules`); approvals are gated lifecycle transitions (§7 `requires_permission?` + the §8.1 `workflow-gate`) and/or §9 RACI. A known, non-derivable row-scope requirement can be stated in the Additional Requirements Specification section.

### 2.2 Spec (`*-semantic-spec.md`)

**Produced by:** `semantius-analyst`
**Consumed by:** `semantius-modeler`
**Format version key:** `version` (currently `"4.0"`)
**Analyst skill stamp:** `version: "<analyst CURRENT_VERSION>"` (currently `"4.0"`)

**Template:** `.claude/skills/semantius-analyst/references/semantic-spec-template.md`

**Sections (fixed order):**

| Section | Purpose |
|---|---|
| frontmatter | All blueprint frontmatter keys PLUS `reconciled_at`, `reconciled_against_catalog_snapshot`, `source_blueprint`, optional `promotion_decisions` array |
| §1 Overview | Carried verbatim from blueprint unless user changed it during reconciliation |
| §2 Entity summary + Permissions summary | Rich permission catalog with 5 columns: `Permission / Type / Description / Used by / Hierarchy parent` |
| §3 Entities | Per-entity sub-section with `**Reconciliation:**` annotation, Fields table (5 cols), Relationships prose, optional Computed fields / Validation rules / Input type rules / Select rule JSON sub-blocks |
| §4 Relationship summary | Per-FK table cross-checking §3 |
| §5 Enumerations | Per-field enum value listing |
| §6 Cross-model link suggestions | Resolved FK proposals against the live catalog, with `Reconciliation` column |
| §7 Open questions | §7.1 🔴 Blockers (gate the modeler) + §7.2 🟡 Future considerations |
| §8 Implementation notes | Per-module procedural steps the modeler follows |

**Reconciliation annotation grammar** (per §3 entity sub-section):

| Annotation | Meaning | Fields block | Notes |
|---|---|---|---|
| `create-new` (default, omitted) | Brand-new entity in this module | full Fields block required | Default when the line is absent |
| `reuse-from <module>.<entity>` | Use an existing entity from another module / built-in | omitted entirely (or `**Additive fields**` block only for built-in extensions) | Modeler reads existing fields for FK resolution |
| `rename-incoming-from <existing_module>.<existing_entity> as <new_name>` | Disambiguate from a colliding name | full Fields block under `<new_name>` | Analyst chose the new name; user confirmed |
| `promote-to-master <master_module>.<entity>` | Move this entity to a shared master module | full Fields block; entity creates in master, not this domain | Pairs with `promotion_decisions` frontmatter entry |
| `dropped (optional, user declined)` | Optional blueprint entity user opted out of | no Fields block | Skipped from all later stages |

**Frontmatter `promotion_decisions`** (when any `promote-to-master` appears):

```yaml
promotion_decisions:
  - entity: vendors
    host_module: vendor_management
    manage_option: 1   # 1=master-only, 2=both modules, 3=original only, 4=incoming only
```

The `manage_option` records the analyst Stage 3b follow-up decision; the modeler reads it without re-prompting.

---

## 3. Skill responsibilities

### 3.1 `semantius-architect`

**Role:** Designs the blueprint. Platform-agnostic. No catalog awareness.

**Modes (from Step 0):**

| Mode | Trigger | Behavior |
|---|---|---|
| Create-Greenfield | New idea, no source | §5.3 and §6 written sparse |
| Create-Catalog-Clone | "Clone the candidate-crm blueprint" | Load source via path/URL, present overview, ask what to change; inherit §5.3/§6 |
| Customize | "Customize the ATS blueprint" without specifics | Load source, show §1 + §3 table, ask what to change; route into Extend or targeted edits |
| Audit | Existing blueprint, "audit it" | Read-only structured report (Blockers/Warnings/Notes) |
| Extend | Existing blueprint, "add entities / edges / lifecycle / permissions" | Additive changes to §3/§5/§7/§8 |
| Rebuild | Existing blueprint, "rebuild from scratch" | Mode D — fresh pass preserving `initial_request` and curated metadata |

**Stages within Mode A (Create):**

1. Capture the system (domain category, initial_request)
2. Offer legacy-vendor vs agent-optimized naming
3. Propose entity list (with role/mastered_in/necessity per entity, no fields)
4. *(moved to analyst Stage 4)* — propose fields
5. Build Mermaid diagram (master/contributor/consumer/platform_builtin classDef)
6. Related-domains shadowing walk → `related_modules` frontmatter + §6.4
7. Cross-domain handoffs → §6.2 / §6.3 event-level; greenfield skips this unless user asks
8. *(moved to analyst Stage 10)* — computed fields and validation rules
9. Classify entity as operational vs admin-tier → feeds §3 role + §8.1 baseline-admin rows
9b. *(moved to analyst Stage 9)* — cross-tier FK reconciliation
10. Workflow-permission scan W1/W2/W6 only — lifecycle-terminal gates; feeds §7 `requires_permission?` + §8.1 workflow-gate rows
11/12/12.5. *(moved to analyst Stages 6, 7, 8)* — conditional input-type / row-level read / consistency gate
13. Write the blueprint file

**Never does:**
- Inspect the live Semantius catalog. Architect output is platform-agnostic.
- Decide reuse / rename / merge / promote. Those need catalog awareness.
- Specify field shapes, validation rules, JsonLogic.

**Output filename:** `<system_slug>-semantic-blueprint.md`

### 3.2 `semantius-analyst`

**Role:** Reconciles the blueprint with live Semantius and elicits field-level detail. **Gatekeeper of the unified catalog.**

**Modes (from Step 1):**

| Mode | Trigger | Behavior |
|---|---|---|
| Reconcile (default) | Blueprint exists, no prior spec | Full end-to-end pipeline |
| Audit | "Audit this spec" | Read-only structured report on field-level checks |
| Extend | "Add entities / fields / rules to the spec" | Re-run Stage 2 reconciliation for new entities only |
| Rebuild | "Rebuild the spec, blueprint changed materially" | Fresh pass preserving promotion_decisions and curated text |

**Stages in Reconcile mode:**

1. Parse the blueprint
2. Inspect the live catalog (2a module resolve, 2b built-ins, 2c full entity load, 2d classify, 2e similarity heuristic, 2f comparison blocks, 2g cross-scope edge resolution)
3. Drive reconciliation decisions via `AskUserQuestion` (3a optional entities multiSelect, 3b cross-module exact-name 4-option widget, 3c similar-name 3-option widget, 3d cross-scope edge picks, 3e confirm plan)
4. Elicit field-level detail for create-new / rename-incoming / promote-to-master entities only
5. Workflow-permission scan W3/W4/W4n/W5 (field-driven)
6. Conditional input-type scan (per-field UI rules)
7. Row-level read-access scan (`select_rule`)
8. View & edit rules consistency gate (cross-checks across §2, §3 sub-blocks)
9. Cross-tier FK reconciliation
10. Computed fields and validation rules (15-family scan)
11. Write the spec file

**Catalog-awareness boundary:** the analyst reads (via `read_module`, `read_entity`, `read_field`, `read_permission`, `read_role`) but plans writes only — it doesn't execute them. The modeler executes.

**Output filename:** `<system_slug>-semantic-spec.md`

### 3.3 `semantius-modeler`

**Role:** Thin executor. Trusts the spec. No interactive decisions on catalog ambiguity.

**Stages:**

1. Parse the spec (read `**Reconciliation:**` annotations per entity)
2. Verify reconciliation against the live catalog (2a-2g, much lighter than the old Stage 2 — just confirms the analyst's decisions still hold)
3. Plan and present (render the diff, single yes/no confirmation; medium-risk operations like `select_rule` changes and `edit_permission` tier flips still pause)
4. Execute (4a scaffold, 4b permissions/hierarchy, 4c entities, 4d fields, 4e write-side rules, 4f read-side rules, 4g built-in extensions, 4h cross-model link execution, 4i cross-module permission inclusions, 4j seed master manager)
5. Verify (per-area checks, structured report, Gates A and B)
6. Optional: Sample data (only for created entities, never for reused or built-ins)

**Never does:**
- `AskUserQuestion` for cross-module collisions, similar names, master promotions, or merge/rename decisions. Those are baked into the spec.
- Delete anything. The whole `delete_*` family is banned.
- Re-classify entities. Annotations in the spec are the source of truth.

**Catalog drift handling:** if Stage 2 finds that a `reuse-from` target is missing, a `rename-incoming-from` target name is now taken, or a `promote-to-master` host master is wrong type / missing, the modeler **halts and routes the user back to the analyst** with a clear message. It does not try to re-decide.

---

## 4. Version compatibility matrix

| Skill | Skill version | Reads artifact | Writes artifact |
|---|---|---|---|
| `semantius-architect` | `"4.0"` | own outputs in modes B/C/D | `version: "4.0"`, `blueprint_version: "2.0"` |
| `semantius-analyst` | `"4.0"` | `blueprint_version: "2.0"` (`EXPECTED_BLUEPRINT_VERSION`) | `version: "4.0"`, carries `blueprint_version: "2.0"` |
| `semantius-modeler` | n/a (executor) | `version: "4.0"` (`EXPECTED_MAJOR = 4`) | n/a (writes to catalog) |

**Bumping rules:**

- *Minor bump* on a skill: non-breaking content rule (new optional annotation, new modeling convention authors must follow, new audit check).
- *Major bump* on a skill: breaking shape change (section renumbered, frontmatter key removed, column shape changed, reconciliation-annotation value removed/renamed).
- Bumping the analyst's major **requires** bumping the modeler's `EXPECTED_MAJOR` in lockstep.
- Bumping the blueprint `blueprint_version` major **requires** bumping the analyst's `EXPECTED_BLUEPRINT_VERSION` in lockstep.

**Drift behavior:**

- **Modeler reads spec with `version` major != 4** → refuses, error message: *"This spec is for analyst v\<N\>; modeler is at EXPECTED_MAJOR=4. Re-run semantius-analyst on the source blueprint to regenerate the spec."*
- **Analyst reads blueprint with `blueprint_version` major != 2** → refuses, asks user to regenerate via architect.
- **Either skill reads a *newer* major than expected** → refuses, asks user to update the skill.

---

## 5. Hand-off protocol

Each skill closes with a message pointing at the next skill:

| From | Close-message template |
|---|---|
| Architect → Analyst | *"Blueprint written to `<path>` (\<lines\>, \<entity count\>, \<role breakdown\>). Next: invoke `semantius-analyst` to reconcile this blueprint with the live Semantius catalog and produce a deployable spec."* |
| Analyst → Modeler | *"Spec written to `<path>` (\<lines\>, \<entity count\>, \<reconciliation summary\>). Next: invoke `semantius-modeler` to deploy this spec to the live catalog."* |
| Modeler → user | *"Spec deployed to module `<slug>`. Live catalog matches the spec ✅."* |

The reconciliation summary in the analyst's close-message is shaped like `{N created, N reused, N renamed, N promoted, N dropped}` so a glance tells the user what kind of deploy is coming.

---

## 6. Failure modes and recovery paths

### 6.1 Blueprint-side failures (handled in analyst Stage 1)

| Symptom | Likely cause | Recovery |
|---|---|---|
| Blueprint has Format/Required/Label columns in §3 | Old v3.x architect output, or hand-edited spec | Re-run `semantius-architect` Mode D Rebuild on the file, or hand-edit to strip field-level content |
| `blueprint_version` is `"1.x"` or missing | Pre-v4 architect output | Architect Mode D Rebuild to re-author at current shape |
| `blueprint_version` is `"3.x"` (future) | Newer architect than this analyst | Update `semantius-analyst` skill |
| §2 Mermaid diagram missing entities from §3 | Hand-edit drift, or architect bug | Run architect Audit; fix; re-export |
| §7 has `requires_permission? = ✓` row with no matching §8.1 workflow-gate | Architect audit didn't catch it | Run architect Audit; the verification block enforces this |

### 6.2 Catalog-drift failures (caught in analyst Stage 2 or modeler Stage 2)

| Symptom | Likely cause | Recovery |
|---|---|---|
| `reuse-from <module>.<entity>` target is missing in modeler | Catalog changed between analyst-run and modeler-run | Re-run `semantius-analyst` to refresh reconciliation |
| `rename-incoming-from … as <new_name>` target name is now taken | Another deploy beat us to the name | Re-run analyst; user picks a different name |
| `promote-to-master <master>.<entity>` host module is `module_type = "domain"` | Analyst should have caught this | Analyst bug; surface the offending entity and route back |
| Spec lacks reconciliation annotations entirely | Spec is from v3.x analyst | Re-run analyst on the blueprint |

### 6.3 Spec-side validation failures (analyst Stage 8 + modeler Stage 1 parse)

| Symptom | Likely cause | Recovery |
|---|---|---|
| `require_permission(<code>)` invokes a permission not in §2 | Author missed declaring it | Analyst Mode B Audit catches; user adds the row |
| `select_rule` references a column not on the entity | Typo, or author named a sibling field's column | Audit catches; user fixes |
| `select_rule` prose claims a bypass the JsonLogic doesn't encode | Misleading audit-bypass risk | 🔴 Blocker; user fixes prose or JsonLogic |
| `validation_rules` has duplicate `code` within an entity | Author copy-paste error | 🔴 Blocker; user fixes |
| Spec has `validation_rules` on a built-in (`users`, `roles`) | Author shouldn't have | 🔴 Blocker; route to analyst Mode B |

### 6.4 Execution failures (modeler Stage 4)

These are runtime errors hitting the Semantius platform.

| Symptom | Likely cause | Recovery |
|---|---|---|
| `create_field` rejected: cross-primitive format change | Spec mutates a `text` field to `integer` | Re-author the field via analyst Extend |
| Enum value removal hits check constraint | Existing rows carry the removed value | Reconcile existing rows first, then re-deploy |
| Hierarchy direction inverted in live | Manual catalog edit | Stop, ask user; never silently update |
| FK target table missing | Build order error, or spec drift | Re-run analyst |
| `permissions.module_id` is NULL | Pre-v3.2.1 deployer bug residue | Modeler issues corrective `update_permission` |

---

## 7. Banned operations

Across all three skills:

- **No deletion.** No `delete_entity`, `delete_field`, `delete_module`, `delete_permission`, `delete_permission_hierarchy`, `delete_role`, `delete_role_permission`, `delete_user`, `delete_user_role`, `delete_webhook_receiver`, `delete_webhook_receiver_log`, `delete_api_key`. Renames are rewires (new entity + FK reseats), not deletes.
- **No silent built-in modification.** Built-ins (`users`, `roles`, `permissions`, `permission_hierarchy`, `role_permissions`, `user_roles`, `webhook_receivers`, `webhook_receiver_logs`, `modules`, `entities`, `fields`) are platform infrastructure. Additive fields are allowed; replacement is not.
- **No DDL in any artifact.** Raw `CREATE TABLE`, `CREATE INDEX`, `ALTER TABLE`, `DROP`, `REFERENCES`, `ON DELETE CASCADE` (as SQL) MUST NOT appear in any prose surface or JSON sub-block. The platform reads structured cells (format, reference_table, delete_mode, JsonLogic) and never executes DDL the analyst writes.
- **No em-dashes (`—`).** US English. Singular-subject grammar in confirmation prompts. (Writing conventions are duplicated in all three skills.)
- **No identifier leakage in user-facing prose.** No backticks around tokens in `singular_label` / `plural_label` / entity Description / field Description / permission Description. Use English labels, not `table_name` / `field_name` / `<slug>:<permission>`.

---

## 8. Key invariants (debugging checkpoints)

When something goes wrong, walk these in order:

1. **Frontmatter versions are stamped correctly.** Blueprint carries `blueprint_version: "2.0"`; spec carries `version: "4.0"` AND `blueprint_version: "2.0"`. A version mismatch fails fast at the next skill's Stage 1.
2. **Every blueprint §3 entity has a reconciliation decision in the spec.** No entity is silently in both files without an annotation.
3. **Every `reuse-from` spec entity has no Fields block.** Field re-spec on a reused entity is a hard error (the spec is over-specifying something the modeler will read from live).
4. **Every owned spec entity (`create-new` / `rename-incoming-from` / `promote-to-master`) has a Fields block.** Under-spec is a hard error (the modeler has nothing to create).
5. **Every `require_permission(<code>)` argument appears in §2 Permissions summary.** The deployer's parse-time check enforces this.
6. **Every §3 `personal_content` flag has matching `view_all_<plural>` and `manage_all_<plural>` rows in §8.1.** Architect's pre-save verification enforces this.
7. **Every §7 `requires_permission? = ✓` row has a matching §8.1 `workflow-gate (lifecycle)` row.** Architect's pre-save verification enforces this.
8. **Modeler's `EXPECTED_MAJOR` matches analyst's `CURRENT_VERSION` major.** A skipped bump on either side causes silent dispatch failures.
9. **Catalog snapshot timestamp.** Spec's `reconciled_against_catalog_snapshot` is informational but useful for diagnosing drift; modeler's Stage 2 verifies live state against the annotations regardless.
10. **No live entity has been deleted between analyst-run and modeler-run.** The catalog only grows; the modeler's pre-flight catches the rare drift.

---

## 9. File layout in the repo

```
.
├── ats-candidate-crm-semantic-blueprint.md   ← canonical example blueprint
│
└── semantius-plugin/skills/
    ├── semantius-admin/
    │   ├── SKILL.md                  ← admin/orchestrator skill
    │   └── three-skill-workflow-spec.md   ← THIS FILE
    │
    ├── semantius-architect/
    │   ├── SKILL.md                  ← architect skill (1212 lines)
    │   ├── CHANGELOG.md
    │   └── references/
    │       ├── semantic-blueprint-template.md   ← blueprint template (275 lines)
    │       └── data-modeling.md                 ← kept for design reference
    │
    ├── semantius-analyst/
    │   ├── SKILL.md                  ← analyst skill (788 lines)
    │   └── references/
    │       ├── semantic-spec-template.md   ← spec template
    │       └── data-modeling.md            ← Semantius platform reference
    │
    ├── semantius-modeler/
    │   ├── SKILL.md                  ← modeler skill (1141 lines)
    │   └── CHANGELOG.md
    │
    └── use-semantius/
        ├── SKILL.md                  ← shared CLI patterns
        └── references/
            ├── data-modeling.md
            └── cli-usage.md
```

---

## 10. Quick reference: when to invoke which skill

| User says | Skill |
|---|---|
| "I need a CRM / helpdesk / HRIS / ..." | architect (Create-Greenfield) |
| "Clone the candidate-crm blueprint" | architect (Create-Catalog-Clone) |
| "Customize the ATS blueprint" | architect (Customize) |
| "Audit this blueprint" | architect (Audit) on a `*-blueprint.md` |
| "Audit this spec" | analyst (Audit) on a `*-spec.md` |
| "Add entities to this blueprint" | architect (Extend) |
| "Add fields to this spec" | analyst (Extend) |
| "Rebuild this blueprint" | architect (Rebuild) |
| "Rebuild this spec" | analyst (Rebuild) |
| "Reconcile this blueprint with the catalog" | analyst (Reconcile) |
| "Deploy this spec" | modeler |
| "Promote vendors to a shared master" | spec already has `promote-to-master`; modeler executes |
| "Re-run the deploy" | modeler (idempotent; diffs against live, applies only the delta) |

If the user references a `*-semantic-blueprint.md` and says "deploy", route them through the analyst first, **not** straight to the modeler. The modeler refuses to consume blueprints.

---

## 11. Open questions / future work

- **CHANGELOG.md updates.** Architect and modeler CHANGELOGs were not updated to record the v4.0 split; should be done by hand.
- **Stale rows in modeler's Conflict Resolution Reference.** Several rows reference "Stage 2d/2e ambiguity gate" patterns that the modeler no longer fires (the analyst handles them now). Cleanup is cosmetic; doesn't affect runtime.
- **Architect Mode B Audit still includes field-level checks.** A banner at the top of the checklist notes they moved to analyst Mode B, but the checklist rows weren't surgically pruned. Could be a follow-up.
- **`data-modeling.md` duplication.** Lives in both `architect/references` and `analyst/references`. Architect doesn't strictly need it anymore; harmless duplication for now.
- **Catalog discovery.** Catalog-clone mode requires the user to provide the source blueprint path/URL. A future iteration could ship a curated catalog under `.claude/skills/semantius-blueprint-catalog/` with a lookup helper.
- **Master-vs-master consolidation.** Path-2 multi-master consolidation logic (formerly modeler 4c-merge-master) was dropped in the modeler trim. Currently assumed to be analyst-resolved; verify this in practice before relying on it.
