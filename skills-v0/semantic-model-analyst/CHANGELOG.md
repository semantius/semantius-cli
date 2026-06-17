# semantic-model-analyst — changelog

This file records the history of the analyst skill's `CURRENT_VERSION` and the content-contract changes each version introduced. The current `CURRENT_VERSION` and the rules a maintainer must follow when bumping it live in [SKILL.md](./SKILL.md) under "Skill version". The body of SKILL.md is the **current contract**; this file is the **history of how the contract evolved**.

This file is NOT loaded into Claude's context when the skill triggers. Maintainers read it when planning a bump; users read it when investigating why an older-major file is shaped the way it is. Runtime behavior never depends on this file.

The entries below are written in reverse chronological order (newest first). Each entry follows the template the maintainer keeps using: what changed, why, the new convention as a numbered list, and the major-vs-minor justification.

---

## `3.6` (MINOR) — Stage 9b cross-tier FK reconciliation

Adds a new mandatory mechanical sub-stage between Stage 9 (tier classification) and Stage 10 (workflow-permission scan) that walks every planned `format: parent` FK after tiers are resolved and downgrades cross-tier ones to `format: reference` + `restrict`. Closes a long-standing gap where the divergent-permission-scope rule (`data-modeling.md:748`) was authoritative on paper but never fired because FK shapes were committed before tiers were classified.

**The failure mode this fixes.** Pre-3.6 flows applied the FK-shape table (`data-modeling.md:739-746`) during the entity-draft pass, then ran Stage 9 to classify tiers. By the time tiers were known, `format: parent` had already been emitted for every junction leg and every owned-child FK. The divergent-permission-scope override sat in the reference doc with no stage that actually invoked it. The canonical defect: a junction like `feature_tags` linking an operational `feature_tags` to an admin-tier `tags` shipped with `format: parent (junction)` + `cascade` on the tag leg, which lets a roadmap admin's tag deletion silently cascade through to manager-owned tagging decisions. The audit checklist's §IV.5 catches the residual case, but only after the file is written.

**The new convention.**

1. Stage 9 produces a tier per entity (`manage` default, `admin` when annotated, narrow tier when Stage 10 will rebind it).
2. **Stage 9b runs immediately after.** For every planned `format: parent` FK (junction legs included), compare the child's tier to the parent's tier. If they differ, downgrade to `format: reference` + `restrict` (default) or `clear` (when §3 prose justifies orphan-survival). Never emit `cascade` on a downgraded FK — that's the exact failure mode the rule exists to prevent.
3. Junction legs are evaluated per-leg, not table-wide. A junction may legitimately have one `parent + cascade` leg (same-tier parent) and one `reference + restrict` leg (cross-tier parent). The FK shape describes permission scope per-edge, not table symmetry.
4. The Stage 9 confirmation table grows a third row group, `Cross-tier FK downgrades`, listing every downgrade with `(FK, child tier, parent tier, new shape)`. Empty result → write `No cross-tier FK downgrades.` rather than omit the section — the audit reads the missing block as a skipped step.
5. The companion table in `references/data-modeling.md` is restructured so the divergent-permission rows visually mark themselves as **overriding** the "child owned by parent" and "M:N junction FK" rows. A read-order note prepended to the table tells future authors to evaluate divergence first and fall through to same-tier rows only when tiers match.

**Why this is a minor bump.** The model file shape is unchanged: same §3 fields columns, same §4 relationship-summary columns, same front-matter keys. What changes is the *content* a 3.6 file produces from the same Stage 1 input: cross-tier junction legs that used to emit `parent (junction) + cascade` now emit `reference + restrict`. A 3.5 file and a 3.6 file built from the same input will differ in those cells. Downstream tools (deployer, audit, optimizer) read both shapes correctly — the deployer already accepts `reference + restrict` everywhere, and the audit's §IV.5 check is unchanged. No translation rules needed.

**Companion changes.**
- `references/data-modeling.md` lines 739–748 restructured: read-order note prepended, same-tier scope clarified per-row, divergent rows marked as overrides.
- The audit checklist (`semantic-model-audit-checklist.md` §IV.5) is unchanged — it already catches the residual cases where Stage 9b was skipped or applied incompletely. Stage 9b is the *primary* defense; the audit is the *secondary* defense.

---

## `3.5` (MINOR) — platform `permission_hierarchy` field rename (`parent`/`child` → `including`/`included`)

The platform renamed the `permission_hierarchy` columns: `parent_permission_id` → `including_permission_id` (the broader permission, the one doing the including) and `child_permission_id` → `included_permission_id` (the narrower permission, the one being included). The `id` natural-key shape is unchanged (`"<including_permission_id>.<included_permission_id>"` — same format as before, just with new column names supplying the values). Old field names are gone, not aliased; sending the old payload shape fails at PostgREST with an unknown-column error.

**Why this is a minor bump for the analyst even though the model file shape is unchanged.** A 3.4 model file and a 3.5 model file are byte-identical for the same input — the §2 Permissions summary table still uses the `Hierarchy parent` column header, and the analyst's authoring rules for that column (rollup direction, type-vs-direction constraints) are unchanged. What did change is the SKILL.md *guide text* for what the deployer does with the column: the cell is now documented as mapping to `including_permission_id` (the broader, including end of the hierarchy row), with the row's own `Permission` mapping to `included_permission_id` (the narrower, included end). §8 step 1 documentation and the template's §8 step 1 wording were updated to spell out the new payload shape. Authors using a 3.4 file against a 3.5 deployer get the same result as authors using a 3.5 file — the analyst doesn't write hierarchy rows itself; the deployer does. The bump exists so a maintainer reading a 3.4-stamped file knows it was authored under the old documentation and a 3.5-stamped one under the new. Pre-3.5 audit / extend / rebuild flows route unchanged.

**Companion changes.**
- `semantic-model-deployer/SKILL.md` (v3.3) flips every `parent_permission_id` / `child_permission_id` reference in the actual write payload, idempotency-read filter, and verification narration to the new field names. Cross-module inclusion semantics restated as "consumer's `:read` *includes* master's `:read`" with explicit direction in the read/manage bridge rows.
- `semantic-model-deployer/CHANGELOG.md` gains a `v3.3` entry covering the rename.
- `semantic-model-optimizer/SKILL.md` walks cross-module bridges via `including_permission_id` (this module) + `included_permission_id` (master) instead of the old direction terms.
- `semantius-deploy-test-maker/SKILL.md` and `references/checks-catalog.md` update the multi-column filter syntax (`and=(including_permission_id.eq.<id>,included_permission_id.eq.<id>)`) and the failure-message natural-key shape (`<including>.→.<included>`).
- `use-semantius/references/{rbac,crud-tools,data-modeling}.md` reflect the new tool input schema and table field names. The CLI itself was updated independently (`semantius v0.4.2`) — the skills lag-fix here is documentation-only.

The platform `permission_hierarchy.origin` enum and the `id` natural-key format (`"<left>.<right>"`) are unchanged. Only the two FK column names changed.

---

## `3.4` (MINOR) — no DDL in models, no identifier leakage in user-facing prose

Two real bugs landed in v3.3 output that the existing rule set didn't catch:

