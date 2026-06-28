*Reference for `semantius-architect`. Loaded on demand; the resident SKILL.md stage index points here.*

### Stage 6 — Related modules (neighborhood walk)

> **🛑 This is a mandatory, standalone confirmation gate.** It fires every time, in Create, Extend, and Rebuild. Skipping it or collapsing it into another turn's prose is an authoring bug, even when the conversation is mid-flow on an unrelated scope change. If you find yourself writing "Budgeting stays, CRM stays" as a one-liner, stop and surface the full Stage 6 proposal block instead.

`related_modules` is a discovery tag for humans browsing the catalog (no skill consumes it for logic), but its accuracy matters on two fronts: (a) an under-declared list quietly hides the model's neighborhood from anyone scanning the catalog and silently widens the data-silo problem the deployer is built to surface; and (b) **this list is the input that Stage 7 (cross-model link suggestions) walks** — a missing domain here means missing §6 rows there, so produce this list before reaching for §6. Build the list yourself from analyst knowledge (same posture as the entity list in Stage 3), then surface it as its own proposal block under a visibly labeled "Stage 6 — Related modules" (or just "Related modules") heading for prose review. Do **not** offload the discovery to the user via AskUserQuestion or by asking "what neighbors should this have?" — the analyst owns the proposal; the user reviews it.

**`related_modules` describes the system's *neighborhood* in the enterprise, NOT just what's shadowed by §3 entities.** The walk has two axes that must both run; do not collapse them to just the entity-driven axis.

**Axis 1 — System-type walk (do this first).** Independent of which entities are currently in §3, ask: *"What does a typical instance of this kind of system sit next to in a typical organization's enterprise stack?"* The answer is driven by the system's `domain` and the kind of work it represents, not by which fields/tables happen to be in this model. A Product Roadmap is next to OKR (strategic alignment), Issue Tracking (feature handoff), Release Management (delivery), CRM (customer requests), Identity & Access (people), AND Budgeting / Finance (because features cost money in every organization, whether or not *this* roadmap tracks cost internally). An ITSM helpdesk is next to ITAM, CMDB, HRIS, Identity & Access. An ATS is next to HRIS, Workforce Planning, Identity & Access. Produce this list from analyst knowledge of the system's domain, before walking §3.

**Axis 2 — Entity-driven shadowing walk.** Then walk the §3 entity list and apply the shadowing test for each entity: *"would a dedicated enterprise system model this concept in meaningful depth?"* If yes, the corresponding domain belongs in `related_modules` if it's not already on the list from Axis 1. Familiar shadows: `objectives` shadows OKR (which adds key results, check-ins, confidence updates), `users` shadows Identity & Access (auth, group membership, lifecycle), `vendors` shadows Vendor Management (onboarding, risk, contract metadata), `assets` shadows CMDB / ITAM (discovery, lifecycle, depreciation), `tickets` shadows ITSM, `employees` shadows HRIS, `releases` shadows Release Management (release trains, environments, deployment pipelines), `features` shadows Issue Tracking once they hand off to delivery (sprints, sub-tasks, branches, PRs), and so on. Self-contained models must shadow neighboring concepts internally; that shadowing is a positive signal a shadowed domain is a neighbor — but **the absence of an internal shadow is NOT evidence the domain is not a neighbor.** Axis 1 catches what Axis 2 misses. Junctions and weak shadows (`comments`, `tags` that no enterprise system materially expands on) are skipped; on borderline cases the bias is toward inclusion.

**Removing internal entities NEVER removes a related domain.** When the user removes scope ("no cost constraints", "drop attachments", "we don't track customer requests in this system"), the agent must NOT conclude that the corresponding sibling domain has stopped being a neighbor. The neighborhood is about *what this kind of system sits next to in the enterprise*, not *what entities are currently in §3*. A roadmap with no `cost_centers` is still next to Budgeting because roadmap features get funded somewhere. A helpdesk with no `vendors` is still next to Vendor Management because vendor support contracts exist somewhere. The user's intent "no cost in this system" is **not** equivalent to "Budgeting is not a neighbor" — those are different statements. Apply Axis 1 to recover the neighbor regardless of removal. **Concrete trigger:** if the user removes entities for any reason, do NOT remove the corresponding `related_modules` entry. Re-derive `related_modules` from Axis 1 + Axis 2; the result will keep the neighbor.

