---
name: semantius-deploy-test-maker
description: >-
  Generates a self-contained TypeScript verification script that pedantically
  checks a live Semantius instance against a `*-semantic-model.md` file
  (produced by the semantic-model-analyst skill and deployed by the
  semantic-model-deployer skill). Use this skill whenever a model exists and
  the user wants a post-deploy drift-detection harness, an automated check
  that the deployer did its job, or a regression test to run after future
  re-deploys. Trigger on phrases like "make a deploy test for the X model",
  "generate a verification script for this semantic model", "after deploy I
  want to validate", "test that semantius matches the model", "post-deploy
  check", "drift detection script for this model", "did the deployer cover
  everything", "verify the model is fully in place", "build me a check that
  fails if anything is missing", and any variation where the user wants an
  executable post-deploy assertion that the live catalog faithfully contains
  every entity, field, enum value, permission, role, role-permission,
  permission-hierarchy edge, and (when present) webhook receiver declared in
  the model. Also trigger when a `*-semantic-model.md` file is present in the
  workspace and the user asks for a test, harness, validator, or assertion
  script tied to that model. The skill produces the script; the user runs it
  after each deploy. Undetected drift between model and live state is
  business-critical, the generated script is deliberately exhaustive: it
  fails loudly on any missing or differing item declared in the model, and
  is silent about additional items in Semantius that the model does not
  declare (the deployer is additive).
---

# semantius-deploy-test-maker Skill

This skill takes a `*-semantic-model.md` file and writes a single self-contained TypeScript file that, when executed with `bun`, asserts the live Semantius instance contains **every** entity, field, enum value, permission, role, role-permission link, permission-hierarchy edge, and webhook receiver the model declares, with the exact properties the model specifies.

**Why this exists.** The deployer is additive: it creates what's missing and updates what differs. Its in-process Stage 5 report (see the deployer skill) confirms the writes it issued, but it does not re-prove the end state from a cold read after the session ends. Manual re-runs of the deployer are still the only mechanism that retries reconciliation. Live state can drift between deploys (an admin edits a field's `title` in the UI, an entity gets renamed, a `role_permission` is deleted, a `permission_hierarchy` edge is dropped). Without a standalone post-deploy check, that drift is invisible until users hit it in production. **The user's words:** "if any difference between model and semantius platform remain undetected we will all lose our business and maybe existence." Take that seriously. Over-check rather than under-check.

**Division of responsibility.**

- This skill owns the workflow: parse the model, plan the checks, emit one self-contained TypeScript file. The skill itself does **not** call Semantius and does **not** run the test.
- The generated **script** owns execution: shells out to the `semantius` CLI, reads live state, compares against the model embedded inline as a JSON constant, prints a structured report, exits non-zero on any mismatch.
- The `use-semantius` skill owns CLI conventions; this skill borrows its `read_*` patterns and `--single` semantics, but applies them inside the generated script rather than at chat time.

## Writing conventions (apply to chat output and the generated script)

These match the rest of the semantic-model skill family. Apply them to both the chat narration in this skill and every string the generated TypeScript file prints.

**1. US English spellings, always.** Examples (left = correct US, right in backticks = banned British form): optimize (not `optimise`), behavior (not `behaviour`), modeling (not `modelling`), labeled (not `labelled`), normalize (not `normalise`), analyze (not `analyse`).

**2. No em-dashes (`—`, U+2014).** Use parentheses, commas, periods, or semicolons. Scan output for `—` before writing any file.

**3. Singular-subject grammar in confirmation prompts.** "Looks good?" not "Look good?".

---

## Step 0: Load required context

Before parsing anything, read these so the generated script reflects current conventions:

```
Read: <skills-root>/use-semantius/SKILL.md
Read: <skills-root>/use-semantius/references/data-modeling.md
Read: <skills-root>/use-semantius/references/rbac.md
Read: <skills-root>/semantic-model-deployer/SKILL.md   # at least the parse rules in Stage 1 and the per-area checks in Stage 5
```

