# Stage 3: Optional, collision, and cross-link widgets (3a-3e)

*Reference for `semantius-analyst`. Each widget's "Policy path:" line depends on the protocol in [`customizations-consultation.md`](customizations-consultation.md); read it alongside.*

### 3a. Optional concepts

**Policy path:** `.optionals_decided.<slug>` (per-slug verdict, `included` or `excluded`). Both directions are recorded; 2c.5 has already filtered the entity list to un-decided slugs only. This widget fires only when at least one un-decided optional remains.

Blueprint §3 entries with `necessity = optional` are offered to the user as multiSelect `AskUserQuestion` choices, **one option per optional entity**:

- **question**: `"Some parts of this module are optional. Which do you want to set up?"`
- **header**: `"Optional parts"`
- **multiSelect**: `true`
- **options**: one per optional entity:
  - label: the entity's **Plural Label** (e.g. `"Career Aspirations"`)
  - description: blueprint §2 description, followed by `" Skip if you don't track this."`

**The 4-option cap (mandatory).** `AskUserQuestion` allows at most **4 options per question**. Most modules have ≤4 optionals and fit one multiSelect question. When **more than 4** optional entities remain un-decided:

- **Never merge two entities into one combined option** to fit the cap. The user must be able to include one without the other; a `"Issues + Service Requests"` mega-option silently forces an all-or-nothing choice and corrupts the per-slug `.optionals_decided` record.
- **Split** the optionals across several multiSelect questions of ≤4 options each, **all carrying the same `"Optional parts"` header**, and send them together in **one** `AskUserQuestion` call (a single call holds up to 4 questions → up to 16 optionals). With more than 16 un-decided optionals, fire successive `AskUserQuestion` calls until all are covered.
- **Keep this in its own `AskUserQuestion` call.** Do not fold the optional-parts question(s) into the access-control question (Stage 2c) or any other decision. Batching unrelated questions makes every chip inherit the first question's header (the access-control question's `"Access control"` chip would then mislabel the optional-parts question).

Entities the user does NOT select get the internal annotation `dropped (optional, user declined)` on the spec entry and are skipped from all later stages. Selected entities proceed to bucket classification.

Example option (for Career Aspirations):
- Label: `"Career Aspirations"`
- Description: `"Worker-declared career interests: target roles, mobility preferences, aspired timeline. Skip if you don't track this."`

### 3b. Same-name collisions (cross-module exact match)

For every 🛑 cross-module exact-name collision, the widget shape depends on the incoming blueprint's declared `role` for the entity. Three sub-cases, ordered by precedence:

#### 3b.0 Catalog-owner adoption (1-option confirmation widget)

**Fires when:** incoming blueprint's `role` is `master`, an entity with the same slug exists in some module X (X ≠ incoming module), AND the Stage 2 workspace scan found that **X's blueprint (or spec, if blueprint is missing) carries an `embedded_master` row pointing this entity at the incoming blueprint's `system_slug`**. In other words: an earlier blueprint declared this entity as a placeholder "for whenever the catalog owner shows up." This blueprint IS that catalog owner. The adoption is the contract being honored.

**Policy gate:** `.adoption_consent` (`auto-confirm` skips this widget; `prompt-each-time` or absent fires it).
**Policy record:** `.adoptions.<entity>` (audit log — date of adoption; recorded on every successful confirmation).

**Behavior:** fire a single `AskUserQuestion` so the user has explicit consent that the entity is moving to the catalog owner.

- **question**: `"<Plural Label> exists already as part of `<X Display Name>`. `<Module Display Name>` will adopt it now. Proceed?"`
- **header**: `"Adopt entity"`
- **multiSelect**: `false`
- **options** (exactly 2 — do NOT expand this widget at runtime; the alternatives would either contradict the blueprint or require manual catalog work):
  1. label: `"Yes, adopt (Recommended)"`
     description: `"Reassigns <Plural Label> from `<X Display Name>` to `<Module Display Name>`. The underlying table doesn't move, every record stays in place, every link pointing at <Plural Label> still resolves. `<X Display Name>` keeps read access. Then this blueprint's full design (fields, lifecycle, permissions) gets applied as additive deltas."`
  2. label: `"Cancel"`
     description: `"Stop without changes. <Plural Label> stays in `<X Display Name>`. If you actually want `<X Display Name>` to own <Plural Label>, edit this blueprint's §3 to set its role to `embedded_master` (or `consumer` if read-only) and re-run."`

