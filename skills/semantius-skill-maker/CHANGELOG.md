# semantius-skill-maker — changelog

The skill-maker's `EXPECTED_MAJOR` and per-version behavior are bumped in lockstep with the analyst skill (`semantic-model-analyst`). This file records the skill-maker-side delta for each analyst minor / major bump. The current `EXPECTED_MAJOR` constant and the routing rules live in [SKILL.md](./SKILL.md) under "Schema compatibility"; this file records how the skill-maker's parser, indices, and generated-skill shape changed when each contract change landed.

This file is NOT loaded into Claude's context when the skill triggers.

Entries below are newest first.

---

## `v2.3` — script-robustness gate (Principle 7)

Major stays at `3` (no analyst-side contract change). This entry tightens the **generated scripts' real-world behavior**, not the parser. Three classes of defect that prior generations shipped despite Step 9 passing:

- **Raw `$var` interpolation into URL paths.** Recipes built `wfts(simple).$name`, `<col>=eq.$value`, and `in.(...)` filters by concatenating caller values directly. The moment a real catalog name contained a space (most do: `Customer Management`, `Investment Banking`, `Service Desk`), the URL mangled and the script either 4xx'd or returned wrong rows.
- **String-concatenated JSON bodies.** Recipes built `"body":{...}` payloads as `body="{\"notes\":\"$caller_notes\"}"`. A `"` or `\` in caller text (common in research-agent prose) silently produced invalid JSON and the platform returned an opaque parse error.
- **Optional columns written without a per-entity guard.** Polymorphic scripts that accepted an `entity` arg and unconditionally wrote `notes` (or any optional column) 4xx'd on every entity that lacked the column; the platform's `column "notes" does not exist` response was opaque to the agent.

Step 7 ("Conventions every script follows") gained three new bullets:
- URL-encode caller values via `printf '%s' "$raw" | jq -sRr @uri` before interpolating into any URL path or filter.
- Build JSON bodies with `jq -nc --arg` / `--argjson`, never string concatenation.
- For optional columns, bake the entity-supports-column list (computed from the model's §3 field tables at generation time) into the script and refuse the caller's arg with a precise stderr message when the target lacks the column.

Step 9 gained **Principle 7** ("Scripts handle real-world inputs"), a literal-text scan over every script (and every inline bash recipe in SKILL.md) for the three classes above, plus a fourth: `--single` vs array misuse on caller-driven lookups (mixing Pattern A and Pattern B from `use-semantius` silently mis-reports ambiguity).

Step 9 "Output of the self-review" was rewritten to require **per-principle evidence**, not a collapsed "no issues found" line. Principle 7 in particular must name a count of interpolation sites / JSON bodies / column guards inspected, because that was the principle prior generations skipped most often.

Step 10's Audit-findings bullet was tightened: on a fresh generation the bullet still appears, with explicit wording that names Step 9 (specifically Principle 0 + Principle 7) as the behavioral-correctness gate. The earlier wording ("skip this bullet on a fresh generation") let generators report "Fresh generation; nothing to audit" which read as "behavioral correctness also skipped". That was the immediate trigger for this entry.

Concrete recurring defect from the `domain_map` v2.2-era generation that motivated this entry: `promote-record.sh` accepted a `notes` arg and wrote it unconditionally against any of 20 entities, but 7 of those entities (industries, business_functions, domains, capabilities, data_objects, jurisdictions, regulations) have no `notes` column in §3. The Step 9 self-review passed Principle 0 (structural) but missed the behavioral defect because no principle scanned for it.

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
