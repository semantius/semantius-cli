*Reference for `semantius-architect`. Loaded on demand; the resident SKILL.md stage index points here.*

### Stage 3: Propose the entity list

With the naming convention locked in, draft the entities from your own knowledge of the domain.

- If a template vendor was chosen, start from that vendor's core object model, the entities a fresh-install user of that product would encounter first, and trim to what this user actually needs. Don't include obscure tables just because the vendor ships them.
- If agent-optimized, start from first principles: what happens in this system? who acts? what do they act on? what gets recorded? Name each entity with a self-describing singular noun.
- In either case, weave in any extra entities the user flagged in their Stage 1 requirements, and drop entities that clearly don't apply.

> **🛑 Template mode: name the vendor object each entity maps to.** When `naming_mode` is `template:<vendor>`, every proposed entity **must** explicitly cite the vendor object it mirrors, in a fourth column "Vendor object". This forces you to check your own confidence. If you can't name a specific vendor object with high confidence, you don't actually know the vendor's schema well enough to claim template-fidelity, say so in one sentence and offer the user either (a) switch to agent-optimized, (b) let them paste the vendor's object list, or (c) proceed but mark the entity as "inspired-by, not canonical".
>
> **Watch for domain ambiguity traps.** Some concepts are modeled very differently across vendors and editions:
> - **"Lead"**, Salesforce has a dedicated `Lead` object that converts to Contact+Account+Opportunity. HubSpot (since 2023) has a dedicated `Lead` object (FQN `LEAD`, 0-136) separate from `Contact`; older HubSpot accounts treated a lead as a `Contact` with `lifecycle_stage=lead`. Pipedrive has `Lead` separate from `Person`. Zendesk Sell has `Lead` separate from `Contact`.
> - **"Ticket" vs "Case" vs "Incident"**, Zendesk uses `Ticket`, Salesforce Service Cloud uses `Case`, ServiceNow uses `Incident`/`Problem`/`Change` as distinct objects, Jira Service Management uses `Issue` of a specific type.
> - **"Opportunity" vs "Deal"**, Salesforce/MS Dynamics use `Opportunity`; HubSpot/Pipedrive use `Deal`.
>
> When the user's ask sits on one of these ambiguity lines (a lead manager, a helpdesk, a deal/opportunity tracker), **state which vendor object you're picking and why before proposing the entity list**, so the user can correct a wrong pick before a dozen fields are built on top of it.

Present the list as a table with **Table name**, **Singular label**, **Purpose (one line)**, and, in template mode only, a **Vendor object** column showing the exact vendor object name (e.g., `HubSpot Lead (0-136)`, `Salesforce Contact`, `Zendesk Ticket`).

Then ask the user a single open question: *"Does this entity list look right, or would you like to add, remove, rename, or merge any?"* Loop on their feedback until they confirm. **When the user renames an entity that carries an inherited `catalog code` (catalog-clone or prior version), apply the silo-rename rule under `catalog code` in §3: pin the catalog code to the pre-rename concept and keep `role` / `mastered in`; change only `data_object` and labels — unless the user says it is a genuinely new concept.** Keep the list tight, 6–15 entities is the sweet spot for most mid-sized systems; if you feel the urge to go over 20, that's a signal you're over-modeling.

#### `necessity` rule — greenfield blueprints carry no optionals

**In greenfield mode, every entity in the final blueprint is `necessity: required`.** Greenfield blueprints are tailored to *one specific user's request* during a live conversation. The conversation is the place to scope what's in and what's out — not the blueprint's `necessity` column.

This is the opposite of catalog blueprints, which are intentionally generic ("an ATS supports many configurations of recruitment_events / talent_pools / referrals / ...") and use `necessity: optional` so each consuming org can opt in. A greenfield blueprint is built FOR this org from scratch; ambiguity about scope belongs in the architect conversation, not in markers the analyst has to ask about later.

**Mode-specific rules:**