**On Yes:** stamp the incoming entity with `**Reconciliation:** promote-to-master <incoming.system_slug>.<entity>`. Add a `promotion_decisions` frontmatter entry for this entity (host_module = incoming `system_slug`, host_module_name = incoming `system_name`, manage_option = 1). The modeler executes the move via `update_entity` and applies the full blueprint design.

**On Cancel:** halt the run cleanly. No spec written, no catalog changes.

**Batching when multiple entities adopt at once.** If the workspace blueprint/spec scan finds N adoption candidates (e.g., `candidates` AND `recruitment_sources` both placeholdered by hiring-starter pointing at ats-candidate-crm), present them as a single combined confirmation widget rather than N separate prompts. The question text becomes: *"<English-joined list of Plural Labels> exist already as part of `<X Display Name>`. `<Module Display Name>` will adopt them now. Proceed?"* Same Yes / Cancel options. The user makes one decision for all entities sharing the same source module + same catalog-owner target.

**No other options.** Do not surface "Reuse the existing one," "Share via shared shell," "Other," or any other alternative. The blueprint contract has already been signed at the prior install; this widget exists only to confirm the modeler is about to act on that contract. If the user wants a different outcome, they edit the blueprint and re-run.

#### 3b.1 Embedded-master second-mover (2-option widget)

**Policy path:** `.collisions.<entity>` (object). When `outcome: share`, auto-resolve via the host module in `.collisions.<entity>.host_module`. When `outcome: silo`, auto-resolve via the rename target in `.collisions.<entity>.rename_to`. Missing key fires the widget; the answer writes the matching outcome shape back.

**Fires when:** incoming blueprint's `role` is `embedded_master`, the owner module named in `mastered in` doesn't exist yet, AND an entity with the same slug already exists somewhere in the catalog (placed there by a prior first-mover install). This is where the **shared placeholder shell actually gets created if the user chooses to share** — not at first-mover install.

**B's blueprint is the source of truth for this install** (per the design rule: A's prior intent is unrecoverable, and B is the one running right now). So the option-1 shell name uses B's `mastered_in` slug and B's `label`, regardless of whether A's prior spec said the same thing, a different thing, or nothing at all. The widget shape is identical in all three sub-cases (matching A's intent, mismatched, unknown source).

- **question**: `"<Plural Label> already exists in `<Existing Module Display Name>`. This blueprint says <Plural Label> should be owned by `<B.label>` once that module is set up. What should we do?"`
- **header**: `"Existing concept"`
- **multiSelect**: `false`
- **options** (exactly 2):
  1. label: `"Create the shared `<B.label>` placeholder and put <Plural Label> there (Recommended)"`
     description: `"Sets up `<B.mastered_in>` now as an empty placeholder module owned by `<B.label>`, moves the existing <Plural Label> from `<Existing Module Display Name>` into it via \`update_entity\` (no data movement, just reassigning \`module_id\`), and wires both `<Existing Module Display Name>` and this module to read from there. When `<B.label>` is later deployed as its own blueprint, the analyst's spec scan will auto-detect this placeholder and offer to take ownership."`
  2. label: `"Keep our own separate <Plural Label> (rename)"`
     description: `"Create our own <Plural Label> in this module under a different name (e.g. `<this_module_short>_<entity>`). Records won't be combined with `<Existing Module Display Name>`'s. Pick this only if these are actually different concepts despite the matching name."`

**Internal mapping** (do NOT show to the user):
- Option 1 → `promote-to-master <B.mastered_in>.<entity>` annotation + `promotion_decisions` frontmatter entry capturing the host module (slug = `<B.mastered_in>`, name = `<B.label>`, manage_option = 1 by default). Modeler creates the master shell module if it doesn't exist, then `update_entity` moves the existing entity into it. This module gets cross-module read inclusion.
- Option 2 → `rename-incoming-from <existing_module>.<entity> as <this_module_short>_<entity>` (silo; full Fields block under the renamed entity in this module).

No host-module or manager-scope follow-up — the host is determined by B's blueprint, the manager-scope defaults to `1` (dedicated manager group seeded from both modules).