1. Analyst-emitted DDL fragments (`CREATE UNIQUE INDEX feature_votes_unique_voter ON feature_votes (feature_id, user_id);` and similar) appeared in the model file as if they were enforceable constraints. The deployer never executes DDL, so the line was decorative — but humans read it as a real constraint, and the underlying need (multi-column uniqueness) had no actual representation anywhere in the catalog.
2. Entity-level **Description** sub-blocks leaked `table_name` references wrapped in backticks: *"A reusable label for categorizing `features` (e.g. mobile, enterprise, platform)."* The existing v3.3 rule against `field_name` references in §3 field-row Description cells didn't extend to the entity-level Description, and the broader "no backticks around identifiers in user-facing prose" intent was never written down as a rule the audit could enforce.

**The new convention** (for authors):

1. **Writing convention #6 — no identifier leakage in user-facing prose.** Banned across every prose surface (`system_description`, entity `singular_label` / `plural_label` / `Description`, field `Label` / `Description`, permission `Description`, every sub-block `description`, §6 prose, §7 question bodies): (a) backticks around any identifier or value, (b) references to other entities by `table_name` (use Singular / Plural Label or plain English), (c) `field_name` references on any prose surface (already a rule for field Description cells in v3.3; now scoped to *every* prose surface), (d) raw permission codes. Narrow exception: enum values quoted in inline `code` style **inside the §3 field-row Description cell** stay as written (the canonical *"Match Status reaches `auto_matched`"* pattern). Everywhere else, no backticks.

2. **Writing convention #7 — no DDL anywhere in the model file.** SQL DDL fragments (`CREATE TABLE`, `CREATE [UNIQUE] INDEX`, `ALTER TABLE`, `DROP TABLE`, `DROP INDEX`, `ADD COLUMN`, `ADD CONSTRAINT`, `ADD FOREIGN KEY`, `ON DELETE CASCADE` as a SQL clause, `REFERENCES <table>(<col>)`, `CREATE VIEW` / `TRIGGER` / `FUNCTION` / `PROCEDURE`) are 🔴 Blockers anywhere in the file body. The fix path: (a) re-express as a §3 structured annotation when the platform models it (single-column `unique`, `reference_delete_mode`, `precision`, `default`, JsonLogic validation rules); (b) move to §7.2 Future considerations as a forward-looking question when the platform doesn't currently model it (multi-column uniqueness, partial / expression indexes, check / exclusion constraints, triggers, views); (c) delete outright when the DDL was analyst-side commentary with no remaining intent (rare).

3. **Mode B audit gains two new checks.** One 🟡 Warning per offending prose surface for identifier leakage (with a per-surface sweep offer); one 🔴 Blocker per DDL token with the offending line quoted verbatim, the proposed rewrite (annotation move or §7.2 entry), and the reason ("the deployer cannot execute this; the constraint is currently unenforced"). The two canonical DDL bugs that triggered this version (`feature_votes_unique_voter` and `feature_tags_unique_pair`) are written into the audit rule as worked examples, so the audit emits a copy-pasteable §7.2 rewrite for each.

4. **Pre-save verification block gains two new lines:** `DDL tokens found: <list or "none">` and `Prose-surface identifier leaks: <count> (target: 0)`. Same shape as the v3.3 family-14 / family-15 / family-10 counters: any non-zero count blocks the Write call until the draft is fixed.

5. **The Stage 4 description-prose rule** (formerly "No snake_case identifiers when referring to a sibling field") is re-framed as a special case of writing convention #6 and explicitly extended to (a) entity-level Description sub-blocks, (b) references to other entities (use Singular / Plural Label), (c) backticks. Stage 4's exception list — enum values quoted inline, external identifiers, stored format hints — is unchanged.

**Minor bump justification:** the contract changes are additive author conventions and audit checks. A 3.3 file that already happens to satisfy the new rules parses unchanged against a 3.4 reader. A 3.3 file with identifier leakage or DDL fragments is now defective — but the file *structure* (front-matter shape, section order, table columns, sub-block JSON shape) is identical, so the deployer parses both versions the same way. No major bump because no parser changes.

**Companion changes.** None outside this skill. The deployer ignores prose-surface content (it reads structured cells), so no deployer-side rule moves with this bump.

---

## `3.2` (MINOR) — cross-entity JsonLogic primitives: `set_record`, `let`, `throw_error`

The platform now exposes three JsonLogic operators that bind values into the data context before the expression body evaluates, on top of an underlying `get_record_by_id(entity_name, id)` Postgres helper. This lets `computed_fields` and `validation_rules` reach off the current row for the first time — parent-state gates, inherited values, merged labels, and domain-specific error messages are no longer "out of scope, use cube views".

The motivation: a meaningful fraction of every model's "out of scope" deferrals were cross-entity rules the analyst recognized but had no way to encode (an order line can't be modified once the parent order is shipped; a child line should inherit the order's currency; a label should combine the parent's number with the child's sequence). Without the operators, these landed in §7.2 with a "moves to cube view" footnote that the deployer couldn't act on and that future readers couldn't enforce. The operators let the analyst keep these rules on the entity where they belong.

**The new convention** (for authors):

1. **Two new Stage 8 signal families.** Family 14 (cross-entity parent-state gate) fires when prose conditions writes on the state of a parent / referenced record ("cannot modify once the parent is shipped / closed / signed / posted"). Family 15 (cross-entity inherited / merged value) fires when prose names another entity's column as the source of one of the current entity's columns (inherited currency, country, discount; merged labels like `'<order_number> · line <line_no>'`). Both families fire mechanically by default and produce JsonLogic that uses `set_record` (and, for merged labels, `cat` + nested `set_record` for multi-hop FK chains).

2. **`throw_error` as the alternate failure shape for `validation_rules`.** A rule body may now wrap its rejection branch in `{"throw_error": "<message>"}` instead of returning falsy. The throw raises a SQL exception (SQLSTATE `23514`) with `<message>` as the caller-visible error text, bypassing the rule's static `message`. Reach for `throw_error` whenever prose names a specific, hand-tailored, user-facing error string (the canonical example: *"Cannot modify a shipped order"*); stay with falsy-return when the rule's `code` and the generic `message` are sufficient.

3. **`let` for naming sub-expressions.** Use `{"let": ["<name>", <value-expr>, <body-expr>]}` to bind a sub-expression you'd otherwise recompute, e.g. `gross = unit_price * quantity` in a `line_total` derivation that then applies a discount.

4. **Stage 8 structural cross-check is now binding-aware.** Column references inside a `set_record` / `let` body are resolved against the *binding's* entity, not against the entity the rule lives on. The audit checks that `<entity_name>` in every `set_record` call is either a §3 table or a Semantius built-in, and that every `{"var": "<binding>.<column>"}` lookup names a real column on the bound entity's §3 table. A typo in a bound reference silently returns `null` at evaluation time, so this is the only place the analyst can catch it.

5. **Out-of-scope table is updated.** Cross-entity validation, FK-target predicates, and inherited values are no longer out of scope. Cross-row aggregates and table scans (`Σ child.amount ≤ parent.total`, `≤ N per release`) remain out of scope — `set_record` reads one row by id, it does not aggregate. The Stage 8 footnote in the SKILL surfaces both moves explicitly.

6. **`select_rule` and `input_type_rule` guidance.** `set_record` is technically callable from `select_rule` (same JsonLogic engine) but runs an extra `SELECT` per row of every read; the SKILL warns against it and points authors at `has_permission` / column-encoded broadening. `input_type_rule` runs client-side at form render, so `set_record` can't fetch a row — don't use the cross-entity operators there.

