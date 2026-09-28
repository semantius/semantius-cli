# Stage 3c.1: Same real-world thing as a live entity

*Reference for `semantius-analyst` (Stage 3c.1 in the SKILL.md stage index). Runs after 3c and before 3f / 3g, as a **ledger** stage: every widget is a `Q:` task.*

> **Terms used here.** A **base** is the entity others share a key with; a **`has_a` entity** is something a base record can also be; an **`is_a` entity** is a kind of its base, fixed at creation.
> Either one is a **based entity** (`**Key type:** has_a|is_a` plus `` **Based on:** `<base>` `` in the spec). A base plus its based entities is a **family**.
> Never say these words to the user (Writing Convention 8): say "keep each company once", "something a business partner can also be".

Some duplication only shows against the live catalog: the blueprint adds `vendors` while a live `business_partners` already holds companies. The architect cannot see that; this stage can. It asks about every pair Stage 2e.1 flagged, and every answer lands in `.shared_bases`.

**1. Read [`../../use-semantius/references/entity-families.md`](../../use-semantius/references/entity-families.md) now** (mandatory before the first widget): which bases are valid, what a based entity may not carry, how writes and permissions span levels.

## Which pairs get which widget

| Pair | Widget |
|---|---|
| Same name (a 3b pair) | None here. Sharing the name already covers it in 3b. |
| A 3c similar-name pair that 2e.1 also flagged, with an eligible live base | None here. 3c shows its fixed 4th option "Keep each one once" (`stage-3-collisions.md`). |
| Every other 2e.1 flag | The standalone 3c.1 widget below (Case A, B or C). |
| A pair `.shared_bases` already holds (and the recorded base is still eligible) | None: apply the recorded outcome silently. |

**MUST-FIRE:** always ask unless `.shared_bases` holds the pair. An obvious answer is not a reason to skip it.

**One incoming entity, several eligible live bases.** An entity can have only one base, so never ask pair by pair when two or more flagged live entities pass the eligibility test below. Ask **one** single-select question instead (a pick list per the AskUserQuestion mechanics): the 3 best eligible candidates as options, each `"Keep each one once, in <Other Plural Label> (<Module Display Name>)"`, plus `"Keep them separate"`; say in the question text that another can be typed in. Record the chosen pair as `role_of` (or `kind_of`) and every other flagged pair as `separate`. Candidates that fail the eligibility test get no option; they go into the §7.2 note only.

## Base eligibility test (inline; decides Case A vs C)

A live entity can be the base only when **all** hold:

1. It exists live and is **managed** (`managed` is not `false`).
2. It is **not a platform built-in** (`users`, `roles`, `permissions`, …): reference a built-in with a field instead.
3. Its key type fits: **`typeid`** for a `has_a` entity; **`typeid` or `is_a`** for an `is_a` entity.
4. **`<incoming table_name>_ext`** is free live (the platform reserves it, `90250`).
5. **The incoming entity is created by this spec** (`create-new`). An incoming entity that already exists live (it was reused, promoted or merged in 3b, e.g. onto another module's same-name table) keeps its locked key type and cannot become based: use Case C for every pair it has.

`has_a` or `is_a`? Apply the decision table's questions to the incoming entity (the full table is the architect's `normalization.md`):

- **Q1** Can a live record also be one of these, alongside anything else it is (a business partner that is also a vendor)? → **`has_a`**. This is the default for a live base, whose existing records already exist.
- **Q2** Is it exactly one kind at a time but can switch? → **no family**: offer only "Keep them separate" (Case C wording without the lock reason), since a type choice would belong on the live entity, which this module does not own.
- **Q4** Is every incoming record exactly one kind, fixed when created, and wanted in the base's combined list? → **`is_a`** (needs its own `**Key prefix:**`). Use it only when the blueprint already marks the entity `is_a` or its description says so; otherwise `has_a`.

## The widgets

`<things>` is the plain plural of the 2e.1 type: organization → "companies", person → "people", place → "places", product → "products", asset → "assets", activity → "activities", other → "records".

**Case A: a live base fits** (the eligibility test passes).

- **question**: `"<Plural Label> and the <Other Plural Label> in <Module Display Name> both hold <things>. Keep each one once?"`
- **header**: `"Keep once"`
- **multiSelect**: `false`
- **options**:
  1. label `"Keep each one once (Recommended)"`, description `"A <Singular> becomes something a <Other Singular> can also be. Shared details (name, address, and so on) are entered once, in <Other Plural Label>."`
  2. label `"Keep them separate"`, description `"<Plural Label> keeps its own copy of these details, so the same company may be entered twice."`