#### 3b.2 Master-vs-master collision (4-option widget; rare)

**Policy path:** `.collisions.<entity>` (object). Outcomes map to write shapes:
- Option 1 (share) → `{outcome: share, host_module: <host>}`
- Option 2 (silo, rename incoming) → `{outcome: silo, rename_to: <new_slug>}`
- Option 3 (claim ownership for incoming) → `{outcome: claim, new_owner: <incoming_module>}`
- Option 4 (abort) → write nothing (matches the cancel-selection rule in admin `references/customizations-protocol.md`, 7.6).

**Fires when:** incoming blueprint's `role` is `master` AND the existing entity in the catalog is in a module with a DIFFERENT slug from the incoming blueprint's `system_slug`. In other words: two modules each claim master ownership of the same entity, and they disagree on which slug owns it. This is the master-vs-master case [architecture.md §11](../../../docs/architecture.md) flags (Path-2 consolidation). Fire the 4-option widget:

- **question**: `"<Plural Label> already exists in `<Existing Module Display Name>`. This blueprint also claims master ownership of <Plural Label>. What should we do?"`
- **header**: `"Existing concept"`
- **multiSelect**: `false`
- **options** (in this order):
  1. label: `"Share one copy across both modules (Recommended)"`
     description: `"Move <Plural Label> into a shared module so both modules read the same records. Best when they really are the same concept."`
  2. label: `"Keep our own separate copy"`
     description: `"Create <Plural Label> just for this module under a different name. Records can't be combined in reports. Pick this when the two concepts are actually different despite the same name."`
  3. label: `"Use the existing one directly"`
     description: `"This module reads `<Existing Module Display Name>`'s <Plural Label>. Future shape changes need `<Existing Module Display Name>` owners to agree."`
  4. label: `"Stop, I want to think about it"`
     description: `"Abort this run. No changes are made."`

**On picking option 1 (share)**, follow up with a host-module question:

**Policy path:** `.collisions.<entity>.host_module`.

- **question**: `"Where should the shared <Plural Label> live?"`
- **header**: `"Where to host"`
- **multiSelect**: `false`
- **options** depend on existing master modules:
  - *Case A* (no shared modules exist, no cluster hint): single option `"New shared module called <plural_label_snake_case>"` — confirm or override.
  - *Case B* (no shared modules, cluster hint `<cluster>`): default option `"New shared module called <cluster> (Recommended)"`.
  - *Case C* (shared modules exist, cluster hint matches one): default option `"Existing <Master Display Name> module (Recommended)"`.
  - *Case D* (shared modules exist, no match): one option per existing shared module by display name, plus `"Create a new shared module called <name>"`.

Then a follow-up on who manages records:

**Policy path:** `.shared_master_managers` (global default; one value applies to every shared-master decision in the org).

- **question**: `"Who can edit records in the shared <Plural Label>?"`
- **header**: `"Manager scope"`
- **multiSelect**: `false`
- **options**:
  1. `"A new dedicated manager group (Recommended)"` — description: `"Only people in this group can edit shared <Plural Label>. Existing managers of the colliding modules are seeded into the group automatically and can be adjusted later."`
  2. `"New group plus current managers of both modules"` — description: `"Anyone who already manages either module also keeps edit rights on shared <Plural Label>."`
  3. `"New group plus current managers of <Existing Module Display Name> only"` — description: `"Only the module that already had <Plural Label> retains edit rights alongside the new group."`
  4. `"New group plus current managers of this module only"` — description: `"This module's managers keep edit rights alongside the new group."`

**Internal mapping** (do NOT show to the user):
- Option 1 → `promote-to-master <host>.<entity>` annotation + `promotion_decisions` frontmatter entry capturing host and manager-scope choice.
- Option 2 → `rename-incoming-from <existing_module>.<entity> as <incoming_module>_<entity>`.
- Option 3 → `reuse-from <existing_module>.<entity>` (no Fields block; record as a §7.1 blocker only when the user explicitly wants future shape changes coordinated).
- Option 4 → halt the run.

#### 3b.3 Dispatch summary

Stage 2 has already applied the role-driven placement table (top of Stage 3) using both the live catalog AND the workspace blueprint/spec scan. By the time the dispatcher reaches 3b, the cases that need a prompt are narrow:

| Incoming `role` | Existing entity location | Workspace spec evidence | Sub-case |
|---|---|---|---|
| `master` | Some module X (X ≠ incoming) | X's spec carries `embedded_master mastered_in: <incoming.system_slug>` for this entity | **3b.0** (1-option take-ownership confirmation, batched if multiple entities adopt at once) |
| `master` | Some module X (X ≠ incoming) | No matching spec evidence, OR X's spec claims `master`/`create-new` ownership | **3b.2** (master-vs-master, 4-option) |
| `embedded_master` | `<mastered_in>` module exists, entity exists there | n/a | (no prompt — `reuse-from <mastered_in>.<entity>` per placement table) |
| `embedded_master` | Some module X (`<mastered_in>` doesn't exist yet) | (any — placement is the same regardless of A's prior intent) | **3b.1** (2-option second-mover widget — share via new shell, or silo via rename) |
| `embedded_master` | Doesn't exist anywhere | n/a | (no prompt — first-mover, lands locally with §7.2 🟡 note per placement table) |
| `contributor` or `consumer` | (any) | n/a | Skip 3b entirely; handled by Stage 2g cross-module link resolution (the row in §5.3 / §6 points at the existing entity as the target). |

### 3c. Similar-name collisions

**Policy path:** `.aliases.<incoming_slug>` (the rename IS the alias). Options 1 and 2 write an alias object `{slug, singular_label, plural_label}` using `headComment` for provenance; option 3 ("different, keep both names") writes nothing.

For every 🛑 Similar-name flag, fire a three-option `AskUserQuestion`:

- **question**: `"<This Plural Label> looks similar to <Existing Plural Label> in <Existing Module Display Name>. Are they the same concept?"`
- **header**: `"Similar name"`
- **multiSelect**: `false`
- **options**:
  1. label: `"Different concept, use a clearer name"`
     description: `"Rename this module's version to <disambiguated_name> so reports don't mix them up."`
  2. label: `"Same concept, use the existing one"`
     description: `"This module reads <Existing Module Display Name>'s <Existing Plural Label>. We won't create a duplicate."`
  3. label: `"Different concept, keep both names"`
     description: `"They look alike but aren't actually related. Create our own."`

**Internal mapping**:
- Option 1 → `rename-incoming-from <existing_module>.<existing_entity> as <new_name>`.
- Option 2 → `reuse-from <existing_module>.<existing_entity>`.
- Option 3 → `create-new` (default, no annotation needed; record the comparison was inspected).

### 3d. Modules-not-deployed-yet (external owner absent)

> **Entity-owning-module rule.** Workflow gates and row-scope overrides for entity E are prefixed by E's CURRENT owning module slug, not by the installing unit. The Stage 3d / 3b.0 / 3b.1 logic below routes the decision; the actual emission rules are:
>
> - **Case 1: catalog owner module installed** → consume via the catalog owner (`reuse-from <catalog-module>.<entity>`). Personas grant on catalog-prefixed codes.
> - **Case 2: catalog owner absent AND entity does NOT exist anywhere in the live catalog** → installing unit becomes the entity's owning module. Emit the entity's full derived governance (workflow gates + row-scope overrides + matching §8.2 rules + boundary-crossing handoffs in §6.2 / §6.3) prefixed by the installing-unit slug. **Annotate each re-prefixed gate / override with `**Reconciliation:** re-prefixed-from <catalog-module>.<verb>`** so the deployer's Stage 4n knows to reconcile when the catalog owner later installs.
> - **Case 3: catalog owner absent BUT entity already exists under a non-catalog owner module** → emit `reuse-from <non-catalog-module>.<entity>`. Personas grant on existing non-catalog-prefixed codes. DO NOT mint duplicate gates / overrides; DO NOT emit re-prefixed governance — it's already minted under another unit. This is the second-installer case (3b.1).
>
> A module that embeds an entity whose catalog owner is absent ALWAYS deploys (Case 2 or Case 3); there is no "install the master first" prompt. The widget below applies only to `contributor` / `consumer` rows that legitimately can't materialize without the owner; `embedded_master` rows route through 3b.0 / 3b.1 / Case 2 instead.

