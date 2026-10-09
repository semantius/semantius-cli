*Reference for `semantius-architect`. Loaded on demand; the resident SKILL.md stage index points here.*

### Stage 7 — Cross-domain handoffs and link hints

> **Architect scope.** §6 carries the blueprint's cross-domain *context* in the template's four sub-sections: **§6.1 Master consumers** and **§6.4 Master providers** (derived from §3 `role` / `mastered in` — which other modules embed this module's masters, and which modules own the masters this module embeds), plus **§6.2 Outbound** / **§6.3 Inbound handoffs** (events the module publishes or reacts to, with trigger names, payloads, integration modes, friction levels). §6 does **not** carry a `From | To | Verb | Cardinality | Delete` FK-link table — per-FK cross-domain column resolution against the live catalog is the analyst's job (analyst Stage 2g + Stage 4). Use the template's §6.1–6.4 column layout verbatim.
>
> **Greenfield mode**: **keep §6 and its four sub-blocks present** even when the user did not ask for cross-domain context — each empty sub-block carries the canonical `_(none: <short reason>)_` placeholder. Never omit the section, never leave a bare empty heading. Draft the handoffs and show them in the proposal below: the rows the user accepts count as requested and are written in Stage 13; rows never shown to the user are not written, and their sub-block keeps the placeholder.
>
> **Catalog-Clone mode**: inherit §6 from the source blueprint — but **flatten any `<details>` / `<summary>` collapsibles to plain markdown tables; replace any inherited old-form free-text stub with the canonical `_(none: <short reason>)_` placeholder** (catalog sources carry both) — then let the user trim or extend; a sub-block trimmed empty keeps its heading with the placeholder.

The blueprint is atomic by design (one bounded domain), but Semantius is a unified catalog where many modules coexist. §6 records two kinds of cross-domain context: **which modules embed or provide this module's master entities** (§6.1 / §6.4, derived from §3 roles) and **which events this module publishes or reacts to** (§6.2 / §6.3 handoffs).

**§6 is informational context, not a contract.** It tells a human reader (and the analyst at reconciliation) how this module sits in the catalog. Per-FK cross-domain column resolution and shared-master name-collision detection (`vendors` vs `suppliers`, `users` vs `employees`) happen at deploy time against the live catalog — the architect does not predict them, and §6 carries no `From | To | Verb | Cardinality | Delete` FK-link table.

#### §6.1 Master consumers — other modules that embed this module's masters

| data_object | other module / domain | role | necessity | notes |

One row per §3 entity (`role = master`) that another module is expected to embed or read. The §6.1 `role` cell is `embedded_master` (the other module hosts a shell until this module installs) or `consumer` (read-only). For a leaf domain module whose masters nothing else consumes yet, §6.1 is typically empty — keep the heading and write the canonical `_(none: <short reason>)_` placeholder.

#### §6.4 Master providers — modules that own masters this module embeds

| data_object | role here | necessity | catalog owner(s) | slice notes |

One row per §3 entity whose `role` is `embedded_master` / `contributor` / `consumer` — i.e. every §3 row whose `mastered in` is not `-`. `role here` mirrors the §3 role; `catalog owner(s)` is the owning module from §3 `mastered in`. **This section is derived mechanically from §3**: every §3 row with a `mastered in` value gets a §6.4 row, and vice versa. (Catalog-clone blueprints inherit §6.4 from the source and trim/extend it.)

#### What does not belong in §6

- A `From | To | Verb | Cardinality | Delete` FK-link table. Per-FK cross-domain links are resolved by the analyst against the live catalog, not authored here.
- Shared-master name collisions (vendors / users / cost-centers / departments / customers). The deployer's deploy-time name-collision flow handles these.
- Any hard contract about which module owns which entity. Ownership is a deploy-time decision driven by the live catalog.

**Event-handoff rows (§6.2 outbound / §6.3 inbound):**

The handoff tables carry a `transition` column on top of the existing `trigger_event` / `payload` / `integration` / `friction` / `description` columns. The `transition` column carries the trigger's `<to_state> _(<event_category>)_` — e.g. `hired _(lifecycle)_`, `accepted _(state_change)_`, `_(entity_event)_` for entity-insert/update/delete events. `event_category` is one of:

- `lifecycle` — the event fires on a §7 lifecycle state transition. `to_state` MUST appear in the source entity's §7 table.
- `state_change` — the event fires on a value change to a non-lifecycle field on the source entity (some status-like attribute other than the `workflow_state` lifecycle field; a §7 lifecycle transition is the `lifecycle` category above).
- `entity_event` — the event fires on raw entity insert / update / delete; no associated state.

**Pre-emit validation:** for every §6.2 / §6.3 row whose `event_category` is `lifecycle`, the architect verifies the named `to_state` exists in the source entity's §7 lifecycle table. A mismatch is an authoring bug; emit `⚠ unresolved gate: <to_state> missing from <entity>'s §7` (Writing Convention 9) and ask the user to fix the source data.

Present a short proposal to the user, in plain sentences (Convention 8: no section labels, no backticked event or table names). Required in guided and expert flow; it is its own turn, never combined with another stage's confirmation. Word anything involving another module as a possibility ("could", "once <module> is set up"): a link only happens if that module exists and the user approves it when deploying.

> **Links to other modules.** These are possibilities, not connections: each depends on that module being set up, and links are only made when you approve them while deploying.
>
> - Candidates, interviews and job offers could come from the Candidate CRM, Interviews and Offers modules, once those are set up.
> - When a candidate is hired, an HR module could be told, so it can create the employee record.
> - When a job offer is signed, a compensation module could be told.
> - A flagged background check could block an offer, once a background-check module is set up.
>
> Does this look right, or should I add or drop any?

> **Fast flow, after the go-ahead:** don't show the proposal and don't ask; accept it as drafted and log one line ([fast-flow.md](../../semantius-admin/references/fast-flow.md), section 4). A `to_state` missing from the source lifecycle is not asked about: take the most conservative assumption, drop that handoff, and log it (rule 7).

After the user confirms, the §6.1–6.4 sub-sections are written in Stage 13. Any sub-section with no rows keeps its heading and carries the canonical `_(none: <short reason>)_` placeholder — never omit a sub-section, never leave a bare empty heading.