**Case B: the design's own shared record exists live under another name** (the blueprint's family base, e.g. `parties`, matches a live `organizations` that passes the eligibility test).

- **question**: `"This design keeps <things> once as <Plural Label>. Use the <Other Plural Label> in <Module Display Name> instead?"`
- **header**: `"Use existing"`
- **multiSelect**: `false`
- **options**:
  1. label `"Use the existing <Other Plural Label> (Recommended)"`, description `"Every <thing> is kept once, in <Other Plural Label>. Nothing new is created for it here."`
  2. label `"Keep our own <Plural Label>"`, description `"This module creates its own <Plural Label>, so a <thing> may be entered in both."`

**Case C: the live duplicate cannot join** (eligibility fails on a locked key: the live entity is `auto_increment`, `uuid`, `bigint` or `text`; or it is unmanaged).

- **question**: `"<Plural Label> and the <Other Plural Label> in <Module Display Name> both hold <things>, but they can't be combined as set up. Keep them separate?"`
- **header**: `"Keep apart"`
- **multiSelect**: `false`
- **options**:
  1. label `"Keep them separate (Recommended)"`, description `"<Plural Label> keeps its own copy of the shared details. Combining them later means redoing both."`
  2. label `"Stop so the design is redone"`, description `"Nothing is saved now. Run the design step again so each <thing> is kept once."`

## Outcomes

| Case and answer | Action | Written to the spec | `.shared_bases.<entity>.<live_table>` |
|---|---|---|---|
| A: keep once | `has_a` (or `is_a` per Q4) on the live table | `**Key type:** has_a` (or `is_a` plus `**Key prefix:**`), `` **Based on:** `<live table>` ``, no `**Reconciliation:**` line (create-new). The live base gets a `reuse-from <module>.<live table>` block when it is not already in §3. Stage 4 drops every drafted field the base already holds (N6 / N8), and the remaining fields must not reuse a base field name (`90243`) | `role_of` (`kind_of` for `is_a`) |
| B: use existing | `reuse-from` the live base; repoint every `**Based on:**` and every FK that named the blueprint's base to the live table | The blueprint base's block becomes `**Reconciliation:** reuse-from <module>.<live table>` under the live `table_name`; each based entity's `**Based on:**` names the live table | `role_of`, keyed by the blueprint base's slug and the live table |
| A / B / C: keep separate | The incoming entity keeps its own fields | A §7.2 "Future considerations (deferred scope)" entry, phrased as a forward-looking question naming the facts both entities hold and the live entity: *"Should vendors and the business partners in CRM keep each company once? Both store a name, an address and a tax id today."* | `separate` |
| C: stop | **Clean halt.** Record every other answer of the same batch in `customizations.yaml` first. Leave the stage task `in_progress` with `halted: <message>`. Tell the user in plain words, reusing the 3b.0 Cancel shape: *"Stopped without changes. Vendors and the business partners in CRM can't be combined as they're set up. Run the design step again so each company is kept once."* The rebuild candidate (the live entity that would need rebuilding) is **said in chat only**; nothing is written: no spec, no `.shared_bases` entry | none | none |

Write each answer before completing its `Q:` task, one scalar per pair with `lineComment` provenance (customizations-protocol.md 7.4 / 7.5). An entity flagged against several live tables gets one key per table:

```bash
yq -i ".shared_bases.${ENTITY}.${LIVE_TABLE} = \"${OUTCOME}\" \
      | .shared_bases.${ENTITY}.${LIVE_TABLE} lineComment = \"${PROV}\"" "$CUSTOMIZATIONS_FILE"
```

## Permissions for a family

A role that writes a based entity must also write its base: the platform refuses a write that does not reach every level (`entity-families.md` → Reading).

- **Base in this module:** give the based entity the same `**Edit permission:**` tier as its base (Stage 9 rule 5 checks it).
- **Base in another module:** add a cross-module edit grant as a §9.1 **Permission hierarchy** row, so every holder of the based entity's edit permission also holds the base's. Exact shape (the modeler's Stage 4i wires it; Gate A checks the included permission exists):

  ```markdown
  | permission | includes | reconciliation |
  | --- | --- | --- |
  | `<slug>:manage` | `<base module slug>:manage` | ✨ to create |
  ```

  Use the based entity's own tier on the left and the base's live `edit_permission` on the right.
