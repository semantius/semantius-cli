# Stage 3: Role-driven placement

*Reference for `semantius-analyst` (Stage 3 placement). The "Prompts" column dispatches to the 3a / 3b.0 / 3b.1 / 3b.2 / 3c / 3d / 3e widgets in [`stage-3-collisions.md`](stage-3-collisions.md) and the drift widgets in [`stage-3f-drift.md`](stage-3f-drift.md).*

**Role-driven placement** (applies before any sub-stage fires):

Walk every §3 row in the incoming blueprint and classify based on `role` + `mastered in` + catalog state (location **and** stamped provenance: `catalog_entity_code` / `catalog_owner_module` / `catalog_entity_aliases`) + (pre-provenance rows only) workspace spec evidence. Most placements are deterministic and need no prompt; sub-stages 3a/3b/3c/3d/3e fire only on genuine ambiguity. In the placement table below, read the **"Workspace spec evidence"** column as **"authoring-intent evidence"**: take it from the catalog's `catalog_owner_module` whenever the entity carries provenance, and only fall back to the workspace file scan for a pre-provenance entity (`catalog_entity_code == ''`).

**Source of truth for placement decisions (the catalog, not sibling files):**

1. **The live catalog** (via `read_module` / `read_entity`) is the **authoritative source for both location AND authoring intent.** It tells you where entities live (`module_id`) and each entity's stamped authoring intent directly: `catalog_owner_module` (the embedded-master / catalog-owner pointer), `catalog_entity_code` (catalog identity), `catalog_entity_aliases`. A live entity with a **non-empty `catalog_owner_module`** is the catalog-owner-arrival signal (3b.0) — read it straight off the Stage 2c index.
2. **Workspace blueprints / specs are a PRE-PROVENANCE FALLBACK only.** Run the `semantius/blueprints/*.md` and `semantius/specs/*.md` §3 scan **only for a live entity whose `catalog_entity_code` is empty** (`= ''`) — an entity created before provenance stamping (or outside the pipeline). For any entity that carries provenance, the catalog wins; never let a sibling file override a stamped `catalog_owner_module` / `catalog_entity_code`. This closes the leak where an absent or drifted sibling file blinded placement.

```bash
# Stage 2c provenance read (one-time, at the start of reconciliation) — the PRIMARY source:
#   For each live entity, the Stage 2c index already carries:
#     { table_name, module_slug, catalog_entity_code, catalog_owner_module, catalog_entity_aliases, entity_type }
#   - catalog_owner_module != ''   → embedded_master placeholder; its value is the catalog owner slug
#                                       (the SIGNAL for catalog-owner-arrival detection / 3b.0).
#   - catalog_entity_code   != ''    → renamed-table detection is an equality join on the catalog code.
#   - catalog_entity_aliases != '[]' → this entity absorbed other domains' codes via reuse/merge.
#
# PRE-PROVENANCE FALLBACK (only when catalog_entity_code == '' on a live entity):
#   parse semantius/blueprints/*-semantic-blueprint.md (§3 by HEADER NAME) then specs/*.md for
#   role + mastered_in + label. Blueprint takes precedence over spec.
#   The §7.2 🟡 note is NOT the signal — it's human-readable documentation. Do not parse it.
#
# This map is consulted by the placement table below and by 3b.0 adoption detection.
```