You also load this skill's own deeper reference for the checks the script must implement:

```
Read: <this-skill>/references/checks-catalog.md
```

The checks catalog is the canonical list of comparisons the generated script performs, with the exact `semantius` call shapes, the exact mapping from model property to live property, and the exact failure-message format. Treat it as the script's specification.

---

## Schema compatibility

This skill consumes the same model files the deployer consumes; track the deployer's `EXPECTED_MAJOR` value, currently `3`. At parse time, read the model's front-matter `version` and compare its **major** against this value. Major mismatch is a 🛑 blocker; tell the user the version found and the major this skill expects, and route them to the analyst's audit mode to migrate the file before regenerating the test script.

When the analyst's major bumps, this skill and the deployer both must move with it: a major bump means section numbers, table columns, or required front-matter keys have changed, and the checks catalog must follow. Keep the `EXPECTED_MAJOR` constant near the top of this file in sync with the deployer's.

---

## High-level workflow

```
1. Locate the model  →  2. Parse it  →  3. Plan checks  →  4. Emit the script  →  5. Tell the user how to run it
```

Narrate what you're doing at each step. Do **not** call Semantius from chat; the script is the only thing that should ever touch the live instance.

---

## Stage 1: Locate the model

If the user named a path, use it directly. Otherwise look in the current working directory for `*-semantic-model.md` and present the matches as a compact list (`filename`, `system_slug`, `version`); ask which one to target. Never glob across unrelated directories without being asked, the model file may be one of several.

Capture the model's absolute path; the generated script will sit next to it as `<system_slug>-deploy-test.ts` by default.

---

## Stage 2: Parse the model

Parse the same way the deployer does (Stage 1 of the deployer skill is the canonical procedure; mirror it). The verifier does **not** need to enforce every Stage 1 blocker the deployer does (those are deploy-time concerns), but it does need every fact the deployer would write to the catalog. Extract:

### Front-matter