7. **No deployer behavior change.** The deployer hands the JsonLogic array byte-for-byte to `create_entity` / `update_entity`; the new operators travel through the same path. The deployer's existing "🛑 column referenced inside `select_rule` must exist on the entity" rule still applies (and is restated more carefully); the deployer also relaxes its "the rule's JsonLogic only references columns on this entity" parse-time check for `validation_rules` / `computed_fields` to skip column references under `set_record` / `let` bindings (the platform validates these at evaluation time, not at deploy).

**Minor bump justification:** the addition is additive and forward-compatible. A 3.1 file written without the new operators parses unchanged against a 3.2 reader. A 3.2 file using the operators parses against a 3.1-aware deployer (the operators are syntactically valid JsonLogic and the deployer never inspects operator names), but the rule's *behavior* depends on the platform version supporting the operators — that's a platform-side concern, not a model-file-shape concern. The content contract (frontmatter shape, section order, table columns) is unchanged.

**Companion changes.**
- `references/data-modeling.md` gains a "Cross-entity lookups inside JsonLogic" sub-section under the existing computed-fields/validation-rules block, with operator reference table, canonical patterns (parent-state gate, inherited value, merged label, two-hop traversal, let-named sub-expressions), null-handling guidance, and the `throw_error`-vs-`message` decision. The same content lands in `use-semantius/references/data-modeling.md` so cross-skill readers see one source of truth.
- `semantic-model-template.md` and the `Computed fields` / `Validation rules` heading prose note cross-entity primitives as available, without changing the JSON shape.

---

## `3.0` (MAJOR) — `module_type: master` frontmatter and `**Shared master cluster:**` annotation

Schema major bumps from `2` to `3` in lockstep with `semantic-model-deployer`'s `EXPECTED_MAJOR`. The bump introduces two optional, forward-compatible authoring conventions that let an analyst-authored model file express what kind of module it represents and which entities are classic master concepts.

The motivation is the deployer's new master-module promotion path: when two domain models collide on a shared concept (`vendors` declared by both ITSM and ITAM, `cost_centers` declared by both finance and procurement), the deployer can now route the colliding entity into a neutral master module both modules consume. Picking which master to host it, and what to name a new one, is a deploy-time decision shaped by analyst hints embedded in the model. The annotation gives the analyst a place to record its domain knowledge about what concepts are typically shared; the frontmatter directive lets a model file declare itself as a master spec (formalizing an ad-hoc runtime-promoted master into a proper domain cluster).

**The new convention** (for authors):

1. **Optional frontmatter `module_type: master`.** Default `"domain"` when the key is absent. Emit `master` only when authoring a master model — a self-contained spec for a master-data module declaring shared entities (e.g. `vendor_management` with `vendors` + `vendor_contacts` + `vendor_categories`; `finance` with `currencies` + `cost_centers` + `ledger_accounts` + `fiscal_years`). For everyday domain modeling, omit the key entirely.

2. **Optional per-entity `**Shared master cluster:** <cluster>` annotation** in §3, alongside `**Audit log:**` and `**Edit permission:**`. Emit for entities the analyst recognizes as classic master concepts: `finance` (currencies, cost_centers, budget_periods, ledger_accounts, fiscal_years, tax_rates, gl_accounts); `parties` (vendors, customers, partners, suppliers); `organization` (departments, business_units, locations, sites); `products` (products, product_categories, skus); `employees` (employees, job_titles). The mapping is not closed — coin a new cluster name when an entity is a recognizable master concept that doesn't fit one of the above. Omit when the entity is not a classic master concept (every operational entity, every domain-specific lookup).

3. **Stage 9 of Mode A surfaces both classifications in the confirmation table.** The admin-tier vs operational split and the master-cluster mapping share the same author-review pass: a single confirmation table with `Entity | Tier | Reason | Master cluster` columns. The analyst proposes both classifications mechanically (admin-tier per the Stage 9 rule; master-cluster per the table above); the user can correct either before §3 is finalized.

4. **The deployer reads both keys at Stage 1.** `module_type` gates Stage 2a's create-vs-extend logic for master modules (exact-slug match → entity-overlap match → create-new); the cluster annotation shapes Stage 2d follow-up 1 defaults at promotion time (recommended existing-master selection or recommended new-module name when no existing master matches). The cluster hint has no effect when the entity is not promoted.

5. **Mode B audit on 2.x files proposes the 3.0 upgrade.** The audit walks every entity and flags master concepts (per the table above) that have no `**Shared master cluster:**` annotation; surfaces them as 🟡 Warnings ("recommended cluster: `<cluster>`, accept or override"). When the user accepts, the audit bumps `version: "3.0"` in frontmatter and stamps the annotations during the Mode B write. Pre-3.0 files without the annotation still parse against a 3.0 deployer (no hint applied, default new-master suggestion is the bare entity name), but the analyst's audit is the prescribed migration path.

6. **No author task changes for non-master domain modules.** A typical domain model (CRM, ITSM, ATS, etc.) emits `version: "3.0"` and zero of the new keys — `module_type` is omitted (defaults to `"domain"`), and the cluster annotation appears only on the handful of entities the analyst recognizes as cross-domain master concepts. The vast majority of §3 entity blocks are byte-identical to their 2.4 form.

7. **Master-model authoring (the upfront / formalization case).** When the user wants to author a master model directly — formalizing an ad-hoc runtime-promoted master, or declaring a new master upfront — emit `module_type: master` in frontmatter and structure §3 around the master's sibling entities plus any validation rules that govern them. The deployer's Stage 2a master-model branch will match against an existing master by exact-slug or entity-overlap, coordinate the rename cascade if the master is being renamed (e.g. bare `vendors` → `vendor_management`), and add new sibling entities additively.

8. **Built-in field-shape alignment is the analyst's job.** When a model declares a built-in entity (`users`, `roles`, `permissions`), use the built-in's actual field names for concepts the platform already covers; only invent new field names for genuinely additive fields. The cheat-sheet of common drifts (`user_name` → `display_name`, `is_active` → `is_disabled`, `username` → `email`, `role.name` → `role.role_name`, `role.code` → `role.slug`, etc.) is in `use-semantius/references/data-modeling.md` § "Semantius built-in entities: shapes" with full field listings. Load that reference before writing §3 for any built-in entity. Re-declaring built-in concepts under different names produces a noisy deploy where the user gets a list of skipped-as-equivalent fields plus the additive ones — the analyst's job is to make that list empty so only the truly additive `✨` fields surface for confirmation.

**Major bump justification:** the `module_type: master` frontmatter directive changes deploy-time behavior materially. A pre-3.0 deployer reading a 3.0 master-typed model would silently create a regular domain module instead of a master — producing the wrong catalog shape rather than a missed optimization. The two skills must move in lockstep; the major bump is the honest signal.

Pre-3.0 files (analyst `2.x`) parse against a 3.0 deployer with both new fields defaulted (`module_type: domain`, no cluster hints). Audit / Extend / Customize modes on a 2.x file route to Mode B audit with a one-line proposal to bump to `3.0` plus stamp cluster annotations; Mode A always emits `version: "3.0"` for new models.

