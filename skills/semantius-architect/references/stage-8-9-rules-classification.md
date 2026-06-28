*Reference for `semantius-architect`. Loaded on demand; the resident SKILL.md stage index points here.*

### Stage 8: Business-rule emission

Computed fields, validation rules, and the 15-family scan walk moved to the analyst skill. The blueprint stops at entity level: §8 declares permissions and business rules at the intent level only (`rule_name + data_object + source_flag + intent`). The analyst converts each blueprint §8.2 rule into JsonLogic and runs the full scan walk in its Stage 10.

**Approvals are not a §8.2 source flag.** An approval is a gated lifecycle transition: a §7 `requires_permission? = ✓` row into the approved state, with the matching `<system_slug>:approve_<noun>` `workflow-gate (lifecycle)` row in §8.1 — plus the §9 RACI Accountable actor when there's a named approver. Genuine multi-party approval (a count of distinct approvers) is a field-level rule the analyst authors; the blueprint just declares the gated transition.

### Stage 9 — Classify each entity's `entity_type`, then derive its write tier (D9)

Walk every entity once and assign its **`entity_type`** — the closed 6-way data-class axis (`operational_workflow | operational_record | catalog | junction | computed | unclassified`) mirroring upstream `data_objects.entity_type`. `entity_type` is the **primary** classification and feeds the §3 `entity_type` column; the per-entity **`write tier` is DERIVED from it** (never the other way round), which in turn feeds the §3 `write tier` column and the permissions §8.1 declares.

**Two paths to the class.**

- **Carry-forward (catalog-clones).** When the entity descends from an upstream `data_objects` row whose `entity_type` is **classified** (not `unclassified` / null), that value is authoritative — carry it through verbatim, do not re-derive. Upstream is ~81.5% classified, so this is the common path for clones. Treat an upstream `unclassified` / null as **absent** and derive locally; never propagate `unclassified` as a decision.
- **Derive (all greenfield, plus any `unclassified` upstream tail).** Greenfield has no ancestor, so it always derives. Run the **derivation ladder** below; first match wins.

**Derivation ladder (first match wins):**

