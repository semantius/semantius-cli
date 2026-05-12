# semantius-skill-maker — changelog

The skill-maker's `EXPECTED_MAJOR` and per-version behavior are bumped in lockstep with the analyst skill (`semantic-model-analyst`). This file records the skill-maker-side delta for each analyst minor / major bump. The current `EXPECTED_MAJOR` constant and the routing rules live in [SKILL.md](./SKILL.md) under "Schema compatibility"; this file records how the skill-maker's parser, indices, and generated-skill shape changed when each contract change landed.

This file is NOT loaded into Claude's context when the skill triggers.

Entries below are newest first.

---

## `v2.2` — read-side rule indices + uniform-filter discipline

Files written by analyst `2.2+` may carry two new optional §3 sub-blocks per entity, both encoding *read-side* JsonLogic that the platform evaluates outside the write path:

- **`Input type rules`** (JSON array per entity, one entry per field — same shape as `Computed fields` / `Validation rules`): each entry binds a single field to a JsonLogic expression that returns one of the five `input_type` enum values, evaluated client-side at form render against the current record. The platform falls back to the static `input_type` on empty / malformed / out-of-enum returns. The skill-maker uses this index for two JTBD-shaping decisions: (a) `*_at` housekeeping fields that "appear on transition" (Pattern A side-effect) must be set in the same PATCH as the trigger field; (b) recipes that POST/PATCH a record bypass the UI entirely, so the rule does not gate the *write* — but the calling agent driving a form must know which fields render under which conditions.
- **`Select rule`** (single JsonLogic object per entity): the platform compiles a non-empty value into a `FOR SELECT` row-level security policy that filters per-row read visibility. The skill-maker uses this index for a new SKILL.md preamble (**Row-level read scope**) and as a *cross-cutting guardrail*: every read recipe against a row-scoped entity must accommodate "the caller may see fewer rows than expected"; recipes that depend on enumerating all rows of the entity need to surface that boundary to the user up-front.

Both default to empty / no-rule when the analyst's heading is absent.

The skill-maker's Step 2 builds two new indices:

- `row_visibility_rules` — per-entity, captures the rule's plain-English uniform predicate from the sub-block `description` or §3 prose. **Critical: the rule applies uniformly to every caller with `view_permission`.** The platform evaluates the JsonLogic body per row; there is no documented mechanism by which holding a specific permission causes the rule to be skipped. If the model's §7 carries an explicit architectural-decision entry naming a documented broadening mechanism (separate cube view, Postgres `BYPASSRLS` role attribute), the index captures the mechanism under `row_visibility_broadening`. **Never invents a `view_all_<plural>`-style permission bypass; promising one ships broken RBAC.**
- `dynamic_input_types` — per-field, captures the rule's trigger gist. A sub-index `conditional_required_fields` captures `(entity, trigger_field, trigger_value, dependent_field)` tuples for the "field becomes required on transition" pattern, which co-fires with Pattern A side-effect.

Step 9 self-review gained the matching anti-fabrication principles:

- No recipe duplicates a `select_rule` in its own GET filter.
- Every read recipe against a row-scoped entity carries a one-sentence visibility callout.
- No recipe promises a `view_all_<plural>`-style permission bypass (the canonical v2.2 defect).
- Every transition JTBD that fires a `conditional_required_fields` trigger writes the dependent field in the same PATCH.
- No recipe interprets the JsonLogic of an `input_type_rule`.

Major stays at `2`; v2.1 files contain neither sub-block and parse cleanly under v2.2 with no behavior change. Skill-maker behavior under v2.2 mirrors the deployer's: read the new sub-blocks from §3, treat the JsonLogic bodies as opaque, and use the `description` text (when present) to compose the SKILL.md preamble and any per-JTBD guardrails. Do not interpret the JsonLogic.

---

## Earlier versions

Earlier skill-maker revisions tracked analyst v1.x and v2.0 / v2.1 updates (§2 Permissions summary as canonical source, `workflow-narrow` Type, the 13-family signal-scan, the Stage 10 workflow-permission scan, Pattern J restrict-chained cleanup). These predate the dedicated CHANGELOG and live only in git history; consult the analyst's CHANGELOG for the corresponding contract-change descriptions.