**Companion changes.**
- `references/semantic-model-template.md` gains the `module_type` frontmatter slot and the per-entity `**Shared master cluster:**` annotation slot.
- `semantic-model-deployer/SKILL.md` (v3.0) adds: Stage 1 parser for both keys; Stage 2a master-model branch with exact-slug + entity-overlap match; Stage 2d Branch A (auto-wire consumer to existing master) and Branch B (5th collision option "Promote to shared master module") with cluster-hint-shaped follow-up defaults; Stage 4b-rename cascade (~7–10 writes, forward-recoverable); Stage 4c-promote and 4c-merge-master sub-cases; Stage 4i cross-module permission inclusions; Stage 4j seed master manager role; Stage 5 structured verification report with `origin`-broken-down counters; Gates A and B; JSON-array merge with `source_module` tagging on master entities; no-auto-deletion safety rule covering roles, permissions, role_permissions, permission_hierarchy rows, and modules.
- Platform `roles.origin` and `permission_hierarchy.origin` enums (`"system"`, `"model"`, `"model_master"`, `"user"`) are strictly immutable after INSERT; `roles.slug` and `permissions.permission_name` have unique indexes (act as natural-key second primary keys).

---

## `2.4` — `has_permission` IS available in `select_rule` (and `input_type_rule`)

Correction release. The 2.2 / 2.3 contract claimed `select_rule` could not reference permissions: "There is no `has_permission` / `require_permission` operator confirmed for the SELECT context", and prose naming a permission as a broadening mechanism inside `select_rule` was treated as a 🔴 Blocker. That claim was wrong. The platform exposes a `{"has_permission": "<code>"}` operator specifically designed for the SELECT context (returns boolean, never throws — `require_permission`'s throw-on-miss semantics are wrong for SELECT, but `has_permission` was added precisely so `select_rule` *can* check the caller's permissions and broaden visibility for elevated roles).

The same `has_permission` operator is also available in `input_type_rule` (the I5 "permission-driven UI mode" family was previously deferred to a §7.1 question; it now emits a rule directly) and inside `validation_rules` (as a non-throwing alternative to `require_permission`, important when a permission check is one branch of a wider `or`).

The shipped 2.3 content treated tiered visibility ("regular sees own; manager sees all") as a 🔴 Blocker requiring user resolution via a four-option architectural-decision matrix. That entire framing was downstream of the wrong-premise claim and quietly forced authors into out-of-rule mechanisms (Postgres `BYPASSRLS`, separate cube views) when the in-rule encoding was available all along.

**The new convention** (for authors):

1. **`has_permission` is the canonical SELECT-context permission operator.** Use it inside `select_rule` `or` clauses to broaden row visibility for elevated roles. The rule body remains the single source of truth, but it can now correctly encode tiered audiences.
2. **`require_permission` does NOT belong in `select_rule`.** Its throw-on-miss semantics would fail the entire SELECT for any caller missing the permission. Use `has_permission` for SELECT and reserve `require_permission` for `validation_rules` where the throw surfaces as the rule's validation message.
3. **Stage 12 Option B (per-row predicate + `has_permission` broadening) is the recommended default for tiered audiences.** Options C / D / E (separate cube view, Postgres `BYPASSRLS`, accept uniform filter) become fallbacks for cases `has_permission` can't express (FK traversal, shape-changing redaction).
4. **Stage 12.5 consistency gate's permission-in-prose-without-clause rule reverses direction.** Previously: prose naming a permission inside `select_rule` was almost always fabrication and a 🔴. Now: prose naming a permission must be matched by a `has_permission` clause in the JsonLogic body (still a 🔴 if missing), but the typical fix is *adding the clause to the body* rather than weakening the prose.
5. **Stage 11 I5 family fires by default and emits a rule.** No more deferring to §7.1.
6. **Files written under 2.3 should be reviewed in Mode B for `select_rule` defects:** §7.2 entries that defer read scoping to "platform-layer concern" are typically resolvable by adding a `has_permission` broadening clause to the relevant `select_rule` body.

**Minor bump justification:** files written under 2.3 are still readable by 2.4 tools (no shape change); the modeling convention is tightened (a 2.3 file that left tiered visibility in §7.2 is now defective when it could have encoded the broadening in-rule, but the file structure is unchanged). No major bump because the §3 sub-block shapes (`Computed fields`, `Validation rules`, `Input type rules`, `Select rule`), §2 Permissions summary structure, and front-matter keys are all stable.

**Companion change in use-semantius/data-modeling.md.** A "Platform-extension operators" sub-section was added documenting `value_changed`, `require_permission`, and `has_permission` (none of which were previously documented in the reference). The `select_rule` section's "Critical: this rule applies uniformly... there is no documented mechanism by which holding a specific permission causes the rule to be skipped" claim was rewritten against the corrected vocabulary. Analyst skill cross-references the corrected reference.

---

## `2.3` — formalize the in-place v2.2 corrections under a real version stamp

Bump-only release. No new modeling conventions beyond what v2.2-late already documented on disk. The reason for the bump is structural: between the initial v2.2 ship and this entry, three substantive corrections were rolled into SKILL.md in-place under the same `2.2` stamp:

1. The "Critical limit (load-bearing)" rule in Stage 12 — `select_rule` applies uniformly to every caller with `view_permission`, there is no documented platform mechanism by which holding a permission causes the rule to be skipped, and prose promising "callers holding `<slug>:view_all_X` bypass the filter" is **forbidden** absent platform confirmation. The §7.1 four-option matrix (accept uniform / encode in column / split entities / DBA-side `BYPASSRLS`) was added as the canonical resolution flow.
2. A new mandatory **Stage 12.5 view & edit rules consistency check** gate whose explicit purpose is catching the canonical v2.2 defect — prose claiming a permission bypasses `select_rule` while the JsonLogic encodes nothing of the kind — before Stage 13 writes the file.
3. `Input type rules` sub-block format unified from YAML to JSON, so all four §3 sub-blocks (`Computed fields`, `Validation rules`, `Input type rules`, `Select rule`) share one parser.

Each of those is "a new modeling convention authors must follow when writing content" or "a new mandatory gate", which the skill's own bump rules call out as MUST-bump-minor triggers. They shipped in-place anyway because the maintainer treated "no production files have shipped yet under the YAML shape" as equivalent to "no contract change has occurred". That reasoning is wrong: the bump stamp's job is to mark *when the contract changed*, not *when somebody started consuming it*. Slash-command-loaded skills make the gap especially expensive — every active session is a frozen-snapshot consumer the maintainer can't see, and an "in-place fix" stops being equivalent to "everyone gets the fix tomorrow" and becomes "every session loaded before the fix is permanently wrong, with no way for the session to detect that its embedded copy is stale".

The 2.3 stamp closes that gap. Files written under any in-disk SKILL.md that contained the three corrections above are *content*-equivalent to files written under 2.3; stamping them 2.3 just makes that equivalence visible to readers and to the consistency-check gate.

**The new convention** (for maintainers, not authors):

1. **Treat new mandatory gates as MUST-bump-minor.** A new Stage-N walk that must produce an artifact, or a new audit pass that runs before Stage 13, is a contract change for authors even when it doesn't change any file's shape. Add a row to the "Bump *minor* when ..." trigger list in SKILL.md explicitly naming this case.
2. **Treat new authoring prohibitions as MUST-bump-minor.** A rule that *forbids* analysts from writing prose they used to be allowed to write (here: the fabricated-bypass prose) is the same kind of contract change as a rule that requires new prose. The asymmetry was implicit before and should be explicit.
3. **Treat "no production files yet" as irrelevant to the bump decision.** The bump stamp tracks the contract, not its adoption. Frozen-snapshot consumers (slash-command embeddings, copies pasted into other tools, agent SDK skill bundles) make the "nobody is affected" reasoning unsafe.
4. **Slash-command-embedded skills cannot detect their own staleness.** This is a known structural failure mode. Bumps are the only signal that propagates — a session embedded with v2.2-early skill content and one with v2.2-late skill content both report `CURRENT_VERSION = "2.2"` and behave divergently with no way to tell. Bump conservatively as a result.

