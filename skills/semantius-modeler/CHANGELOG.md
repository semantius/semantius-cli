# semantius-modeler — changelog

This file records how the deployer's behavior changed when each contract change landed. The file format version and its rule live in [SKILL.md](./SKILL.md) under "File format version".

This file is NOT loaded into Claude's context when the skill triggers.

Entries below are newest first.

---

## Sample data: street names dealt, guarded and per country

2026-10-28. A seeded suppliers table again had `Market Street` on every row, with only the house number varying. The script built the street from one literal name; `r.pick` listed street as a field where repeats are fine, "one shared street pool is fine" read as one street, and `assertSeedDistinct` on the full street passes because the house numbers differ. Rules: `references/stage-6-sample-data.md`, "Data has to read plausibly", the script pattern and "Records, not fields"; `references/deploy-lib.ts`; `references/deploy-script-template.md`, the helper table.

1. **Street names are dealt** from a pool of at least 8 names with `r.deal(streets, n)`; street is no longer a `pick` example.
2. **The street name is guarded without its house number:** the example passes the dealt names to `assertSeedDistinct`, and the guard list names the street.
3. **The street follows the place's country:** each country has its own pool of street names and puts the house number where that country does (`1432 Market Street`, `Hauptstraße 12`, `12 rue Victor Hugo`). With no country field, every place is in the US, as before.
4. **A house number kept in its own field goes there**, and the street field holds the name only.

---

## Sample data: dealt enums and parents, unique names past the pool, totals from children

2026-10-28. A review of the seeded-generator rules found that the example repeated account names above 12 rows (a 409 on a unique name), `tuples` looped forever on a pool with a repeated entry, contacts picked their account at random so fields taken from the parent rarely varied enough for `assertSeedDistinct`, enum values came out in a fixed cycle and two enums of the same length moved in step, `slugify` dropped letters such as ø and ł and turned non-Latin names into an empty string, and an invoice total did not match its lines. Rules: `references/stage-6-sample-data.md`, the script pattern, "Records, not fields", "Uniqueness" and the realistic-data list; `references/deploy-lib.ts`; `references/deploy-script-template.md`, the helper table.

1. **Every enum is dealt with `r.deal(values, n)`**, shuffled, every value once before any repeats; a repeated value weights the mix. The index-cycling `pick(values, i)` is removed from `deploy-lib.ts`.
2. **FK parents are dealt with `r.deal(parentRows, n)`**, so every parent gets a child before any gets a second.
3. **The example builds account names with `r.tuples`** from two pools (144 names). New `r.distinct(pool, n)` throws when a pool has fewer than `n` different entries. A label column or `unique_value` field is checked with `assertSeedDistinct(..., rows.length)`.
4. **`r.tuples` removes repeated pool entries** before checking the pool sizes, and falls back to walking the combinations in order near exhaustion, so it always ends.
5. **`slugify` transliterates ø, æ, œ, ß, ł, đ, ð, þ and ı** and throws when no Latin letter is left; a non-Latin name carries a Latin form for its email.
6. **A parent's totals come from its children:** build the children first, sum them into the parent, insert the parents, then the children with ids matched by the parent's natural key. New invoice / invoice-lines example.
7. **A place outside the US, Canada, the UK and Australia leaves the phone empty**, since those are the countries with a range reserved for fiction.
8. **Re-runs converge only for the unchanged script:** editing a count, a pool or the order of draws can change that table's rows and its children's.
9. **The UK address example reads `London EC1A 1BB`.**

---

## Sample data: whole records from a seeded generator

2026-10-28. A seeded accounts table read like a counter: every row on Market Street, house numbers 100 to 109, postal codes 10000 to 10009 that matched none of the cities, phones 555-0101 to 555-0110. Each field came from its own index formula, and the Stage 6 example itself showed `${pick(streets, i)} ${100 + i}`. Rules: `references/stage-6-sample-data.md`, the script pattern, "Records, not fields" and "Uniqueness"; `references/deploy-lib.ts`; `references/deploy-script-template.md`, the helper table.

1. **New `rng(table)` in `deploy-lib.ts`:** one fixed-seed (42) generator per table with `pick`, `int`, `chance`, `deal` (every entry once before any repeats) and `tuples` (distinct combinations, each part dealt; throws when the pools are too small). The same script writes the same rows on every run, so `seedEnsureMany` keys stay stable. `combine` is removed; `pick(values, i)` stays for the §5 enum driver; `uniq` stays for code-like fields.
2. **New `slugify` and `exampleDomain`:** an invented company's email and web domain is `<name>.example.com`, which is reserved and never receives mail. A person's email is `first.last@<their company's domain>`. Company names are invented, never real brands.
3. **Addresses come from a place:** city, state or region, country, the city's own postal codes and the phone area code travel together. With no country field on the entity or on any record it belongs to, places are in the US; with one, they span several countries in each country's format, and the country written is a value the field allows. A record that belongs to another takes its parent's place.
4. **No base + index in a value a person reads** (house number, postal code, phone, amount, date). Phones use the ranges reserved for fiction (US and Canada 555-0100 to 555-0199, UK 07700 900xxx and 020 7946 0xxx, Australia (0X) 5550 xxxx).
5. **The script pattern seeds accounts and contacts** instead of campaigns and leads, showing places, dealt names, `tuples` for people and emails from the account's domain. A pool for a field checked by `assertSeedDistinct` holds at least 8 entries.

---

## Entity icon goes to `entities.icon_name`

2026-10-27. The platform renamed `entities.icon_url` to `icon_name`; the analyst's §3 line is now `**Icon:**`. Rules: `references/stage-1-parse.md`, the §3 entity lines and the mapping table; `references/stage-4-execute.md`, 4c; `references/deploy-script-template.md`, the schema preflight.

1. **`**Icon:**` is parsed into `icon_name`** and stamped on `create_entity` / `update_entity`; it is omitted when the line is absent or empty.
2. **The schema preflight expects `icon_name`** on `create_entity`.

---

## No invalid icon name is ever deployed

2026-10-27. The modeler sent every icon name the spec carried without checking it, so a hand-edited spec, one saved before the analyst's icon gate, or a copied `none` would deploy a name that is not an icon. The analyst now also writes `  - icon: none <!-- finder: …: no fit -->` where no icon fits. Rules: `references/scaffold-lib.ts`, `checkEnumIcons`, `iconFindings` and the module icon; `references/deploy-script-template.md`, the copy step and steps 4 to 6; `references/stage-1-parse.md`, "Enum values from §5"; `references/stage-4-execute.md`, 4a and 4d; `references/stage-5-verify.md`, checks 1 and 5 and the "Icons not deployed" block.

1. **Icons are checked at deploy time against the bundled Lucide list** (`lucide-icon-tags.json`, copied into `.tmp_deploy/` next to the libs), on every enum field, new or existing, and on the module's `icon_name`.
2. **`icon: none` deploys as no icon** (`""`, never the text "none"), and on a live field it removes the live icon.
3. **An unknown enum icon deploys as no icon; an unknown module icon deploys as `box`.** Each is listed as a 🟡 in the Stage 5 report's "Icons not deployed" block.
4. **Each enum field is merged with live once,** on the create path too, so a cleared icon never comes back from a second merge.

---

## Label column reaches the live table

2026-10-27. The 4c ✨ New rule did not list `label_column` among the `create_entity` payload keys, and Stage 5 only checked that `label_column` was set, not that it named the spec's field. Rules: `references/stage-4-execute.md`, 4c "✨ New"; `references/deploy-script-template.md`, steps 0 and 3; `references/stage-5-verify.md`, check 5.

1. **The 4c ✨ New rule names `label_column`** as a key of the `create_entity` payload, from the `**Label column:**` line. The platform stores it on create and auto-creates that field. Based entities and junctions without the line omit it.
2. **Preflight lists `label_column`** among the `create_entity` keys.
3. **Verify compares the value:** live `label_column` must equal the spec's for each owned table; a different value is a 🛑, re-pointed with `update_entity`.

---

## Fast run: the spec download links a top-level copy; clean writes are not errors

2026-10-27. The download route serves flat names only, from the top level of `/workspace`, so the link to `semantius/specs/<system_slug>-semantic-spec.md` never resolved. Separately, a run called a file saved cleanly through a shell heredoc "a file write error". Rules: `SKILL.md`, "Closing Contract: clean and sticky" and "Narration restraint"; `references/stage-6-sample-data.md`; `../semantius-admin/references/fast-flow.md`, section 6.

1. **Copy, then link:** after the Stage 5b stamp, in the response that completes the Verify task, the deployed spec is copied byte-for-byte with `cp` to `/workspace/<system_slug>-semantic-spec.md`; the closing block links that copy.
2. **The link form is `[Download the <System Name> spec](/workspace/{sessionId}/<file name>)`,** with `{sessionId}` written literally (the client fills it in) and spaces and parentheses percent-encoded in the file name only. A file in a subfolder is never linked.
3. **A write is an error only when a tool call failed.** A clean write is not narrated; a failed one is reported with the tool's error verbatim, and the run stops.

---

## Fast run: the closing block links the deployed spec

2026-10-27. A fast run names none of the files it writes, so after the deploy the user had no way to get the spec that was deployed. Rules: `SKILL.md`, "Closing Contract: clean and sticky"; `../semantius-admin/references/fast-flow.md`, sections 4.1 and 6.

1. **In a fast run the closing block has four lines:** the status line, the "Open in UI" link, `[Download the <System Name> spec](<spec path>)`, then the sample-data question. The path is the deployed spec (the `Input artifact:` path, after the Stage 5b stamp), relative to the workspace root.
2. **The link re-attaches with the sticky footer** while the sample-data question is unanswered.
3. **Guided and expert runs are unchanged:** three lines, no download link.

---

## Verification report: one fixed shape, in plain language

2026-10-26. A fast-run report dropped the Roles and Permission hierarchy blocks, wrote the handoffs and skipped links as prose paragraphs, put them before Counters, and added facts the template has no place for (record-id prefixes, lifecycle states, "a kind of", shared-module hints). The template allowed it: it was an example, not a contract, and it used tokens the Writing Conventions ban (`module_type`, `origin=`, `lineage`, slugs, permission names), so a run kept some of them and paraphrased the rest. Rules: `references/stage-5-verify.md`, "Structured Stage 5 report".

1. **The shape is required:** one code block, the blocks in a fixed order under fixed headings, each line in one of the listed forms, no other facts and no prose, lines of at most 80 characters. Two tables say when each block is rendered and what its lines hold.
2. **Plain language:** modules, tables, fields and roles by display name; permissions by level (view, edit, admin) or by action; no slugs, column names, `origin` or `module_type`. Block names: Tables, Access inclusions, Rules on shared tables, Ownership, Business roles, Handoffs to other modules, Links not added, Steps skipped, Business process rules. Counters lose the `origin` breakdown.
3. **New Checks block:** one ✓ or 🛑 line per check area (module setup, tables and fields, names and descriptions, choice lists, visibility and field display rules), with one indented line per problem. The verdict line reads `🛑 Verification failed: <N> problems, listed under Checks.` when any remain.
4. **Closing lines in a fixed order:** read-visibility callouts, verdict, access level, then the summary line, reworded in plain language.

---

## Seed data reads plausibly; a computed label column deploys disabled

2026-10-23. A seeded person table had one surname on every row: the Stage 6 example built first + last name pairs with `combine(i, [firstNames, lastNames])`, whose second pool only advances past `i = F`, so at the default 10 rows with 10 first names every row took `lastNames[0]`. The count guard passed, and nothing checked whether the values read sensibly. Rules: `references/stage-6-sample-data.md`; `references/deploy-lib.ts`.

1. **The name-pair examples (first run and re-run) use a coprime stride:** `pick(firstNames, i)` with `pick(lastNames, i * 3)`. `combine` is used only when the target is larger than its first pool's length.
2. **New `assertSeedDistinct(table, rows, fields, minDistinct?)` in `deploy-lib.ts`:** called after each insert on the human-facing fields generated from pools (name parts, company, city, label column); it prints a per-field receipt and exits non-zero when a field has fewer than `min(rows, 8)` distinct non-empty values. It sees columns only, so name parts that exist only inside one combined field are passed to it as their own values. Listed in `deploy-script-template.md` and imported in the seed-script pattern.
3. **"Data has to read plausibly, not just hit the count"**, a Stage 6 subsection next to the count contract, names the fields to guard.
4. **The label column's input type is set after `create_entity`:** the platform creates it as `required`, so the post-create `update_field` sends `"disabled"` when a computed field fills it (a person's `display_name`), otherwise the §3 `Required` value when that is not `required` (`references/stage-1-parse.md`, "Label-column input type"; `references/stage-4-execute.md`, 4d). Checked on a live instance: a computed label column fills on insert, overrides a typed value, recomputes on update and accepts `disabled`.
5. **The seed report adds label samples:** the first three `_label` values of each seeded table, read with `select=_label` at the end of the seed script. They never fail the seed; a line that looks wrong gets a one-clause note.

---

## Pre-deploy question says "deployment"

2026-10-16.

1. **The pre-write question after the plan** is *"Plan shown above. Proceed with deployment?"*. It is still asked in guided and expert flow; fast flow's go-ahead counts as this confirmation.

---

## `label` is a §5 property

2026-10-16. Paired with the analyst entry "every enum entry gets a label and a color; `label` is a §5 property".

1. **Stage 1 parse:** a §5 bullet `` - `value` `` with no sub-bullets is the value; one with property sub-bullets (`label`, `color`, `icon`, `description`) is the `{"value", "label", …}` object. The inline `` - `value` - Label `` form is no longer read.
2. **Stage 6 sample data** names the property sub-bullets as what a seed never writes.

---

## file format version `3.1`; enum hints deployed without wiping live ones; display formats

2026-10-15. Paired with the analyst entry of the same date.

1. **`version` is the file format version**: Stage 1 accepts only `version: "3.x"` and rejects anything else. `EXPECTED_MAJOR` and the minor-version tolerance paragraph are replaced by "File format version" and "Optional lines" in SKILL.md.
2. **Enum hints:** Stage 1 parses §5 hint sub-bullets into the entry object. `mergeEnumEntries` / `sameEnumEntries` in `deploy-script-template.md` build and compare the array sent by `update_field`: the spec's values, labels and stated hints win, a hint the spec does not state is kept from live. Stage 5 verifies only the keys the spec states; a label or hint difference is cosmetic.
3. **Same-primitive formats** point to the type table in `data-modeling.md`. This removes the list in Stage 4d that put `json` in the TEXT family, treated `integer` / `number` as one primitive and named a `datetime` format.
4. **Display formats:** `rating` joins the non-nullable integers (`0` = not rated); sample data keeps ratings in 0–5, colors hex, icons real Lucide names; `color` / `icon` empty is `""`. `logo_color` is read with its quotes stripped.

---

## yolo mode (experimental)