1. **Platform built-in** (`users`, `roles`, `permissions` declared in §3 only for self-containment) → classify by data-kind: `users` → `operational_record`; `roles` / `permissions` → `catalog`. (Built-ins are dedup'd at deploy, so this is informational, but emit it.)
2. **Pure junction (binary or N-ary)** — read **§5**: a link table with **two or more** `parent` FKs, no own attributes, and no lifecycle → `junction` (`entity_type = junction` auto-combines **all** legs — a binary `(user, role)` link or an N-ary `(user, role, tenant)` link work the same way). But an N-ary link that carries **its own attributes or a lifecycle** is an association class → classify it `operational_record` / `operational_workflow`, **not** `junction`.
3. **No direct user writes, every field derived** → `computed`. Rare at blueprint level (it is usually a field-level fact), so this almost never fires for the architect; leave it to upstream / the analyst unless the entity is unambiguously a computed rollup.
4. **Reference / config / lookup** — admin-maintained, **no gated lifecycle** — when **all three** of the old admin-tier test hold → `catalog`:
   - **small and slowly-changing** (hundreds of rows at most, edited a handful of times a month, not continuously);
   - **referenced by operational entities as a lookup / category / stage / type / source** (other §3 entities FK *at* it to classify themselves; operational entities point *outward* at reference data, reference data is pointed *at*);
   - **typically ships seeded values** with the module or the org's initial config (the allowed sources / stages / categories / types / priorities / currencies / departments list, decided once and only occasionally extended).
   This is the Stage 9 admin-tier heuristic **preserved and promoted** — the admin test was always the `catalog` test.
5. **Has a gated lifecycle state machine** — read **§7**: ≥1 lifecycle-states row, with one initial state and ≥1 terminal state, normally ≥1 `requires_permission?` gate. A single gated transition (e.g. `draft → submitted`) qualifies; state count is irrelevant, and a submit-then-lock posture is orthogonal and never makes it `catalog` → `operational_workflow`.
6. **Otherwise** → `operational_record` (the default for an entity that captures work happening but has no gated lifecycle).

**Then DERIVE the write tier from `entity_type`** (this replaces the old direct tier classification):

| `entity_type` | derived `write tier` |
|---|---|
| `catalog` | `:admin` |
| `operational_workflow` | `:manage` |
| `operational_record` | `:manage` |
| `junction` | neighbor-based — `:manage` by default (follows its parents; flip toward `:admin` only when **all** parent legs are `catalog`) |
| `computed` | `:read` (read-only) |
| (`embedded_master` whose catalog owner is absent and may shift the tier) | `:manage` _(pending)_ — the pending qualifier is orthogonal to the class |

Never invent an `entity_type` outside the closed set, and never derive the class *from* the tier.

Common `catalog` shapes by domain (illustrative, not exhaustive):

- ATS: `candidate_sources`, `application_stages`, `departments`
- CRM: `lead_sources`, `pipeline_stages`, `industries`, `currencies`
- ITSM: `priorities`, `categories`, `ticket_types`, `sla_definitions`
- HRIS: `job_titles`, `pay_grades`, `leave_types`, `cost_centers`, `departments`
- Product Roadmap: `feature_types`, `tags`, `release_trains`

Common `operational_*` shapes (the records that capture *work happening*): `candidates`, `job_applications`, `interviews`, `offers`, `tickets`, `incidents`, `leads`, `opportunities`, `features`, `votes`, `comments`, `notes`. Those with a gated §7 lifecycle (a candidate's hire flow, an offer's approval, a ticket's close) are `operational_workflow`; the rest are `operational_record`.

**Edge entities deserve a moment's thought.** `users` is a built-in (ladder step 1 → `operational_record`) dedup'd at deploy, so its class is informational. Junction tables (`hiring_team_members`, `feature_votes`, `campaign_members`) are `junction` (ladder step 2) and write `:manage` unless **all** parent legs are `catalog`. Entities like `releases` or `sprints` that are *named time-windows* are `operational_record` (added every cycle); entities like `release_trains` or `pipelines` (the *configurations*) are `catalog`.

**Surface the classification to the user before §3 is finalized.** Present a short table showing both the class and the derived tier:

> **Entity classes and permission tiers.** Walking the entities:
>
> | Entity | entity_type | Write tier (derived) | Reason |
> |---|---|---|---|
> | `candidate_sources` | catalog | :admin | small lookup, referenced by `candidates` / `job_applications`, ships seeded values |
> | `application_stages` | catalog | :admin | pipeline definition, referenced by `job_applications`, ships seeded values |
> | `job_applications` | operational_workflow | :manage | has a gated §7 lifecycle (screening → offer → hired) |
> | `interview_notes` | operational_record | :manage | bulk records, no gated lifecycle |
> | `hiring_team_members` | junction | :manage | pure link table (2 `parent` legs) |
> | `interview_panel_members` | junction | :manage | N-ary link table (3 `parent` legs: interview × user × panel_role), no own attributes |
>
> Catalog entities are writeable by `<slug>:admin`; workflow / record / junction by `<slug>:manage`. The hierarchy chain (`admin → manage → read`) means anyone with `admin` can also do `manage`-level work. Look right?

Loop on user feedback until they confirm. The classification feeds the §3 `entity_type` column and the derived `write tier` column (both written in Stage 13) and the §8.1 permission enumeration.

**Master-concept cluster hints.** During the same Stage 9 walk, also identify entities that are classic **master concepts** — entities that other domain modules across the catalog are likely to reference as shared data rather than redeclaring locally. Emit a `**Shared master cluster:** <cluster>` annotation in §3 for each one. The hint travels inside the self-contained model and shapes the deployer's default suggestions at the master-promotion prompt, without binding the tenant to any specific taxonomy.

The hint is **optional and per-entity**; omit it when the entity is not a master concept. Default cluster names the analyst should use when one fits:

| Entity examples | Suggested cluster |
|---|---|
| `currencies`, `cost_centers`, `budget_periods`, `ledger_accounts`, `fiscal_years`, `tax_rates`, `gl_accounts` | `finance` |
| `vendors`, `customers`, `partners`, `suppliers` | `parties` |
| `departments`, `business_units`, `locations`, `sites` | `organization` |
| `products`, `product_categories`, `skus` | `products` |
| `employees`, `job_titles` | `employees` |

The mapping is not closed; coin a new cluster name when the entity is a recognizable master concept that doesn't fit one of the above (e.g. `pricing` for `price_lists`, `pricing_tiers`; `geo` for `countries`, `regions`, `time_zones`). Use snake_case. Prefer a domain noun the user would recognize at the prompt over an entity-name suffix.

The hint never overrides the user — the deployer surfaces it as a recommendation at Stage 2d follow-up 1, and the user can always pick a different host module or type a custom name at the prompt. **Authors review the cluster classification at confirmation time, same as the `entity_type` classification.** Surface both classifications in the same Stage 9 confirmation table when masters are present:

> | Entity | entity_type | Write tier | Reason | Master cluster |
> |---|---|---|---|---|
> | `vendors` | catalog | :admin | small lookup, shipped seeded values | `parties` |
> | `cost_centers` | catalog | :admin | reference data, ships seeded | `finance` |
> | `(other entities)` | operational_record | :manage | bulk records, changes continuously | (none) |

**Narrow-tier override.** The narrow tier is a Stage 10 (W4n) decision layered on top of the Stage 9 class, not an `entity_type` value. An entity whose primary writers are external participants (e.g. `interview_feedback` writers get `ats:interview` rather than `ats:manage`) keeps its derived §3 `write tier` (`:manage`, from `operational_workflow` / `operational_record`); Stage 10 then declares the narrow tier as a `narrow`-tier row in §8.1 plus a `narrow_write` rule in §8.2 (narrow is never a §3 `write tier` value and never an `entity_type` value). `catalog` entities are never narrow-tier-overridden (the two sit at opposite ends of the authority axis).

**Special case: purely operational model.** If the walk finds zero `catalog` entities (no reference/config tables — the model is all `operational_*` records, workflows, and junctions), drop to **two baseline permissions** (`<slug>:read` and `<slug>:manage`) and document the reason in §8.1 (the two-permission fallback). Don't fabricate a config entity just to justify a third permission. Most non-trivial modules will have at least one `catalog` entity; a purely operational module is a real shape (a simple `notes` or `comments` module, for instance) and the two-permission fallback is correct for it.

**Special case: purely reference model.** If the walk finds *only* `catalog` entities and no `operational_*` ones (a pure lookup module: `countries`, `currencies`, `locales`), keep the `entity_type` as `catalog` for each (the class is honest), but drop to two permissions (`<slug>:read` and `<slug>:manage`) and **set every `write tier` to `:manage`** rather than the `:admin` the class would normally derive. The admin tier is meaningless when there is no operational layer below it to distinguish from, so this is the one place the derived tier is deliberately flattened (note it in §8.1). The lookup module is "configuration" in spirit, but the inner split doesn't exist.