**The body of SKILL.md** stamps `CURRENT_VERSION = "2.3"`. The body content is otherwise identical to the v2.2-late state on disk before this bump.

**Mode B audit cross-checks under v2.3.** No new audit rules. Files stamped `2.2` parse cleanly under v2.3; the major comparison still passes. Files stamped `2.2` should be re-saved as `2.3` on the next Mode B/C/D pass so the equivalence is recorded. The downstream deployer's `EXPECTED_MAJOR` stays at `2`.

Minor bump, not major: front-matter shape is unchanged; the §3 sub-section structure is unchanged; the deployer parses 2.2 and 2.3 files identically.

---

## `2.2` — read-side rules + view/edit consistency gate

Two new mandatory mechanical scans, mirroring the v1.12 (workflow-permission) and v1.4/1.5 (validation-rules) pattern: a per-field **conditional input-type scan** and a per-entity **row-level read-access scan**. Each produces a structured table the analyst must walk, with empty cells as visible misses; matching results become a new optional §3 `Input type rules` sub-block (per field) and a new optional §3 `Select rule` sub-block (per entity).

Platform background. The Semantius MCP now exposes two read-side JsonLogic surfaces that already existed in the database but were not addressable from the tool schemas (`postgrest-mcp` model-neon, handover 2026-05-12): `entities.select_rule` (JSONB object, drives a generated `FOR SELECT` RLS policy, must return a boolean — `true` = row visible) and `fields.input_type_rule` (JSONB object, evaluated client-side at form render, must return one of the `input_type` enum values — `"default"` / `"required"` / `"readonly"` / `"disabled"` / `"hidden"`, fallback to the static `input_type` on empty / malformed / out-of-enum result). Both default to `{}` (no rule), are additive, and have lifecycle-on-empty semantics (rule resets to `{}` ⇒ generated policy / override is dropped). Reserved variables match the validation/computed-rule vocabulary: `$today`, `$now`, `$user_id` (`$old` is server-side only on writes and not meaningful in either read context).

The 1.4/1.5/1.12 pattern proved that *passive* discovery ("look for signals") under-fires reliably. Both new scans are therefore structured-table mechanical walks with explicit fire-by-default rules, mirroring Stage 8's signal-scan and Stage 10's workflow-permission scan exactly. Adding an unwarranted rule is reviewable in seconds and remains a low-cost authoring choice; missing a rule that the domain genuinely needs is invisible until production. Default to firing; surface the §7.2 escape when the analyst can name a specific domain reason not to.

The new convention:

1. **New Stage 11 — Conditional input-type scan.** Walks every field on every entity for *state-driven UI mode* signals: status-driven visibility (`approved_at` hidden until `status='approved'`), submit-then-lock (`feedback_text` editable until `is_submitted=true`, then readonly), conditional-required (`manager_comment` required when `termination_reason='dispute'`), permission-driven readonly (`compensation` editable only for HR), and a few more. The scan produces a structured table (one row per field, columns per signal family). Each fired cell becomes one entry in the entity's new `Input type rules` §3 sub-block, binding the field to a JsonLogic expression that returns the dynamic `input_type` value.

2. **New Stage 12 — Row-level read-access scan.** Walks every entity for *per-row visibility* signals: personal / private content (notes, journal entries, private feedback — owner-only read), tiered audience (e.g. the ticket-system shape: regular user sees own submissions; agent sees assigned-or-unassigned), confidential / restricted flags (`is_confidential`, `visibility='restricted'`), sensitive HR data. Each fired entity becomes a `Select rule` §3 sub-block holding the JsonLogic boolean rule. **Critical limit (load-bearing).** The `select_rule` applies uniformly to every caller with `view_permission`; it is a pure per-row predicate the platform evaluates with `$today` / `$now` / `$user_id` as reserved variables. There is no documented platform mechanism by which holding a specific permission causes the rule to be skipped for that caller. Tiered visibility ("regular sees own; manager sees all") **cannot be encoded inside a single `select_rule`** against the platform as currently documented. When a fired family hits this wall, Stage 12 surfaces a §7.1 architectural decision (option A: accept the uniform filter; option B: encode broadening in a column the rule reads; option C: split the broader audience to a separate entity / cube view; option D: confirm with the user that Postgres-role `BYPASSRLS` is provisioned and capture in §8 implementation notes). **Never describe a permission-bypass the JsonLogic does not encode.**

3. **Renumbered Stage 13 — Write the semantic-model file.** Old Stage 11 ("Write the semantic-model file") moves to Stage 13. The renumbering is internal-to-the-analyst (same v1.13 pattern). No section renumbering in the model files themselves, so this is a minor bump, not major.

3a. **New Stage 12.5 — View & edit rules consistency check (MANDATORY gate).** A cross-cutting consolidated audit that runs after Stages 8/9/10/11/12 have all proposed their rules and before Stage 13 writes the file. It walks every model surface that touches read or write access (`view_permission`, `edit_permission`, `validation_rules` with `require_permission`, `select_rule`, `input_type_rule`, §2 Permissions summary) and reconciles them with each other AND with every prose claim the model makes about visibility / authorization. The gate's load-bearing job is catching the v2.2 canonical defect: prose claims a permission bypasses `select_rule`, JsonLogic encodes nothing of the kind, the rule ships looking authoritative, production access is wrong. **The gate's audit table is mandatory output before Stage 13.** Mode B replays the same audit; Mode C and Mode D include it as a named gate.

4. **Template additions.** `references/semantic-model-template.md` adds two new optional §3 sub-blocks (`Input type rules`, `Select rule`) parallel to the existing `Computed fields` / `Validation rules`. Each entity may carry zero, one, or both. Headings are omitted when the sub-block is empty (same authoring rule as the existing two sub-blocks). **Format: all four sub-blocks are JSON.** `Computed fields`, `Validation rules`, and `Input type rules` are JSON arrays of objects (each entry has named keys: `name` / `code` / `field` plus `jsonlogic` plus optional `description`); `Select rule` is a single JSON object holding the JsonLogic expression. The deployer parses all four with one parser. (An early v2.2 draft used YAML for `Input type rules`; the JSON unification was rolled into v2.2 in-place before any production files relied on the YAML shape.)

5. **§8 deployment step.** Step 8 instructs the deployer to apply the new sub-blocks: walk every entity's `Input type rules` and call `update_field` on each `<table>.<field>` with the entry's `jsonlogic`; walk every entity's `Select rule` and call `update_entity` with the JsonLogic object. Warn the user before applying any `select_rule` (read-visibility changes are medium-risk).