**Policy path:** `.on_missing_owner` (global default; `embed_locally` / `skip`). The `wait` value is not used — modules deploy standalone. A file that still carries `.on_missing_owner: wait` is coerced to `embed_locally` with a one-line narration: *"Updated your old wait-for-master rule to deploy-anyway — modules now deploy standalone."*

**Fires only for `contributor` and `consumer` rows.** `embedded_master` rows with a missing owner are handled by 3b.0 / 3b.1 / Case 2 above — they always emit re-prefixed governance under the installing unit's slug; no widget fires for them.

When a `contributor` or `consumer` entity (per blueprint §3 `mastered_in`) points at a module that does NOT exist in the live catalog, group these by missing module and fire one `AskUserQuestion` per missing module.

**Design intent recap** (drives the option order and "(Recommended)" placement): for `contributor`/`consumer` rows the catalog owner is treated as optional infrastructure. A module is meant to be self-contained when its dependencies aren't deployed yet, and the analyst's own Stage 3b collision flow merges duplicates automatically when those dependencies arrive later. **Embedding locally is the friction-free default.**

- **question**: `"<Plural Label list, English comma-joined> should come from the <Missing Module Display Name or slug> module, but that module isn't deployed yet. What now?"`
- **header**: `"Module not deployed"`
- **multiSelect**: `false`
- **options** (in this order — option 1 first; there is no "wait for master" option):
  1. label: `"Set up <Plural Label> in this module for now (Recommended)"`
     description: `"This module deploys today. If you add <Missing Module Display Name> later, you'll be asked whether to share <Plural Label> across both modules — that's a quick reassignment, your existing records stay where they are. Until then, records live in this module."`
  2. label: `"Skip <Plural Label> entirely"`
     description: `"Remove <Plural Label> from this module. Anything in the design that referenced them is dropped."`

**"(Recommended)" placement**: always option 1. There is no "wait for master" option — every module deploys standalone; the catalog-owner-arrival flow (Stage 3b.0) handles the reassignment without data migration.

**Internal mapping**:
- Option 1 → `create-new` in this module's spec (this module is the entity's current owning module). Add a §7.2 🟡 note: *"<Plural Label> currently lives in this module. When <Missing Module Display Name> is added later, run the analyst on its blueprint and pick 'share via shared module' at the collision prompt to reassign — no data migration needed."*
- Option 2 → `dropped (out of scope)` annotation.

**Slug collision under option 1.** Entity slugs are globally unique. If the blueprint's bare `table_name` is already used by *another* module (e.g. blueprint wants `employees` but `northwind.employees` exists in the live catalog as a sales sample), option 1 can't create with the bare name. Fire a follow-up `AskUserQuestion`:

**Policy path:** `.slug_collision_naming` (global default; `context-prefix` / `module-prefix` / `reuse-existing`). Free-text "Other" answers are NOT cached (matches the not-written rules in admin `references/customizations-protocol.md`, 7.6).

- **question**: `"The name <Target Plural Label> is already used by the <Owner Module Display Name> module. What should we call our version?"`
- **header**: `"Naming"`
- **multiSelect**: `false`
- **options**:
  1. label: `"<expected_context>_<target> (Recommended)"` — e.g. `workforce_employees`, `finance_currencies`. Reads naturally and says what the table is for.
  2. label: `"<this_module_short>_<target>"` — e.g. `atscrm_employees`. Module-prefixed; fine when no clean context word fits.
  3. label: `"Use the existing <Owner Module Display Name> <Target Plural Label> after all"` — fall back to option 2 of Stage 3d, treat the existing entity as the link target.
  4. label: `"Other"` — runtime auto-adds; user types a free-text name. Analyst checks it doesn't collide before accepting.

Record the picked name on the new §3 entity in the spec and stamp `**Reconciliation:** create-new`. The §7.2 note from option 1 above gets the picked name substituted in (*"<Picked Plural Label> currently lives in this module..."*).

### 3e. Cross-scope link target resolution