**Deferred-scope special case.** When the user explicitly defers scope to a sibling domain ("cost tracking belongs in a Budgeting domain", "vendor master is in Vendor Management"), the destination domain stays — and a §6 hint row bridging back is *expected* because the deferral *is* the integration point. This is a strict subset of the rule above (removal in any form keeps the neighbor); the deferred-scope phrasing just makes the §6-row implication explicit. **The §6 row and the `related_modules` entry are the entire deferral record.** Do *not* add prose narration of the deferral anywhere in the file — not in §1, not in §3 entity descriptions, not in §7. Both representations are machine-readable, both are checked by audit, and both survive a re-author. A "this used to include cost tracking, see §6" sentence in §1 is decision-log narrative, which §7's audit already bans (rule below); §1 has the same constraint and for the same reason.

**The parenthesized entities in your shadowing-walk descriptions are direct inputs for Stage 7.** When you write `OKR — typical neighbor of Product Roadmap; OKR systems add key results, check-ins, confidence updates`, the parenthesized "key results, check-ins, confidence updates" are not flavor text — those are the sibling entities Stage 7 will walk for inbound FK candidates against this model's entities. Write the parenthetical *concretely* (named entities, not vague descriptions), because Stage 7 reads it.

**Look-ahead loop:** if while running Stage 7 you discover a sibling target whose owning domain isn't on this list, return here and add it before continuing — Stage 7's per-domain walk only fires for domains that appear here.

**Mandatory output format for Stage 6.** Produce the `related_modules` list as a single block with each entry showing **(a)** which axis it came from (system-type, entity-shadow, deferred-scope, or multiple), **(b)** the concrete sibling entities the agent will pass to Stage 7. Format:

> **Related modules.** Walking the system type and the §3 entities:
>
> - **`OKR`** — system-type neighbor of Product Roadmap (strategic alignment); also entity-shadow on `objectives`. Sibling entities: `key_results`, `check_ins`, `confidence_updates`.
> - **`Identity & Access`** — system-type neighbor; entity-shadow on `users`. Sibling entities: `groups`, `team_memberships`, `sessions`.
> - **`Release Management`** — system-type neighbor (delivery side); entity-shadow on `releases`. Sibling entities: `deployments`, `environments`, `release_trains`.
> - **`Issue Tracking`** — system-type neighbor (engineering handoff); entity-shadow on `features`. Sibling entities: `issues`, `epics`, `sprints`.
> - **`CRM`** — system-type neighbor (customer request capture); no internal shadow but the planned §6 link to `accounts` makes it a clear neighbor. Sibling entities: `accounts`, `contacts`, `opportunities`.
> - **`Budgeting`** — system-type neighbor (features cost money in every org); also a deferred-scope target since cost tracking was scoped out. Sibling entities: `cost_centers`, `cost_allocations`, `budgets`.
>
> Add, drop, or rename any?

The "Sibling entities" lists feed Stage 7 directly. Empty sibling-entity lists are visible misses; if a domain genuinely has no entities that would FK to/from this model's entities, say so explicitly ("no inbound or outbound FK candidates expected — overlap-only via X").

Then surface the proposal:

> **Related modules.** Walking the entities, I'd tag this model's neighborhood as:
>
> - `OKR` — driven by `objectives` (a dedicated OKR system adds key results, check-ins, confidence updates)
> - `Identity & Access` — driven by `users` (auth, group membership, lifecycle)
> - `Release Management` — driven by `releases` (release trains, environments, deployment pipelines)
> - `Issue Tracking` — driven by `features` once they hand off to engineering (sprints, sub-tasks, branches, PRs)
> - `CRM` — driven by the planned §6 link to `accounts` (customers requesting features)
>
> Add, drop, or rename any?

Loop on user feedback until they confirm, the same way the entity list is confirmed in Stage 3. After confirmation, the list feeds Stage 7's per-domain walk and is written into the front-matter in Stage 13.