6. **Mode B audit cross-checks under v2.2.**
   - Every `Input type rules` entry's `field` value must resolve to a real field in this entity's §3 field table (typo / non-existent name is 🔴 Blocker).
   - Every `Input type rules` JsonLogic must syntactically return one of the five `input_type` enum values on every branch (deployer-side parse warning, 🟡 here).
   - Every entity with a workflow-shaped `*_at` lock timestamp (`submitted_at`, `approved_at`, `locked_at`, `finalized_at`, `posted_at`) carries an `Input type rules` entry for that field OR a §7.2 escape (🟡 Warning).
   - Every entity flagged by Stage 12 as personal-content / tiered-audience / confidential carries a `Select rule` block OR a §7.2 escape (🟡 Warning).
   - Every `select_rule` JsonLogic references only real fields on this entity (🔴 Blocker if it doesn't).
   - Every elevated tier referenced in a `Select rule` via a permission code (e.g. `<slug>:view_all_<plural>`) is declared as a row in the §2 Permissions summary (🔴 if missing).

Minor bump, not major: front-matter is unchanged; the §3 sub-section structure gains two new optional headings (existing readers ignore them). v2.1 files contain no `Input type rules` or `Select rule` sub-blocks and parse cleanly under v2.2. The downstream deployer's `EXPECTED_MAJOR` stays at `2`; the deployer's per-entity creation pass is bumped in lockstep to recognize the new sub-blocks and apply them after `create_entity`/fields.

---

## `2.1` — workflow-narrow permission tier

New `workflow-narrow` Type value in the §2 Permissions summary, for permissions that grant *less* authority than `<slug>:manage` rather than more.

v2.0 modeled every non-baseline permission as a single `workflow` Type whose `Hierarchy parent` must be `<slug>:admin` or `—` and never `<slug>:manage` (rolling up under `manage` would auto-grant the gated authority and defeat the conditional check). That covered every *elevated* workflow permission (offer approval, manager-override on personal records, signing authority) but had no shape for the inverse case: a permission granted to **external participants who should get less than `manage`**. The canonical example is the ATS narrow tier for panel interviewers — engineers, PMs, AEs who write `interview_feedback` scorecards but should not get the rest of recruiter-level access. Other examples: external reviewers in performance management, guest contributors in CMS, vendor reps in procurement portals.

A narrow-tier permission is the inverse of an elevated one:
- **Elevated workflow permission** grants *more* than `manage` (offer-approval, manager-override). Holder set ⊂ admin holders ⊂ manage holders by capability. Rollup direction: `admin` includes the workflow permission so admins inherit it. Rolling up under `manage` would defeat the gate.
- **Narrow workflow permission** grants *less* than `manage`. Holder set ⊃ manage holders by count (more people can hold the narrow permission than `manage`) but ⊂ `manage` holders by *capability* (manage holders can do everything a narrow holder can, transitively). Rollup direction: `manage` includes the narrow permission so every `manage` holder transitively passes the narrow check. Rolling up under `admin` would *exclude* `manage` holders from the narrow tier, which is the opposite of intent.

The new convention:

1. **New `Type` value: `workflow-narrow`.** The §2 Permissions summary Type vocabulary expands from `{baseline-read, baseline-manage, baseline-admin, workflow}` to `{baseline-read, baseline-manage, baseline-admin, workflow, workflow-narrow}`. The bare `workflow` value retains its v2.0 meaning (elevated) — renaming it would be a breaking change; leaving it adds the narrow case as an explicit alternative.
2. **Inverted hierarchy direction for narrow-tier rows.** A `workflow-narrow` row's `Hierarchy parent` cell **must** be `<slug>:manage` (or higher in the baseline chain). A `workflow-narrow` row whose `Hierarchy parent` is `<slug>:admin` or `—` is a 🔴 Blocker — that rollup direction would exclude `manage` holders from the narrow tier, defeating the intent. The existing 🔴 "no `<slug>:manage` parent" rule applies only to `Type: workflow` (elevated); for `Type: workflow-narrow` the rule inverts to 🔴 "must be `<slug>:manage` (or higher)".
3. **`Edit permission:` annotation vocabulary extends to declared narrow-tier codes.** The v2.0 §3 `**Edit permission:**` annotation accepted only `manage` or `admin`. v2.1 also accepts any fully-qualified `<slug>:<suffix>` code that appears as a `Type: workflow-narrow` row in the §2 Permissions summary. This is how an entity binds its static `edit_permission` to a narrow tier (e.g. `interview_feedback` sets `Edit permission: interview` to wire `edit_permission = ats:interview`). The annotation parser reads `<bare_suffix>` as `<slug>:<bare_suffix>` so the §3 prose stays compact (`Edit permission: interview` not `Edit permission: ats:interview`).
4. **Stage 10 W4 expansion: narrow-tier participants.** The W4 "ownership-scoped edit" signal family was previously the only path to narrow-tier discovery (and only fired for entities with personal-content framing). v2.1 adds a recognition heuristic for the **external-participant pattern**: an entity whose primary writers are *outside* the module's normal operational role (panel interviewers in ATS, external reviewers in performance management, vendor reps in procurement). When detected, the family proposes a `workflow-narrow` tier (`<slug>:<role_noun>` — e.g. `ats:interview`, `perf:reviewer`, `procurement:vendor_rep`) alongside (or instead of) the elevated `manage_all_<plural>` permission, and the entity's `Edit permission:` annotation binds to the narrow tier.
5. **Mode B audit cross-checks under v2.1.** Every entity whose `**Edit permission:**` annotation names a code that is *not* `manage`, `admin`, or a `workflow-narrow` row in the §2 table is a 🔴 Blocker (undeclared narrow tier). Every `workflow-narrow` row in §2 must be referenced by at least one entity's `Edit permission:` annotation OR be invoked by at least one `require_permission` call (orphan narrow permission is a 🔴 Blocker, same rule as elevated workflow).

Minor bump, not major: the v2.0 column shape is unchanged (still five columns, same order); `workflow-narrow` is a new optional value within the existing `Type` column. v2.0 files contain no `workflow-narrow` rows and parse cleanly under v2.1. v2.1 files that don't *use* narrow tiers look byte-identical to v2.0. The downstream deployer's `EXPECTED_MAJOR` stays at `2`; the deployer's parser is bumped in lockstep to accept the new Type value and the inverted rollup rule. Files written under `2.0` that *should* have used a narrow tier (the v2.0 workaround was to invoke the elevated rule pattern plus a §7.2 note explaining why the static gate is overloaded) are flagged by the Mode B audit under `2.1` with a proposed fix: promote the workaround to an explicit `workflow-narrow` row.

---

## `2.0` (MAJOR) — mandatory §2 Permissions summary table

Mandatory **Permissions summary** table as the canonical source of truth for module permissions; the downstream deployer, optimizer, and skill-maker bump `EXPECTED_MAJOR` to `2` in lockstep.

In `1.x`, a model's permission story was scattered across three places: per-entity `**Edit permission:**` annotations in §3 (the static tier per entity), the `require_permission` references inside `validation_rules` JsonLogic (which permissions gate which transitions), and §8 step 1 (the enumeration of every permission to create with hierarchy rows). A reviewer had to read all three to understand what permissions a module declared, and the deployer had to cross-reference them on every parse. Drift between the three was a recurring audit finding. `2.0` collapses them: a single **Permissions summary** sub-section in §2 lists every permission with its tier, description, hierarchy parent, and the entities/rules that use it. The per-entity `**Edit permission:**` annotations and the per-rule `require_permission` references still exist as their own data (they're per-entity and per-rule respectively, not per-permission), but the permission *catalog* lives in one table.

The new convention:

1. **Mandatory `### Permissions summary` sub-section under §2.** Comes after the entity-summary table and the Mermaid diagram. Five columns: `Permission`, `Type` (baseline-read / baseline-manage / baseline-admin / workflow), `Description` (one line), `Used by` (which entities and rule codes consume it), `Hierarchy parent` (the permission this one rolls up under, or `—`). Every permission the model declares appears in exactly one row. The hierarchy column encodes the full rollup chain — the deployer iterates the table and creates each `create_permission_hierarchy` row from the column directly, no separate enumeration needed.
2. **§8 step 1 is simplified.** It no longer enumerates each permission inline; instead it instructs the deployer to create every permission listed in the §2 Permissions summary table in order, with the hierarchy rows derived from the same table. §8 step 2 is removed (the hierarchy data now lives in the table column). The implementation-notes section stays as the procedural guide for the deployer but stops being a parallel source of truth for the permission list.
3. **Cross-checks in Mode B audit.** Every `require_permission` argument inside `validation_rules` must appear in the Permissions summary table (🔴 Blocker if missing). Every permission listed in the table must be invoked by at least one `require_permission` rule OR serve as a baseline tier (read / manage / admin) referenced by at least one entity's `Edit permission:` annotation or `view_permission`/`edit_permission` default (🔴 Blocker if orphan). Every `**Edit permission:** admin` annotation must match a row in the table whose `Type` is `baseline-admin`. The Permissions summary IS the contract; the audit catches drift instead of fixing it silently.
4. **Deployer behavior under v2.** The deployer's `EXPECTED_MAJOR` is `2`; it refuses to parse v1 files. v1 files are routed through Mode D Rebuild on the analyst side (which re-authors at v2 and writes the Permissions summary table from the existing data — the rebuild has all the inputs it needs since v1 already encoded the permissions, just scattered).

Major bump, not minor: the file shape has a new required structural element (the §2 sub-section), and existing tooling without v2 awareness will silently miss it. Files written under any `1.x` are not deploy-compatible until they pass through Mode D Rebuild. The deployer, optimizer, and skill-maker bump `EXPECTED_MAJOR` to `2` in the same commit; partial upgrades produce confusing mismatches.

---

## `1.13` — linear stage numbering + parent requires shared permission scope

Stage renumbering (linear Stage 1 through Stage 11, no more `4b/4c/4d/4e/4f/4f-bis`); and a new modeling rule, `parent` requires shared-permission scope.

Two cleanups, one mechanical and one semantic.

1. **Linear stage numbering.** The legacy `Stage 4 → Stage 4b → Stage 4c → Stage 4d → Stage 4e → Stage 4f → Stage 4f-bis → Stage 5` shape grew incrementally and ended in a `-bis` that smelled wrong (a strong indicator the analyst is silently skipping the half-stage). `1.13` renumbers to a flat sequence: Stage 1 capture, Stage 2 vendor template, Stage 3 entities, Stage 4 fields, Stage 5 Mermaid (was 4b), Stage 6 related domains (was 4c), Stage 7 cross-model links (was 4d), Stage 8 computed/validation rules (was 4e), Stage 9 permission tier (was 4f), Stage 10 workflow-permission scan (was 4f-bis), Stage 11 write the file (was 5). Cross-references in the optimizer skill have been updated to match; the deployer's own internal stage labels are unrelated and unchanged. **No file-content shape change**: existing models still have §1 through §8 sections, and `version` major stays at `1`.
2. **`parent`-relationship requires shared permission scope.** A child entity referenced via `format: "parent"` semantically claims "I am wholly owned and governed by my parent's permission model". The platform enforces nothing about this, but the modeling contract is real, and it is broken whenever the child carries its own conditional permission gate (Stage 8 family-13 owner-or-manager edit rule, or any `validation_rules` rule whose JsonLogic invokes `require_permission` against a permission different from the parent's `edit_permission`). Examples: an interview's `feedback` row is permission-scoped to the interviewer who recorded it (not to the interview's coordinator); a job application's `note` row is permission-scoped to the note's author (not to the application's recruiter). In both cases the FK shape declaration should be `format: "reference"` (independent permission scope, possibly still cascade-deleted with the lifecycle owner), not `format: "parent"`. The new Stage 4 sub-rule names this explicitly and routes the analyst into the right delete-mode choice (`restrict` recommended default, `clear` for orphan-safe, `cascade` with a high-risk acknowledgment). Mode B audit raises 🟡 Warning + proposed fix when it finds a `parent` FK on a child that carries family-12 or family-13 rules referencing permissions that diverge from the parent's tier.

Minor bump, not major: column shape and front-matter keys are unchanged. The downstream deployer's `EXPECTED_MAJOR` stays at `1`. Files written under `1.12` are still structurally valid, and the audit pass under `1.13` proposes the parent→reference flips on entities where the new rule fires.

---

## `1.12` — mandatory mechanical workflow-permission walk

Mandatory mechanical workflow-permission walk; the `1.11` shape was passive and got skipped.

`1.11` added Families 12 / 13 to the signal-scan, plus a Stage 10 "workflow-permission scan" that walked every entity for approval / sign-off / lock-in events. In practice, none of that fired. The scan was framed as "look for signals" rather than "produce an artifact", and Mode D's Step D2 walk did not explicitly call Stage 10 as its own mandatory gate. The result: rebuilds shipped without proposing the workflow permissions a non-trivial domain obviously needs (an interviewer permission for `interview_feedback.is_submitted`, an approver for `offers.status='approved'`, a closer for `job_openings.status='closed'`). The `1.12` design fixes this by treating workflow-permission discovery the same way `1.4`/`1.5` fixed validation-rules under-detection: a *structured table the analyst must produce*, with an empty cell as a visible miss, plus an explicit gate in every write mode.

The new convention:

1. **Stage 10 becomes mechanical and mandatory.** Every model write (Mode A Stage 10, Mode C update, Mode D Step D2 gate 10) must produce a structured **workflow-permission scan table** with one row per entity. The row lists each entity's *workflow-shaped signals* across six families (lifecycle approval, lifecycle terminal closure, submit-then-lock, sign-off / publication, ownership-scoped edit, ownership reassignment). Each signal cell is either *"none"* with a one-line reason, or a proposed permission code + the rule it gates. An entity with zero workflow rules but at least one workflow-shaped signal must carry a §7.2 justification. The forward-scan table IS the audit, exactly mirroring Stage 8's design.
2. **Signal vocabulary expanded.** `1.11`'s Family 12 looked for `approved` / `signed` / `released` enum values; Family 13 looked for `created_by` framed as personal. `1.12` adds: `is_submitted` / `is_locked` / `is_final` boolean flags and their `*_at` timestamp siblings (the submit-then-lock pattern, classic for `interview_feedback`, `scorecards`, `journal_entries`); `closed` / `cancelled` / `void` / `archived` on high-weight records (a contract void requires admin, a hired candidate transition requires HR); `assignee_id` / `coordinator_id` reassignment events; and the "recording-of-evidence" entity shape (an entity whose primary purpose is to capture one user's input that becomes part of an audit trail, where only that user should originate it). The signal phrases catalog grew accordingly.
3. **Mode D gate 10 is its own confirmation step.** Step D2 of Mode D now lists Stage 10 as a separate, mandatory gate after Stage 9, with the same "do not skip, do not collapse, do not bundle" discipline as Stage 6. A rebuild that produces zero workflow permissions must surface the scan table to the user so they can confirm "yes, this domain genuinely has no workflow gates" (rare for non-trivial domains) rather than implicitly skipping the analysis.
4. **Audit checks (Mode B) under `1.12`** add: every entity with a `*_status` enum or an `is_submitted` / `is_locked` / `is_final` flag must appear in the scan-table evidence (or carry a §7.2 entry explaining why no workflow permission applies) (🟡 Warning); the file's `version: "1.12"` stamp is the contract that the scan was performed, an older-version file is given a one-line audit note rather than treated as a defect, but the file isn't re-stamped until the audit also re-runs Stage 10 end-to-end.