| Mode | `necessity` policy |
|---|---|
| **Greenfield Create** | All `required`. **No `optional` entities ever in the final blueprint.** Scope decisions happen during this stage's entity-proposal loop. |
| **Catalog-Clone Create** | Inherit `necessity` markers verbatim from the source blueprint. The Customize-the-clone conversation may flip an entity from optional → required (the user wants it for sure) or drop it entirely (the user doesn't want it); both edits are fine. |
| **Customize** | Preserve existing `necessity` markers. The customize conversation can flip optional → required or drop entirely, but never add new optionals. |
| **Audit / Extend / Rebuild** | Treat the inherited values as authoritative; flag any greenfield-style file containing optionals as a Warning (see Mode B audit). |

**Proactively scope adjacent concepts during the entity-proposal loop.** Instead of marking borderline entities as `optional` for the analyst to ask about later, ask about them here. Pattern:

After presenting the core entity list, identify 3-6 *commonly-related but not always wanted* concepts for this domain.

**Customizations consultation first.** For every candidate concept, check `.optionals_decided.<slug>` in `$CUSTOMIZATIONS_FILE` before deciding whether to include it in the multiSelect:

- Verdict `included` → silently add the concept to the entity list as `required`. Do not include it in the multiSelect.
- Verdict `excluded` → silently drop the concept. Do not include it in the multiSelect.
- No entry → the concept appears in the multiSelect as today.

Only fire the multiSelect if at least one concept remains un-decided. On answer, write each verdict back per concept (per the "Optional entity verdict" row in `../../semantius-admin/references/customizations-protocol.md`):

```bash
DATE=$(date +%Y-%m-%d)
PROV="decided ${DATE} during ${THIS_BLUEPRINT} deploy"
[ -f "$CUSTOMIZATIONS_FILE" ] || printf 'version: "1.0"\n' > "$CUSTOMIZATIONS_FILE"
# For each concept the user CHECKED:
yq -i ".optionals_decided.${SLUG} = \"included\" | .optionals_decided.${SLUG} lineComment = \"${PROV}\"" "$CUSTOMIZATIONS_FILE"
# For each concept the user did NOT check:
yq -i ".optionals_decided.${SLUG} = \"excluded\" | .optionals_decided.${SLUG} lineComment = \"${PROV}\"" "$CUSTOMIZATIONS_FILE"
```

Their answer is binding: selected concepts join the entity list as `required`; unselected concepts are not in the blueprint at all.

Example for a roadmap tool:
- Core list confirmed: `features`, `ideas`, `releases`, `feedback`, `tags`
- Then the multiSelect: *"Roadmap tools commonly also track these. Want any of them in your module?"*
  - Master Features — epic-level work items aggregating features across releases
  - Requirements — sub-tasks or acceptance criteria belonging to one feature
  - Personas — target user personas features and ideas can be tagged to
  - Comments — threaded discussion attached to features or ideas
- User picks two; those two get added to §3 as `necessity: required` alongside the core list. The other two are not mentioned again.

This pattern resolves scope at the architect stage where it belongs. The analyst then never has to ask scope questions for greenfield blueprints — it goes straight to catalog reconciliation and field-level work.

**Why not just mark them optional?** Because `necessity: optional` is a poor proxy for "user might want this". It defers a scope decision to a downstream skill, where the user has lost the conversational context to make the call. The user is right here, in the architect conversation, with the context fresh — make the decision now.

#### `data_object`, `singular`, `plural`, `role`, and `mastered in` policy (greenfield + catalog-clone)

The §3 catalog columns are: `# | data_object | catalog code | singular | plural | role | mastered in | mastered label | necessity | entity_type | write tier | notes`.

- **`data_object`** — the backticked snake_case `table_name` and **nothing else** (no parenthesized label). Lower snake_case `[a-z][a-z0-9_]*`, always plural form (`candidates`, not `candidate`). Must equal the entity's §2 `data_object`. This is the **local / dialect** deployed name.
- **`catalog code`** (blueprint_version 3.0+) — the entity's catalog uber-model code (lower snake_case plural, backticked), recorded **beside** the local/dialect `data_object`. The deployer stamps it into `entities.catalog_entity_code` as write-once identity. **Agent-optimized self-describing naming: catalog = local** (set it equal to `data_object`). When the deployed name is a vendor dialect (`accounts` for `customers`) or a silo rename (`erp_vendors` for `vendors`), `catalog code` carries the catalog concept; default to `data_object` rather than inventing a catalog name you cannot confidently identify. Catalog-clones inherit the source slice's catalog code.

**Renaming a catalog-derived entity is a silo rename — the catalog code stays pinned.** When the user renames an entity that already carries an inherited `catalog code` (a catalog-clone, or a prior version of this blueprint), do **not** re-derive `catalog = local` from the new name. The rename changes `data_object` and the `singular` / `plural` labels only; the `catalog code` stays equal to the **pre-rename catalog concept** (so renaming `incidents` → `issues` in a starter cloned from `itsm-incident-mgmt` keeps `catalog code: service_incidents`, with `data_object: service_issues`). Likewise the entity's `role` and `mastered in` / `mastered label` **persist across the rename** — a local rename does not redefine the concept, so an `embedded_master` keeps pointing at its catalog owner. Re-baptizing the catalog code to the new local name, or dropping `mastered in`, silently severs the lineage the catalog owner uses to recognize and promote/merge this entity when it later installs — it would then create a duplicate instead of adopting the renamed entity. (If the user states the rename is a genuinely *new, distinct concept* rather than a different name for the same one, then it is no longer a silo rename: treat it as a net-new entity — `catalog = local`, role/`mastered in` re-derived from scratch. The default is preserve; severing requires the user to say so.)
- **`singular`** — the entity's singular display label (e.g. `Candidate`). Must equal the parenthetical in this entity's §7 lifecycle heading. Maps to the platform `entities.singular_label`.
- **`plural`** — the entity's plural display label (e.g. `Candidates`). Must equal the §2 `Name` column and the §2 Mermaid node label. Maps to the platform `entities.plural_label`.

Use one of four role values in §3:

- **`master`** — this module is the catalog owner. `mastered in` = `-`, `mastered label` = `-`.
- **`embedded_master`** — this module declares the entity locally for self-containment, but a *different* module is the intended catalog owner. Used when (a) the blueprint must stand alone (catalog-clone) even though a future shared master will own this concept, or (b) greenfield blueprints reference a system-of-record that may or may not be deployed in the user's instance. `mastered in` = `<owner_module_slug>`, `mastered label` = owner module's display name. Example: `candidates` in `hiring-starter` with `mastered in: ats-candidate-crm`, `mastered label: Candidate CRM`.
- **`contributor`** — entity is mastered elsewhere AND this module participates in its workflows (writes some fields). `mastered in` and `mastered label` carry the owner. Example: `skill_profiles` in `ats-candidate-crm` with `mastered in: lms-skills`, `mastered label: Skills and Learning Paths`.
- **`consumer`** — entity is mastered elsewhere AND this module only reads it. `mastered in` and `mastered label` carry the owner. Example: `career_aspirations` with `mastered in: talent-succession-career`, `mastered label: Succession and Career Planning`.

**`mastered label` column rule:** whenever `mastered in` is not `-`, fill `mastered label` with the owner module's display name (the same string that would appear as `system_name` in the owner's blueprint frontmatter). It names the owner module, NOT this entity (the entity's own labels are `singular` / `plural`). Never leave `mastered label` empty when `mastered in` is filled. For platform built-ins (`users`, `roles`), use `_(platform built-in)_` in both `mastered in` and `mastered label`.

Why both: `mastered in` is the slug the analyst uses for cross-module FK resolution; `mastered label` is the display string the analyst uses in user-facing prompts ("Candidates is needed for `Candidate CRM`, but `Candidate CRM` isn't deployed yet" reads better than "`ats-candidate-crm` isn't deployed yet").

`embedded_master` is the right choice when the blueprint must be deployable today even though the catalog owner doesn't exist yet, but you want the analyst to migrate the entity automatically once the owner installs. The blueprint contract is: *"this entity will belong to `<mastered_in>` once that module is in place; until then, host it here."* **Renaming the entity's local name does not break this contract:** an `embedded_master` keeps its `mastered in` / `mastered label` and its pinned `catalog code` across a rename (see the silo-rename rule under `catalog code` above), because a different local name is still the same catalog concept owned by `<mastered_in>`.

**Presence-conditional `is_required` on §5.3 edges.** A `required` cross-scope edge is **presence-conditional**: it becomes a mandatory FK at deploy time only when the target entity is installed in the same deploy. It NEVER forces the target to install. The vocabulary in §5.3b's `delete_mode` column makes this explicit:

- `none` — fully optional edge from this scope's perspective.
- `none (required-if-present)` — the catalog owner declares the edge required, but this scope treats it as presence-conditional: target installed → FK is mandatory; target absent → edge is dormant (no FK column, no constraint).
- `⚠ audit: <reason>` — a required-composed-child-out-of-scope flag (see Writing Convention 9). The architect surfaces; the analyst expects the source data fixed.

For §5.3a (this scope's masters point outbound at sibling targets), the `delete_mode` vocabulary is the normal Semantius set (`restrict` / `clear` / `cascade`). For §5.3b (context edges driven by the catalog owner, shown for informational completeness when the in-scope endpoint is `embedded_master` / `consumer` / `derived`), the vocabulary expands as above. The architect emits the resolved `delete_mode` and `fk_format` directly into the §5 row so the analyst consumes verbatim.