**Policy path:** `.links.<blueprint_slug>.<field_name>` (keyed by blueprint+field because link targets often don't generalize across blueprints). If a future blueprint happens to declare an identical field-in-table combo, the path matches and auto-resolves; otherwise it prompts under its own key.

For every blueprint §5.3 / §6 row, the analyst resolves the target against the live catalog. Four outcomes:

| Outcome | Trigger | Prompt? |
|---|---|---|
| ✨ Clean match | Exactly one candidate AND its owning module is plausible for the expected role (e.g. matches the blueprint's `mastered_in`, or is a master module, or a similar-context domain) | No — wire silently |
| 💤 No match | Zero candidates | No — mark `dormant`, log silently |
| 🟡 Multiple candidates | Two or more candidates fit | Yes — multi-candidate widget |
| 🟡 Single candidate, suspicious context | One candidate exists BUT its owning module's context disagrees with the blueprint's expectation (blueprint says `mastered_in: hcm-core` workforce; live match is `northwind` sales sample) | Yes — wrong-context widget |

**Multi-candidate widget** (≥2 candidates fit):

- **question**: `"<This Singular Label> should link to a record in another module. Several candidates fit — which one?"`
- **header**: `"Multiple matches"`
- **multiSelect**: `false`
- **options**:
  - one per candidate, label = `"<Plural Label> in <Module Display Name>"`, description = `"<one-line description from the existing entity>"`
  - then: `"Create our own here under a different name"`, description = `"Set up <suggested_local_name> as a new table in this module so we don't have to pick from the candidates above. The other tables stay where they are. When a catalog <Expected Context> module arrives later, you can merge."`
  - then: `"Skip this link for now"`, description = `"Don't connect anything. You can add the link later, when the right module is in place."`

**Wrong-context widget** (1 candidate, suspicious owning module):

- **question**: `"<This Singular Label> should link to <Target Plural Label> when <trigger event in plain English>. Your semantic model has <Target Plural Label> in the <Owner Module Display Name> module (<one-word context, e.g. 'sales sample'>), not a <expected context> module. What should we do?"`
- **header**: `"Link target"`
- **multiSelect**: `false`
- **options** (recommended choice depends on suspicion level — see below):
  1. label: `"Skip the link for now"`
     description: `"Don't wire <This Plural Label> to any <Target Plural Label> table. When a <expected context> module is deployed later, we can add the link then. The hire flow still works — the candidate's status moves to hired without writing to another table."`
  2. label: `"Link to <Target Plural Label> in <Owner Module Display Name>"`
     description: `"Wire <this_module>.<field_name> to that table. Pick this only if <Owner Module Display Name>'s <Target Plural Label> is acting as your stand-in <expected context> in this instance."`
  3. label: `"Create our own <Target Plural Label> here under a different name"`
     description: `"Set up <suggested_local_name> (e.g. `workforce_<target>` or `<this_module_short>_<target>`) as a new table in this module. The existing <Owner Module Display Name> records stay untouched. When a real <expected context> module arrives later, you can merge our table into a shared module."`

**"(Recommended)" placement** for the wrong-context widget:

- **Default → option 1** ("skip"). Wrong-context matches usually shouldn't be silently wired; the user should make a deliberate choice when the catalog module arrives.
- **Switch to option 3** ("create our own") only when the blueprint's `related_modules` lists the expected context module AND there is no plausible reason to use the suspicious candidate (i.e., they really are unrelated concepts).
- **Never auto-recommend option 2** ("link to wrong-context") — that always needs a deliberate choice.

**Internal mapping** (both widgets):

- Pick a specific candidate → spec §6 row resolves to that candidate; emit the FK column pointing at it.
- "Create our own here under a different name" → analyst adds a new §3 entity to the spec under the disambiguated name with `**Reconciliation:** create-new`, with field shape inherited from the blueprint's intent for that target (best-effort from the blueprint's §5.3 / §6 description). FK points at the local entity. Also add a §7.2 🟡 note: *"<Local Plural Label> currently lives in this module as a workforce-context alternative to <Owner Module Display Name>'s <Target Plural Label>. When a catalog <expected context> module is added later, run the analyst on its blueprint to merge."*
- "Skip" → §6 row marked `dormant`; no FK column emitted.

**Naming the local alternative** (option 3):

When suggesting `<suggested_local_name>`, pick in this order:
- `<expected_context>_<target>` if the expected context is short and well-known (`workforce_employees`, `finance_currencies`).
- `<this_module_short>_<target>` otherwise (`atscrm_employees`).
- Avoid generic suffixes (`_internal`, `_local`, `_new`); they don't say what the table is for.
- Confirm the chosen name doesn't collide with anything else in the live catalog before proposing it.