Minor bump, not major: column shape and front-matter are unchanged. The audit-pass under `1.12` adds new checks; the deployer's `EXPECTED_MAJOR` stays at `1`. Files written under `1.11` are structurally valid but were authored under the under-trigger version; route them through a Mode B audit pass before deploy.

---

## `1.11` — conditional permissions via `value_changed` + `require_permission`

Conditional permissions via two new JsonLogic operators, plus a workflow-permission scan in Stage 4.

The platform's JsonLogic dialect now ships two side-effecting extensions: `{"value_changed": "<field>"}` (true when the field moved relative to `$old`, true on INSERT) and `{"require_permission": "<perm_code>"}` (true when caller holds it, throws otherwise). Together they make *conditional* permission checks expressible inside `validation_rules`, which closes the gap between coarse static `edit_permission` and the per-transition or per-owner gates real business workflows need (approval steps, owner-only edits, sign-off gates).

The new convention:

1. **Stage 8 signal-scan grows two families.** Family 12 (transition-gated permission, e.g. *"only an approver can mark approved"*) and family 13 (owner/manager edit scope, e.g. *"only the author or a manager can edit a note"*). Both compile to JsonLogic that uses `value_changed` and/or `require_permission`. The signal-scan table for each entity must walk every meaningful field against the 13-family catalog (was 11), with the same "empty cells are visible misses" discipline.
2. **Stage 10 (workflow-permission scan).** After classifying entities operational/admin-tier, walk every entity's enum lifecycle and §3 prose once more for *approval / sign-off / lock-in* language. Each finding may justify a workflow-specific permission (`<slug>:approve_<noun>`, `<slug>:close_<noun>`, `<slug>:sign_<noun>`, `<slug>:manage_all_<plural>`) rather than overloading `<slug>:admin`. These permissions are declared in §8 step 1 alongside the baseline triple and referenced by `require_permission` inside the matching family-12 / family-13 rules.
3. **§8 step 1 enumerates workflow permissions too** (in addition to the baseline `read` / `manage` / `admin`). The deployer reads §8 and creates each one. Workflow permissions roll up under `<slug>:admin` in §8 step 2's hierarchy (`admin includes approve_offer`, etc.) so administering the module transitively grants every workflow gate.
4. **Audit pass under `1.11`** adds three checks: every `require_permission` argument is declared in §8 step 1 (🔴 Blocker, deploy will reject otherwise); entities with terminal-approval enum values (`approved`, `signed`, `released`, `published`) carry a family-12 rule or a §7.2 escape (🟡 Warning); entities whose prose says "only the owner / author / assignee can edit" carry a family-13 rule (🟡 Warning).

Minor bump, not major: column shape and front-matter are unchanged. The two new families add rules to `validation_rules` but the array shape is identical; the new workflow permissions add entries to §8 step 1 but the section structure is unchanged. Files written under `1.10` remain structurally valid; the audit pass under `1.11` adds the new checks and proposes fix-up writes for older files. The downstream deployer's `EXPECTED_MAJOR` stays at `1`; the deployer gains a parse-time cross-check (it walks `validation_rules` JsonLogic for `require_permission` and rejects deployments whose referenced permission codes are not declared in §8).

---

## `1.10` — three baseline permissions + per-entity tier annotation

Three baseline permissions instead of two, with an entity-level tier annotation.

Two-permission baseline (`<slug>:read` / `<slug>:manage`) is too coarse for most non-trivial modules. The same recruiters who manage `job_openings` and `job_applications` shouldn't also be rewriting the canonical `candidate_sources` list; the same support agents working tickets shouldn't be editing the `priorities` enum table. The split is universal: **operational** data (the bulk of records, edited many times a day by many people) versus **reference / config** data (small lookup / pipeline-definition / type tables that change rarely and only by an admin).

The new convention:

1. **Three baseline permissions per module.** `<slug>:read` (view), `<slug>:manage` (write operational), `<slug>:admin` (write reference/config). Hierarchy chain: `admin` includes `manage` includes `read`, so granting the higher tier transitively grants the lower ones. Permission name picked over `configure` because `admin` is what every leading SaaS scopes to a module (Jira "Administer Project", ServiceNow `itil_admin`, Atlassian "Space Admin").
2. **Per-entity `**Edit permission:**` annotation in §3** (next to `**Audit log:**`). Values: `manage` (default, omit the line) or `admin` (annotate explicitly). The deployer reads this to set `edit_permission` per entity. `view_permission` is always `<slug>:read`.
3. **Analyst classifies every entity during Stage 4** using a mechanical rule (Stage 9). An entity is admin-tier when (a) it is small and slowly-changing, (b) it is referenced by other entities as a lookup/category/stage/type/source, and (c) it typically ships seeded values. Otherwise operational.
4. **§8 step 1 enumerates the three permissions, the two-row hierarchy chain, and the admin-tier entity list** (the entities whose §3 carries `Edit permission: admin`). §8 step 3 updates the per-entity `edit_permission` assignment.
5. **Fallback to two permissions** when the model is purely operational (no admin-tier entities classified): create only `read` + `manage`. State the reason in §8 step 1. The hierarchy is then a single row `manage → read`.

Minor bump, not major: column shape and front-matter are unchanged. The new `Edit permission:` line is an optional entity-level annotation with a default. Files written under `1.9` remain structurally valid; the audit pass under `1.10` adds checks for the new convention and proposes fix-up writes for older files. The downstream deployer's `EXPECTED_MAJOR` stays at `1`.

---

## `1.9` — default coupled to validation + description for jargon titles

Two authoring rules tightened, both prompted by a real deployment foot-gun where an ATS `Headcount` field opened forms prefilled with `0` and failed the `headcount_positive` rule on save.

1. **Default coupled to validation.** When a field's auto-default (per the Semantius `is_nullable()` / column-default contract) would violate any `validation_rules` entry that references the field, the analyst must declare an explicit `default: "<value>"` annotation that satisfies the rule. Common trigger: required integer/number with a `>= N` floor (N>0) — auto-default `0` fails. The audit pass enforces this as a 🔴 Blocker.
2. **Description for jargon titles.** The "fill the Description column when" list grew a 7th trigger: the title is a domain term-of-art a non-specialist couldn't parse cold (acronyms `MRR`/`FTE`/`RICE`, single-word jargon like `Headcount`/`Disposition`/`Loss Reason`). Descriptions remain the exception, not the rule — plain-English titles (`First Name`, `Email`, `City`) still leave the column blank. The added rule is calibrated with examples and a one-line test ("would someone from a different department know what to type?") to keep it from drifting into "describe every field just in case".

Minor bump, not major: column shape is unchanged, only the rules content must satisfy. Files written under `1.8` remain structurally valid; rewriting them under `1.9` (via the analyst's audit pass) tightens content but doesn't break readers.

---

## `1.8` — §3 Description column

§3 field tables grew a new **Description** column between **Label** and **Reference / Notes**. Description prose now lives in that dedicated column instead of being smuggled into Notes as a `description: "..."` annotation. The deployer reads the column directly. **Major stays at `1`** because this skill is still pre-release / prototyping and no committed models need migrating; once the convention is stable and external models exist, a column-shape change like this becomes a major bump.