Guidance only, no contract change, `EXPECTED_MAJOR` unchanged (2026-09-30). No bump: the modeler reads the same spec and its output keeps its shape (the deploy, the verification report, the Closing Contract); only which questions are asked changes, and only in a yolo run. Canonical rules: `../semantius-admin/references/yolo-mode.md` (the modeler rows of its fixed-picks table, 4.4, are what this entry implements).

1. **Interaction-level header.** The modeler never read the interaction level before. The admin now passes `Interaction level: standard|advanced|yolo` in the run context (admin Step 7.3); the SKILL.md preflight bullet lists it with the other header lines. A run is yolo when that line says `yolo` or the admin pipeline task's marker says `yolo: go-ahead given`; a direct call is never yolo. New resident "Yolo mode (experimental)" section in SKILL.md (five lines): when it applies, the turn rule (no `AskUserQuestion`, no message ending in a question, no plan summary until the Closing Contract), why (the go-ahead was the write confirmation for the whole build), what still stops (halts, refusals, catalog drift since the analyst ran, 🔴 blockers never waived, deploy errors), and the sample-data question still asked.
2. **A yolo line at every gate.** Each question point carries a `> **Yolo mode, after the go-ahead:**` line naming its pick, logged with `log_pick modeler` to `.tmp_admin/<run_id>/auto-picks.md`: diagram vs. relationships (log it and keep going), §7.1 unresolved decisions (a stop), a required field on a table with records (added as optional, required enums with no default included), 2.5 access control (Recommended), 🛑 deltas (removing or retyping live data is skipped: yolo never removes anything; a tier flip and the `select_rule` pause proceed), ambiguous link target (exact-name candidate, else skip), field-name collision (Recommended), link proposals (apply all; "Review each one" never reached), "Proceed with execution?" (not asked, plan not rendered, one "Deploy plan applied as prepared" log line), 4e rule clash (keep the live rule), 4f row visibility rules (as the spec says, but a live rule is never removed), live field UI rules (keep), extra fields on Users (additive, as the spec says), Gate B (proceed), and conflict-resolution rows (keep live rules; every other ask takes its stage's pick). Loud halts are unchanged. In a yolo run no `Q:` tasks are created and a stage task completes when its work is done. "The only confirmation the modeler asks", the standalone-question list, "always pause", and "still pauses" are qualified in place to standard and advanced mode.
3. **"Decided for you after your go-ahead".** In a yolo run the Stage 5 verification report ends with this section (yolo-mode.md section 6), built from the auto-picks log: "Changes to other modules" first (lines whose `touches:` names another module), then the rest, ending with *Say "change" and what you want different to revisit any of these.* It sits before the Closing Contract's `---`.
4. **Unchanged:** the Closing Contract (status line, link, sample-data question) and the sample-data consent gate. The sample-data question is asked in every mode, yolo included, and waits; the go-ahead is never consent to sample data. Standard and advanced behavior is unchanged.

Files: SKILL.md, `references/stage-1-parse.md`, `stage-2-reconcile.md`, `stage-3-plan.md`, `stage-4-execute.md`, `stage-5-verify.md`, `stage-6-sample-data.md`, `conflict-resolution.md`.

---

## entity families and enum labels

2026-09-28. Paired with analyst 5.8 (minor; a 5.7 spec deploys unchanged). The platform added `is_a` / `has_a` key types (an entity based on another through `entities.id_refentity`, sharing its key) and `{"value", "label"}` enum entries.

1. **`deploy-lib.ts`:** new `ensureEntitiesByLevel(rows)`, the entities entry point: groups by `id_refentity` depth and runs one `ensureMany` per level, bases first (one call total without a family); refuses before any write on a cycle, a missing base, `id_refentity` without `is_a` / `has_a`, or `label_column` / `label_parent` / `order_column` on a based row. `updateEntity` also refuses `id_refentity`. New `patchById` for the insert-then-update path (based entities cannot be upserted, 42P10). `seedEnsureMany` / `assertSeedCounts` document family seeding (one insert per `is_a` record at its own table; `has_a` attach sends only its own fields; tally each level from its own inserts, never a base GET).
2. **Stage 1:** parses `is_a` / `has_a`, the `is_a` prefix and `**Based on:**`; labeled §5 bullets become pairs; 🛑 checks mirror `consistency-check.ts` (label lines on a based entity, repeated base fields, cascade from `is_a`, process gates, `_ext` names, Notes ≠ §5, a label as default). The label-column requirement exempts based entities.
3. **Stage 2k:** `id_refentity` and an `is_a` prefix are create-only; live bases must be managed and of the right key type; `<table>_ext` must be free; the cross-module edit grant is a hierarchy row Gate A checks.
4. **Stage 3:** family plan lines; Gate A checks every base is live or created at an earlier level.
5. **Stage 4:** entities through `ensureEntitiesByLevel` (worked mixed example), `id_refentity` on create only, the label passes skip based entities, enum sync compares by value and applies label changes.
6. **Stage 5:** `id_refentity` round-trip, the label-column exemption, an enum round-trip by value. **Stage 6:** family seeding rules; seeds write values, never labels.
7. **conflict-resolution.md:** rows for 23503 / 90240-90252 / 42P10 and the old-CLI preflight failure.

---

## Platform: name-keyed permissions

2026-09-26. The platform re-keyed the RBAC catalog on `permission_name`. Found by a live deploy that halted in the `scaffoldModule` preflight with zero writes (`create_permission_hierarchy has no field(s) [including_permission_id, included_permission_id]`). The spec format is unchanged, so `EXPECTED_MAJOR` stays 5; the schema-coupled scaffold library takes a major bump because its return shape changed.

**Live schema (verified with `semantius info crud`):**

1. `permissions` has no numeric id; `permission_name` is the primary key. `update_permission` / `delete_permission` are keyed by `permission_name` (string or array).
2. `permission_hierarchy` links `including_permission_name` to `included_permission_name`; its `id` is the text `"<including>.<included>"`.
3. `role_permissions` carries `role_id` + `permission_name`; its `id` is the text `"<role_id>.<permission_name>"`. `user_roles.id` is the text `"<user_id>.<role_id>"`.
4. The module record references `view_permission`, `manage_permission`, `admin_permission` by name. The three `default_*_role_id` columns stay numeric role ids.
5. `fields.catalog_field_code` is a new write-once provenance column (the field-level twin of `entities.catalog_entity_code`).

**Where the deployer changed.**

1. `scaffold-lib.ts` (`SCAFFOLD_LIB_MAJOR` 5 → 6): permissions converge by a `permission_name` array; hierarchy edges and role grants are written and matched by name; the module wire sets `manage_permission` / `admin_permission` by name; the preflight checks the new keys plus the `update_module` keys; `verifyScaffold` compares the module's permission references by name and reads edges / grants by name. `scaffoldModule()` returns `permissionNames` (was `permissionIds`).
2. The "resolve the permission name to its id, use, discard" pattern is gone for permissions (names are written directly). It still applies to roles.
3. Stage 4d stamps `catalog_field_code` (= the spec's `field_name`) on every `create_field`, VALUE-only and write-once, like `catalog_entity_code`; Stage 5 asserts it is non-empty on fields the deploy created.
4. Docs updated to the name-keyed shape: SKILL.md, stage-1/2/4/5 references, deploy-script-template.md, conflict-resolution.md.
5. 4b-rename reordered: `update_permission` first (a permission rename cascades to every table that names it), then `update_module`, then `update_role`. Setting `view_permission` to a name that does not exist yet now fails the foreign key.

**Same day, found by the same live deploy (analyst 5.6 → 5.7):**

6. Validation-rule `code` must be a class-99 error code (`^99[0-9]{3}$`; platform error `90905` otherwise). The rule identifier moves to `name` (snake_case, unique within the entity), which is now the natural key for the 4e-merge and the Stage 5 duplicate check. Stage 1 blocks a spec whose rules lack `name` or carry a non-class-99 code and routes it to the analyst. Platform rules on built-in tables carry class-90 codes and `source_module: "platform"`.
7. The auto-created `label_column` field lands without its §3 `description` and without `catalog_field_code`; the post-create pass now sets both alongside the title correction (the first live deploy left seven label descriptions empty).
8. JSON columns (`computed_fields`, `validation_rules`, `select_rule`, `input_type_rule`) are compared structurally with sorted keys, because `jsonb` reorders object keys and a string compare reported every rule as drifted.

---

## entity key type

2026-09-26. Deployer-side delta for the analyst's 5.6 minor: the optional `**Key type:**` / `**Key prefix:**` entity lines (→ `entities.id_type` / `entities.id_prefix`). The key type is create-only: the platform locks it once the table exists (`90233`).

1. **Stage 1 parse** reads both lines (absent = `auto_increment`, nothing to stamp; every pre-5.6 spec); a `computed` / unknown type, or a missing / stray / malformed prefix, is a 🛑 route-back. Mapping-table rows added.
2. **Stage 2k (new): key type is create-only.** On an entity that already exists live, a spec `**Key type:**` differing from live `id_type` halts before any write with a plain explanation (the id kind is fixed at creation; changing it means rebuilding the table) and routes back to the analyst; the modeler never offers the rebuild. An absent line compares nothing. A new entity's prefix already used by another live entity halts as catalog drift.
3. **Stage 4c**: `id_type` / `id_prefix` go on the ✨ New / rename-incoming / promote-create `create_entity` payload when present (payload template updated); `id_type` is never sent on `update_entity`; a differing `id_prefix` on a ♻️ same-module entity is synced. `deploy-lib.ts` `updateEntity()` throws if `id_type` is in the patch. The `deploy-script-template.md` preflight lists `id_type` / `id_prefix` for `create_entity`.
4. **Stage 5** verifies the key type / prefix landed (a mismatch cannot be repaired by a re-run and is reported as such).
5. **Stage 6** sample data: `bigint` / `text` entities need a caller-supplied `id` on every row; FK values into non-numeric keys are the ids as given.
6. **SKILL.md** minor-version tolerance paragraph now covers 5.4 ↔ 5.5 ↔ 5.6.

Files: SKILL.md, `references/stage-1-parse.md`, `stage-2-reconcile.md`, `stage-4-execute.md`, `stage-5-verify.md`, `stage-6-sample-data.md`, `deploy-script-template.md`, `deploy-lib.ts`.

## CLI env-var name correction

Documentation only, no contract change, `EXPECTED_MAJOR` unchanged (2026-09-26). `references/deploy-script-template.md` ("Large deploys") named the CLI's timeout variable `MCP_TIMEOUT`, which the CLI never reads: every operational variable carries the `SEMANTIUS_` prefix (or the `--env` prefix). It now reads `SEMANTIUS_TIMEOUT` (default 1800 s). Entry #13 below keeps the old name as written at the time.

## spec-contract clarifications

2026-08-19. Parser-side delta for the analyst's 5.5 minor (see the analyst CHANGELOG). All changes are tolerant of 5.4 files; nothing in the deploy procedure changes.

1. **Stage 1 parse.** H1 is `# <name>: Semantic Model` (legacy `—` accepted; frontmatter `system_name` authoritative). `persona` is optional (absent under `basic`); the actor cross-check runs only when present. `**Label column:**` is read when present: required on non-junction entities (absent → 🛑), optional on `entity_type: junction` (omit `label_column` on `create_entity`, skip title-correction / uniqueness passes). §6: the link table is the first table under `## 6.` (may carry a `Reconciliation` column); `### Outbound handoffs` / `### Inbound handoffs` are parsed **when present** into a handoff list (9 blueprint columns; `to_state` check on Outbound `lifecycle` rows against the `payload` entity's `workflow_state` enum; Inbound payloads not checked). RACI `consult_mode` `(none)` / legacy `—` / blank ⇒ `null` on the living-mode POST. The `workflow-gate (lifecycle)` cross-check and the lifecycle-field rule no longer cite a spec "§7 lifecycle table" (the spec has none; the blueprint's §7 arrives as `workflow_state` enum values / `process_gates` rows).
2. **Stage 4a.** `settings.module_kind` is written only when the frontmatter carries a non-empty, non-null value (payload checklist + template comment updated); never `null`.
3. **Stage 4m.** Input is the spec's §6 handoff sub-sections (no-op when absent); the deploy-boundary `to_state` re-check reads the `payload` entity's `workflow_state` enum.
4. **Stage 5.** `settings.module_kind` compared only when the frontmatter carried it; `label_column is set` skipped for a junction whose spec omitted the line.
5. **SKILL.md** gains a "Minor-version tolerance (5.4 ↔ 5.5)" paragraph under Schema compatibility listing every surface that may differ between the two.

Files: SKILL.md, `references/stage-1-parse.md`, `references/stage-4-execute.md`, `references/stage-5-verify.md`.

## task-tool call economy

Guidance only, no contract change, `EXPECTED_MAJOR` unchanged (2026-08-19). Task tracking: one `TaskUpdate` per task carries chain edge, parent edge and status together; question gates are set in one call on the stage task (`addBlockedBy: [Q: ids]`). Same graph, ~⅓ fewer task calls per stage entry, N→1 for a question enumeration. Canonical text: `../semantius-admin/references/task-tracking.md` (§1 relations, §2 rule 1, §3 E and the gate; `TaskList` row corrected: returns `blockedBy` only, not `blocks`). Files: SKILL.md (resident "Task tracking" section, stage tasks and the 2.5 / Stage 3 gates). Motivated by a 2026-08-19 run that spent ~40 of 149 tool calls on task bookkeeping.

## task tracking and the question ledger

Guidance only, no contract change, `EXPECTED_MAJOR` unchanged (2026-08-18). The modeler now uses the harness task tools (`TaskCreate` / `TaskUpdate` / `TaskList` / `TaskGet`; canonical rules in `../semantius-admin/references/task-tracking.md`; ordering via `blocks` / `blockedBy`: stage tasks chained, pointed at the admin pipeline task when orchestrated, and every `Q:` task blocking its stage task): a resident "Task tracking" paragraph in SKILL.md; the High-Level Workflow table gains a Task subject column (four `Apply ›` stage tasks created at Step 0, Stage 4 always one task, the sample-data task created only on the user's yes); Stages 2.5 and 3 are ledger stages (the access-control question, ambiguous cross-model rows, field-name collisions, the four-or-more-proposals question and its "Review each one" fallback become `Q:` tasks with fixed subject templates, asked in batches of up to four per call, completed only after the answer is applied to the plan; Gate A requires the ledger clean); the pre-execute yes/no, the 1-3-proposals inline confirmation, the tier-flip confirmations, the 4e-merge and 4f prompts, and the sample-data question stay standalone. Closing Contract: the Verify task is completed in the response before the closing block. Files: SKILL.md, `stage-2-reconcile.md` (2.5 prompt), `stage-3-plan.md` (link flow, standalone list), `stage-4-execute.md` (halt marks the task), `stage-6-sample-data.md`, `conflict-resolution.md` (two rows).

## `AskUserQuestion` call mechanics

Guidance only, no contract change, `EXPECTED_MAJOR` unchanged. The resident writing conventions in SKILL.md (mirroring `semantius-admin/references/writing-conventions.md`) gain an unnumbered "AskUserQuestion mechanics" paragraph: call the widget alone in its own response after edits and re-renders; answers arrive as a `<user_answers>` input block; there is no `user_answers` tool. Motivated by a 2026-08-17 copilot run where `edit` + `AskUserQuestion` in one tool batch cancelled the pause.

## historical / version-stamp narration removed from runtime files

No behavior change. Removed the retired `single_approver` pattern-flag note, the `alias` note, "legacy" labels on current states (two-permission baseline, `readonly` fields, entries without `source_module`), "no longer" / "used to fail" phrasings, and "Older 5.3 specs" / "v5.4 specs" wording (kept as version-free tolerance rules) from SKILL.md and `references/*`. History lives here and in git only.

## bulk (array) writes, entities before fields, preflight fix for the `anyOf` tool schemas

2026-08-17. The crud server (postgrest-mcp "array inserts") and the CLI ("add array support") now take `data` on every typed `create_*` as one object **or a non-empty array** (one request, one transaction, all-or-nothing; items may have different keys — the server sends `?columns=<union>` + `Prefer: missing=default`; the response is always an array), and `id` / `table_name` on every `update_*` / `delete_*` as one value or an array (`in.(...)`, same `data` for all). `--single` is rejected (exit 1, `SINGLE_ARRAY_INPUT`) when any of those is an array. The platform's new golden rule: more than one record of the same kind pending → ONE call. Deployer-side only; `EXPECTED_MAJOR` stays `5`, `SCAFFOLD_LIB_MAJOR` stays `5` (additive).

1. **P0 — `scaffold-lib.ts` `preflightSchemas` false-failed every deploy** against the new server: `toolDataKeys` read `schema.properties.data.properties`, which no longer exists under the new `data: { anyOf: [object, array] }` shape, so it fell back to the top-level `{data, accept}` keys and every `create_module` / `create_entity` preflight threw "has no field(s) […]. Live schema accepts: [accept, data]". New `dataKeys()` resolves `$ref`s and reads the object variant's `properties` (or the array variant's `items.properties`), still handles the legacy plain-object shape and non-`data` tools, and now THROWS instead of falling back when a `data` node has no object shape. Verified live against all seven preflighted tools.
2. **`deploy-lib.ts` bulk primitives** (schema-agnostic, additive; existing exports keep their signatures): `BATCH_SIZE` (100), `chunk`, `pgQuote` / `inFilter` (the server's `in.()` quoting rule + percent-encoding), `readIn` (multi-key read, chunked), `createMany` (one `create_*` call per ≤100 raw rows, asserts the row count back, throws naming the chunk's keys, **no per-row fallback**), `ensureMany` (the bulk `ensure`: `in.()` read → create the missing → re-read → `Map<key, liveRow>`; rejects duplicate keys), `ensurePairs` (composite-key twin for hierarchy / role_permissions / user_roles), `postMany` (Layer-2 bulk POST, asserts uniform keys and the returned count, never `--single`) and `seedEnsureMany` (re-run-safe, input order). `write` gained an optional `label` for the error message; `pgRequest` throws before spawning when `single` is combined with an array body; `runDeploy` reports "write call(s)" (a bulk call counts once).
3. **`scaffold-lib.ts` batches the baseline scaffold**: `ensurePermission` / `ensureHierarchy` / `ensureRole` / `ensureRolePermission` (one row per call) became `ensurePermissions` / `ensureHierarchy` / `ensureRoles` / `ensureRolePermissions` (one array call per row kind via `ensureMany` / `ensurePairs`, drifted `module_id` converged with ONE id-array `update_*`). `create_role` now also stamps `catalog_role_code` (the §9.1 slug; the stage-4 contract always said so, the code never did) and preflights it. Fresh scaffold: 6 write calls instead of ~11; re-run: 2 updates, no creates. `verifyScaffold` unchanged and green.
4. **Entities before fields, no second pass** (`stage-4-execute.md` order block, 4c, 4d, "No second pass", spine pass; `stage-1-parse.md` "Self-References and forward references"; `conflict-resolution.md` new rows; `deploy-script-template.md` skeleton steps 3-5 as real code + cardinal rule 9 + four new anti-patterns). 4c now collects every ✨-new / rename-incoming / promote-create payload and issues **ONE `create_entity` call** for the whole spec (`ensureMany`); 4d starts only after that, one `create_field` array call per entity (`ensureMany` scoped by `table_name`), one `update_field` per drifted field, same-data patches (label-column `unique_value`, the `disabled` migration) as one id-array call. The interleave (entity 1 → its fields → entity 2 → …) that made a field referencing a later entity fail is now the named anti-pattern; self-references and cross-reference pairs need no deferral flag. Verified live: `create_entity` with the referencing entity listed first, then one `create_field` call carrying an FK to the second entity plus a self-reference.
5. **Every other multi-record write batched in prose** (`stage-4-execute.md` 4a scaffold / 4b hierarchy, 4g / 4h one `create_field` call keyed by the composite id, 4j `create_user_role`, 4k / 4l grants and 4n siblings via `ensurePairs`, living-mode RACI as one POST per table; `stage-2-reconcile.md` §2a-scaffold steps 2-4 restated set-wise so the canonical contract matches the lib).
6. **Stage 6 seeds one POST per table** (`stage-6-sample-data.md`): the script builds each table's rows in the loop and calls `postMany` (or `seedEnsureMany` when a re-run is plausible); FK pools come from the returned array; the uniform-keys rule (`null` / `""` / `0` explicitly, never an omitted key or conditional spread) is spelled out; `--single` / `post()` remain for a genuine single row only. This reverses the older entry below that rejected "bulk insert needs a `Prefer` recipe" — the seed path inserted one row per `post()` because the platform had no array support; it does now.
7. **SKILL.md**: three new safety-net rows (loop of single creates; fields before all entities; `--single` with an array), the `--single` paragraph (array reads for the set sweep; never with an array payload), the Generated-artifacts primitive list, and Data-fidelity rule 4 restated per record / per array item (an omitted key in a bulk item silently takes the column default — the same empty-description trap, easier to hit).

`deploy-lib.ts` and `scaffold-lib.ts` type-checked with `tsc --strict` and exercised live end-to-end (scaffold → bulk entities → bulk fields → id-array update → re-run no-op → array deletes) against the `tests` org.

## Stage 5b stamps the deployed module version back into the spec (drift gate)

2026-07-05. New **Stage 5b** in `stage-5-verify.md`: on a clean deploy, after all Stage 4 writes settle, read the platform-maintained `modules.version` (monotonic integer, bumped by the platform on any owned-schema change) + `modules.version_date` and upsert them into the spec front-matter as `deployed_version` / `deployed_version_date`, plus `deployed_related_versions` (the live `version` of each `reuse-from` / `promote-to-master` source module). This is the **only** write the modeler makes to the spec, and only on a clean deploy — an in-place front-matter upsert, nothing else touched. Graceful no-op when the platform predates the `version` column. Pairs with the analyst's new 2a.1 gate, which reads `deployed_version` to answer "did prod drift since deploy?" in one read instead of deep-inspecting every entity. Additive / behavioral; no spec-shape break, `EXPECTED_MAJOR` stays `5`.

## parse + write the new spec constructs (entity UI columns, field `width` / `searchable` on create, module `logo_color` / `home_page`, header-based §9.1)

2026-07-05. Minor bump to lockstep with the analyst v5.4 (analyst `CURRENT_VERSION` "5.3"→"5.4", optimizer `SPEC_VERSION` "5.3"→"5.4"). **`EXPECTED_MAJOR` stays `5`; a minor does not touch it.** The modeler compares only the spec version's MAJOR part (SKILL.md "Schema compatibility"), so a `5.4` spec (major 5) already passes the gate; there is no minor-version pin anywhere in the skill to relax. Older 5.3 specs (which omit every construct below) deploy byte-for-byte unchanged (each new construct is emitted only when non-default, so its absence is indistinguishable from a 5.3 spec). All additive / behavioral; no spec-shape break, no forced major bump. The parse mappings for `edit_mode` / `cube_mode` already existed (`stage-1-parse.md`); the gap was that the EXECUTE stage never wrote them, plus five brand-new columns and the header-based §9.1 conversion.

Platform defaults confirmed from the live `semantius info crud` schemas (all skills must agree): `entities.edit_mode` = `auto`, **`entities.cube_mode` = `auto`** (NOT `disabled`; the enum's first value is `disabled` but the column default is `auto`, and the stale parse note that said `disabled` was corrected), `entities.order_column` = `''`, `entities.id_column` = `id`, `entities.icon_url` = `''`, `fields.width` = `default`, `fields.searchable` = false/`''`, `modules.logo_color` = `''`, `modules.home_page` = `''`.

1. **Entity `edit_mode` / `cube_mode`, write them** (`stage-1-parse.md`, `stage-4-execute.md`). The parser mapped `**Edit mode:**`→`edit_mode` and `**Cube mode:**`→`cube_mode` but the deployer never wrote either (grep of `stage-4-execute.md` = 0). Added the write on the ✨-New `create_entity` payload and the ♻️ same-module `update_entity` diff; each omitted when its §3 line is absent (platform default applies). Corrected the `cube_mode` default note from `disabled` to `auto` in the Model-to-Entity table and added a parse bullet for both.
2. **Entity `order_column` / `id_column` / `icon_url`, parse + write** (`stage-1-parse.md`, `stage-4-execute.md`). New Model-to-Entity rows and parse bullets: `**Order column:**` (backticked field name; the platform auto-provisions the INTEGER column + BEFORE INSERT trigger, written as given; omit when absent → `''`), `**Id column:**` (backticked; omit when absent or `id` → `id`), `**Icon URL:**` (plain value, no backticks; omit when absent/empty → `''`). Written on `create_entity` and synced on the same-module `update_entity` diff.
3. **Field `width` on create** (`stage-1-parse.md`, `stage-4-execute.md`). The `width:` Notes marker was already synced on the field update-diff but the 4d create path hardcoded `width: "default"`. New Model-to-Field row maps `width: <value>` → `width`; 4d create now writes it from the marker (omit when absent or `default`). Update-diff unchanged (already listed `width`), clarified its source marker.
4. **Field `searchable` on create + diff** (`stage-1-parse.md`, `stage-4-execute.md`). New Model-to-Field row maps the bare `searchable` marker → `searchable: true`; added to the 4d `create_field` payload (emit only when marked) and clarified the existing update-diff `searchable` sync to name the `searchable` marker as its source. This is `fields.searchable` (the column joins full-text search), distinct from the read-only auto-computed `entities.searchable`.
5. **Module `logo_color` / `home_page`, parse frontmatter + write** (`stage-1-parse.md`, `stage-4-execute.md`, `scaffold-lib.ts`). New frontmatter parse bullets. Stage 4a `create_module` / `update_module` write both as top-level `modules` columns: `home_page` when the frontmatter carries a non-empty value; `logo_color` verbatim when provided (honored on re-deploy too, not fill-only-empty). The existing `logo_color` random-fill fallback now fires ONLY when the frontmatter omitted `logo_color` AND the live value is empty; it never overwrites a provided value. `scaffold-lib.ts` `ModulePayload` gained optional `home_page` / `logo_color`; `ensureModule` writes each conditionally on create and on the update path; the `create_module` preflight allow-list gained both. `SCAFFOLD_LIB_MAJOR` stays `5` (additive). `bun build` validated.
6. **§9.1 baseline-roles table parsed BY HEADER NAME** (`stage-1-parse.md`). The canonical v5.4 §9.1 header becomes `| role | baseline grant | origin | catalog role code | reconciliation |` (two display-only columns inserted before `reconciliation`). Converted the `baseline_roles[]` / `permission_hierarchy[]` parse instruction to be **explicitly header-based**: read the header row, map cells by column name, consume only `role` + `baseline grant` (and `permission` + `includes` for the hierarchy table), and IGNORE `origin` / `catalog role code` (the deployer re-derives both at scaffold time: `origin` from module_type, `catalog_role_code` from the §9.1 baseline-role slug). Reads both the 5.4 five-column shape and the 5.3 three-column shape correctly; does not fail whether the two new columns are present or absent. The downstream consumer (`scaffold-lib.ts` `scaffoldModule`, which reads a structured `cfg.roles.{viewer,manager,admin}` built from the parsed rows) never keyed on column position, so no executable change was needed there; the conversion is confined to the parse instruction. **§9.1 parse approach flag: converted the parse instruction to header-based (it was described by column name but not explicitly header-driven; now it is, and the two ignored columns are documented). No positional column indexing existed anywhere in the modeler, so the conversion is safe and non-breaking.**
7. **Preflight allow-lists** (`deploy-script-template.md`). Added `edit_mode` / `cube_mode` / `order_column` / `id_column` / `icon_url` to the `create_entity` list and `searchable` to the `create_field` list (the hand-authored payloads). `create_module` is preflighted inside `scaffoldModule` (updated there, not in the template). The template `cfg.module` shape documents the optional `home_page` / `logo_color` pass-through.

Reference-prose / contract edits plus one additive `scaffold-lib.ts` change (validated with `bun build`); `deploy-lib.ts` unchanged, no other rebuild.

## fix `input_type` required-ness regression + write the dropped field columns (`default_value` / `precision` / `cube_type` / `singular_label_parent` / `plural_label_parent`)

2026-07-05. The analyst authors the §3 `Required` column and several §3 Notes annotations (`default:`, `precision:`, `cube_type:`, `parent label:`), and the optimizer already round-trips `input_type === "required"` ⟺ `Required = yes`, but the deployer never wrote any of them to `create_field` / `update_field` — so every deployed field landed `input_type: "default"` (nothing UI-mandatory), FK parent labels were lost, and number `precision` / `cube_type` / `default_value` were silently dropped. This makes the deployer honor the EXISTING spec contract (the analyst already emits these; the optimizer already reads `input_type`), so it is deployer-side only: `EXPECTED_MAJOR` stays `5`; no spec-shape change. The platform property is `input_type` (enum `default`/`required`/`readonly`/`disabled`/`hidden`) — there is no boolean `required` column and no settable `is_nullable` (DB nullability is format-computed).

1. **Map `Required` → `input_type`** (`stage-1-parse.md`). New Model-to-Field row: §3 `Required` `yes` → `input_type: "required"`, `no` → `input_type: "default"` (computed-field override forces `"disabled"`). Rewrote the old blockquote that said `Required` is "not passed to `create_field`" — it now decouples `Required` (deployable as `input_type`) from `is_nullable` (still never sent; the platform computes DB nullability from `format` and delete-mode). Also added a Model-to-Field row for the `precision: <n>` annotation (number fields → `precision`, omit when absent, platform default `2`).
2. **Write the columns on create** (`stage-4-execute.md`, 4d create path). `input_type` is now derived from the field's §3 `Required` instead of hardcoded `"default"` (the computed-field override at 4d still wins). When the §3 Notes carry them, 4d also passes `default_value` (`default:`), `precision` (`precision:`, number fields), `cube_type` (`cube_type:`), and `singular_label_parent` / `plural_label_parent` (`parent label:`, parent FKs); each omitted when its annotation is absent. `width: "default"` and the `unique_value` rule are unchanged. The computed-field override wording changed from "instead of `"default"`" to "instead of the `Required`-derived value".
3. **Sync the columns on re-run** (`stage-4-execute.md`, 4d field diff). Removed the phantom `required` from the properties-to-compare list (there is no such column); `input_type` is now sourced from the `Required` mapping (computed-field override forces `"disabled"`); added `default_value`, `precision`, `cube_type`, `singular_label_parent`, `plural_label_parent` — each synced to the model value. `searchable` / `width` stay.
4. **Preflight allow-list** (`deploy-script-template.md`). Added `default_value`, `precision`, `cube_type`, `singular_label_parent`, `plural_label_parent` to the `create_field` key list (`input_type` was already listed). Kept the "no literal `required` column — mandatory is `input_type: "required"`" guidance; nothing now implies `input_type` is hardcoded `default`.

The §6 cross-model-link `create_field` example is deliberately left at `input_type: "default"` — those FK links have no §3 `Required` source. Reference-prose / contract edits only; no `deploy-lib.ts` / `scaffold-lib.ts` logic changed, no rebuild.

## deploy + verify field `unique_value` (the §3 `unique` marker)

2026-07-03. The analyst template lists `unique` among the §3 Reference / Notes markers and names `semantius-optimizer` as its round-trip carrier, but the deployer never parsed or wrote it — so a spec declaring a `unique` natural key (e.g. `it-ops-starter`'s `asset_contracts.contract_number` and `saas_applications.application_name`) deployed with `unique_value: false` and the database enforced no uniqueness. Surfaced by an optimizer round-trip: `extract(live)` showed no `unique`, diverging from the master spec. Deployer-side only; `EXPECTED_MAJOR` stays `5`; no spec-shape change (the marker already exists in the analyst contract).

1. **Parse the marker** (`stage-1-parse.md`). New Model-to-Field row: §3 Notes `unique` (bare or backticked) → `unique_value: true`, else omit. Applies to label-column fields too (a natural-key label is the common case), though they are auto-created and skipped for `create_field`.
2. **Deploy it** (`stage-4-execute.md`). 4d `create_field` now passes `unique_value: true` for marked fields; the re-run field diff syncs `unique_value` (medium-risk caveat: adding it to a populated column fails on existing duplicates — surface and dedup, never force or silently drop a live `true`); the label column, skipped for `create_field`, gets its `unique_value` stamped via `update_field` in the post-`create_entity` title-correction pass.
3. **`is_unique` → `unique_value`** (`stage-4-execute.md`, 4d diff + §6 1:1 rule). `is_unique` is not a platform parameter (`use-semantius/data-modeling.md` §All Field Properties lists only `unique_value`; changelog #9 codified `unique = unique_value: true`), so the FK-1:1 uniqueness path silently never deployed either. Corrected both references.
4. **Verify it** (`stage-5-verify.md`). New per-field round-trip: live `unique_value` must match the spec's `unique` marker (true where marked, false otherwise); a mismatch is a blocker with an `update_field` repair. Mirrors the Stage 5a text-fidelity gate so a dropped uniqueness surfaces at verify time, not in production.

Companion fix in `semantius-optimizer` (separate skill): its extractor now emits `unique` from live `unique_value` (`mapNotes`), which it previously dropped — the same round-trip gap from the other direction. Reference-prose / contract edits only here; no `deploy-lib.ts` / `scaffold-lib.ts` logic changed, no rebuild.

## deploy-time correctness fixes — UI link, create-response id, role-slug hyphens, `label_parent` ordering, module-record wiring, role provenance

2026-06-28. Four executor fixes from a real deploy post-mortem. All are deployer-side behavior; `EXPECTED_MAJOR` stays `5`; no spec-shape change, no analyst/architect lockstep needed (the analyst already handles its half of #3).

1. **UI link reads the `ui_baseurl` field, never derives it.** The Closing Contract said *"`ui_baseurl` comes from `getCurrentUser`"* without naming the field, which let a deploy build the "Open in Semantius" link from `whoami`'s `api_baseurl` (the `.semantius.ai` API host) instead of the `.semantius.app` UI host. Tightened to: read the discrete `ui_baseurl` field (`getCurrentUser '{}' | jq -r .ui_baseurl`); do NOT derive from `api_baseurl`, do NOT string-replace `.ai`→`.app`, do NOT use `whoami`. The two hosts are different subdomains and only `ui_baseurl` is guaranteed correct.
2. **Never trust a create response for the new id.** Added a safety-net cheat-table row and a new `ensure(readTool, filters, writeTool, data)` primitive in `deploy-lib.ts`. The PostgREST representation a `create_*` echoes is not a dependable carrier of the new row's `id` / natural key (the `module_id`-null-on-permission-create failure came from reading `.id` off the create response). `ensure` read-before-writes, then re-reads by natural key so the caller always gets a real row with its real `id`, and throws loud if the post-create read finds nothing. This is the existing "resolve, use, throw away" rule made the default path.
3. **Role-slug hyphen guard (defense-in-depth).** `module_slug` may contain hyphens; `roles.slug` (`^[a-z0-9_]+$`) may not. The analyst's §9.1 already normalizes `-`→`_` and the scaffold reads those slugs verbatim, but three deployer paths could still re-derive `<module_slug>_<tier>` from a hyphenated slug (4a baseline scaffold, 4l functional-ownership lookups, 4b-rename cascade) and emit e.g. `ben-admin_viewer`, which the platform rejects. Added a canonical normalization rule at 4a and applied it at 4l and 4b-rename, mirroring the persona-slug derivation in 4k that already converts hyphens.
4. **`label_parent` deferred to a post-field Spine pass.** 4c stamped `label_parent` on the `create_entity` payload, but it names a `reference`/`parent` FK that 4d (or the second pass) has not created yet, and the platform validates it at write time — so the create rejected whenever the line was present. Moved the stamp out of the 4c create payload (and its checklist + template) into a new **Spine pass** after the second pass, where every FK exists. Same deferral pattern 4e already uses for `computed_fields` / `validation_rules`; the ♻️ same-module branch was already correct (it re-points via `update_entity`). Stage 5's round-trip is unchanged, so a missed stamp still surfaces.
5. **Module-record FK wiring surfaced where it gets dropped.** The wiring of the six module-record columns (`view_permission`, `manage_permission_id`, `admin_permission_id`, `default_*_role_id`) is already specified (`stage-2-reconcile.md` §2a-scaffold step 5) and verified (Stage 5 module-scaffold check), but the deploy-script-template skeleton stopped at "permissions, hierarchy, roles" and never showed the follow-on `update_module` — so agent-authored scripts dropped it, and the module header then shows `user:read` with empty default-role pickers while per-entity RBAC still looks correct. Added the wiring as an explicit labeled step in the template skeleton + a new cardinal rule (#7), and elevated it from a buried clause to a concrete callout in the 4a Scaffold pass. **No new analyst spec section** (the report's third suggestion): the six values are fully determined by the slug + §9.1 roles + resolved `access_scope`, so the modeler derives them rather than the spec carrying — and risking drift on — them.
6. **Role provenance + use-semantius example fixes + Stage 5 role `module_id` (it-ops-starter post-mortem).** A second deploy shipped both roles with `origin: "user"` and `module_id: null` — orphans, invisible in the module governance panel — by copying a stale `create_role` example. Root cause was upstream in **use-semantius**, not the modeler: `rbac.md` and `crud-tools.md` showed `create_role` with `name` / `label` and no `origin` / `module_id`, contradicting the live tool schema (`role_name` / `slug` / `module_id` / `origin`, verified via `semantius info crud create_role`). Fixed both examples (and an adjacent `name`→`permission_name` read filter), and added to `data-modeling.md`: the `update_module` permission-wiring step + the text-vs-numeric-FK column distinction, the `&`-not-`,` multi-filter rule (with a wrong comma example corrected), and a junction `label_column` warning. Modeler-side: the deploy-script-template skeleton now spells out `role_name` / `slug` / `module_id` / `origin: "model"` on `create_role`; Stage 5's module-scaffold check now asserts each baseline role's `module_id == module.id` (the orphan symptom it previously missed — it checked `origin` and the role↔permission link but not `module_id`); and a safety-net cheat row points at `semantius info crud <tool>` for live field names. **Rejected** the report's claim that RBAC junction tables lack typed CRUD tools — `create_role_permission` / `create_permission_hierarchy` / `create_user_role` all exist and stay the documented path; and the "make Stage 6 / Step 0 blocking" asks, which are already required (the failures were non-reads, not missing instructions).
7. **New committed resource `references/scaffold-lib.ts` (scaffold builder + live-schema preflight).** Three post-mortems shared one root pattern: agents hand-roll the deterministic module scaffold from memory and drop a piece (orphan roles, null module FKs, missing provenance, hyphen slugs, the FK wiring). Added a version-stamped (`SCAFFOLD_LIB_MAJOR = 5`), schema-coupled companion to `deploy-lib.ts` that encapsulates the whole baseline scaffold as one idempotent call — `scaffoldModule(cfg)`: module (+ provenance, converged on re-run) → baseline permissions (with `module_id`) → hierarchy → roles (`role_name` / `slug` / `module_id` / `origin`, hyphen-normalized) → role_permissions → the six module-record FK wires + `access_scope`; `scope: "basic"` auto-skips the admin tier. It self-verifies every tool's field names against the live `semantius info crud` schema first (`preflightSchemas` / `assertToolSchema`, also exported for the script's own entity/field payloads). Kept deliberately OUT of `deploy-lib.ts`: those primitives are schema-agnostic and never change, so a helper that bakes in column names belongs in a separate, lockstep-versioned file. The template skeleton, the §2a-scaffold contract, Stage 5, and SKILL.md "Generated artifacts" now point at it; decision-bearing work (entity buckets, field diffs, non-baseline permissions/personas, sample-data counts) stays hand-authored on the deploy-lib primitives. Field names verified against the live schema; file validated with `bun build`.
8. **Mechanized self-audit `verifyScaffold()` — the Stage 5 scaffold check as un-skippable code.** Every post-mortem deployed a broken scaffold and still reported success because Stage 5 verification — though it existed and would have caught the drift — was a prose step the agent performed cursorily or skipped ("I only did a manual spot-check"). Adding more prose would just be a fourth skippable instruction. Instead `scaffold-lib.ts` now exports `verifyScaffold(cfg)`: pass the same config back, it re-reads the live catalog and asserts the Stage 5 module-scaffold checks (`view_permission`, the manage/admin permission-FK derefs, each baseline permission's `module_id`, the hierarchy edges, each default-role FK's slug + `module_id` + `origin` + baseline grant, `access_scope`, the lineage stamp) as code, returns findings for the report, and THROWS on any hard drift. Run as the last step inside `runDeploy`, a failed audit halts with the same loud semantics as a failed write — so "model is live" becomes contingent on the scaffold actually being correct, not on the agent remembering to look. Scope/honesty note: it is a MECHANICAL check (did the write land / is the FK null / does it deref to the right row) and covers the entire failure class the three post-mortems hit; it does NOT catch semantic errors ("built the wrong thing"), which need an independent reviewer — flagged, not built. Entity/field/rule verification stays in Stage 5 prose (a `verifyEntities` is a noted future addition). Template skeleton now ends with the audit; Stage 5 area 1 points at it; `bun build` validated.
9. **More from-memory transport traps (compliance / it-ops seed-script post-mortem): `required`, `update_entity`, `postgrestRequest` body.** (a) The #1 deploy blocker is still "there is no `required` column" — added a boxed ⚠️ warning at the top of `data-modeling.md` §Fields (mandatory = `input_type: "required"`, unique = `unique_value: true`, never `is_nullable`), plus a template note to list EVERY payload key in the preflight (so a stray `required` is caught — it would throw) and never list `required` / `is_nullable`. The preflight *would* have caught it; the failure was skipping it. (b) `update_entity` is keyed by **`table_name`** at the top level, not `id` (verified live) — new cheat-table row spelling out the three different update shapes (`update_entity` → `table_name`, `update_field` → composite `id` string, `update_module` / `update_permission` / `update_role` → numeric `id`). (c) `postgrestRequest`'s record field is **`body`**, not `data` (verified live) — added loud `pgRequest()` / `post()` Layer-2 primitives to `deploy-lib.ts` that own the `body` envelope (schema-agnostic transport, like `write`), and pointed the Stage 6 seed script at `import { post } from "./deploy-lib"` with its own deploy-lib copy step (a seed script imports ONLY deploy-lib, never scaffold-lib). (d) Template entity-create now defaults to `ensure("read_entity", …, "create_entity", …)` so the id comes from a re-read, not the create response (fixes `id=undefined` logging). `preflightSchemas` already covers `postgrestRequest` via its top-level-keys fallback, but `post()` makes the envelope un-fumbleable, so that's moot. `bun build` validated.
10. **Sample-record count made mechanical, with per-table overrides (recurring under-seeding + the "12 each but 20 customers" case).** The agent repeatedly seeded the wrong number of sample rows (18 vs 50, 2-3 per entity) because the count lived in a prose self-check ("count the `post()` calls by hand") — the same prose-discipline-gets-skipped pattern as the rest of this entry. Added `assertSeedCounts(counts, defaultTarget, perEntity)` to `deploy-lib.ts`: declare `const COUNT` + a `perEntity` override map at the top of the seed script, tally `counts[table] = rows.length`, and call it as the last line — it prints a per-table receipt and **exits non-zero if any table missed its resolved target** (default or override), or if an override was declared for a table that was never seeded. `perEntity` (`{ target, reason? }`) covers BOTH a user-named per-table count, up or down (a reply like "12 each but 20 customers" → `COUNT = 12`, `perEntity = { customers: { target: 20 } }`) AND required-FK-id scarcity (a required FK into an ineligible table with fewer than target real ids → `{ target: 4, reason }`); without that escape hatch the guard would false-fail a legitimate deploy and get ripped out. The Stage 6 consent gate now states that a reply specifying counts is itself consent (parsed into `COUNT` + `perEntity`, honored without re-asking), not an ambiguous bundle; the consent question shows the math up front (default `10 × <N> = <M>`; with overrides, the sum of resolved targets with the exceptions named) so the number the user agrees to is identical to what the guard enforces. **Root-cause fix for the under-seeding itself:** the Stage 6 script pattern now **generates rows by looping to the target** (`for (let i = 0; i < target(table); i++)`, building each row from curated pools via a new `pick(pool, i)` index-cycler in `deploy-lib.ts`) instead of hand-writing literal row arrays. Hand-authoring was the actual cause — at 10 tables × 10 rows that is 100 literals, truncated under volume (worst exactly when the entity count was also ~10), so even a plain "yes" came back short. Looping makes the count structural (cannot emit fewer), `pick` cycles value pools + §5 enums by index for realism and even coverage, and the guard drops to a backstop that should never fire. The loop fixes the count, not the content: the LLM still authors the pools/factory (real domain values), with two rules so looped data stays rich rather than robotic — size each pool >= the target (no repeats on unique fields) and construct correlated fields together rather than by independent picks (or, for tightly-coupled entities, iterate a target-sized array of complete coherent rows). **After an independent subagent review, two correctness gaps were closed:** (a) `assertSeedCounts(counts, COUNT, perEntity, tables)` now takes a required `tables` (the eligible newly-created tables) and is DRIVEN off it, so a whole table the agent forgot to seed reads as 0 and FAILS — a counts-only check could not see an omitted table, leaving the "every new table gets N" promise unbacked; (b) the consent gate now has an explicit precedence rule (a reply carrying a count beats a continuation word, so "ok, but 30 customers" seeds with `COUNT = 10` + `customers: 30` instead of re-asking), plus a stated parse rule (bare number → global `COUNT`; number + table → per-table override) and an ordered consent→parse→author→guard procedure; the SKILL closing contract notes the count-bearing-reply consent path. `bun build` validated.
14. **Third post-mortem (HVAC deploy) — one real gap (role-slug regex in `data-modeling.md`), one cheap guard added, two claims already-covered.** Independent verification again (per #12/#13). **Bug 3 (VALID, fixed):** the role-create how-to `rbac.md` got the role-slug `^[a-z0-9_]+$` regex + module-slug contrast in entry #13, but the `roles` schema table in use-semantius `data-modeling.md` still documented `slug` as a bare "snake_case handle" with no regex and no contrast — and that file is where someone reading the schema looks. Added the regex + the "underscores only, unlike `module_slug`'s `^[a-z0-9_-]+$`; convert `-`→`_`" note to the `slug` row, mirroring `rbac.md`. (Confirmed the asymmetry is real: `module_slug` regex at `data-modeling.md:42` explicitly allows hyphens.) **Bug 1 (premise false, cheap guard added anyway):** the report feared an agent piping `getCurrentUser` through `head`/`tail` and dropping `ui_baseurl`; the canonical preflight block already captures the whole output into a variable and parses it whole (it never truncates), so there was no functional gap — but added a one-line "parse the full response, never pipe through `head`/`tail`/`cut`" guard adjacent to the extraction block as requested, since it is cheap defense-in-depth against an agent that improvises instead of copying the block. **Bug 2 (REJECTED, premise false):** "ui_baseurl is captured only at the closing contract, too late." It is actually captured at the very start of every run by the preflight `getCurrentUser` probe (Check 3b: *"remember it for the rest of the run and reuse it"*, listed as a resolved Output) and again early inside Stage 4 (4g/Spine, before closing); the closing contract only consumes it. No fix. **Bug 4 (ALREADY FIXED in entry #13):** "source credentials from `.env`, never inline export" is verbatim the bolded paragraph entry #13 added to `preflight.md` (with extra paste-corruption rationale). No change. Reference-prose only; no executor logic, no rebuild.
13. **Second end-to-end run post-mortem — three discoverability gaps fixed, two already-solved claims rejected.** A real deploy hit five failures; an independent subagent verified each before any change (pattern from entry #12). **Two claims were rejected as misreadings of existing design:** (a) "preflight should probe credentials before working / mandate reading the key from a file" — the admin preflight ALREADY probes `getCurrentUser` as its single first-class auth/install/org check (`preflight.md` Check 3) and writes the key to `.env`; the probe-before-work behavior the report wants is the core of that check. (b) "add a `.deploy-progress.json` so a timed-out run can resume" — resume is ALREADY provided by idempotent read-before-write re-run convergence (`runDeploy` / `ensure` / `read1`): re-running the same script skips already-created entities/fields and reconciles forward, so a progress file would duplicate live state and risk trusting a stale copy over it (the design explicitly has "no transaction, rollback, or resume" *state* because the live catalog is the checkpoint). The reported failure was the agent not knowing to re-run, not a missing feature. **Three claims were PARTIALLY VALID — the mechanism existed but a user-facing discoverability gap remained, now closed:** (1) **Role-slug vs module-slug format** (use-semantius `rbac.md`). The prescribed `scaffoldModule` path already normalizes `-`→`_` (`scaffold-lib.ts` `roleSlug`), so the failure was a hand-rolled `hvac-svc-mgmt_viewer`; but the hand-authoring reference stated the role regex `^[a-z0-9_]+$` without contrasting it with module slugs (which DO allow hyphens). Added the explicit contrast + the convert-and-example to the `create_role` how-to. (2) **Timeout on a long deploy + "no resume"** (modeler `deploy-script-template.md`, `stage-4-execute.md`). The mechanism (Bun script, re-run convergence) existed but there was zero operational guidance on *avoiding* the timeout. Added a "Large deploys" note: run `bun run` in the background or with a raised tool timeout (the CLI's own `MCP_TIMEOUT` defaults to 30 min — the wrapping *tool* timeout is the lever), and if killed partway just re-run the same script (it converges), never hand-finish a partial deploy. This also closes the rejected-claim-5 discoverability gap. (3) **Typed `create_*`/`update_*` responses are arrays too** (use-semantius `SKILL.md`). The array-vs-object shape, `--single`, and the `.[0]` jq pattern were all documented but framed on `postgrestRequest`/reads; the report hit `Cannot index array with string` on a typed `create_role`. Added an explicit "applies to every `crud` tool, typed creates/updates included — index `.[0]` or `--single`, and better still don't read the id off a create response at all (re-read by natural key / use `ensure`)" note to the Response-handling section. No modeler executor logic changed; these are reference-prose and operational-guidance edits across three skills. `deploy-lib.ts` unchanged here, so no rebuild needed.
12. **Four-skill end-to-end run post-mortem — seed idempotency, seed nullability, `ensure` pre-wrap, modeler `yq`.** A full architect→analyst→modeler→deploy-test run surfaced nine rough edges; an independent subagent verified each against the source before any change. **Three claims were rejected as misreadings and NOT acted on:** (a) "`update_entity`'s `{table_name, data}` shape is undocumented and `preflightSchemas` rejects `data`" — the shape is documented (cheat row #313) and `preflightSchemas` checks `data`-LEVEL columns, never the `data` key itself (`toolDataKeys` reads `properties.data.properties`), so there is no contradiction and `update_entity` is simply not preflighted; (b) "Stage 2 emits only `✓ Reused: <table>`" — that string does not exist anywhere; reuse already renders field-level in the Stage 3 plan (`♻️ vendors: 6 fields, no drift`); (c) "bulk insert needs a `Prefer: return=representation` recipe" — the seed path inserts one row per `post()` (never an array body), so the uniform-keys constraint never applies, and the return-row mechanism is `--single`, not a `Prefer` header. **Five valid gaps were fixed:** (0) **`update_entity` shape had no owning helper — the structural root of the "3 attempts" confusion.** The skill's established pattern is "a helper owns the fumble-prone envelope so call sites can't get it wrong" (`ensure` owns the create-then-read-id dance, `post`/`pgRequest` own the PostgREST `body`, `scaffoldModule` owns the baseline). `update_entity` was the one common mutating call with NO owning helper: hand-rolled through raw `write("update_entity", {table_name, data})`, with its shape documented only in a backstop cheat row, a table in a *different* skill (use-semantius `crud-tools.md`), and stage-4 prose — so the agent reassembled it from memory each time and got it wrong (table_name buried in `data`, or the patch double-wrapped). Added `updateEntity(tableName, data)` to `deploy-lib.ts` (it owns the `{table_name, data}` envelope, goes through `write` so it stays loud, blind-PATCH to pair with a read1/readMany diff), wired it into the deploy-script-template (export-table row, import line, the create-or-diff orchestration comment), and re-pointed the SKILL cheat row at the helper so the backstop is no longer the primary source of the shape. Also added a template preflight note that update tools are NOT preflighted (their shape is helper-owned, and `update_entity`'s top-level `table_name` would false-fail against the tool's `data` schema) — closing the *other* half of the report's confusion (trying to preflight `update_entity`), which the verifier had flagged as a misread of `preflightSchemas` (it checks `data`-level columns, not the `data` key). (1) **Seed idempotency.** `post()` is a bare INSERT, so a re-run (common after a partial first run halts mid-seed) appends a second full batch, and `assertSeedCounts` cannot see it (it tallies only this run's inserts). Added `seedEnsure(path, row, keyField)` to `deploy-lib.ts` — read-before-write keyed on a `unique_value` column built with `uniq(base, i)` (stable across runs), returns the row with its id like `post`, converges on re-run — plus a new "Re-running the seed (idempotency)" Stage 6 subsection and an import-line note. (2) **Seed nullability.** Required TEXT formats (`string`/`text`/`multiline`/`html`/`code`) are `NOT NULL` and need `""` not `null` in seed VALUES (a `null` aborts the run before the count guard); the cheat table covered this only for `create_field` schema, not for row data — added a "Nullability safety" note to Stage 6 alongside Enum/String safety. (3) **`ensure` pre-wrap footgun.** `ensure` already wraps its `data` arg in `{data}` for the write; a reader who conflates it with `write()` (which DOES take `{data: f}`) double-wraps to `{data:{data:...}}` and the create fails. Spelled out the raw-fields-vs-payload distinction on the template's `ensure` row. (4) **Modeler does not need `yq`.** The shared admin preflight checks `bun jq yq`, but `yq` only serves the customizations layer the modeler skips, so a missing `yq` was wrongly blocking standalone runs — the SKILL preflight note now states the modeler needs `bun` + `jq`, not `yq`. The centralized-preflight design itself is intentional and unchanged. `bun build` validated.
11. **Sample-data uniqueness at scale (`unique_value` 409 crash + lockstep / pool-cap traps).** A second independent subagent review found the loop-to-target pattern guaranteed the COUNT but not UNIQUENESS past pool size: `pick(pool, i)` cycles, so above `pool.length` values repeat, and a field carrying `unique_value: true` (email, code, external id) then fails its insert with a **409** — which `post()` throws on, aborting the whole run *before* `assertSeedCounts` runs (the count guard cannot catch it; the seed doc never mentioned `unique_value` at all). The shipped example also had a lockstep bug (`pick(first,i)` + `pick(last,i)` share `i` → only 10 distinct names, not 100). Fixes: added `combine(i, pools)` (mixed-radix composition → F×L×… distinct tuples from small pools) and `uniq(base, i, suffix)` (index-composed, collision-proof) to `deploy-lib.ts`; a new "Uniqueness that scales (and `unique_value` safety)" Stage 6 subsection with Enum/String-safety prominence (detect `unique_value` fields and make them distinct by construction; `pick` for repeat-OK, `combine` for distinct-at-scale, in-loop derivation for correlated fields); and the example now uses `combine` for names + `uniq` for a `unique_value` email. Net: count is structural (loop), uniqueness is compositional (helpers), neither needs hand-authoring N rows. `bun build` validated.

## §3 flag removal, frontmatter simplification, `canonical_`→`catalog_` rename, `domain_code`/`access_scope`/`icon_name` as top-level columns

2026-06-27. Deployer-side half of the platform-schema contract change (architect + use-semantius landed the upstream half). `EXPECTED_MAJOR` stays `5` — the prior version was never deployed, so there is no installed base to migrate.

Platform columns moved / renamed / deleted, so the deployer's writes change:

1. **Stop stamping `entities.pattern_flags` (column deleted).** Removed the stamp from the Stage 4c provenance payload, the 4c provenance checklist row, the "`pattern_flags` is the trap" block, the Stage 1 derivation (Model-to-Entity Mapping), the SKILL.md provenance list, the `deploy-script-template.md` payload comment, and the Stage 5 entity-provenance assertion. The §3 behavior flags (`personal_content` / `submit_lock` / `single_approver` / `multi_approver`) were never platform-enforced; enforcement always lived in analyst-authored `select_rule` / `validation_rules` + RBAC.
2. **`entities.canonical_owner_module` → `catalog_owner_module`**, and the spec line label `**Canonical owner:**` → `**Catalog owner:**` (the analyst emits it, the deployer parses it — renamed atomically across both skills). Part of the `canonical_`→`catalog_` concept rename, including the re-prefix machinery (`re-prefixed-from <catalog-module>.<verb>`, catalog-prefixed / non-catalog-prefixed permissions, Stage 2i "Catalog-owner detection"). The authoritative English sense of "canonical" (canonical copy / source / built-in list / branches) is unchanged.
3. **`domain_code` / `access_scope` → top-level `modules` columns** (were `modules.settings` keys), plus the **new `modules.icon_name`** column. The Stage 4a create/update payload, the 4a checklist + example, the Stage 2a `create_module` plan, the module schema note, the Stage 2.5 access-scope persist + the detection query (`access_scope=eq.full`, was `settings->>access_scope=eq.full`), and the Stage 5 verify round-trip all read / write the top-level columns now. `modules.settings` keeps `naming_mode` / `module_kind` / `catalog_snapshot` / `promotion_decisions` / `raci_mode`.
4. **`modules.description` ← frontmatter `tagline`** (was `system_description`, removed). `tagline` is now the ≤40-char selector-chip text; the `description` frontmatter key is longer marketing prose, carried only.
5. **Approval cross-check retired (Stage 2j).** The `single_approver` / `has_single_approver` named-gate mechanism is gone; an approval is now a §7 gated transition + its §8.1 `workflow-gate` permission (minted / verified like any §8.1 row) + the §9 RACI Accountable actor. The §8.1 `override` tier no longer carries a `(personal_content)` / `(submit_lock)` parenthetical.

Deploy-time correctness change (the deployer would otherwise write platform columns that no longer exist as `settings` keys / under the old names); no spec-shape change beyond the frontmatter keys above. The `settings.access_scope` / `settings.domain_code` entries further down are now historical — read them as "what was true before this entry."

## plain-language vocabulary pinned (entity vs. field vs. record); access-control label plainer

2026-06-22. Two user-facing wording fixes, both documentation/contract (no executor-code change), `EXPECTED_MAJOR` stays `5`:

1. **Entity / field / record nouns pinned in the Writing Conventions.** The plain-language deploy contract is model-generated and the conventions had no rule keeping the three nouns distinct, so a deploy rendered *"Create 5 records and their fields"* — calling entities "records," which collides with the Stage 6 meaning of "records" (saved rows / sample data). Added a banned-usage bullet: an entity (table) is named by its Plural Label or called a "table" / "record type" (never "records," never "fields"); a "field" is only a column; "records" / "rows" are reserved for data rows. Worked example shows *"Create 5 tables and their fields"* ✅ vs. *"Create 5 records and their fields"* ❌.
2. **Access-control option label.** The Stage-2.5 access-control prompt's `Full access control` option is now `Advanced access control` (basic access is not missing capability, it is simply not role-gated), and the "add full access control later" line reads "advanced."

**Minor**: user-facing prose only. No parser, executor, or schema-compatibility change.

## Stage 6 sample-data count made prescriptive (fixes under-seeding drift)

2026-06-22. A deploy seeded only 2 records per entity despite the Stage 6 question promising 10, because the count lived solely in advisory prose and the script-pattern example demonstrated exactly 2 rows per entity — so agents copied the example, not the instruction. No skill regression; this was runtime drift the prose did not prevent. Three coupled changes to Stage 6, all documentation/contract (no executor-code change), `EXPECTED_MAJOR` stays `5`:

1. **New "How many records" rule.** The default is now stated as *exactly 10 per eligible entity*, framed as a commitment the user's "yes" buys. The only legitimate ways to seed fewer are an explicit user-chosen count or FK-id scarcity on a required field, and both must be surfaced. Adds a pre-run self-check: count `post(...)` calls per entity and add rows until the count is met.
2. **Fixed the misleading script example.** The pattern previously showed 2 hard-coded rows per entity; it now loops over a row array with explicit `... 10 total ...` markers and a banner stating the example is abbreviated for readability only.
3. **Summary must report per-entity counts.** The run step now requires reporting how many records landed per entity, with a reason on any line below the target. Turns silent under-seeding into a visible defect.

## `module_id` is now reliably set + self-healing on permissions, roles, AND entities

2026-06-21. Fixes a deployed defect from the `it-ops-starter` deploy where `module_id` came back NULL on records that the platform/model expects to own a module FK:

- `it-ops-starter:read` / `:manage` permissions: `permissions.module_id = NULL`.
- All five owned entities (`asset_contracts`, `saas_subscriptions`, `service_incidents`, `saas_applications`, `software_licenses`): `entities.module_id = NULL` — no entity pointed at module 1033 at all.

Two distinct root causes, same symptom:

1. **Permissions/roles — create-only scaffold.** Step 2 / step 4 ran `create_permission` / `create_role` *only* on `read_* ` exit 1 and did nothing on exit 0, so a row once minted with a NULL `module_id` could never self-heal; every re-deploy read exit 0 and skipped it. (The prose already said to pass `module_id`, and `rbac.md` shows it — the gap was the missing converge path.)
2. **Entities — `module_id` absent from the create instructions entirely.** The **Model-to-Entity Mapping** table (the authoritative param list the deployer builds `create_entity` from) and the ✨-New prose bullet both enumerated every other column but **omitted `module_id`**, even though `data-modeling.md` documents it as *required on `create_entity`* (null rejected). The deployer faithfully built a payload without it.

Changes:

1. **Stage 4a-scaffold step 2** now *converges* `permissions.module_id` (exit-0 path asserts and `update_permission`s NULL/mismatched values).
2. **Step 4 (default roles)** gets the identical converge guard for `roles.module_id`.
3. **Model-to-Entity Mapping table** now lists `module_id` as a required `create_entity` param (this-module for create-new/rename-incoming; master module for promote-to-master); the **✨-New prose** passes it explicitly.
4. **Stage 4c ♻️ same-module path** converges `entities.module_id` on re-run (repairs a stranded entity instead of skipping it).
5. **Stage 5** — per-area check 1 reworded so a permission `module_id` hit means the Stage 4 backfill didn't land (re-issue + halt); per-area check 5 gains an owning-`module_id` assertion for every owned entity (previously only *promoted* entities were checked).

All four record types (`permissions`, `roles`, `entities`, plus the existing `modules` FK refs) now both set `module_id` correctly on first deploy and converge it on re-deploy. `EXPECTED_MAJOR` stays `5`. Deploy-time correctness/idempotency fix only; no spec-contract change.

Live note: the five stranded `it-ops-starter` entities still carry NULL `module_id` in the instance — a re-deploy now repairs them via the Stage 4c converge path (or an explicit `update_entity ... module_id=1033`).

## persist `settings.access_scope` on every deploy path; access-scope default reads it

2026-06-20. Two coupled changes so the access-scope default reflects what the instance actually uses.

1. **Persist on every resolution path.** The modeler previously recorded `modules.settings.access_scope` only at resolution step 3 (the "undecided → ask" path). In the normal hybrid pipeline the spec frontmatter carries the decision (step 1), so the setting was never written and live module records showed `settings.access_scope = null`. The modeler now writes the resolved value via an idempotent `update_module` at Stage 4a-scaffold on all three paths (frontmatter, prior setting, ask), same pattern as `settings.raci_mode`.

2. **Detection backstop matches the analyst.** The Stage 2.5 default detection no longer sniffs for any non-built-in permission / non-system role (a basic deploy creates those too, so it could not tell basic from full). It now counts live modules whose `settings.access_scope = full` (excluding the module being deployed): any row → default Full, none → default Basic.

`EXPECTED_MAJOR` stays `5`. Behavior change to a deploy-time default and an added idempotent write only; no spec-contract change.

## blueprint front-matter key renamed (`fact_sheet_version` → `blueprint_version`)

2026-06-15. The spec front-matter key carrying the blueprint artifact version was renamed `fact_sheet_version` → `blueprint_version` (value unchanged at `"3.0"`). `EXPECTED_MAJOR` stays `5`; the deployer gates on the spec's `version` major (not this key), so there is no behavior change. Coordinated with the architect and analyst.

**No `EXPECTED_MAJOR` bump applied** (deferred to the maintainer).

---

## access-control scope (basic vs full RBAC); Stage 2.5 backstop

`EXPECTED_MAJOR` stays `5`. Lockstep delta with the access-control change folded into the (unreleased) analyst `5.3` — no version bump, since the analyst was never released. **The architect is not involved** (it is platform-agnostic and never decides access control; the analyst owns the decision because it is platform-aware). Closes the reliability gap where the modeler deployed a spec's full RBAC (permissions, roles, workflow gates, lifecycle gating) unconditionally and never asked whether the user wanted plain read + edit access.

**What changed in the deployer.**

1. **Stage 1 parse** reads an optional `access_scope` frontmatter key (`basic` / `full`); a value outside those two is a 🛑 High blocker.
2. **New Stage 2.5 (Access control scope)** between Stage 2 and Stage 3. Resolution order: spec frontmatter `access_scope` → live `modules.settings.access_scope` (a prior deploy's choice) → detect-and-ask. Detection: an instance "already uses access control" when it carries any non-built-in permission (outside `user:read` / `user:manage` / `admin` / `public:read`) or any non-system role; that flips the default (fresh → Basic, RBAC-in-use → Full). The prompt fires ONLY at the detect-and-ask branch — when the spec or module already carries the choice, the modeler obeys without asking (consistent with "the only confirmation the modeler asks").
3. **Two-permission projection (Stage 4)** when the resolved scope is `basic` and the spec is full-shaped: deploy only `<slug>:read` + `<slug>:manage`, the `manage → read` edge, and viewer + manager roles; force every `edit_permission` to `<slug>:manage`; drop write/read rules that gate on a dropped permission (keep pure-logic ones); skip 4k (personas/RACI), 4l (functional ownership), 4m (handoffs). When the spec is already two-permission-shaped (the hybrid path, analyst authored it basic), the projection is a no-op. The rare entry whose JsonLogic mixes a permission gate with a data-integrity check routes back to the analyst rather than guessing.
4. **Persistence**: Stage 4a writes `modules.settings.access_scope` so re-deploys read the choice back (Stage 2.5 step 2) and never re-ask.
5. **Plan + verification**: a `🔐 Access control:` line in the Stage 3 plan and a mandatory access-control callout in the Stage 5 summary (naming what a projection suppressed, and any pre-existing higher-governance objects left as quiet orphans — never deleted, per the no-auto-deletion rule).

**No bump.** `EXPECTED_MAJOR` unchanged. `access_scope` is a new optional frontmatter key with a defined default (absent = undecided = the backstop resolves it at deploy time, reproducing prior behavior when `full` is chosen). No structural change; every spec authored before this change deploys unchanged. The analyst minor bump was not applied — the analyst was unreleased, so the change folds into the current version (analyst `5.3`). The architect is unchanged.

---

## enforce lifecycle state field name (`workflow_state`); stop stamping `catalog_field_code`

2026-06-15. `EXPECTED_MAJOR` stays `5` (analyst `5.3` is the same major). Lockstep delta with analyst `5.3` and architect `5.2`. Two changes in the deployer.

**What changed in the deployer.**

1. **Enforce the fixed `workflow_state` lifecycle state field.** Stage 1 parse adds a 🛑 High blocker: any spec whose lifecycle state lands in a field not named `workflow_state` FAILS LOUD and routes the user back to the analyst. Detection: a `process_gates[].state_column` ≠ `workflow_state`, or a lifecycle-bearing entity (one with a `workflow-gate (lifecycle)` permission or a `process_gates` row) whose §3 Fields table has no `workflow_state` enum field. Stage 5 adds a live round-trip of the field name. The deployer never silently renames the field.
2. **Stop stamping `catalog_field_code`.** The platform is dropping `fields.catalog_field_code`; `create_field` no longer passes the value, the Model-to-Field mapping and Provenance-stamping rules drop it, and the "three scalar codes" become two (`catalog_entity_code` / `catalog_module_code`). `catalog_role_code` and the rest are unchanged.

**Major-vs-minor.** `EXPECTED_MAJOR` unchanged. The state-field gate is a stricter validation, not a spec-format change — a spec that already uses `workflow_state` deploys unchanged; a legacy spec with a differently-named state field now fails loudly (the intent). No structural change.

---

## composed record labels: parse / stamp / verify `label_parent`; skip `_label` / `<fk>_label`; reserved-name guard

2026-06-14. `EXPECTED_MAJOR` stays `5` (analyst `5.2` is the same major). Lockstep delta with analyst `5.2` and architect `5.1`. The platform added read-time composed labels (`_label` on every entity, `<fk>_label` on every reference/parent FK) and an optional `label_parent` entity property naming the identity-spine FK. The analyst now derives and emits `label_parent`; the deployer stamps and verifies it.

**What changed in the deployer.**

1. **Parse `**Label parent:**`.** Stage 1 captures the new per-entity line into `label_parent` (default null/absent). Added to the Model-to-Entity mapping table.
2. **Stamp `label_parent`.** The ✨-New `create_entity` branch passes `label_parent` only when the line is present (omit → null); the ♻️ same-module branch re-points it via `update_entity` on drift (set to the spec's FK, or clear when the spec omits the line). Unlike the write-once provenance codes it is a normal nullable property — re-pointing is allowed, with no data migration.
3. **Skip the composed-label columns.** `_label` (`ctype: _label`) and every `<fk>_label` (`ctype: fk_label`) join the auto-generated skip set — never `create_field`ed, skipped on every field diff. They never appear in the spec's Fields tables or in `read_field`.
4. **Reserved-name guard (defense-in-depth).** Before any `create_field`, reject any `field_name` starting with `_` or ending in `_id_label` (platform-reserved; the platform also rejects). A spec carrying such a name is an authoring bug → FAIL LOUD, route back to the analyst.
5. **Stage 5 round-trip.** Verify `label_parent` matches the spec (set when the `**Label parent:**` line is present, null otherwise) and that no `_label` / `<fk>_label` column was materialized as a real `fields` row.

`entity_type` stamping already existed (the v5.1 provenance pass) — unchanged here.

**Major-vs-minor.** MINOR: `EXPECTED_MAJOR` unchanged. The `**Label parent:**` line is an optional per-entity sub-block (5.1 specs still parse; an older deployer that ignores it leaves `label_parent` null with no regression). No structural change, no `fact_sheet_version` bump.

---

## provenance stamping pass: `catalog_entity_code` / `entity_type` / `catalog_entity_aliases`

2026-06-14. `EXPECTED_MAJOR` stays `5` (analyst `5.1` is the same major). Lockstep with analyst `5.1` and architect `5.0` (`fact_sheet_version 2.2 → 3.0`). The analyst began carrying the blueprint's provenance into the spec as per-entity lines; the deployer learned to stamp them onto the platform's v0.1.2 core provenance columns.

**What changed in the deployer.**

1. **Parse the new per-entity lines.** `**Catalog entity code:**` → `catalog_entity_code`; `**Entity type:**` → `entity_type`; `**Catalog alias:**` → an element appended to `catalog_entity_aliases`. Added to the Model-to-Entity mapping table.
2. **Stamp on `create_entity` (write-once codes).** The ✨-New branch stamps `catalog_entity_code` (the CANONICAL code, defaulting to `table_name`), `entity_type` (`'unclassified'` when absent), `canonical_owner_module`, and `pattern_flags` on the same payload. Codes are write-once — never re-sent on a later rename.
3. **APPEND `catalog_entity_aliases` on reuse/merge.** A cross-domain identity renamed onto an existing host appends `{alias_code, source_domain, source_module, decided}` to the host's array (read-modify-write; never rewrite or drop prior elements).

**Major-vs-minor.** MINOR: `EXPECTED_MAJOR` unchanged; the spec additions are new optional per-entity lines an older deployer ignores (the columns stay at their empty defaults). Stamp-only; no structural change.

---

## §2-Permissions-summary retirement finalized; canonical empty-section placeholder recognized

2026-06-05. `EXPECTED_MAJOR` bumps from `4` to `5` in lockstep with analyst `5.0` (and architect `4.3`). Two coordinated contract changes land together:

**Change B (breaking, this skill's major) — §2 Permissions summary retired; §8.1 / §9.1 canonical.** The analyst's spec no longer carries the §2 Permissions summary table; the §8.1 Permissions catalog and the §9.1 Permission hierarchy (including the `manage → narrow` rollup row that moved out of §2) are the canonical permission surface. This is a breaking spec-structure change (a structural table removed), so pre-existing `4.x` specs — which carry §2 Permissions summary with the narrow rollup that lived only there — are **non-deploy-safe** and are rejected at Stage 1 (`major != EXPECTED_MAJOR`) until regenerated through the analyst. This is the intended migration signal, not a regression.

**Change A (non-breaking) — canonical empty-section placeholder.** The architect/analyst now keep every canonical section present and write `_(none: <short reason>)_` (bare `_(none)_` allowed) when a section is empty. The deployer's one literal empty-section read — the §6 cross-model-link-suggestions read at Stage 1 — now recognizes the canonical placeholder (detect via `^_\(none\b`), treating it as "section present, empty" (zero rows; Stages 2g / 4h no-op). The retired sentence `No cross-model link suggestions.` is kept only as a grandfathered alias, treated identically. This is a staleness fix, not a runtime change — an empty/placeholder §6 yields zero table rows either way.

**What changed in the deployer.**

1. **`EXPECTED_MAJOR 4 → 5`** at the Schema-compatibility heading, the prose mention, and the error string. The Conflict-Resolution version rows parameterize on the `EXPECTED_MAJOR` symbol and track the constant automatically. The historical "v4.1 contract additions" narrative's `EXPECTED_MAJOR stays 4` clause was rewritten to past-tense.
2. **§6 read recognizes `_(none: …)_`** as the empty-section form (Stage 1 §6 parse), no longer matching only the retired sentence. The placeholder line is never parsed as a table row nor carried forward as data.
3. **`fact_sheet_version` echo reconciled** to `"2.2"` (the architect's stamped value; major `2` unchanged — informational, the modeler does not re-validate it against the architect).

**Folded-in consolidation-era additions verified during the deployer audit (D1–D8):** Stage-1 `consistency-check.ts` pre-deploy gate; the Stage-4 "deploy incomplete, re-run" loud-failure invariant; Stage-5 Per-area check #7 (live-RACI round-trip); 4c-promote / 4h read-before-write tightening; the `promotion_decisions` list-shape parse note; the §6 resolve-at-deploy (5-col hint) read correction; the §9.1 RACI `process` column removed from the parse tuple; the inverted-hierarchy Conflict-Resolution row hardened to additive-only.

**Major-vs-minor.** MAJOR: the spec structural-table removal (Change B) is not backward-compatible — a `4.x` spec carries §2 and a `5.0` spec does not, and the two skills must move in lockstep. Change A is non-breaking on its own (the placeholder recognition is purely additive tolerance), but it ships in the same lockstep bump.

---

## RACI-mode-aware Stage 4k: sync the live RACI matrix + enforcement (living mode); agent actors

2026-06-03. `EXPECTED_MAJOR` stays `4` (analyst `4.2` is the same major). The deployer learns to drive the platform's now-shipped live-RACI engine (`0210_raci.sql`, PR #189) instead of only compiling RACI into `role_permissions`. Lands in lockstep with architect `4.2` and analyst `4.2`. Backward compatible: `documentation` mode is the default and reproduces v4.0 behavior exactly.

**What changed.**

1. **Mode pre-step (Stage 4k).** Resolve the module's RACI mode: honor the spec's `**RACI mode:**` line (the analyst already asked — the deployer does NOT prompt). Absent → catalog-aware fallback (`living` when ≥1 module already uses RACI, else `documentation`); no RACI engine on the instance → force `documentation`. Surface `🧭 RACI mode: <mode>` in the Stage 3 plan.
2. **Living-mode materialization (Stage 4k).** Emit the analyst's RACI plan via the generic `postgrestRequest` tool — the `crud` server exposes **no** dedicated `create_process` verb (confirmed against CLI v0.5.8), so all RACI-table CRUD goes through `{method, path, body}` against `/processes`, `/raci_assignments`, `/process_gates`. Idempotent GET-by-natural-key → POST on miss. Set `process_gates.emits_events = true` for C-notify / I (drives the platform emit trigger → `raci_events` → `raci_notify` queue). Author the A-gate (`is_raci_actor`) and C-block (`has_consultation`) as `validation_rule`s via the existing `update_entity` path — the A-gate replaces the hand-authored `has_single_approver` when living. Set `modules.settings.raci_mode = "living"`. Pre-verify at most one `accountable` per process (the platform also enforces a partial unique index).
3. **Agent actors no longer deferred.** `kind = skill` rows resolve to a role held by an agent user (`users.is_agent = true`) via `create_role` + `create_user` (`is_agent`) + `create_user_role`, then are treated like personas. Removes the v4.0 "🟡 informational … Plan-5 will revisit when the platform exposes the relevant tables" deferral — the platform now exposes them. ("Accountable must be human" enforcement + JIT agent tokens remain platform Phase 3.)
4. **The write-tier grant still flows in both modes.** Living mode is **additive**: RLS is permission-based, so an actor still needs the baseline tier grant to touch the table. Living mode adds the matrix + rules; it does not remove or regenerate `role_permissions`.

**Major-vs-minor.** MINOR: `EXPECTED_MAJOR` unchanged, `documentation` mode default = v4.0 behavior, all living-mode work is opt-in per module.

---

## extended blueprint/spec contract: §9 governance, module_kind, presence-conditional FKs, ⚠ handling, has_single_approver cross-check, entity-owning-module rule + master-install reconciliation

2026-06-03. `EXPECTED_MAJOR` bumped from `3` to `4` in lockstep with analyst `4.0` → `4.1`. Files written by analyst `4.x` may carry six new authoring conventions on top of `3.x`:

1. **Frontmatter additions** — `tagline`, `description`, `persona` (flat list), `license`, `module_kind` (informational label; NOT a behavior switch).
2. **§3 `**Reconciliation:** re-prefixed-from <canonical-module>.<verb>` annotation** on workflow gates and pattern-flag overrides for `embedded_master` entities whose canonical owner module is absent.
3. **§5 `delete_mode` / `fk_format` columns** (already covered by the existing field-shape parse; the deployer now consumes verbatim and adds the §5.3b cross-scope vocabulary `none` / `none (required-if-present)` / `⚠ audit`).
4. **§6.2 / §6.3 `transition` column** carrying `<to_state> _(<event_category>)_`.
5. **§7 ⚠ annotations** (`⚠ state-machine shape: <reason>`, `⚠ unresolved gate: <reason>`).
6. **§9 governance section** (baseline roles + permission hierarchy + RACI realization + functional ownership).

Pre-3.0 files are still rejected (the major mismatch is a halt); a 4.0+ deployer reading a 3.x file rejects via the schema-compat gate, routing back to the analyst.

**The failure modes this fixes.**

- **Phantom permissions** — under v3.x, `has_single_approver` rules paraphrased the approve gate; the analyst minted `<slug>:approve_<entity>_approval` and dead role-permission rows landed on deploy. v4.0 cross-checks at the deploy boundary (Stage 2j) that the rule names a permission code that actually appears in §2.
- **Broken non-null restricts** — §5 edges declaring `is_required = true` with absent targets emitted FK columns with non-null restrict, breaking row inserts. v4.0 Stage 4d skips FK column emission for `delete_mode: none (required-if-present)` when the target isn't installed.
- **No persona / functional-ownership provisioning** — §9 didn't exist; baseline roles / hierarchy / RACI were ad-hoc. v4.0 adds Stage 4k (persona provisioning) and Stage 4l (functional-ownership default grants) as authoritative consumers of §9.
- **Embedded-entity "thin shells" with un-minted gates** — when a blueprint embedded an entity whose canonical owner was absent, the entity's gates / overrides were under-emitted. v4.0 Stage 4a-scaffold mints under the installing-unit slug per the entity-owning-module rule; Stage 4n reconciles when the canonical owner later installs (sibling permissions + sibling role_permissions; no deletes).
- **Silent ⚠ provisioning** — v3.x had no concept of soft data-quality flags. v4.0 Stage 4d's ⚠ handling SKIPS or FAILS LOUD rather than silently provisioning a malformed state machine or phantom gate.

**The new convention.**

1. **Stage 1 (Parse)** extended with: new frontmatter (`module_kind`, `tagline`, `description`, `persona`, `license`); §8.1 `re-prefixed-from` annotation; §8.2 `has_single_approver` named-gate extraction; §6 `transition` column; §7 ⚠ annotations; §9 governance sub-indices (baseline_roles / permission_hierarchy / raci / functional_ownership).
2. **Stage 2 new sub-stages:**
   - **2h `module_kind` recognition** — surface in plan summary, no behavior branch.
   - **2i Canonical-owner detection** — for every §8.1 row with `re-prefixed-from`, look up the canonical module live; queue for Stage 4n reconciliation when present.
   - **2j `has_single_approver` cross-check** — re-verify at deploy boundary that the named gate exists in §2.
3. **Stage 3 plan-summary line types added:** `🏷 module_kind`, `👥 Personas to provision`, `🏢 Functional ownership`, `🔁 Re-prefix`, `🔁 Master-install reconciliation`, `⚠️ Skipping on ⚠`, `💤 Skipping FK (presence-conditional)`.
4. **Stage 4 sub-stages added:**
   - **4d extension** — skip FK column emission for `delete_mode: none (required-if-present)` when target absent; honor ⚠ annotations (SKIP / FAIL LOUD).
   - **4a-scaffold extension** — when a §2 row carries `re-prefixed-from`, mint under the installing-unit slug as-is (the analyst already resolved the prefix per the entity-owning-module rule).
   - **4k Persona provisioning** — idempotent role check + grant resolution per RACI row, using the row's `grant_module` column (the entity-owning-module lookup result emitted by analyst v4.1+). Persona-actor rows mint tenant roles; skill-actor rows defer to platform `personas` / `skills` support.
   - **4l Functional-ownership default grants** — walk §9.2; resolve named default_role; idempotent role-permission grant.
   - **4m Boundary-crossing handoff wiring** — wire `transition_event_triggers` (when supported); 🟡 informational rows when the platform doesn't expose the registry yet.
   - **4n Permission reconciliation on owner-module change** — fires when Branch-B promotion moves an entity. Sweeps every accumulated non-canonical prefix (multiple prior installs possible), mints canonical-prefixed sibling permissions, creates sibling `role_permissions` rows, re-emits matching `permission_hierarchy` edges. No deletes (per the no-auto-deletion symmetric rule). Symmetric across install orderings.
5. **Stage 5 (Verify) new structured report sections:** Functional ownership grants, Personas provisioned, Re-prefixed permissions, Master-install reconciliation, Boundary-crossing handoffs, Skipped FKs, Skipped on ⚠ flag.

**The entity-owning-module rule (the load-bearing simplification).** Workflow gates and pattern-flag overrides for entity E are prefixed by E's CURRENT owning module slug, not by the installing unit. The rule applies uniformly to every blueprint shape (`hiring-starter`, `ats-recruitment-pipeline` which is itself master-of-15-and-embedded-of-5, `real-estate-agent`, any future bundle) and to every install ordering. The deployer's behavior on every install is `module_kind`-agnostic — no special "starter" branch. Walked install orderings:

- **First-installer creates the entity** → entity's owning module = the installing unit; gates / overrides get the installing-unit prefix.
- **Later-installer finds the entity already exists** → reuses it via `reuse-from <other-module>.<entity>`; personas grant on existing codes via the row's `grant_module` column. No duplicates.
- **Canonical owner installs (first, mid-sequence, or last) and Branch-B promotion moves the entity** → Stage 4n reconciles every accumulated non-canonical prefix onto the canonical prefix. N prior non-canonical prefixes → N sibling grants per role per verb. No deletes.

**Plan-5 escape hatch.** When the platform later moves to entity-scoped identity (`<entity>:<verb>`), Stage 4n becomes a no-op merge — the prefix never changes because there isn't one. The deployer-side reconciliation obligation disappears entirely; Stage 4n becomes documentation of the rule the analyst already enforces at spec-write time.

**Major bump rationale.** Although the new contract carriers are additive at the syntactic level (new columns, new sub-sections, new frontmatter keys), the changes are not backward-compatible at the **semantic** level: a v3.x deployer reading a v4.x file would silently produce the wrong shape (phantom permissions on `has_single_approver` rules, broken non-null restricts on presence-conditional FKs, no persona provisioning, no master-install reconciliation). The major bump is the honest signal that the two skills must move in lockstep.

**Companion changes.**
- Analyst `4.0` → `4.1` in lockstep (consume-the-blueprint paradigm shift; full per-skill scope in its own SKILL.md).
- Architect `4.0` → `4.1` in lockstep (extended blueprint contract: §3 write tier col, §5 cols, §6 transition col, §7 ⚠, new §9, embedded-entity-governance convention).
- Shared `references/data-modeling.md` (architect + analyst sibling copies): retired "deployable closure" framing; tightened `is_required` to presence-conditional; added "Embedded-entity governance follows the entity, not the role" subsection.

---

## `permission_hierarchy` column rename (`parent`/`child` → `including`/`included`)

2026-05-27. In lockstep with analyst minor `3.5`. The platform renamed two columns on `permission_hierarchy`:

- `parent_permission_id` → `including_permission_id` (the broader permission, the one doing the including; e.g. `crm:manage` when expressing "`crm:manage` includes `crm:read`")
- `child_permission_id` → `included_permission_id` (the narrower permission, the one being included; e.g. `crm:read`)

A row reads as `including_permission_id` ── *includes* ──▶ `included_permission_id`. Old column names are gone, not aliased — sending the old payload shape fails at PostgREST with an unknown-column error. The `id` natural-key format (`"<including>.<included>"`) and the `origin` enum (`"system"` / `"model"` / `"model_master"` / `"user"`, strictly immutable) are unchanged. `EXPECTED_MAJOR` stays at `3`.

**Where the deployer changed.**

1. **Stage 2a-scaffold step 3 (in-module hierarchy chain).** Resolution pattern restated: `includingId = (await read_permission_single("permission_name=eq.<broader>")).id; includedId = (await read_permission_single("permission_name=eq.<narrower>")).id;` then `read_permission_hierarchy --single by including_permission_id=eq.<includingId>&included_permission_id=eq.<includedId>`; `create_permission_hierarchy` payload becomes `{including_permission_id: includingId, included_permission_id: includedId, origin: ...}`. Verification narration renders as `<including_permission_name> → <included_permission_name>` (e.g. `product_roadmap:admin → product_roadmap:manage`, meaning admin *includes* manage).

2. **Stage 4b (in-module rollup chain).** Three-permission models write rows with `including = <slug>:admin, included = <slug>:manage` and `including = <slug>:manage, included = <slug>:read`. Two-permission models write `including = <slug>:manage, included = <slug>:read`. Idempotency read filters use the new field names. The "never invert direction" rule is restated explicitly: the narrower permission must never appear on the including side.

3. **Stage 4i (cross-module bridges).** Master-promotion read inclusion rows use `including_permission_id = <consumer>:read.id, included_permission_id = <master>:read.id, origin = "model_master"` (the consumer's `:read` *includes* the master's `:read`, so holding the consumer's read transitively grants visibility into the master's entities). Manage inclusion follows the same direction. Idempotency reads use the new field names.

4. **Lookup-conventions section.** Numeric-FK callout updated: `permission_hierarchy.including_permission_id` / `.included_permission_id` replace the old pair as the canonical example of resolve-use-discard FK columns. Verification narration example updated to reference `included_permission_id` instead of `child_permission_id`.

5. **No-auto-deletion safety rule.** The wording covering FK adjustments during master-rename / master-merge now names `including_permission_id` / `included_permission_id` as the legal mutations. Behavior unchanged: the deployer never deletes hierarchy rows, regardless of origin.

**Minor bump (not major).** The model file shape, the §2 column shape, and the `Hierarchy parent` column semantics are all unchanged. The change is internal to how the deployer writes the row, and to the natural-key narration the verification report renders. Analyst-side `3.4` and `3.5` files produce identical hierarchy rows on the new deployer; the bump exists to keep the lockstep history honest.

The CLI (`semantius v0.4.2` and later) accepts only the new field names. A `v3.2.1` deployer paired with that CLI fails on hierarchy creates with `PGRST204 — column "parent_permission_id" not found`. Upgrade in lockstep with the CLI.

---

## `create_permission` must pass `module_id`; lookup conventions formalized

2026-05-27. In lockstep with no analyst change; pure deployer-side bug fix plus a conventions tightening that prevents the same defect class.

**Bug fix.** Stage 2a-scaffold step 2 previously passed only `permission_name` and `description` to `create_permission`, leaving `permissions.module_id` NULL on insert. The defect was invisible to hierarchy edges and role-permission joins (which resolve by `permission_name` or by FK id, neither needing `module_id`) but produced real catalog drift: permissions were unscoped, so `?module_id=eq.<id>` queries silently missed them and per-module RBAC audits reported drift.

Fix: Stage 2a-scaffold step 2 now passes `module_id = <module.id>` on every `create_permission`. On re-run, a NULL or mismatched `module_id` triggers a corrective `update_permission`. The Conflict Resolution Reference gains a row covering the live-NULL drift case.

**Conventions: natural keys.** New subsection "Lookup conventions: prefer natural keys, never narrate numeric ids" right after Step 0. Three catalog tables carry stable unique natural keys (`modules.module_slug`, `permissions.permission_name`, `roles.slug`). The deployer now:
- always filters reads by natural key (`module_slug=eq.<slug>`, `permission_name=eq.<code>`, `slug=eq.<slug>_<tier>`);
- treats numeric ids as resolve-use-discard write-only artifacts (`role_permissions.permission_id`, `permission_hierarchy.including_permission_id`, `modules.manage_permission_id`, etc.);
- writes natural keys directly into text-FK columns (`modules.view_permission`, `entities.view_permission` / `.edit_permission`, `fields.reference_table`);
- renders every Stage 5 verification line by natural key (`product_roadmap:read`, `product_roadmap_viewer`, `product_roadmap → product_roadmap:manage`) — `id=N` only appears for an orphan FK whose target has no resolvable natural key.

Two Stage 2a-scaffold steps got concrete pattern guidance:
- Step 3 (hierarchy): the `permission_hierarchy` table only exposes numeric FKs, so resolve both ends from `permission_name` at the top of the pass and pass ids in the write payload; narration in chat / verification renders the natural-key form.
- Step 4 (default roles + `role_permissions`): same resolve-use-discard pattern for `role_permissions.permission_id` and `.role_id`. The `roles` table has no `label` column — guidance corrected (older drafts of this skill passed `label` and tripped a PostgREST schema-cache error).

**Stage 5 verification tightened.** Module scaffold integrity check #1 now explicitly says "dereference the FK and assert the natural key matches the expected value" — non-null FKs can still point at the wrong row. Each `manage_permission_id` / `admin_permission_id` / `default_*_role_id` is read back and its target's `permission_name` / `slug` asserted. This catches the `module_id IS NULL` defect class and any future class where a non-null FK exists but points at the wrong row.

No `EXPECTED_MAJOR` change.

---

## cross-entity JsonLogic primitives pass through transparently

2026-05-27. In lockstep with analyst minor `3.2`. No `EXPECTED_MAJOR` change; 3.x files continue to pass the version gate.

The platform now exposes three additional JsonLogic operators inside `validation_rules`, `computed_fields`, and `select_rule` bodies: `{"set_record": ["<name>", "<entity>", <id-expr>, <body>]}`, `{"let": ["<name>", <value-expr>, <body-expr>]}`, and `{"throw_error": "<message>"}`. The deployer already passes these arrays byte-for-byte to `create_entity` / `update_entity`, so the operators travel through the existing path with no parser change. Two adjustments to the deployer's static-analysis posture:

1. **Column-existence check is binding-aware.** The "column must exist on this entity" rule (applied to `select_rule`, `validation_rules`, `computed_fields` JsonLogic) skips column references qualified by a `set_record` or `let` binding name. The bound variable's columns are resolved against the *bound entity's* live shape (or, for built-ins, against the platform's known field list). An unbound column reference that fails to resolve is still a Blocker; a bound reference whose binding entity doesn't exist in the live catalog is a Blocker.

2. **Three new anti-pattern table rows.** (a) `set_record` referencing an entity that doesn't exist in the live catalog → 🛑 Reject; (b) top-level `throw_error` not guarded by an `if` → 🛑 Reject (unconditional throws belong in `edit_permission`, not `validation_rules`); (c) `set_record` inside `select_rule` → ⚠️ Perf warning surfaced in Stage 3 plan, deploy proceeds on user confirmation.

The 3.2 minor is forward-compatible: a 3.1 file parses unchanged against a 3.2 deployer, and a 3.2 file using the operators parses against a 3.1-aware deployer because the operators are syntactically valid JsonLogic the deployer doesn't introspect (the platform-side runtime is what gives them meaning). The two new anti-pattern rules and the column-check loosening fire only when 3.2 operators actually appear in the file.

---

## master modules, module scaffold, shared-entity promotion

2026-05-27. `EXPECTED_MAJOR` bumped from `2` to `3` in lockstep with the analyst skill.

Files written by analyst `3.0+` may carry two new authoring conventions on top of `2.x`: an optional `module_type: master` frontmatter directive (default `"domain"` when absent), and an optional per-entity `**Shared master cluster:** <name>` annotation in §3 alongside `**Edit permission:**` / `**Audit log:**`. Both are forward-compatible additions: pre-3.0 model files parse against a 3.0 deployer with both fields defaulted. However, a pre-3.0 deployer reading a 3.0 master-typed model would silently create a regular domain module instead of a master, producing the wrong shape rather than a missed optimization — the major bump is the honest signal that the two skills must move in lockstep.

**Module scaffold standardization.** Every module (domain or master) now carries a standard scaffold: three permissions (`<slug>:read`, `<slug>:manage`, optionally `<slug>:admin`), three default roles (`<slug>_viewer`, `<slug>_manager`, optionally `<slug>_admin`), and six module-record references (`view_permission` text + `manage_permission_id` / `admin_permission_id` FKs + three default-role-id FKs). Stage 2a-scaffold builds the scaffold idempotently on first deploy and re-deploys; the three-permission upgrade case adds the missing tier additively. Role records gain a `slug` column (snake_case, unique via Postgres index — acts as a natural-key second primary key) and an `origin` enum (`"system"` / `"model"` / `"model_master"` / `"user"`, strictly immutable after INSERT).

**Master module concept.** A new `module_type` enum on the `modules` table (`"domain"` or `"master"`, default `"domain"`) designates master modules — neutral hosts for shared / master data, consumed by multiple domain modules via cross-module `permission_hierarchy` rows tagged `origin = "model_master"`.

**Stage 2d Branch A and Branch B.** The collision gate gains two new branches:

- **Branch A (🟢 shared-master match):** when the incoming entity matches a live entity in a `module_type = "master"` module, the deploy auto-wires the consumer via a cross-module read inclusion (always) and a manage inclusion (per-consumer binary prompt). No collision widget.
- **Branch B (5th collision option):** the existing 4-option collision widget for domain-vs-domain collisions gains "Promote to shared master module" as the 5th option. Picking it moves the entity into a master host (newly created or selected from existing masters), wires up cross-module bridges, and seeds the master's manager role from the original module's manager members. Two follow-up prompts (host module + manage option 1–4) batch into the same `AskUserQuestion` call.

**Analyst-emitted cluster hints.** The optional `**Shared master cluster:** <name>` annotation (parsed in Stage 1) shapes Stage 2d follow-up 1 defaults — recommended existing-master selection or recommended new-module name. The hint is a soft suggestion; the user can always override at the prompt.

**Master models (`module_type: master` frontmatter).** A model file can declare itself a master, formalizing an ad-hoc runtime-promoted master into a properly-modeled domain cluster (more common) or declaring a new master upfront (rare). Stage 2a's master-model branch matches by exact slug first, then by entity overlap; renames the matched master if the user opts in (Stage 4b-rename cascade: ~7–10 writes, forward-recoverable); consolidates multiple sibling masters into a domain cluster (4c-merge-master) by moving entities and re-pointing consumer bridges, leaving source masters as quiet orphans.

**JSON-array merge with `source_module` tagging.** `computed_fields` and `validation_rules` on master entities are now merged across consuming models rather than wholesale-replaced. Natural key is `name` / `code` alone (global within the entity); `source_module` is reconciliation metadata. Conflict on same key from different sources triggers a 🛑 prompt (keep / replace / rename / abort). Domain entities keep wholesale-replacement semantics.

**Stage 4 sub-stages 4i and 4j (new).** 4i creates cross-module `permission_hierarchy` rows tagged `origin = "model_master"` (read inclusions always, manage inclusions per consumer's decision). 4j seeds `<master>_manager` from `<original>_manager` members at promotion time (one-shot, not a dynamic link).

**Stage 4b-rename (new).** Master-model rename cascade: `update_module` + per-tier `update_permission` (codes embed the slug) + per-tier `update_role` (slugs embed the slug). No transaction envelope; forward-recoverable on partial failure.

**Stage 4c-promote and 4c-merge-master (new).** Branch B promotion (entity → master via `update_entity` setting `module_id`) and Path-2 cleanup (entity moves + bridge re-points across multiple source masters).

**No auto-deletion of catalog records.** The deployer never deletes roles, permissions, `role_permissions`, `permission_hierarchy` rows, or modules, regardless of `origin`. Master-merge leaves source masters as quiet orphans. The deployer does not maintain an orphan registry, does not detect orphans, and does not report them. Symmetric across all catalog-record kinds, all origins, all stages.

**Stage 5 structured verification report.** Replaces the single-line success summary with a structured per-area report: modules, roles (grouped by `origin`), entities, permission hierarchy, merged JSON arrays, counters broken down by `origin`. No orphan section. The compact one-line summary is still emitted for log-parsers; the structured report sits above it.

**Two new gates.** Gate A (pre-write planned-state integrity) fires in Stage 3, verifies the planned end-state object graph is internally consistent before any writes. Gate B (steward seed non-empty) fires in Stage 4 right after 4j seeds the master manager role; if zero members, surfaces a 🟡 and requires explicit user confirmation.

**Origin field protection.** `roles.origin`, `permission_hierarchy.origin`, and system-generated `roles.slug` are audit-trail fields installed via platform validation rules (`origin_immutable_roles`, `origin_immutable_hierarchy`, `system_role_slug_immutable`) tagged `source_module: "platform"`. All three rules use the `value_changed` JsonLogic operator; INSERT-only, no transitions after INSERT regardless of value. The deployer never modifies `origin = "user"` records under any circumstance.

**Slug-collision policy.** When the scaffold pass would create a role with slug X and a role with that slug already exists with `origin = "user"`, the deploy surfaces a 🛑 via `AskUserQuestion` with two options: rename existing user role first (admin renames in UI), or abort. No silent-claim path, no origin flip.

**Stage numbering update.** Stage 4 sub-stages 4i and 4j are added after 4h. Stage 5/6 add the structured verification report and two gates. No existing stage numbers change.

---

## read-side sub-blocks (`Input type rules`, `Select rule`)

2026-05-27. Files written by analyst `2.2+` may carry two new optional §3 sub-blocks per entity: **`Input type rules`** (a JSON array of `{field, jsonlogic, description?}` entries that bind dynamic UI-mode overrides to specific fields — same shape as `Computed fields` / `Validation rules`) and **`Select rule`** (a single JsonLogic object that drives a `FOR SELECT` row-level security policy on the entity).

Both are platform features that already exist server-side; the analyst skill v2.2 made them addressable from the model file. The deployer applies them in **Stage 4f** ("Apply read-side rules") after fields exist, via `update_field` (per `Input type rules` entry) and `update_entity` (per `Select rule`). Missing headings mean no rule (both columns default to `{}` on the platform); the deployer never silently clears an existing live rule when the model omits a heading (same drift-handling rule as `computed_fields` / `validation_rules`).

Stage 4 sub-stages were renumbered in this release to remove the legacy `4d-bis` smell. The mapping is:

| Was | Now | Purpose |
|---|---|---|
| 4a | 4a | Module |
| 4b | 4b | Permissions and hierarchy |
| 4c | 4c | Entities |
| 4d | 4d | Fields |
| 4d-bis | **4e** | Apply write-side rules (computed_fields, validation_rules) |
| — | **4f** | (NEW) Apply read-side rules (select_rule, input_type_rule) |
| 4e | **4g** | Built-in extensions |
| 4f | **4h** | Cross-model link suggestions |

Defense-in-depth check: the Stage 1 parser walks every `Select rule` sub-block's `description` and the entity's §3 prose for bypass-shaped phrases (*"bypass"*, *"elevated"*, *"override"*, *"see every"*, *"unrestricted"*) and permission tokens (`<slug>:<suffix>`). For every permission token named in prose, the JsonLogic body must literally reference that token. For every bypass phrase, either the JsonLogic body must encode the bypass OR the model must carry a §7-resolved architectural-decision entry naming a documented broadening mechanism. A prose claim that doesn't reconcile with the JsonLogic body is a 🛑 High blocker — the deployer never deploys a rule the analyst's Stage 12.5 audit should have caught.

Major stays at `2`; v2.1 files contain neither sub-block and parse cleanly under v2.2 with no behavior change.

---

## mandatory `### Permissions summary` table

2026-05-27. Files written by analyst `2.0+` carry a mandatory `### Permissions summary` table under `## 2` (after the entity-summary table and the Mermaid diagram). This table is the canonical source for the module's permission catalog and its hierarchy rows. The deployer reads the table directly in Stage 2a (module + permissions setup) and creates every `create_permission` + `create_permission_hierarchy` call from it; the legacy parallel enumeration in §8 step 1 is gone in v2.0 files (§8 step 1 just points the deployer at the §2 table). v1.x files lack this table and are refused; route the user back to analyst Mode D Rebuild to materialize the v2 file from the v1 content.

Parse-time validation that previously checked §8 step 1 now checks the §2 table directly. See SKILL.md "Parse the Permissions summary table" for the column shape and the full validation list.

`EXPECTED_MAJOR` bumped from `1` to `2` in lockstep with the analyst skill.

---

## Earlier versions

Earlier deployer revisions tracked analyst v1.x updates (per-entity `Edit permission:` annotations, workflow-permission scan integration, conditional-permission `require_permission` cross-checks). These predate the dedicated CHANGELOG and live only in git history; consult the analyst's CHANGELOG for the corresponding contract-change descriptions.
