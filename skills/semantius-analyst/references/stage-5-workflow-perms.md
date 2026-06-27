# Stage 5: Workflow-permission scan (W3/W4/W4n/W5)

*Reference for `semantius-analyst` (Stage 5).*

## Stage 5: Workflow-permission scan (W3/W4/W4n/W5)

> **`access_scope = basic` short-circuit.** When the resolved scope is `basic`, this stage emits **nothing** — no `workflow-gate` / `narrow` / `override` rows, no gating `validation_rules`. Skip straight to Stage 6. (See the "What basic authors" access-control contract in SKILL.md.)

The architect already handled W1/W2/W6 (lifecycle-terminal gates) at blueprint time — they appear in §7 `requires_permission?` rows and as `workflow-gate (lifecycle)` permissions in §8.1. This stage adds the field-driven workflow permissions:

**W3 — Submit-then-lock.** When an entity has an `is_submitted` boolean or a `submitted_at` timestamp and writes after submission are restricted, propose a `<slug>:bypass_submit_lock` workflow permission. Encode as a `validation_rules` entry on the entity: `{"code": "no_writes_after_submit", "message": "...", "jsonlogic": {"if": [{"==": [{"var": "$old.is_submitted"}, true]}, {"require_permission": "<slug>:bypass_submit_lock"}, true]}}`.

**W4 — Ownership-scoped edit.** When an entity has an `owner_id` / `assignee_id` / `author_id` FK to `users` and edits should be restricted to that user, propose row-scope via `validation_rules` (writes) + `select_rule` (reads). **Stage 7's row-scope playbook (S1) owns the private-vs-oversight decision and the override-permission emission** (the blueprint no longer carries a flag for it): when the playbook picks *owner + oversight*, §8.1 gains `<slug>:view_all_<plural>` (read override) and `<slug>:manage_all_<plural>` (write override) as `override`-tier rows rolled up under `:admin`, and the write-side `validation_rules` gate on `manage_all_`; when it picks *private*, no override permissions are minted and the write rule scopes to the owner alone.

**W4n — Narrow-tier external write.** When an entity is written by external participants (panel interviewers, external reviewers) who don't have full `:manage`, declare a `narrow` tier permission `<slug>:<narrow_suffix>` and mark the entity's `**Edit permission:** <narrow_suffix>` annotation. The narrow tier rolls up under `<slug>:manage` (never `—`, never `<slug>:admin` alone).

**W5 — Reassignment.** When an `assignee_id` change is policy-different from other writes, propose `<slug>:reassign_<entity>` workflow permission. Encode as a `validation_rules` rule: `{"if": [{"value_changed": "assignee_id"}, {"require_permission": "<slug>:reassign_<entity>"}, true]}`.

Output: every W3/W4/W4n/W5 discovery adds a row to spec §8.1 Permissions catalog AND emits the corresponding `validation_rules` / `select_rule` JsonLogic on the affected entity.

For full scan logic (W1/W2/W6 included for cross-reference) see the architect's Stage 10 — but in the analyst, only W3/W4/W4n/W5 are net-new work; W1/W2/W6 come from the blueprint.
