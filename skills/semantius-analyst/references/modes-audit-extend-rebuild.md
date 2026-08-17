# Modes B / C / D: Audit, Extend, Rebuild

*Reference for `semantius-analyst`. The default Reconcile flow is in SKILL.md; these are the non-reconcile invocations.*

## Mode B: Audit (review existing spec)

When the user has an existing `*-semantic-spec.md` and wants it audited (without deploying), run a read-only pass over the file.

### How to run the audit

Load the file and walk every section. **Do not rewrite the file** unless the user explicitly asks. Produce a structured report grouped by severity:

- 🔴 **Blocker** — the modeler will refuse to deploy or the spec is internally inconsistent. Must fix before deploy.
- 🟡 **Warning** — the spec is valid but a convention is violated or a smell is present.
- 🟢 **Note** — informational, no action required.

### Field-level audit checks

These run on every owned entity (skip `reuse-from` / `dropped`):

- **Entity health**:
  - `label_column` is a scalar field, not a FK (🔴 if FK).
  - No `id` / `created_at` / `updated_at` / auto-label field in the §3 field table (🔴 if present).
  - Every `enum` field has `enum_values` (🔴 if missing).
  - Effective default satisfies all `validation_rules` (🔴 if default would reject on auto-fill).
  - Monetary fields (`amount`, `price`, `cost`, `total`, …) use `format: number` not `float` (🟡 if otherwise).
  - Multi-line text uses `format: multiline` not `text` (🟡 if title is a description-shaped term).

- **Relationship integrity**:
  - Every FK has a §4 row (🔴 if missing).
  - Every FK has a `relationship_label` annotation in §3 Notes (🟡 if missing).
  - §2 Mermaid edge direction + verb matches what §3 `relationship_label` + §4 `Cardinality`/`Kind` derive (🔴 if drift — mechanically enforced by `consistency-check.ts`, not an eyeball check; see `stage-11-write.md` "Generate §2, never hand-author it"). If a hand-edit drifted §2 out of sync, regenerate it with `consistency-check.ts --emit-mermaid` rather than patching the diagram by hand.
  - `format: parent` + `Delete: clear` is a 🔴 (parent-owned child cannot orphan-survive parent).
  - `format: reference` + `Delete: cascade` is a 🟡 (probably should be `parent`).

- **Permissions consistency** (cross-check §8.1 Permissions catalog + §9.1 hierarchy vs every entity / rule):
  - Every `require_permission` argument is in §8.1 (🔴 if not).
  - Every entity with `**Edit permission:** admin` has the `baseline-admin` row (`<slug>:admin`) declared in §8.1 (🔴 if missing).
  - Every `workflow-gate (rule)` row is invoked by at least one rule; every `workflow-gate (lifecycle)` row matches a §7 `requires_permission?` state (🟡 if dead).
  - Every `narrow` row is consumed by an entity's `Edit permission:` annotation or a rule (🟡 if dead).
  - No `workflow-gate` permission is included by `<slug>:manage` in §9.1 (🔴 — defeats the gate).
  - Every `narrow` permission rolls up under `<slug>:manage` or higher in §9.1 (🔴 — narrow tier would be unreachable otherwise).

- **Rule blocks** (computed_fields, validation_rules, input_type_rules, select_rule):
  - JSON is valid (🔴 if not parseable).
  - Every `computed_fields[].name` resolves to an existing scalar field on the same entity (🔴).
  - Every `validation_rules[].code` is snake_case and unique within the entity (🔴 on collision).
  - Every column referenced inside any JsonLogic is on the same entity (🔴 on dangling) — unless wrapped in `set_record` / `let`.
  - Bypass-prose in a `select_rule` `description` reconciles with the JsonLogic body (🔴 on disagreement).
  - No throwing operator (`require_permission` / `throw_error`) inside a `select_rule` body (🔴: `select_rule` runs per-row on every read, so a throw aborts the read; use the non-throwing `has_permission`).
  - No `throw_error` at top level without `if` guard (🔴).
  - `set_record` references an existing entity (🔴).

- **Reconciliation annotations**:
  - Every blueprint entity has exactly one decision (🔴 on missing / multiple).
  - `reuse-from` entities have no Fields block (🔴 on over-spec).
  - `promote-to-master` entities have a corresponding `promotion_decisions` entry in frontmatter (🟡 if missing).
  - Annotated source modules (`reuse-from <module>.<entity>`) exist in the live catalog (🟡 if dormant — flag for user awareness).

- **Universal scans**: em-dash, US-spelling, DDL, identifier-leakage (per Writing Conventions 1, 2, 6, 7).

### Audit output format

```
🔴 Blockers (N)
  - <entity>.<field>: <description>  [line <N>]
  - ...

🟡 Warnings (N)
  - ...

🟢 Notes (N)
  - ...

Total: N blockers, N warnings, N notes.
```

End with: *"Run `semantius-analyst` Extend mode to fix specific items, or fix manually then re-run audit."*

---

## Mode C: Extend (add to existing spec)

When the user wants to add entities, fields, rules, or §6 link rows to an existing spec:

1. Read the current spec. Note its `version` (must be `"5.4"` major; older → Mode D Rebuild first).
2. Capture what to add (entity / field / rule) via conversation.
3. **If adding entities**, re-run Stage 2 reconciliation against the live catalog for the new entities only. Same collision detection, same widgets.
4. **If adding fields to an existing owned entity**, apply Stage 4 field elicitation for the new fields. Then re-run Stages 5-10 (scans, consistency gate) on the affected entity.
5. **If adding rules**, draft the JsonLogic; run the Stage 8 consistency gate.
6. Stamp `version: "5.4"` (no bump unless skill version bumped).
7. Write the updated file at **`semantius/specs/<system_slug>-semantic-spec.md`** (create the folder if missing). If the input file you read in step 1 sits at the workspace root, leave that file alone; the `semantius/specs/` path is the truth-source. Run the pre-save verification block from Stage 11.

---

## Mode D: Rebuild (holistic re-derivation)

Use when the blueprint has materially changed (entities added/removed, role classifications flipped, lifecycle states added) and the spec needs a fresh pass rather than a series of Extends.

1. Read the existing spec as content, not structure. Extract user-confirmed decisions worth preserving: `promotion_decisions`, custom field titles diverging from blueprint defaults, hand-tuned descriptions in §1, §7 questions and their resolutions.
2. Drive a fresh Stage 1-10 pass with the current blueprint as input.
3. **Carry forward** the preserved decisions where they still apply (e.g. a `promote-to-master` decision for an entity that's still in the blueprint).
4. Show the user a diff summary: what's new, what's changed, what's removed.
5. Stamp `version: "5.4"`, write a fresh file at **`semantius/specs/<system_slug>-semantic-spec.md`** (create the folder if missing). If the input spec sits at the workspace root, leave that file untouched; the `semantius/specs/` path is the canonical location. Git tracks both files; the user can `git mv` or delete the root copy when ready.