- `version` (required; major-gate first, see Schema compatibility above)
- `system_slug` (this is the module slug)
- `system_name` (the module's display name)
- `system_description` (the compact tagline)
- `module_type` (optional, defaults to `"domain"`; the verifier asserts the live `module.module_type` matches)
- `entities` list (informational; the §2 table is authoritative)

### §2 Entity summary table

Build the canonical entity order. Each row gives `table_name` and `singular_label`.

### §2 Permissions summary table (analyst v2.0+)

Parse the five-column table verbatim: `Permission | Type | Description | Used by | Hierarchy parent`. Build a `permissions[]` list (each entry: `permission_name`, `type`, `description`, `used_by`, `hierarchy_parent`). The `Type` values are `baseline-read`, `baseline-manage`, `baseline-admin`, `workflow`, `workflow-narrow`. Permissions and hierarchy edges in this table are what the generated script asserts exist; everything else in the §2 chunk is informational.

### §3 Entity sections

For every entity, capture:

- `table_name`, `singular_label`, `plural_label`, `description`, `label_column`, `audit_log` (default `no`)
- `edit_mode` (optional; the platform default is `auto`; the verifier skips the comparison when the model is silent regardless of live value)
- `cube_mode` (optional; the platform default is `auto`; the verifier skips the comparison when the model is silent regardless of live value)
- `view_permission`: always `<system_slug>:read`
- `edit_permission`: resolved from `**Edit permission:**` line (default `<system_slug>:manage`; `admin` ⇒ `<system_slug>:admin`; bare narrow suffix matching a `workflow-narrow` row ⇒ `<system_slug>:<suffix>`)
- For each field row in the entity's table:
  - `field_name`, `format`, `title` (the Label column)
  - `reference_table` (parsed out of the Reference / Notes column for `reference` and `parent` rows)
  - `relationship_label` (parsed from the `relationship_label: "<verb>"` annotation)
  - `singular_label_parent` / `plural_label_parent` (from `parent label: "<sing>" / "<plur>"`)
  - `cube_type` (default `auto` when absent)
  - `default_value` (from `default: "<value>"`)
  - `unique_value` (true when the Notes cell carries the `unique` token)
  - `description` (the fifth column; verbatim)
  - `enum_values` (collected from the §5 sub-section the Notes cell references; only present for `format: enum`)
- The entity's `computed_fields` and `validation_rules` JSON arrays (parse verbatim; default `[]` when the heading is absent)
- The entity's `select_rule` JSON object (parse verbatim; default `{}` when the heading is absent)
- The entity's `input_type_rules` JSON array (parse verbatim; default `[]` when the heading is absent)

### §4 Relationship summary

For every FK row in §3, the §4 table gives `reference_delete_mode` (the Delete mode column). Carry that into the field record so the script can assert it on `read_field`.

### §5 Enumerations

One sub-section per enum field. The values list is the authoritative `enum_values` for the corresponding field.

### Per-module scaffold the deployer always applies

The deployer applies a standard scaffold to every module it touches. Even when the model does not enumerate them explicitly, the generated script asserts these exist:

- The module exists with the right `module_slug`, `module_name`, `module_type`, and `description`.
- The three baseline permissions exist: `<slug>:read`, `<slug>:manage`, and `<slug>:admin` **when** the model declares an admin-tier row (a `Type: baseline-admin` row in the §2 Permissions summary table). Without that row, only `read` and `manage` are required.
- The three default roles exist: `<slug>_viewer`, `<slug>_manager`, and `<slug>_admin` (admin only when the baseline-admin permission exists). The roles' `module_id` matches the module's `id`.
- The role-permission joins: viewer carries `<slug>:read`; manager carries `<slug>:manage`; admin carries `<slug>:admin`.
- The baseline permission hierarchy: `<slug>:manage → <slug>:read`, and `<slug>:admin → <slug>:manage` when admin exists.
- The module's view/manage/admin permission columns: **`view_permission` is a string column** (carrying the permission name verbatim, e.g. `"itsm:read"`); **`manage_permission_id` and `admin_permission_id` are FK id columns** (`admin_permission_id` nullable when no admin tier). There is **no** `view_permission_id` column on the live `modules` table — earlier catalog versions claimed there was, that was incorrect. Plus three FK id columns for the default roles: `default_viewer_role_id`, `default_manager_role_id`, `default_admin_role_id` (nullable when no admin tier). The generated script reads the live `modules` row, compares the string and resolves each FK against the natural-key-to-id map it built during the permission/role check.

Additional permissions, roles, or hierarchy edges that the model declares in the §2 Permissions summary table (workflow / workflow-narrow rows, custom hierarchy edges) are layered on top of this scaffold and asserted individually.

### Semantius built-in entities (platform-owned; relaxed check)

Semantius ships with a small set of built-in entities the deployer dedups against rather than recreating. The current canonical set is `users` (others may follow). The script emits a `BUILT_IN_TABLES` constant (currently `["users"]`) at the top of the module so a future major bump can extend it in one place.

Built-in entities are **platform-owned**. The deployer reuses the live row as-is and does not write its metadata; treating any of that metadata as a deploy contract produces false-positive drift on every run. The verifier's job for built-ins is to confirm the load-bearing surface the model relies on (the columns the model reads and writes, plus the workflow rules the model registers) and nothing more. Concretely, for every entity in `BUILT_IN_TABLES`:

1. **Lookup**: query `read_entity --single '{"filters":"table_name=eq.<table>"}'` unscoped by `module_id` (the built-in's live row lives in the platform's identity module, not the current model's module).
2. **Field existence only**: for each field the model declares, assert one live `fields` row exists with the same `field_name`. **Do not** compare `format`, `title`, `description`, `unique_value`, `enum_values`, `default_value`, `relationship_label`, `reference_table`, `reference_delete_mode`, `input_type_rule`, or any other field-level property.
3. **Rule-name presence**: when the model declares `computed_fields` or `validation_rules` with non-empty arrays, assert each entry's identifier (`name` for `computed_fields`, `code` for `validation_rules`) is present in the live entity's corresponding JSON array. Live may carry additional entries (additive). JsonLogic content and other rule metadata are **not** compared.
4. **All other entity-level metadata is skipped**: no checks on `module_id`, `singular_label`, `plural_label`, `description`, `label_column`, `audit_log`, `view_permission`, `edit_permission`, `edit_mode`, `cube_mode`, `select_rule`.

This is a deliberate relaxation against the rest of the verifier's "over-check, never under-check" stance. The justification is asymmetric ownership: the deployer never writes a built-in's `module_id`, `view_permission`, `audit_log`, etc., so the model's declaration of those properties is documentation of the model's own assumption about the platform, not a deploy assertion. The verifier reports drift on things the deployer is responsible for; platform-owned metadata is governed by the platform's release process, not the model.

### Webhook receivers

If the model carries any webhook receiver declarations (a `## Webhook receivers` section, or an equivalent block; analyst convention is to declare them with a `name`, `event`, and optional `url`/`description`), parse them into a `webhook_receivers[]` list and assert each one exists with matching properties. The model files in current use rarely declare these; when the section is absent, the script does not assert any.

---

## Stage 3: Plan the checks

Build the complete check list in memory. **Every** model fact maps to at least one assertion in the generated script. The catalog in [`references/checks-catalog.md`](references/checks-catalog.md) is the canonical specification; read it before writing the script and follow it row-for-row.

The high-level grouping the script emits, in execution order:

1. **Module check.** Confirm the module exists by slug, with matching `module_name`, `module_type`, and `description`, and that the six scaffold permission/role columns resolve correctly (the asymmetric `view_permission` string plus five FK ids).
2. **Permissions check.** For every row in the §2 Permissions summary table, plus the implicit baseline rows, look up the live `permissions` record **by `permission_name` (its unique natural key) using a `--single` read scoped globally — never filtered by `module_id`**. A row that exists with the right name but a null or mismatched `module_id` is then reported as a `module_id` mismatch, not as missing. After the lookup, compare `description` and `module_id` (against the module id from check 1.1). The script also builds a `permission_name → id` map from these lookups, used by checks 3 and 5.
3. **Permission-hierarchy check.** For every `Hierarchy parent` value in the table (and for the implicit baseline edges), confirm a live `permission_hierarchy` row exists with the matching `(including_permission_id, included_permission_id)` — the broader (including) permission on the `Hierarchy parent` side, the narrower (included) permission on the row's own `Permission` side.
4. **Roles check.** Confirm the three default roles exist by their `slug` (the live natural key, **not** `name` which is the deployer-chosen display label). Use a per-role `--single` read filtered **only** by `slug=eq.<role_slug>`, scoped globally. A role with the right slug but a null or mismatched `module_id` is reported as a `module_id` mismatch, not as missing. Compare `module_id` against the module id from check 1.1. Role display name and description are deployer-chosen and not asserted.
5. **Role-permissions check.** Confirm each default role carries its baseline permission via `role_permissions`. Any model-declared role-permission link beyond the baseline gets its own check.
6. **Entities check.** For every entity in the model, confirm the live `entities` record exists in this module with matching `singular`, `plural`, `singular_label`, `plural_label`, `description`, `label_column`, `audit_log`, `edit_mode`, `cube_mode`, `view_permission`, `edit_permission`, and the entity-level JSON properties (`computed_fields`, `validation_rules`, `select_rule`) compared by value-equality. **Entities in `BUILT_IN_TABLES` take the relaxed built-in branch instead** (field-existence-only plus rule-name presence; see the "Semantius built-in entities" subsection in Stage 2).
7. **Fields check.** For every model field on every entity (after auto-field stripping, see below), confirm the live `fields` record exists with matching `format` (with the label-column alias), `title`, `description`, `reference_table`, `reference_delete_mode`, `relationship_label`, `singular_label_parent`, `plural_label_parent`, `cube_type`, `default_value`, `unique_value`, `enum_values`, and `input_type_rule`. The `fields` table joins to its entity via the **`table_name`** string column (not `entity` or `entity_id`); the live `fields.id` is the composite string `"<table_name>.<field_name>"`. Batch-read fields once per entity by `table_name=eq.<table>` and look up by name in a local `Map`. **Fields on built-in entities are checked for existence only**; see the "Semantius built-in entities" subsection in Stage 2.
8. **Webhook receivers check** (only if the model declares any).

### Auto-field stripping (mandatory)

Semantius auto-creates these fields on every entity. The model never declares them, so the script must **not** assert their absence or look them up:

| Field name | Why skipped |
|---|---|
| `id` | Auto-created primary key |
| `label` (the generic `ctype: label` row, distinct from the named `label_column` field) | Auto-created computed display field |
| `created_at`, `updated_at` | Auto-maintained timestamps |

**Keep** the named `label_column` field (e.g. `product_name`). It is rendered in §3 and is a normal assertion target.

### Additive-is-OK rule

The script must **not** fail when Semantius carries extra entities, fields, permissions, roles, role-permission links, hierarchy edges, or webhook receivers that the model does not declare. The deployer is additive, an admin may have added bespoke fields, and the model's contract is "everything I declare is there", not "nothing else is there". A field's `description` cell being blank in the model means the model has nothing to assert about that field's live description, so the script skips that one comparison (do not assert `description === ""`); the same goes for any other optional property where the model is silent.

The one exception is enum value lists: when the model declares an enum's values, the live `enum_values` array must contain **every** model value with matching ordering and casing. Extra live values beyond the model's are accepted (an admin may have widened the enum). Missing or differently-cased values are a failure.

---

## Stage 4: Emit the script

Write the script to `<system_slug>-deploy-test.ts` in the model's directory (override path on request). The file is one TypeScript module, runnable with `bun <slug>-deploy-test.ts`. Keep it self-contained, **no external dependencies beyond `bun`'s built-ins and the `semantius` CLI on PATH**.

The script's anatomy, top to bottom:

1. **Shebang + module docstring.** One paragraph naming the model file the script was generated from, the date, and the `EXPECTED_MAJOR` of the deployer it pairs with.
2. **The parsed model as a JSON constant.** Embed everything Stage 2 captured as a single `const MODEL = {...} as const;` literal. The script is then truly self-contained, it never re-reads the `.md` file at runtime. **This is the load-bearing design choice**: a CI runner doesn't need the `.md` file shipped alongside, and any future analyst-version-bump in the source `.md` cannot accidentally break the script.
3. **A tiny CLI runner.** A `runSemantius(server, tool, payload, single?)` helper that shells out via `Bun.spawn(["semantius", "call", server, tool, ...])`, parses stdout as JSON, and translates exit codes per the use-semantius contract (`0` ⇒ success; `1` ⇒ not found when `--single`; `2` ⇒ ambiguous when `--single`; `3` ⇒ retry-once transient; `4` ⇒ tool failure; `5` ⇒ auth failure, abort). Hard-coded retry exactly once on exit `3`.
4. **A check registry.** Each check is a small async function returning `{ name: string, passed: boolean, expected?: unknown, actual?: unknown, message?: string }`. The registry is the literal list from the checks catalog, in the order Stage 3 plans.
5. **A driver.** Iterates the registry, captures results, prints a structured report:
   - One line per check while running (✓ for pass, ✗ for fail, the check name, and, on fail, the expected/actual pair quoted exactly).
   - At the end, a one-block summary with totals (`<total> checks, <passed> passed, <failed> failed`).
   - If `failed > 0`, print the failures again as a numbered list and `process.exit(1)`. Otherwise print `Verification passed.` and `process.exit(0)`.
6. **Optional `--json` flag.** When present, the driver suppresses per-check console output and prints a single JSON document at the end (`{summary, failures}`) for CI consumption. Pass-through for human and machine callers without forking the script.

### Comparison semantics (read this carefully)

- **String fields**: byte-for-byte equality. Trim whitespace from both sides before comparing only when the model file explicitly trims (it does for table cells); otherwise compare verbatim. Empty model values (`""`) are skipped, see the additive-is-OK rule above.
- **Platform sentinel values**: several live columns carry platform-chosen defaults whenever the model declares nothing — `fields.description=""`, `fields.default_value=""`, `fields.relationship_label="has"`, `fields.reference_table=""`, `fields.reference_delete_mode="restrict"` (on non-FK rows), `fields.singular_label_parent=""`, `fields.plural_label_parent=""`, `fields.cube_type="auto"`, `fields.input_type_rule={}`, `entities.cube_mode="auto"`, `entities.edit_mode="auto"`. Skip every comparison where the model is silent, regardless of the live value being one of these defaults. The "Platform sentinel values" table in `references/checks-catalog.md` is the canonical list; keep both in sync.
- **Boolean fields**: strict equality after coercion (`"yes"` ⇒ `true`, `"no"` ⇒ `false`, undefined ⇒ `false` for `audit_log`).
- **Required**: not a separately stored field. Semantius does not expose a per-field `required` flag; the deployer and optimizer agree that `format: parent` is required, `format: reference` is optional, and other formats default to required. The script therefore asserts `format` equality and does not separately probe `required`; format equality is the load-bearing check and subsumes the inference.
- **`format` aliasing**: the deployer rewrites the entity's label-column field format from `string` to `text` at create time (the field also carries `ctype: label`). Accept live `text` as equivalent to model `string` **only** for the field whose `field_name` equals the entity's `label_column`. All other `string` fields stay `string` in live state and are compared verbatim. This is the only known platform format rewrite; do not generalize.
- **`enum_values`**: the live array must contain every model value, in the same order, with matching casing. Extra live values are accepted (they appear after the model's last entry). Re-ordering of model values is a failure (display order matters in UI dropdowns).
- **`reference_table` / `reference_delete_mode`**: byte-for-byte equality on FK rows. A mismatch on `reference_delete_mode` is high-severity, deleting the wrong target on cascade is a data-loss class of bug. On non-FK rows the live row still has non-null values for these columns (platform-default placeholders, `""` and `"restrict"`); skip the comparison entirely on non-FK rows.
- **`computed_fields` / `validation_rules` / `select_rule`** (entity-level): deep value-equality after JSON canonicalization (sort object keys, leave arrays in declared order). The deployer round-trips these byte-for-byte on the **entity** row; the script must accept that contract and fail loudly on any divergence.
- **`input_type_rule`** (field-level, singular): the deployer extracts the matching entry from the entity's §3 `Input type rules` array (matched by `field` name) and stores **only the entry's `jsonlogic` sub-object** on `fields.input_type_rule`. The `field` and `description` keys are NOT round-tripped — `field` is redundant with the row's `field_name`, and `description` is analyst documentation that lives in the model only. Deep value-equality is against the entry's `jsonlogic`, after JSON canonicalization. The generated script must compare `entry.jsonlogic` (not the wrapping entry) against `live.input_type_rule`, otherwise every entity with input type rules produces false-positive drift on every run.
- **Permission, role, and hierarchy ids**: resolve by natural key (`permissions.permission_name`, `roles.slug`, the `(including_permission_id, included_permission_id)` pair), not by numeric `id`. Ids drift across instances; natural keys are the model's contract.
- **Module permission columns**: `view_permission` is a string column compared directly to `<slug>:read`. `manage_permission_id`, `admin_permission_id`, `default_viewer_role_id`, `default_manager_role_id`, `default_admin_role_id` are FK ids — resolve the expected id via the corresponding natural-key lookup, then assert equality. A null where the model expects a value is a failure; a value where the model expects null (because the model has no admin tier) is **not** a failure (additive rule). There is no `view_permission_id` FK on `modules` — do not query it.
- **PostgREST filter syntax**: single-column filters use `col=eq.<val>`. **Multi-column AND filters MUST use `and=(col1.eq.<v1>,col2.eq.<v2>)`** (PostgREST RPC form with `.` separators inside the parens). The naive comma-joined form `col1=eq.<v1>,col2=eq.<v2>` is parsed as one filter whose value contains commas and produces `(22P02) invalid input syntax for type integer` at PostgREST. The catalog gives the correct call shape on every multi-column row; copy verbatim.

### Failure-message format

Every failure line in both human-readable and `--json` output must include enough context to diagnose without re-reading the model. Use this exact shape:

```
✗ <check group>: <natural-key path>
    expected: <quoted model value or summary>
    actual:   <quoted live value or "missing">
    why:     <one short clause naming the kind of drift>
```

Examples:

```
✗ field: applications.application_type.enum_values
    expected: ["point_solution","internal_system","platform","custom_built"]
    actual:   ["point_solution","internal_system","platform"]
    why:     model enum value missing from live state

✗ permission_hierarchy: apm:manage → apm:read
    expected: present
    actual:   missing
    why:     hierarchy edge declared in model is not in live state

✗ entity: vendors.singular_label
    expected: "Vendor"
    actual:   "Vendor Name"
    why:     entity label differs (asymmetry suggests an admin edit)
```

The natural-key path is the script's primary debugging surface; a maintainer should be able to copy the path into `read_*` calls and re-confirm the live state by hand.

### Don't over-engineer

The script is a leaf utility, not a framework. Do not pull in test runners (no vitest, no bun test), do not register custom matchers, do not emit JUnit XML, do not write a config file. One file, one entrypoint, no flags except `--json`. The user just wants to type `bun apm-deploy-test.ts` and see whether the deploy held up.

---

## Stage 5: Tell the user how to run it

After writing the file, share a one-line summary and the run command. Keep it tight:

> Wrote `<slug>-deploy-test.ts` next to the model. Run with:
>
> ```bash
> bun <slug>-deploy-test.ts
> ```
>
> Exits non-zero on any drift. Add `--json` for machine-readable output (use this in CI).

Do **not** offer to run the script yourself. The whole point of this skill is that the user (or their CI) runs it after every deploy, on demand. Running it once during this chat tells you nothing about the next deploy.

---

## What this skill does not do

- Does **not** call Semantius. Reads no live state. Every fact about the live instance flows through the generated script at run time.
- Does **not** modify the model file. The model is read-only input.
- Does **not** propose fixes for drift. The generated script's failure output is the diagnostic; fixing the drift is the deployer's job (re-run the deploy) or the admin's job (revert the manual edit). After fixing, re-run the test script.
- Does **not** verify business data (rows in the entity tables). Schema-only, like the model itself. Sample-data assertions are out of scope and would couple the test to a specific instance's content.
- Does **not** verify users, user-roles, or webhook-receiver-logs. Those are operational state, not schema. Default-role membership is checked structurally (the role exists with the right permission joins), not by member count.

---

## Re-generating the script after a model change

The generated script is **disposable**. After the model file changes (the analyst added a field, the user customized the model and pushed it back via the optimizer), regenerate the script by re-running this skill against the new `.md`. Do not hand-edit the generated `.ts` to keep it in sync; an out-of-date test script is worse than no test script because it silently passes drift.

Existing scripts in the workspace are fine to overwrite. Confirm before overwriting if the existing file has a modification time newer than the model, that's the signal that someone may have hand-edited it; in that case ask before clobbering.