| Incoming `role` | Catalog state | Workspace spec evidence | Placement | Annotation | Prompts |
|---|---|---|---|---|---|
| `master` | Entity exists in module X | X's blueprint OR spec declared this entity as `embedded_master mastered_in: <incoming.system_slug>` | **Catalog-owner adoption**: this blueprint IS the catalog owner finally arriving for an entity that was declared as a placeholder in X. Apply this blueprint's fields, lifecycle, permissions as additive deltas. | `promote-to-master <incoming.system_slug>.<entity>` (the modeler reassigns `module_id` from X to incoming module + applies deltas) | **3b.0 1-option confirmation** (single Yes / Cancel; explicit so the user knows ownership is transferring). |
| `master` | Entity exists in module X | No workspace evidence (X has neither blueprint nor spec in workspace, OR X's files declare the entity as `master` / `create-new` for X) | **Master-vs-master collision** — the existing entity's authoring intent is "X owns it," and the incoming blueprint claims ownership too. | per 3b.2 widget | 3b.2 4-option widget. |
| `master` | Entity doesn't exist | n/a | Create in this module | `create-new` | None. |
| `embedded_master` | Owner module (`mastered in`) exists, entity exists there | n/a | Reuse from the established catalog owner. | `reuse-from <mastered_in>.<entity>` | None. |
| `embedded_master` | Owner module exists, entity NOT there | n/a | Edge: owner module was created without this entity (shell from an earlier deploy that didn't declare it, or manual catalog edit). Use the existing owner module as the home but add the entity to it via cross-module insertion. | `promote-to-master <mastered_in>.<entity>` with full Fields block. | None. |
| `embedded_master` | Owner module doesn't exist, entity doesn't exist anywhere | n/a | **First-mover**: land entity locally in this module. **No shell is created** — that comes later if and only if a second embedder picks the share path. | `create-new` in this module | None. §7.2 🟡 note added (see below). |
| `embedded_master` | Owner module doesn't exist, entity exists in module X (somebody else already declared it) | Spec for X declared this entity as `embedded_master mastered_in: <same as incoming.mastered_in>` | **Second-mover, matching intent**: 3b.1 2-option widget fires (share via new shell named `<mastered_in>` / silo via rename). | per 3b.1 outcome | 3b.1 2-option widget. |
| `embedded_master` | Owner module doesn't exist, entity exists in module X | Spec for X declared this entity as `embedded_master mastered_in: <different slug>` | **Second-mover, mismatched intent**: same 3b.1 2-option widget but the option-1 shell name uses incoming `<mastered_in>` (B's blueprint is truth per the design rule). | per 3b.1 outcome | 3b.1 2-option widget. |
| `embedded_master` | Owner module doesn't exist, entity exists in module X | No spec evidence | **Second-mover, unknown source**: still 3b.1 2-option widget. Don't try to reconstruct what X intended. | per 3b.1 outcome | 3b.1 2-option widget. |
| `contributor` | Owner module exists, entity exists there | n/a | Auto-reuse | `reuse-from <mastered_in>.<entity>` | None. |
| `contributor` | Owner module doesn't exist | n/a | 3d decision (set up here / wait / skip) | per 3d outcome | 3d 3-option widget. |
| `consumer` | Owner module exists, entity exists there | n/a | Auto-reuse, read-only consumption | `reuse-from <mastered_in>.<entity>` | None. |
| `consumer` | Owner module doesn't exist | n/a | 3d decision | per 3d outcome | 3d 3-option widget. |
| (any role) | Optional row (`necessity: optional`) | n/a | Inclusion gated by user pick | per 3a outcome | 3a multiSelect (if any optionals). |
| (any role) | Similar-name collision against an existing entity | n/a | per 3c widget | per 3c outcome | 3c 3-option widget. |

**The §7.2 🟡 note for first-mover `embedded_master`** (when entity lands locally because no other embedder has touched the slug yet):

> *"<Plural Label> currently lives in `<this module display name>` as a placeholder. The catalog owner is `<label>` (`<mastered_in>`). When `<label>` is later deployed as its own blueprint, the analyst will auto-detect this placeholder via the workspace blueprint/spec scan and offer to migrate <Plural Label> into `<label>` (single confirmation, no data movement, just `module_id` reassignment). If a second module also declares <Plural Label> as `embedded_master` before `<label>` arrives, you'll get a choice between creating a shared shell now or siloing."*

**Stage 2g drift correction** (narrower scope than before). The Stage 2 spec scan resolves the catalog-owner-arrival case cleanly via 3b.0. Stage 2g now only fires for **catalog ↔ spec disagreement that the rest of Stage 3 can't resolve** — specifically, when the live catalog has an entity in a different module than the spec for THAT module says it should be in (i.e., somebody manually moved the entity via `update_entity` after the last analyst run, breaking the spec's authority). This is rare; when it fires, the prompt is the existing 2-option widget (move back to where the spec says, or cancel).
