# use-semantius CHANGELOG

This file is history, not contract: it is **not** loaded into context at runtime. The body of `SKILL.md` is always the current contract. Newest entries first.

## A rule that reads a read-time label and an entity at the wrong write tier are refused

2026-11-14. Asked for by Martin Amm after a run that built a recruiting module. Three label columns were filled by a hand-written `concat` over `<fk>_label`, so they stored the separators and little else, and a `catalog` entity was created at `:manage` and repaired by hand afterward. Both are now refused before anything is sent.

- `call-file.ts` and `writeModel`: a `computed_fields` or `validation_rules` rule that reads `_label`, a name ending in `_id_label`, or the `<fk>_label` of one of the entity's own relationship fields (known to `writeModel` from `fields`) is refused. One message per rule names every such read. For a `computed_fields` rule it gives the `composedLabel` call to use, with the table and label column filled in when the model has them; for a `validation_rules` rule it points to `setRecord`. A stored `status_label` passes. `select_rule` and `input_type_rule` are not checked.
- `call-file.ts` and `writeModel`: an entity whose `edit_permission` is `<slug>:read`, `<slug>:manage` or `<slug>:admin` but not the tier of its `entity_type` (`catalog` at `:admin`, `operational_record` and `operational_workflow` at `:manage`) is refused, and the message names the permission to use. A `junction`, a `computed` entity, an item without `entity_type` and a `<slug>:write_<entity>` are not checked.
- `jsonlogic.md` ("`computed_fields` element shape" and the `composedLabel` example), `data-modeling.md` ("Choosing the label" and the `call-file.ts` list), `crud-tools.md` ("Composed labels"), `rbac.md` ("Choosing an entity's permissions") and `SKILL.md` (the `call-file.ts` row) say so.
- `scripts/call-file.test.ts` and `scripts/jsonlogic-kit.test.ts` cover both checks.
- `flows.md` has no row about these checks: a search of the whole file for `writeModel`, `call-file`, `computed`, `composedLabel`, `jsonlogic` and `edit_permission` found nothing, and no question, step, order or flow changed. The file format is unchanged; `version` stays `3.1`.

## Typeid only for a family or on request, and the key prefix is the singular

2026-11-14. Asked for by Martin Amm, who wanted `typeid` kept to `is_a` / `has_a` families and to what a human asks for, and the entity's singular as the prefix again. This replaces "every new entity takes `typeid`, except a junction and a based entity" and the 2 to 6 letter prefix of the entries of 2026-11-12. The label rule ("Choosing the label") is unchanged.

- `data-modeling.md` → "Choosing the key type": an entity's key is `auto_increment`. It takes `typeid` only in an `is_a` / `has_a` family (the base is `typeid`, a subtype `is_a`, an extension `has_a`) or when the user asked for it, in their own words. The key type is never asked. The section says that `id_type` is locked at creation, so an `auto_increment` entity that is asked to take `typeid` is rebuilt with its records, and that the user is told so before anything changes. The prefix is the entity's singular, leaving out any digit (`vendor_contract`); a prefix that is taken is a name clash, settled with the user.
- `call-file.ts` and `writeModel` refuse a prefix that is not the entity's singular (read from `singular`, else `singular_label`, else `table_name`) and one prefix on two entities of a payload; `call-file.ts` also refuses a prefix another entity on the host has. The messages for the last two say to settle it with the user. A `create_entity` without `id_type` passes.
- `module-rbac-setup.ts --slug` warns about a `typeid` or `is_a` prefix that is not the singular.
- `build-module.md` step 1 takes prefixes only for entities that take `typeid` or `is_a`, and step 2 settles a taken one again. `build-module.md` and `seed-data.md` say that the records of an `auto_increment` entity take the numbers 1, 2, 3, not only a junction's.
- `entity-families.md` examples use the singular prefixes (`business_partner`, `activity`, `email`). `review-module.md` row 90 leaves a `typeid` key outside a family as it is, and reports an entity the user asked to have `typeid` that holds `auto_increment` as needing a rebuild.
- `flows.md` rows 8.2 and 8.6 carry the change. Rows 8.1 to 8.10 and 9.1 to 9.6 were read again against the changed files, and a search of the whole file for key and prefix wording found only row 8.6. The file format is unchanged; `version` stays `3.1`.

## The limits are ten seed runs and five identical failures

2026-11-14. Asked for by Martin Amm: the import's check is cheap, so a few honest retries cost little, and the limits only have to block an endless loop. The two limits of the entries below were three runs and two failures.

- `seed-lib.ts`: `SEED_RUN_LIMIT` is 10. Ten runs of the seed command go on; the eleventh, with no finished report between, prints `SEED STOPPED` and exits 5. `seed-data.md` → "Run" and `SKILL.md` say so.
- `SKILL.md` → Golden Rule 13: the same problem on five runs in a row, with the input changed between them, ends the sequence; the sixth run is not made. `seed-data.md` and `build-module.md` no longer have a rule of their own for a problem that comes back after a fix: they point at Golden Rule 13.
- `flows.md` rows 8.9 and 8.10 carry the new numbers; rows 8.1 to 8.10 and 9.1 to 9.6 were read again against the changed files. The file format is unchanged; `version` stays `3.1`.
- `scripts/seed-lib.test.ts` takes the limit from `SEED_RUN_LIMIT`, so the next change of it is one line.

## A failure that comes back after a change ends the sequence

2026-11-14. Asked for by Martin Amm, who asked whether the retry limits added the day before were still in place. The only one in code, the halted-run counter of the seed script, went with that script (the entry below); nothing else counted retries, and the builder script (`writeModel`) had failed three times in the last recruiting build before it passed.

- `SKILL.md` → Golden Rule 13: when a step fails (a command, a builder script, `call-file.ts`, `module-rbac-setup.ts`) and, after the input was changed, fails again with the same problem, it runs no third time. The next response is a message to the user (a problem only the user can resolve, Golden Rule 12): the step, the problem it named and what was written before it. A different problem is not a repeat, and a call the host did not answer (exit `3`) is retried as `cli-usage.md` says and is not counted.
- `flows.md` row 8.10 says what the user sees. Rows 8.1 to 8.10 and 9.1 to 9.6 were read again against the changed files, and the sections of `SKILL.md` that `flows.md` names are all still there. The file format is unchanged; `version` stays `3.1`.

## The seed command stops itself after three runs without a finished report

2026-11-14. Asked for by Martin Amm, after the halted-run counter went with the seed script on 2026-11-13: since then `seed-data.md` carried one sentence ("a problem that comes back ends the seed"), which nothing enforced, and seed loops had happened several times (`seed-halts.json` was added after a build that looped on its seed, and a seed took seven runs instead of one).

- `seed-lib.ts`: `--emails`, the first step of every run of the seed command, counts the runs of a records file in `seed-runs.json`, beside the file. Three runs go on. The fourth, with no finished report between, prints `SEED STOPPED` and exits 5, which ends the command chain, and so does every later run until the user deletes `seed-runs.json`. A run whose file is not valid JSON counts too. `--report` ends the count when every record of the file is on the host; a report with records missing keeps it. A count that cannot be written never blocks a seed.
- `seed-data.md` → "Run" says so, and that every `--emails` run counts, also one sent alone. `build-module.md` → "Final response" and `flows.md` row 8.9 name a seed that stopped itself among the ways a seed ends before its report. The `seed-lib.ts` row of `SKILL.md` says so.
- `scripts/seed-lib.test.ts` covers the three runs and the refusal, a count per file, the command line (exit 5, nothing else checked), a file that is not valid JSON, the reset by a finished report, and a count that cannot be written. The old counter is in git (`844cefa`); it counted the halts of a script the agent wrote, which no longer exists.

`flows.md` row 8.9 is changed as above; no question or step changed. The file format is unchanged; `version` stays `3.1`.

## Reads that do not depend on each other share a round trip

2026-11-14. Asked for by Martin Amm, after a recruiting build spent about 10 of its 25 minutes in tool calls, nearly all of it in `module-rbac-setup.ts` (66 s to create the module, 193 s to write its access, 69 s to verify it) and `seed-lib.ts --describe` (24 s). Every `semantius` call costs about 5 s, whatever it reads, so what counts is the longest chain of calls that wait for one another. A write was already one array call per kind (Golden Rule 7); the reads were not all sent together.

- `module-rbac-setup.ts`: the module is read with the reads that need only its slug (permissions, roles, hierarchy, and with `--access` the other rollups of the instance); the entities and roles filtered by the module's id follow; the grants are read with the module's fields; the permissions and the roles the record names are read together; after the writes, the roles are read with the entities, hierarchy and module. Longest chain on the test module: 11 to 10 calls for a new module, 19 to 16 for the access write, 8 to 6 for the verification run.
- `seed-lib.ts --describe`: the tables are read together, a module read in progress is shared by two of its tables, and the tables they relate to and the users (the user who seeds and the user list) are read together. Longest chain: 5 to 4.
- The writes are unchanged: one call per kind, in order, none beside another. A hierarchy row or a grant changes what every user holds, and a saved rollup holds its tables, so writes beside one another were not tried against the platform.
- `scripts/module-rbac-setup.test.ts` and `scripts/seed-lib.test.ts` count the longest chain and check that no write starts while another call is in flight.

`flows.md` is unchanged: no question, step or order changed. The file format is unchanged; `version` stays `3.1`.

## rbac.md shows a second access record

2026-11-14. Asked for by Martin Amm, after a recruiting build wrote its access record in three tries. The record was refused for a gate with no verb, for states after a gate that were neither in `after` nor in `notAfter`, for an approval with no state before it, and for an entry on an entity with no lifecycle. Each refusal named its fix, and the agent read `access-rules.ts` to learn the shape of a record before it had them.

- `rbac.md` → "The access record": a second complete record, a purchase order that an employee prepares and a Buyer issues, after the first. The gate is not an approval, `after` and `notAfter` place every state after it, an entity with no `workflow_state` has no entry, and a state that does not name its step takes a `verb`.
- `scripts/access-rules.test.ts` reads the record from the file: it is valid, writes `spend:issue_purchase_order` and its sequence rule, is refused when `notAfter` is left out, and a state with no verb is refused until it has one.

`flows.md` is unchanged: no question, step or order changed. The file format is unchanged; `version` stays `3.1`.

## The Golden Rules come first in SKILL.md

2026-11-14. Asked for by Martin Amm, after a recruiting build read the first 200 of the 508 lines of `SKILL.md` and never reached the Golden Rules. It created five label-column fields that Golden Rule 3 forbids (`writeModel` refused them twice), sent a `filters` object that Golden Rule 1 shows as a string, and ended on a line of text that Golden Rule 12 forbids.

- `SKILL.md`: the Golden Rules stand before the reference table, within the first 90 lines, and a line after the introduction says to read the file to its last line before the first command. No rule changed; Golden Rule 6 says "below" where it said "above".
- `flows.md` names Golden Rule 5 and sections of `SKILL.md` by name: all still there, so it is unchanged. No question, step or order changed. The file format is unchanged; `version` stays `3.1`.

## A call-file.ts call that succeeds prints one line

2026-11-14. Asked for by Martin Amm, after a recruiting build sent a `create_field` for 40 fields and the CLI printed all 40 rows, about 5 KB each. The agent cut the output with `head -c 2000` and read the first four fields, so the end of the response, where a failure would be, was never read.

- `call-file.ts`: a call that exits 0 prints `create_field: 40 row(s) created (jobs.department, jobs.location, … +34 more)`, the rows' text keys (a table or a field id; never a number, which is read back from the host) and not the rows. A call that fails prints the CLI's output untouched, a response that is not a JSON array is printed as it is, and `--raw` prints the CLI's own output as before.
- `SKILL.md` (the `call-file.ts` row) says so. `semantius-importer` sends `create_entity` through `call-file.ts` and reads no row of the response.
- `scripts/call-file.test.ts` covers the line, the verbs, a number never listed, a response that is not an array, and `--raw` with `--check` in either order.

`flows.md` is unchanged: no question, step or order changed. The file format is unchanged; `version` stays `3.1`.

## A rollup's link_field is checked before anything is sent

2026-11-14. Asked for by Martin Amm, after a recruiting build's `call-file.ts --check` printed "valid for create_field" for a rollup the platform then refused with `90262`: `jobs.interviews_count` counted through `interviews.application_id`, which points at the applications, not at the jobs. The failed `create_field` cost 15 s, then a patch, a rebuild and a second check (12 s) and a second `create_field` (19 s).

- `call-file.ts` → `rollupRelationshipProblems`: a rollup's `link_field` must be a `reference` or `parent` field of the child that points at the rollup's own entity (a child that is the entity itself, a tree, passes). A field that points elsewhere is refused with where it points, the child's field that does point at the entity when there is one, and the two ways out (the rollup on the entity the field points at, or a field of the child that points at this one); a field of another format (`90262`) and a field that does not exist (`90264`) are named too. The message names the facts and the ways out and picks none: which one fits is the user's model.
- `call-file.ts --check` and a send take the relationship field from the payload, and from the host (`read_field`, `table_name,field_name,format,reference_table`) when the payload lacks it, as when a rollup is added to a module that exists. A host that cannot be read sends nothing. `writeModel` (`modelProblems`) checks the model's own entities and names no table of the host, which it cannot see.
- `data-modeling.md` ("Mandatory Creation Order": what `call-file.ts` and `writeModel` refuse), `rollup-fields.md` ("Creating one") and the `call-file.ts` row of `SKILL.md` say so.
- `scripts/call-file.test.ts` and `scripts/jsonlogic-kit.test.ts` cover the recruiting case, the case with a direct field, a tree, a field of another format, a field that does not exist, the host read and a host that cannot be read.

`flows.md` is unchanged: no question, step or order changed. The file format is unchanged; `version` stays `3.1`.

## The seed's report says that the final response comes next

2026-11-13. Asked for by Martin Amm, after a recruiting build stopped a second time. The seed had finished (`Report finished: 52 record(s) in 5 table(s)`), and the agent sent "All 52 demo records are live — final verification and handover." as a response of its own, with Golden Rule 12 in the skill it had read. Before the final response there is no tool call left to carry a line of text, so an announcement there always ends the turn, and a rule read at the start of the run did not stop it.

- `seed-lib.ts --report`: the last line of its output says what comes next. After a complete seed: this was the last step, and the next response is the final response itself. When records of the file are not on the host: run the seed command again.
- `SKILL.md` → Golden Rule 12: once the last tool call of a sequence has returned, the next response is the final response itself.
- `seed-data.md` → "Report" and `build-module.md` → "Verify, then stop" say that the report prints `Report finished` and then what comes next.
- `scripts/seed-lib.test.ts` covers both last lines.

`flows.md` is unchanged: no question, step or order changed. The file format is unchanged; `version` stays `3.1`.

## A sample-data file that is not valid JSON is refused with the place of the mistake

2026-11-13. Asked for by Martin Amm, after a recruiting seed stopped at its first step with `seed_recruiting.json cannot be read as JSON: JSON Parse error: Unable to parse JSON string`. The runtime's parser says that when something follows the end of the document, such as one closing bracket too many, and names no line in any version.

- `seed-lib.ts`: when the file does not parse, `jq empty` says where, and the message carries its line and column, that line and the one before it, and the usual causes. A document that is closed and goes on, which `jq` may accept as several values, is placed by the script itself. Without `jq` the parser's message stands, with where to get `jq`. Preflight check 2 already installs `jq` on every host.
- `seed-data.md` → "Run", step 1, and the `seed-lib.ts` row of `SKILL.md` say so.
- `scripts/seed-lib.test.ts` covers the three cases and `jq` itself.

`flows.md` is unchanged: no question, step or order changed. The file format is unchanged; `version` stays `3.1`.

## A response without a tool call ends the turn

2026-11-13. Asked for by Martin Amm, after a recruiting build stopped half done. The agent had created the entities and fields, sent "Schema done — now setting up hiring permissions and access." as a response of its own, and the host recorded the turn as completed: the access, the verification and the sample data waited until the user asked whether it was still working. The skill used this on purpose for the entity list ("one message with no tool call, which ends the turn") and had no rule for the rest of a build.

- `SKILL.md` → Golden Rule 12: a response without a tool call ends the turn, in every sequence of steps. It is sent only where the turn is meant to end (a question only the user can answer, a list the user must confirm, a problem only the user can resolve, the final response). Text beside a tool call does not end the turn, but the default is tool calls with no text; a milestone, an intention or an explanation is never a reason for text without a tool call.
- `build-module.md` → "Order of a build": from the first write of step 5 to the final response, every response carries the next tool call.

`flows.md` is unchanged: no question, step or order changed. The file format is unchanged; `version` stays `3.1`.

## Sample data is a records file that the CLI's import checks and writes

2026-11-13. Asked for by Martin Amm, after a recruiting build seeded nothing. Its seed script halted three times in the check pass and the third halt stopped it for good: an `assertStatesAgree` call stood after two writes, three such calls were missing, `assertSeedCounts` expected 8 interviews where the script's own loops made 6, and two interviews keyed on `_ref` sent the same values. None of these was a record the platform would refuse or a child on the wrong parent. The agent wrote a program in a protocol of about 15 functions and `seed-lib.ts` policed that program: of its 65 halts, 36 existed only because there was a script, and it had grown from 570 to 2,249 lines in six days, one check per failed build.

- `seed-data.md`, rewritten: the agent writes one records file, `.tmp_deploy/seed_<module_slug>.json`, in the format `utils/export_entities` writes. A record names itself `<prefix>_sr<n>`, and a relationship column holds the id of the record it means. One command checks the email addresses, checks the records (`utils/import_entities` with `check`), imports them and reports. A step that stops is fixed in the file and the command is run again; a problem that comes back after a fix ends the seed. The rules on records that read as records stay as writing rules and halt nothing.
- `seed-lib.ts`, reduced from 2,249 to about 500 lines and run from the skill folder: `--describe` (the file's skeleton, what a record of each table carries, the tables whose states must agree, the users a record may name), `--emails` (every address at a subdomain of example.com, before anything is written), `--report` (after the import: counts, each computed and rollup column, each parent state with its children's states; it reports and never blocks) and `--clear` (deletes the file's records, children first). The script functions, the check pass, `_ref` keys and the halted-run counter are gone.
- `build-module.md` → step 7, "Sample-data size", "Verify, then stop" and "Final response"; `SKILL.md` → the reference table, the made-up-records entry and Golden Rule 9; `cli-usage.md` → "Moving Entities and Modules Between Hosts" (the `check` parameter, sample ids, records of an `is_a` or `has_a` entity); one line each in `data-modeling.md` and `permission-names.ts`.
- `scripts/seed-lib.test.ts` covers the four commands and the example in `seed-data.md`; `tests/crud-tools-eval.ts` counts seed command runs, check listings, stopped imports and reports.
- The seed needs a CLI whose `import_entities` has `check`. That CLI also pads sample ids to TypeIDs, compares a date-time as an instant, writes records of an `is_a` or `has_a` entity with an insert and a PATCH, and imports a table that references itself whatever its key.

`flows.md` row 8.9 says what the close-out says about sample data that is incomplete. The file format of blueprints and specs is unchanged; `version` stays `3.1`.

## The entity list shows the entities; the final response shows the access as built

2026-11-13. Asked for by Martin Amm, after a recruiting build showed the access summary twice: written by hand in the entity list, then printed by `module-rbac-setup.ts` in the final response. The two differed. The list said Hiring Managers see everything, that an offer is approved from `draft`, and that Interview Scorecards have a lifecycle. The build limited Hiring Managers to the job openings that name them, as its own access record said. `writeModel` refused the draft approval, so the agent added a `submitted` state, and it refused states on scorecards, which had no `workflow_state`. The list also said scorecards open only from each Interview, while the agent's first relationship record already made them a `reference`. The list's details were unchecked prose, and the checks that decide them run only after the user confirms.

- `build-module.md` → "Confirm the entity list": the list shows each entity with its purpose and key relationships, and nothing about access or a relationship's format. "Show who takes each step" becomes "Work out who takes each step, without showing it": the test stays, and the answers still go in the access record (step 5.4). The lines about a gated entity's step, its named person and controls, a role that does part of the work, an entity reached only through a parent, and the access summary at the end of the list are gone.
- `build-module.md` → "Final response": the access summary stays, as the verification run prints it. The line naming a relationship format that differs from the list is gone; the `parent` / `reference` decision and its checks (step 5.6, `writeModel`, `call-file.ts`) are unchanged.
- `rbac.md` → "The access summary": a review's access section uses the same form; the entity list no longer does.
- `select-rule.md` → "Risk": a build's `select_rule` on a new entity needs no warning because the entity has no records yet and the final response shows who sees what.

## Every state after a gate is decided; a seed names every problem in one run and stops after three halted runs

2026-11-13. Asked for by Martin Amm, after a recruiting build looped on its seed. The offers' approval gate was written `"after": ["accepted", "declined", "expired"]`, without `sent`, which comes only after `approved`. So the stamp rules kept nothing on a sent offer, a recruiter could not send an approved one, and the module verification passed against the same record. The seed's check pass said to send the stamps as null, the agent did, the real pass landed every table and `assertStamped` halted, and the tables were cleared. Two halts on `assertStatesAgree` came before; nothing counted the runs, and each run named only its first problem. Earlier still, `create_entity` failed (`23503`) on `edit_permission = recruiting:write_interviews`, which the access run creates later, and the agent created the permission by hand.

- `access-rules.ts`: a gate's states that come after it in the `workflow_state` order are each in `after` or in the new `notAfter` (also reached without the gate), except an approval gate's own `rejected`. `planAccess` refuses a record that leaves one out and names it with the object to write, so `writeModel`, `call-file.ts` and `module-rbac-setup.ts --access` refuse it before anything is written. `notAfter` writes no rule.
- `rbac.md` → "The access record" (the `notAfter` key and the refusal) and "Restricted steps (gates)", step 5 (every later state is decided; the offer and purchase-order examples; the hire example gains `"notAfter": ["rejected"]`).
- `seed-lib.ts`:
  - The check pass records each problem in the plan's rows and goes on, then halts once with every problem, each with its script line and call. A call of the wrong shape, a failed read and stored rows that differ from the plan still halt at once. After a call with a problem, its rows stay in the pass and are never read from the host.
  - Halted runs of a seed script are counted in `.tmp_deploy/seed-halts.json`. The third, or a run that repeats a problem of the last, prints `SEED STOPPED` with every halted run's problems and the rows that stay, and exits 5, as does every later run until the log is deleted at the user's request. Rows already inserted stay. A finished seed forgets its halted runs; a script that only clears is not counted.
  - A stamp sent on a row the stamp rule does not keep gets two readings: a row before the step sends null, and a state reached only after the step means the gate's `after` leaves it out, fixed in `access.json` and `module-rbac-setup.ts --access`. `assertStamped` compares its `states` with the states the rule keeps in the check pass.
- `jsonlogic-kit.ts` (`writeModel`) and `call-file.ts`: a new entity is created with `<slug>:read` and `<slug>:manage` or `<slug>:admin`; `call-file.ts` reads every `view_permission` and `edit_permission` of a `create_entity` or `update_entity` with the rule names, and a missing one is refused with the same instruction. `rbac.md` → "Choosing an entity's permissions" and `build-module.md` step 5.7 say `module-rbac-setup.ts --access` creates `<slug>:write_<entity>` and switches the entity.
- `seed-data.md` → "Run", "The functions", "Approval stamps on rows past the step" and "Report", and `build-module.md` → "The sample-data question", "Sample-data size", "Verify, then stop" and "Final response": one run names every problem, the stop, and what the final response says about a stopped seed. The sample-data question names the exact total, without "about".
- `scripts/access-rules.test.ts`, `scripts/seed-lib.test.ts`, `scripts/jsonlogic-kit.test.ts` and `scripts/call-file.test.ts` cover them.

`flows.md` row 8.9 says what the close-out says about a stopped seed. The file format is unchanged; `version` stays `3.1`.

## Rollups over hidden rows are set without asking; the module is verified before the seed

2026-11-13. Asked for by Martin Amm, after a recruiting build ran `module-rbac-setup.ts --access` twice more than needed. One run stopped on `applications.interview_count`, a rollup over the interviews an interviewer is limited to: its warning asked whether to set `include_hidden_rows`, and the interviews `select_rule` waited. A last run after the seed repeated the report of the run before it.

- `access-rules.ts`: `planAccess` sets `include_hidden_rows: true` on every rollup over an entity whose `select_rule` it writes, and always plans that `select_rule`. A rollup's value is stored once per parent record, so it cannot total only the rows a reader sees; without the flag the platform refuses the `select_rule` (`90269`). The note that names these rollups says every reader of each one's entity sees its total.
- `call-file.ts`: a rollup over hidden rows without the flag is told to set it, without asking, and to name it in the final response.
- `module-rbac-setup.ts --access`: a run that wrote ends `Done. Run this once more: that run is the verification.`
- `rollup-fields.md` → "Hidden child rows", `rbac.md` → "Roles that do part of the work" and "Controls on a gate": the flag is set without asking and named. `data-modeling.md` → "High-Risk" and `review-module.md` no longer treat it as something to confirm.
- `build-module.md`: new step 5.9 verifies the module before any sample row; "Verify, then stop" says no `module-rbac-setup.ts` run follows the seed; "Final response" names each rollup that got the flag.
- `scripts/access-rules.test.ts` and `scripts/module-rbac-setup.test.ts` cover both.

`flows.md` row 8.9 says so. The file format is unchanged; `version` stays `3.1`.

## A seed names a parent keyed on `_ref` by that `_ref`; `edit-file.ts` refuses a change that changes nothing

2026-11-13. Asked for by Martin Amm, after a recruiting seed took seven runs instead of one. Its interviews and offers named their applications, which are keyed on `_ref`, by that `_ref` in `assertParents`, where the stored label was expected. The check pass never compares parents, so each table halted in a real pass of its own, and the halt hint said to change only the lines it named. A later run repeated the whole seed after an `edit-file.ts` change whose new text was its old text, which the tool reported as one changed line.

- `seed-lib.ts`: `idsByKey` on a table keyed on `_ref` keeps each row's stored label for the pass. `assertParents` and `assertJunction` take a parent's `_ref` where they take its label, and compare it with that stored label. The halt hint says to fix, in the same edit, every other call of the script that makes the same mistake, and to run the script again only once the cause is fixed.
- `seed-data.md` → "Run", "The functions" and "Parents and children": a child names its parent by its key in the plan, its label or its `_ref`, in its row and in `assertParents` alike; a junction's pairs do the same. `labelOf` is no longer described. The same two lines on fixing a halt as the hint.
- `edit-file.ts`: a block whose NEW part is the same as its OLD part changes nothing and exits 1. `cli-usage.md` → "Changing a file you wrote" says so.
- `scripts/seed-lib.test.ts` and `scripts/edit-file.test.ts` cover both.

`flows.md` has no row on a `use-semantius` seed and is unchanged. The file format is unchanged; `version` stays `3.1`.

## The access line becomes an access summary in markdown

2026-11-13. Asked for by Martin Amm, after an applicant-tracking build's final response gave its access as one paragraph: every role under its full name ("Applicant Tracking and Recruiting Hiring Manager"), "Gated steps:" followed by the lifecycles that have no gate, and "hires job openings" for a move into Filled.

- `access-rules.ts`: `accessSummary` (was `accessLine`) writes markdown: the access level in bold, with the module name every role name starts with; a Role | Does | Sees table, with a row for the viewer, the manager and the admin and one per role of the record, each step as "marks \<plural\> \<State\>" from the state's label, and Sees naming the records a role is limited to with those below them, what is hidden from it, and "all other records"; "Only an admin can change …"; a **Restricted steps** list, "\<Plural\> → \<State\>: \<roles\>.", with the named person ("When the job opening names a hiring manager, only that person or an admin."), an approval gate's controls and a payout gate's requester check; and **No restricted step** on each lifecycle with no gate.
- `module-rbac-setup.ts --access`: prints it between the lines `access summary:` and `end of access summary`.
- `rbac.md` → "The access summary" (was "The access line"): the form, in five parts, with the purchase request's summary as its example; `scripts/access-rules.test.ts` compares the example with the generator's output.
- `build-module.md` → "Confirm the entity list", point 9, and "Final response", and `review-module.md` → the access section: use that form. The final response pastes the lines between the two markers unchanged.
- `SKILL.md`, `data-modeling.md` and `select-rule.md`: name the access summary.
- `tests/crud-tools-eval.ts`: the check for a final text that says a lifecycle has no gate also counts "No restricted step".

`flows.md` rows 8.7, 8.9 and 9.2 say so. The file format is unchanged; `version` stays `3.1`.

## A build and a review close with only the module's UI link

2026-11-13. Asked for by Martin Amm, after an applicant-tracking build closed with a UI link to each of its five entity lists beside the module's link. Only the module's link was wanted, after a build and after applying a review.

- `build-module.md` → "Final response": the module's UI link (`{ui_baseurl}/{module_slug}`), and no link to an entity list or a record. "Building a module from a request" says a build returns the module's UI link.
- `review-module.md` → the close-out after applying: the module's UI link, with no link to an entity list or a record.
- `SKILL.md` → Quick Decision Guide (the build entry) and Golden Rule 9: a build's default is the module's UI link. Golden Rule 6 says a build's final response and a review's close-out give only the module's link.
- `data-modeling.md` → "Agent Workflow Tips", tip 9: says the same.

`flows.md` rows 8.9 and 9.6 say so. The file format is unchanged; `version` stays `3.1`.

## The entity list is confirmed in plain text; sample data is asked after it

2026-11-13. Asked for by Martin Amm, after the change "The entity list goes above the build-scope question, not inside it" made a recruiting build ask "Build all 6 listed above (…), or adjust the list?" in an `AskUserQuestion` dialog while the list, written in the same response as the dialog, never appeared: that host does not show the text of a response that calls a tool. A dialog cannot carry the list either, since a long question runs together into one paragraph. A message with no tool call, which ends the turn, is always shown, as `review-module.md` already relies on.

- `build-module.md` → "Confirm the entity list": the list, its step lines and its access line go in one message with no tool call, never with `AskUserQuestion` or a picker, on any host. The message closes with the choice in plain text. With more than 4 new entities: A, build all of them (recommended), and B, build only the core ones, named, each its own paragraph, then "Reply with a letter, or tell me what to add, drop or rename." With 4 or fewer: "Build the \<Module\> with these \<N\> entities? Reply yes, or tell me what to add, drop or rename." A reply that changes the list gets the changed list and its choice again.
- `build-module.md` → "Model it like the leading products", step 5, and "Order of a build", steps 1 and 3: the lines on what the module is based on open that message.
- `build-module.md` → "Order of a build", step 4, and "The sample-data question": the sample-data question is no longer paired with the entity list. It is asked on its own once the list is confirmed, in the run's question format, with the exact total and the tables of the confirmed scope, so it needs nothing shown before it. The consent rule on a scope answer given in the same call is gone.
- `preflight.md` → "Question format": with `AskUserQuestion`, every question is asked with it except a question a reference file says to ask as plain text, as this choice and the review's fixes are.

`flows.md` rows 8.1, 8.7 and 8.8, the section 8 entry in "Which flow a run uses", and the note on question formats say so. The file format is unchanged; `version` stays `3.1`.

## A field a computed_fields rule fills is disabled

2026-11-13. Asked for by Martin Amm, after a recruiting build left `applications.application_name`, filled by a `composedLabel` rule, `input_type: required`: the form asked for a value the rule replaced on save. The platform turns only a `default` or `readonly` field a rule fills into `disabled`, and `create_entity` makes the label field `required`.

- `jsonlogic-kit.ts` → `writeModel`: writes each field a `computed_fields` rule fills with `input_type: disabled` (a `hidden` one stays `hidden`), and `labels.json`, one `update_field` that sets each label column a rule fills to `disabled`, in the send order after `fields.json`.
- `data-modeling.md` → "Mandatory Creation Order": names both.

## An entity a role is limited to is never a parent child; relationship answers carry evidence

2026-11-13. Asked for by Martin Amm, after a recruiting build made `interviews.application_id` a `parent` with three yes answers, so Interviews had no menu entry and interviewers had no list of their own interviews, while the same build limited its Interviewer role to the interviews that name them. The 50 saved Haiku runs of the same build (task t4 in `tests/crud-tools-eval.ts`, paper builds), read from their payload files, did the same: interview → application `parent` in 45 of 48, application → job opening in 30 of 48, application → candidate in 20 of 46, offer → application in 31 of 47. Their `relationships.txt` answers said Q1 with cardinality, Q2 with "someone creates it for the parent", and Q3 with what deleting does or with the example's own words ("handled only inside its …"); none named a list. In 7 of the 16 runs that wrote both files, the access record limited the Interviewer to interviews (`limitedTo`) while interviews were a `parent` child.

- `access-rules.ts`: an entity in a role's `limitedTo` with a `parent` field is a problem of the record, so `writeModel` and `call-file.ts` refuse it before the first write. The role works those records in a list of their own across their parents, which question 3 rules out. A role that only writes a `parent` child (the requester's ticket comments) is not affected.
- `data-modeling.md` → "Choosing the Right Format", question 3: says so.
- `build-module.md` → step 5.6: each answer in `relationships.txt` gives the evidence its question asks for (the ways the child is saved; who creates it and who works the parent; each list across parents and whether people cite it by its own number, or `none`), and a single no makes the field a `reference`. The example is two lines, a `parent` (`order_lines.order_id`) and a `reference` whose first answer is yes (`issues.project_id`).
- `build-module.md` → "Confirm the entity list": a `parent` entity's line says it has no list of its own and who opens it from where, not only that it has no menu entry.
- `tests/crud-tools-eval.ts`: new task t5, a sales quotes build through the whole skill, as the control whose quote lines must stay `parent`; `summary` lists each skill run's relationship fields with their format and counts each format across the runs.

Measured on Haiku, 10 paper runs each, after the change: interview → application `parent` in 3 of 9 (the refusal fired in 3 runs, and each switched to `reference`; the 3 left had no `limitedTo` on interviews), application → candidate in 2 of 9, offer → application in 5 of 9, application → job opening in 6 of 9, unchanged. Only 1 of the 10 runs wrote `relationships.txt` (22 of 50 before), and it chose `parent` for application → job opening against its own "3 no". The t5 control kept quote line → quote `parent` in 10 of 10, before and after.

`flows.md` row 8.7 says so. The file format is unchanged; `version` stays `3.1`.

## The entity list goes above the build-scope question, not inside it

2026-11-13. Asked for by Martin Amm, after a recruiting build put its whole confirmation into the `AskUserQuestion` question text: the lines on what the module is based on, all five entity lines, the step lines and the access line, about 1,500 characters that ran together into one paragraph, with only a status line above the dialog. The question tool's own description asks for questions that stand on their own, and "show the list in the message" did not say where the list goes. Three Haiku 5.5 runs as subagents and three as headless Claude Code sessions with the question tool did not repeat it: all six put the list in the response text and asked a question of at most 109 characters.

- `build-module.md` → "Model it like the leading products", step 5: the lines on what the module is based on go in the response text before the first question, never inside a question.
- `build-module.md` → "Confirm the entity list": the list goes in the response text above the question and never inside it, one bullet per entity. The question is one sentence: the choice and the plural labels of the new entities, with nothing from the lines above it.

`flows.md` rows 8.1 and 8.7 say so. The file format is unchanged; `version` stays `3.1`.

## Gates and roles are written from the module's access record

2026-11-12. Asked for by Martin Amm, after a recruiting module came out with only its viewer, manager and admin roles: no gate on hiring, no Hiring Manager role, no Interviewer role. The 22 saved Haiku runs of the same build (task t4 in `tests/crud-tools-eval.ts`) showed why:
- No run wrote the entity list with who takes each step, and every later step read "the confirmed list", so no gate was due anywhere and verification passed. At least 12 runs modeled a `hired` or `approved` state, and at least 15 marked an entity `operational_workflow`.
- Of 5 runs that decided on a gate, 4 ended without the gate, its rule, `gated` or the role that takes it.
- `module-rbac-setup.ts` warned about an `operational_workflow` in an `advanced` module in 8 runs; all 8 went on, because the run still ended `Nothing created or changed.`.
- The final access line described the plan, not the build: 3 of 22 runs said a lifecycle had no gate.
- The viewer, manager and admin setup the script writes was complete in 15 of 15 live runs.

The decision is now data the build cannot skip, and a script writes everything else from it:
- **The access record** (`access.json`, `rbac.md` → "Restricted steps (gates)" → "The access record") answers who does what, the questions the leading products answer: who does the everyday work (`everyday`), every other kind of person who uses the module (`roles`: `seesOnlyNamed`; for a role that does part of the work `writes`, `limitedTo`, `hidden`, `leaves`), and, for each entity with a `workflow_state`, the person who moves a record into each state. A state another person moves records into is a gate for that person's role: the script applies rbac.md's test, so the record never asks "is this a gate?", the question the measured runs answered "no" by default. A gate's verb comes from its state (`hired` → `hire`) and an approval's waiting state from the enum, unless the record says them (`verb`, `after`, `waiting`, `namedPerson`, `filledLater`, `covers`); an entity can have a restricted `create`.
- **The record cannot leave a decision open.** A state where the role usually changes (`approved`, `signed`, `issued`, `released`, `posted`, `committed`, `hired`, `void`, `terminated`, `paid`, `reimbursed`, `disbursed`, `verified`) given to the everyday person needs a `because`. Every user field that names a person is a gate's named person, a role's `limitedTo` field, or an entry of `userFields` (with a `because` when it names someone other than the everyday person). A lifecycle named `status`, `state`, `stage` or `<singular>_status` / `_state` / `_stage` is refused: it is `workflow_state`. In the runs, the escapes were every state given to the manager, and lifecycles named `status`.
- **`writeModel(dir, { entities, fields, access })`** refuses a `workflow_state` the record does not cover, and every problem of the record, and writes `access.json`. `writeAccess(dir, access)` writes it for a module that has its entities. **`call-file.ts`** refuses a `workflow_state` field unless `access.json` beside its payload covers every state.
- **`module-rbac-setup.ts --slug <slug> --access <file>`** (new `access-rules.ts`) writes what is missing or different: gate permissions, bundles, hierarchy rows, roles and grants, `access_scope`, the fields the gates need, the gate, sequence and control rules, the computed stamps, the `select_rule`s of control 7 and of a role that does part of the work, `include_hidden_rows` on the rollups those affect, and each entity's class and `edit_permission`. A generated rule is recognized by its name; any other rule is kept. Run again, it is the verification. It prints the `access line:` the final response uses. Any `warning:` in such a run ends it `Not verified: …` with exit 4; a problem in the record is exit 2 with nothing written. It refuses a `raci` module and a module with per-entity permissions.
- `rbac.md`: the gate steps, "Roles that take gates" and "Roles that do part of the work" describe what the command writes. The complete rules are its output for their examples, with the generated names and messages (`approve_purchase_request_first`, `requester_own_ticket_comments`, `requester_leaves_ticket_fields`, the lock messages, the `purchase_request` binding). `scripts/access-rules.test.ts` compares them with the generator, read from the file.
- `build-module.md`: step 5.4 writes the access record and no gate by hand; new step 5.8 runs `--access`; with no answer the entity list is still shown; verification runs `--access`; the final access line is the verification's. `data-modeling.md` → "Mandatory Creation Order" gains step 9; `review-module.md` applies access findings through the record; `SKILL.md` names the new parts of the three scripts.

`flows.md` rows 8.7 and 8.9 say so. The file format is unchanged; `version` stays `3.1`.

## Key prefixes are short abbreviations of the singular

2026-11-12. Asked for by Martin Amm, after the Muse recruiting build gave each entity its whole singular as its key prefix (`job_opening_…`, `application_…`), where products such as Stripe use short abbreviations (`cus_…`).

- `data-modeling.md` → "Choosing the key type": a key prefix is 2 to 6 lowercase letters, taken in order from the entity's singular and starting with its first letter (`jo` for a job opening, `cand` for a candidate). An `is_a` entity's prefix follows the same rule. A prefix that is taken is replaced by another abbreviation, without a question.
- `call-file.ts` and `writeModel` refuse a prefix that breaks the rule, and one prefix on two entities of a payload, naming a prefix that fits. `call-file.ts` also checks the prefix of an `update_entity`, and its message for a prefix another entity has asks for another abbreviation.
- `build-module.md` step 1 chooses the prefixes, `is_a` entities included, and reads them; step 2 no longer asks about a taken one.
- `module-rbac-setup.ts --slug` shows each entity's key type and prefix on its `report entity` line, and warns about a prefix that breaks the rule: it is changed only on an entity the build created that has no records yet, and an `is_a` prefix never.
- `review-module.md` leaves a live entity's prefix as it is.

`flows.md` row 8.6 says so. The file format is unchanged; `version` stays `3.1`.

## call-file.ts refuses what the platform would refuse one call at a time

2026-11-12. Asked for by Martin Amm, after 3 Haiku builds of the recruiting request with sample data (`SEED=1` of task t4 in `tests/crud-tools-eval.ts`), run with the skill as it was:
- every build skipped the gate test (access `advanced`, no Hiring Manager gate, no Interviewer role), as the Muse build had;
- no seed called `assertStatesAgree`;
- every seed halted once on a person's email at `example.com` itself;
- one build sent a `create_field` payload a second time after filtering away the output of the first send (`23505`);
- one sent `required: true` past `call-file.ts` (`PGRST204`).

A later run took key prefixes another module already had (`23505`, `unique_current_id_prefix`).

`call-file.ts` now also refuses:
- a `create_field` row for a field that already exists on the host, with one `read_field`;
- a key `create_field` or `create_entity` does not take, with the key to write instead (`required` → `input_type: "required"`);
- a value outside a key's list (`width`, `format`, `input_type`, `id_type`, …);
- `ctype`, which is derived and never sent;
- `label_parent` on `create_entity` (90226);
- an `id_prefix` that does not fit the `id_type` (23514), and one another entity already has (23505), with one `read_entity`.

`writeModel` refuses the same keys and values. `scripts/crud-tools-drift.test.ts` checks the key lists against the live tool schemas.

`seed-lib.ts`:
- A seed that fills a parent and a child table that both carry `workflow_state` with no `assertStatesAgree` halts at the end of the check pass. The verification already asked its line for each such pair.
- An address at `example.com` itself is answered with a person's address to write (`ana.silva@globex.example.com`), and `seed-data.md` → "Rows that read as records" shows one.

The skipped gate test is the entry above, "Gates and roles are written from the module's access record". The file format is unchanged; `version` stays `3.1`.

## Seed and kit helpers check their own arguments, and a state check is held to the rows sent

2026-11-12. Asked for by Martin Amm, after the second Muse recruiting build:
- Its seed check pass halted 4 times in a row on `assertStatesAgree`, with 3 failed edits and a Python attempt in between.
  - The agent wrote `only: [[], ["completed"]]` (allowed combinations) where `only` takes child states as strings, and nothing refused the shape.
  - The message read `completed not allowed, only , completed`, as if `completed` were allowed.
  - Each try cost about 90 s, because the call came after the tables were read.
  - The edits failed on old text typed from memory.
- Its last edit widened the rules until they passed. The offers check was given a hand-made list that named 2 of the 5 offers. The run reported "16 parent(s) agree", while 3 offers contradicted their application.
- Its builder threw on `isSet(v("rejection_reason"))`, in a message that named `v`, not `isSet`.

`seed-lib.ts`:
- Every exported helper checks the shape of its arguments and halts with its signature and a right call.
- `assertStatesAgree` refuses a rule that is not a list of states and gives the rule to write instead (`write only: ["completed", "scheduled"]`). Its messages quote every state.
- `assertStatesAgree` and `assertItemized` halt when called after the pass's first write.
- Inside `runSeed`, `assertStatesAgree` is held to the rows. The first insert checks that both tables exist and carry `workflow_state`, and that the child relates to the parent. The child insert compares the rows actually sent, their parents and their states, with the plan and the rules. A check whose child table is never seeded halts at the end of the pass.
- A halt prints the failing call as the file holds it now. Its hint names the agent's own edit tool, with `edit-file.ts` when there is none. It says to copy the old text from those lines, never to use Python, and never to widen a rule until it passes.

`jsonlogic-kit.ts`:
- The helpers that take a field name check it and name their own call: `isSet(field, format): field is {"var":"rejection_reason"}, not a field name; the helper builds the v() itself`.
- `isSet` refuses a missing or unknown format, which used to compare with `""` and pass an empty date. It also refuses a boolean.
- `data-modeling.md` → "Mandatory Creation Order" lists every function of the kit with its parameters, because `SKILL.md` says not to read the kit. A test fails when an export is missing from that table.

`seed-data.md` → "Run", "The functions" and "Rows that read as records" describe the above, and the jsonlogic-kit row of `SKILL.md` points to the table. The file format is unchanged; `version` stays `3.1`.

## The label field gets its title from create_entity

2026-11-12. Asked for by Martin Amm, once CR 2 (`C:\dev\semantius\plans\CR-2-label-field-title.md`) shipped. `create_entity` now titles the label field, so a build no longer renames it with one `update_field` per entity. That step cost the Muse recruiting build a probe and left three label fields titled "Name". `bun tests/platform-probes.ts cr2` confirmed the behavior on `tests`:

- a given `label_column_label` is the title, and the two stay in step both ways;
- without it, the title is the label column in words with the entity's singular left out where the column starts with it (`product_name` on `products` is "Name", `job_opening_title` is "Title");
- a column ending in `_number`, `_no`, `_id` or `_code` keeps the entity's word;
- an `is_a` entity keeps its base's title on create, and an update to another one is refused with `90242`.

The skill follows the platform's default, which replaces its own rule that a title repeats the label column in words ("Enrollment Name").

- `data-modeling.md`: "Customizing the label field's title" describes the default and `label_column_label`. Step 6 passes `label_column_label` only when another title fits better, and step 7 loses the rename. "Key Entity Fields" gains a `label_column_label` row. The `singular_label` row says a blank one is derived from `singular`. The auto-generated fields table and "Choosing the label" follow.
- `build-module.md` step 7 loses "label titles".
- `review-module.md` checks the title against the default, and titles a composed `<singular>_name` "Name".
- `crud-tools.md` lists `label_column_label` for `create_entity`.
- The `call-file.ts` message for a label field re-sent in `create_field` points to `label_column_label`.

The file format is unchanged; `version` stays `3.1`.

## call-file.ts and writeModel refuse a field create_entity already made

2026-11-12. Asked for by Martin Amm. In the Haiku runs of task t4 (`tests/crud-tools-eval.ts`), 4 of 7 runs sent the label column again in their `create_field` call, mostly with the title the skill asks for and sometimes with `input_type: required`. `create_entity` had already made that field, so the whole call failed with `23505` and nothing in it landed. Golden Rule 3 already forbids this.

- `call-file.ts` now refuses a `create_field` row for a field `create_entity` already made: `id`, `created_at`, `updated_at`, and the entity's label column, read from the host in the same read as the rollup check. The message says to use `update_field` for its title or description.
- `writeModel` refuses the same, reading the label column from the entity payload.
- `data-modeling.md` → "Mandatory Creation Order" step 7, the `call-file.ts` paragraph, Golden Rule 3 and the `call-file.ts` row in `SKILL.md` say so.

The file format is unchanged; `version` stays `3.1`.

## One check run names every problem, one builder writes the model, one run verifies it, and one call asks both questions

2026-11-12. Asked for by Martin Amm, after a Muse recruiting build on `tests` lost about ten minutes. Its `create_field` call failed three times in a row, on a required reference with `clear` (`90257`), a rollup over hidden rows (`90269`) and `90265`. Its state rules were added with one `update_entity` per entity after the entities existed. It re-read the module's setup with four separate reads after the verify run. And it asked the entity-list and sample-data questions in two turns. Three Haiku paper builds on the text before this change (`tests/crud-tools-eval.ts`, task t4, `PAPER=1`) left two required references with `clear` and eleven enum icons that are not Lucide icons (`check-circle-2`, `x-circle`, `edit-2`) in payloads that `call-file.ts --check` passed.

- **`call-file.ts`** checks more before it sends, and names every problem in one run instead of stopping at the first. It refuses a required `reference` with `reference_delete_mode: clear`, a rollup without `include_hidden_rows` over a child that has a `select_rule` or another `view_permission` (read from the host), and an `icon_name` or enum `icon` that is not in `lucide-icon-tags.json`. A build therefore no longer runs `lucide-icon-checker.ts` (`build-module.md` step 5.5, `data-modeling.md` → "Icons are Lucide icons"); the checker stays for icons no script checks.
- **`jsonlogic-kit.ts`** gains `modelProblems` and `writeModel`. One builder holds the entities and their fields, and `writeModel` writes `entities.json` (one file per level for a family) and `fields.json` (rollups last) only when the model has no problem. It refuses a field its `input_type_rule` makes required in some states with no validation rule that reads it, `readonly` on a field no computed rule fills, a computed field that fills nothing, and the checks of `call-file.ts`. The rules of the pass in step 5.4 therefore land in `create_entity`, never in a later `update_entity` (`data-modeling.md` → "Mandatory Creation Order", `build-module.md` step 5.7).
- **`module-rbac-setup.ts`** sends its independent reads together. With `--slug` on a module that has entities, it prints `report` lines: the module's `access_scope`, then one per entity (class, permissions, rule and computed-field names, `select_rule`), per `<slug>:*` hierarchy row and per role with its grants. That run is a build's whole verification read (`build-module.md` → "Verify, then stop", Golden Rule 9).
- **With `AskUserQuestion`**, the entity-list question and the sample-data question go in one call, and the sample-data option names the total for each scope offered. An answer that adjusts the list makes the sample-data answer void, and it is asked again on its own. The chat formats keep one question at a time (`build-module.md` → "Order of a build", "Confirm the entity list", "The sample-data question"; `flows.md` rows 8.7 and 8.8 and the overview row follow).
- **`tests/crud-tools-eval.ts`** gains task t4 (the whole skill on the recruiting request, live or paper) and a `clean` mode, and `tests/platform-probes.ts` probes platform change requests.

The file format is unchanged; `version` stays `3.1`.

## A rollup's filter may read fields created earlier in the same call

2026-11-12. Asked for by Martin Amm. A Muse recruiting build on `tests` sent every field in one `create_field` call with the rollups last, as the skill says, and the platform refused a rollup whose filter read `job_applications.workflow_state`, created earlier in that call (`90265`). The platform now compiles a rollup filter against the fields created earlier in the same call (CR 1 in `C:\dev\semantius\plans`). `bun tests/platform-probes.ts cr1` confirmed it on `tests`. The probe also confirmed that `90265` still refuses a filter on a field that exists nowhere, a field later in the array, and a json column, and that a refused call creates nothing.

`rollup-fields.md` → "Creating one" names the fields a filter reads beside `link_field` and `value_field`, and gives the code for each: `90264` for a rollup ahead of its `link_field` or `value_field`, `90265` for one ahead of a field its filter reads. The order of a build does not change: `data-modeling.md` and `crud-tools.md` already put rollups last, after the fields they read.

## The key type and the label are two rules, and no label copies an id

2026-11-12. Asked for by Martin Amm, after a Muse recruiting build on `tests` showed two defects. Each job application's name repeated its id, and so did every interview's and offer's `job_application_id_label`. Job openings got an `auto_increment` key although their ids are seen outside the platform. The agent had followed "A record people do not name" exactly. That rule decided the key and the label in one test, only for records without a name of their own: a named record never got a key-type decision, and a record its related records name got a copy of its id.

Two Haiku paper builds on that text reproduced both defects; both runs said no rule decides the key of a named record. A third, on the text before it, composed the application label from its candidate and job opening, but chose the keys by judgment.

`data-modeling.md` now has two sections:
- **"Choosing the key type":** every new entity takes `typeid`, with its singular as `id_prefix`, except a junction (`auto_increment`) and an `is_a` / `has_a` entity. `build-module.md` step 1 reads the prefixes of all of them.
- **"Choosing the label":** a record's own name, title or number, or else `<singular>_name` composed by a `computed_fields` rule from the related records' label columns ("Ana Silva – Calculus I"). The first round of Haiku paper builds on the new text gave interviews and offers made-up names typed into a form, so the first case asks for a name people already call the record by. It keeps the stored label on an update where a related record reads as `null`, and the entity takes no `label_parent` to a record the rule names. A label never copies the id.

A live check on `tests` found that `set_record` binds stored columns only, so `_label` and `<fk>_label` read as `null` in its body; `jsonlogic.md` says so. The same check ran the composed rule: an insert gave "Marta Keller – Senior Backend Engineer", and an update with an unreadable candidate kept the stored label.

Other changes:
- `jsonlogic-kit.ts` gains `composedLabel`, tested against a new example in `jsonlogic.md` Pattern 3, whose order line label is now `order_line_name`.
- `review-module.md` checks the key type in its own row. A label that copies the id is fixed by replacing its rule, with no rebuild.
- `seed-data.md` uses a composed label as its example of a computed parent label.
- `flows.md` row 8.6 follows.

The file format is unchanged; `version` stays `3.1`.

## A write permission includes read, and the close-out names the roles to assign

2026-11-12. Asked for by Martin Amm, after a Haiku paper build of a recruiting module had to guess both. In the module-wide shape, each `<slug>:write_<entity>` of a role that does part of the work now includes `<slug>:read`, as `write_<entity>` includes `read_<entity>` in the per-entity shape: a write without read is unusable under row-level security. The change is in `rbac.md` → "Roles that do part of the work", step 2, in `build-module.md` steps 5.4 and "Verify, then stop", and in `review-module.md` row 72. A build's final response now lists, by `role_name`, the module's roles that take gates or do part of the work, for the user to assign to people (`flows.md` row 8.9). The file format is unchanged; `version` stays `3.1`.

## A record people do not name gets a typeid key and its id as its label

2026-11-12. Asked for by Martin Amm, after a Muse recruiting build on `tests` created `applications`, `interviews` and `offers` with no label column. The platform then added a required `label` field that nobody could fill. The agent keyed its seed on invented codes and added three fields to the live schema to make them work.

`data-modeling.md` → "A record people do not name" now decides such an entity: people tell its records apart by a number the system gives them, or by the records it relates. It gets:
- `id_type: typeid`, with `id_prefix` set to its singular;
- `label_column: <singular>_number`, set in `create_entity`, its title renamed from "Name" to "<Singular> Number" once the fields exist;
- a `computed_fields` rule `{"var": "id"}` that copies the id into the label.

The prefixes are read before the first write; a taken prefix is settled with the user like a name clash (`flows.md` row 8.6). The platform titles every label field "Name", so every build now renames each new label field's title to match its label column (`offer_number` → "Offer Number", `product_name` → "Product Name"), with `update_field` once the fields exist (`data-modeling.md` → "Customizing the label field's title", creation order step 7). A record that carries a name, a title or a number people type or receive keeps that text as its label. `review-module.md` row 90 checks it, and an entity without it needs a rebuild.

A live check on `tests` first found that a rule could not see a database-assigned typeid at insert. After the platform fix, the same check copied the id into the label, a child's `<fk>_label` showed it, and an update kept it. The file format is unchanged; `version` stays `3.1`.

## Payloads with rules are built in Bun, and call-file.ts checks them before sending

2026-11-12. Asked for by Martin Amm, after the same build spent 12 tool calls on one entity payload. The agent typed its nested JsonLogic on one line, and `call-file.ts` reported only `JSON Parse error: Expected ']'`. The agent then reached for Python, which the skills forbid.

New and changed tools:
- `jsonlogic-kit.ts` builds every rule from small functions. A builder script names each part of a rule and writes the payload file with `writePayload`, which refuses a repeated rule code or name (`data-modeling.md` → "Mandatory Creation Order"). Its tests rebuild rules from `rbac.md`'s own JSON blocks.
- `call-file.ts` now does these checks before it sends:
  - it names the line and column of invalid JSON, with a caret and the bracket still open;
  - it refuses a variable a shell emptied (`""`, `".workflow_state"`);
  - it refuses a `has_permission` / `require_permission` name that is not a permission on the host;
  - `--check` validates without sending.
- `edit-file.ts` changes a file by exact replacement, for a harness with no file-edit tool.
- `permission-names.ts` holds the permission-name helpers that `module-rbac-setup.ts` and `call-file.ts` share.

`cli-usage.md` → "Ad-hoc JSON and file work in Bun" now states the Python rule once, with its reason and a Bun tool for each need. It also covers writing a file with no write tool (a quoted heredoc, then run what was written). `jsonlogic.md` → "Testing a rule" sends its case from a file. The file format is unchanged; `version` stays `3.1`.

## One seed command checks every row before anything is sent

2026-11-12. Asked for by Martin Amm, after the same build spent about 28 of its 42 minutes on 10 seed-script runs and 5 halts:
- an invented key column;
- a required label left out;
- a key emptied by a patch;
- approval stamps found missing only after every table had landed, which cost a clear and a re-seed;
- a real run chained after a failed check.

`seed-lib.ts` changes:
- **One command, two passes.** It runs the script as a check pass and then, only when that passed, as the real pass. `--check` stops after the check pass. Every `rng` stream restarts each pass. The real pass halts when its keys or row counts differ from the check pass; other values are not compared. A check pass hides the rows its `clearSeeded` would delete.
- **Metadata once.** It reads the tables' descriptions once per module.
- **Checks before any write.** Every row is checked:
  - columns are fields;
  - no platform-written column is sent;
  - required fields have a value, including ones an `input_type_rule` requires;
  - enum values are values, with a hint for a label or a near spelling;
  - `null` only where allowed;
  - the stamps of rows past an approval are present;
  - the approver is not the user running the seed;
  - that user is the module's admin and can read every row back.
- **Keys.** A table is keyed on its label column, or on `_ref`, a planned name that is never sent, matched on the values the rows send. Junctions converge on a re-run.
- **Drift and halts.** `seedEnsureMany` reads the whole table (up to 999 rows). A stored row that differs from its planned row, or that matches no planned row because a key or a value changed in the script, halts. Numbers are compared rounded to their field's precision, a junction is keyed on `_ref`, and a stamp sent on a row before its step is refused. A halt names the script line: the line that threw, or the last helper called.
- **New helpers.**
  - `--describe <tables>` prints what each table takes.
  - `at(days, "HH:MM")` builds date-times.
  - `readRows(path)` reads an existing entity such as `users`.
  - `seedUser()` gives the user running the seed.

A Haiku paper build of the same request then passed: its payloads were valid, every permission name resolved, and its seed script's check pass was clean against metadata built from those payloads. It used no Python and typed no rule by hand. Its two stumbles, a missing read helper and no way to get the seed user, gave `readRows` and `seedUser`.

`seed-data.md` describes the one-command run and drops the advice to key on a code. The file format is unchanged; `version` stays `3.1`.

## Mid-market leaders by default, and every record they agree on is outlined or named

2026-11-11. Asked for by Martin Amm, after a recruiting build outlined five entities and left out the interview feedback record that Greenhouse, Lever and Workable each keep. `build-module.md` → "Model it like the leading products", step 1, now picks the leading products from the market segment the request names (a company size, or a segment such as enterprise or small business) and, when it names none, from the mid-market: products that companies of about 100 to 1,000 people buy and set up without an implementation partner. A product the user names to mirror is always one of them. Its examples are now one domain, a CRM: Salesforce, HubSpot. Step 2 now finds what the products agree on by working out each product's own list of records under its own names and matching the lists. A record two or more of them keep is an entity of the outline, or a next step in the final response with its reason when the user's goal does not need it. `flows.md` rows 8.1 and 8.9 follow. The file format is unchanged; `version` stays `3.1`.

## Three questions decide `parent` or `reference`: who creates the child, and whether it has a life of its own

2026-11-11. Asked for by Martin Amm, after a build on the `tests` instance with the two-question text made `interviews.application_id` and `offers.application_id` `parent` with `cascade`; the build ran in Muse with the Ember model. The two questions had dropped two concepts of the earlier tests: who creates the child, and whether it runs through states of its own. `data-modeling.md` → "Choosing the Right Format" now has three questions, and all three must hold for a `parent`. First, the child never exists without its parent and never has to outlive it. Second, the people working on the parent create it as part of that work, named from how the leading products split the work. Third, nobody, whether they write it or read it, needs to reach it without opening the parent, and it has no life of its own: its states only move the parent forward. `build-module.md` step 5.6 records an answer to each, and `review-module.md` row 117 and `flows.md` row 8.7 follow. Three Haiku and two Sonnet paper builds of a recruiting request all made offers `reference` with `restrict`, and made interviews the same in every run that had them. Scorecards stayed the close case, `parent` in two Haiku runs and `reference` in both Sonnet runs, always with `restrict`. The file format is unchanged; `version` stays `3.1`.

## Two questions decide `parent` or `reference`, and who writes the records decides the class

2026-11-11. Asked for by Martin Amm, after an agent reported choosing relationship formats from a record's shape and the same was seen with Claude Haiku. Three Haiku role-play builds of a recruiting module on the old text got the same three relationship fields wrong every time, and the only `parent` they chose was the one child the text named. On the final text, every relationship field but one came out the same in every run and matched the text. The exception was scorecards, a case the two questions leave close. While `rbac.md` used an interviewer's scorecards as its worked example, three runs made them `parent`. With that example replaced, two runs of three made them `reference`. `data-modeling.md` → "Choosing the Right Format" states what the format does in the app, then two questions: the child never exists without its parent, and nobody, whether they write it or read it, needs to reach it without opening the parent first. They replace the four tests, their exceptions, the rulings on named entities, the marketing example and the delete-mode table. The delete mode is one concept: `cascade` only when the children have no value of their own and everyone who may delete the parent may delete them; `restrict` on every other `parent`, every required `reference` and every record kept for audit or by law; `clear` only on an optional `reference`. The one example left is an order line, a `parent` of its order and a `reference` to its product. An entity that stores an n:m relationship and has fields or states of its own no longer takes `parent` fields by rule: the two questions decide. "Classifying an entity" decides the class by who writes the records. A `junction` holds only its relationship fields, and an n:m entity with fields of its own is classified like any other entity, so it can be a `catalog`. The words "leg" and "association class" are gone, and `scripts/terminology.test.ts` fails on "leg" in use-semantius. Lists of field and entity names became concepts: enum colors for an enum whose values are states or levels, `number` for any amount of money, a text format by whether the value is prose, and the title of `workflow_state` by the domain's word. Contradictions are fixed. A class can be changed with `update_entity`, and a field can move among the text formats with `update_field`; both were checked on the `tests` instance with a scratch module that was removed afterward. The `rejection_reason` example follows the "hidden otherwise" table, two examples follow the file's own rules, and the runtime lookups filter by `table_name` and `field_name` (`entity=` fails with `42703`). `data-modeling.md` no longer refers to the spec deploy, its stages or blueprint sections. `build-module.md` reads "Choosing the Right Format" at step 3, and step 5.6 writes `.tmp_deploy/relationships.txt` with each relationship field's format, delete mode, answers and label sentence. `review-module.md`, `rbac.md` and `flows.md` rows 8.7 and 8.9 follow. `rbac.md` → "Roles that do part of the work" now works through a service-desk requester, in place of an interviewer's scorecards. The requester files tickets, comments on them, and never sees internal notes, a case whose formats nobody disputes. `build-module.md`'s sample entity line follows. The file format is unchanged; `version` stays `3.1`.

## One question path per invocation

2026-11-11. Asked for by Martin Amm, after a run that had `AskUserQuestion` asked a build question as lettered chat text and recorded the answer in the Muse format. A role-play check with Claude Haiku did not reproduce the miss; the change removes the ambiguity in the wording. `preflight.md` has one "Question format" step in place of two, which picks one way of asking for the whole invocation, with exactly one case applying. With `AskUserQuestion` (in the tool list, or a deferred tool loaded first), every question uses it and neither `muse-questions.md` nor `dot-questions.md` is read. Muse chat without it reads `muse-questions.md`, and dot and similarly limited tools without it read `dot-questions.md`. Both files open by saying they apply only when `AskUserQuestion` is missing and are ignored when it is there, and `muse-questions.md` overrides other instructions only where it applies. The `SKILL.md` reference table says the two files are never read when `AskUserQuestion` is available. `flows.md` is unchanged. The file format is unchanged; `version` stays `3.1`.

## Seeds key on what they send, states agree across tables, and permission names are checked

2026-11-10. Asked for by Martin Amm, after feedback from a Recruiting build, checked on the `tests` instance with two scratch modules that were removed afterward, then reviewed and tested against Claude Haiku. `seed-lib.ts`: `seedEnsureMany` refuses, before its first read and on a check run too, a `keyField` the platform writes (a `computed` or `rollup` column, or a column a `computed_fields` rule fills, which for a composed label keeps `ctype` `label`), because no stored row would match the plan and a re-run would insert every row again. `idsByKey` also reads each parent's stored `_label`, and its `labelOf(key)` gives `assertParents` the label of a parent whose label a rule composes. The new `assertStatesAgree` checks the plan before the first write, so a parent's state and its children's states agree (a hired application has an accepted offer); it refuses empty rules. The new `assertStamped` reads back the rows seeded past an approval and halts on an empty stamp. `assertComputedVary` leaves out, with a printed line, a `$user_id`, `$now` or `$today` stamp whose one value is this run's user, time or date and whose rule does not read its own field. The halt messages say to edit the script in place and never retype it. `seed-data.md` reads `computed_fields` before writing, says which column can be a key and when a re-run converges, starts the plan from where each chain of records stands, and sends an approval stamp on a row seeded at or past its step, with the record's named approver or a user other than the seeding user; the seed user must hold `<slug>:admin`, and when it does not, or is the only user, no row is seeded past an approval, and the final response says why. `rbac.md` → "Controls on a gate", control 5, and the purchase request's complete rules: each approval stamp first keeps what an insert into the gated state or a later one sends, since such a record never makes the move the stamp waits for, and every other write ignores a sent value. Step 5 shows which states come after an offer's approval, and control 7 says managers need no see-everything clause and that it is never `<slug>:manage`. `select-rule.md` warns about a new `select_rule` only on an entity that already has records. `jsonlogic.md` says so in "A stamp on a record created past its step", and that the recalculation after a `computed_fields` save runs the rule a second time on its own result, so a rule that tests its own field returns that field and never `$old.<field>`. `jsonlogic.md` and `data-modeling.md` say a sent value is kept only by a rule that returns the field itself, and `review-module.md` accepts a stamp set when the state changes and flags a rule that returns `$old.<field>` after testing its own field. The platform saves a `select_rule` or validation rule that names a permission that does not exist, and the check is then false for every caller, admins included; inside a `!` it is true for everyone, so a narrowed role sees every record. `build-module.md` step 5.7, `rbac.md` and `select-rule.md` read every name in one `read_permission` before the rules are written (`<slug>:manager` and `<slug>:viewer` are never permissions), and `module-rbac-setup.ts` prints a `warning:` line, with the nearest permission of the module, for each such name in a `validation_rules` or `select_rule`. `cli-usage.md` gives the Bun forms for ad-hoc JSON and file work. One `create_field` call takes the fields of every entity, with rollups last in the array, after the fields they read (`data-modeling.md` step 7, `rollup-fields.md`, `crud-tools.md`). `build-module.md` checks the new lines, and `flows.md` row 8.9 follows. The file format is unchanged; `version` stays `3.1`.

## A role can do part of a module's work without writing all of it

2026-11-10. Asked for by Martin Amm, after a Recruiting build left its interviewer unable to write a scorecard without `recruiting:manage`, which writes every entity, while the only other way, a narrow tier, existed only in the per-entity shape no build uses. `rbac.md` gains "Roles that do part of the work", beside "Roles that take gates", for a role that does not do the module's everyday work, such as a service desk requester, a field technician, an employee filing expenses or an interviewer. Its bundle includes `<slug>:read` and never `<slug>:manage`. Each entity it writes takes `edit_permission = <slug>:write_<entity>`, which `<slug>:manage` includes. Where the leading products limit it, its holders see only the records a user field names them in (the requester, or the person assigned) and the records below those, through a `select_rule` shaped like control 7 of "Controls on a gate". An entity the products hide from it is hidden by a `select_rule`. A write rule keeps its writes to the records that name its holders, because the platform checks a new row only against `edit_permission`, and a field rule keeps the fields the products leave to the everyday workers. The records above the named one stay visible, because `set_record` reads one row by id, and the access line says so. The section gives complete rules for an interviewer and a requester's field rule. The narrow tier in the bundle tables becomes this role; such a role can also take a gate. `build-module.md` names these roles in the entity list and the access line, creates them in step 5.4 with the gates, and checks them in the verification. "A record only some roles may create" is a gate only among the roles that do the everyday work. `review-module.md` checks each such role and puts a user field naming a person the products limit, with no such role, under To confirm. `rollup-fields.md` and `data-modeling.md` name the section. `flows.md` rows 8.7, 8.9 and 9.2 follow. The file format is unchanged; `version` stays `3.1`.

## A `parent` is only a child that never exists without its parent

2026-11-10. Asked for by Martin Amm, after a Recruiting build made far more entities `parent` children than is reasonable. In the app a `parent` child has no menu entry and is listed only on its parent's page, while a `reference` has its own menu entry and is not listed on the record it refers to; `data-modeling.md` → "Choosing the Right Format" now says so first. The two tests become four, taken in order. The existence test: the child never exists without its parent, in a draft, an import row or an integration message. The order test: the parent exists before the child on every path; delay does not count, and a child saved before its parent is known is a `reference`. The creation test compares roles, never permission names: the sentence that made a child with a different `edit_permission` a `reference` is removed, because in a module built with `module-rbac-setup.ts` every everyday entity has `<slug>:manage`, and in the per-entity shape every entity has its own. Every role that works the child must be able to open its parent, and a reply an outside party adds on its ticket counts as created there. The independence test counts a role whose main work is a list of these records across parents, and a gate, an approval or a report counts for nothing. Junction and association class legs skip only the creation and independence tests; a leg the record can lack is a `reference`. The delete mode is chosen after the format: the "evaluate divergence first" order, "keep `format: parent`" and the default that most children share their parent's permissions are removed. A `parent` takes `restrict` when deleting the parent would delete children its deleter may not delete, and scorecards and signed offers are retention records. `review-module.md` checks the four tests and the delete mode in two rows. `build-module.md` works out each format before the entity list, says on an entity's line when it opens only from its parent, and names in the final response a format the full tests changed. `flows.md` rows 8.7 and 8.9 follow. The file format is unchanged; `version` stays `3.1`.

## Gates follow who takes each step, are decided before a build, and a review shows access

2026-11-10. Asked for by Martin Amm, after two builds (applicant tracking, IT asset management) shipped every lifecycle field as "Workflow State", gave a hiring pipeline no gate without saying so, and were reviewed without showing their permission structure. `rbac.md` → "Restricted steps (gates)": a gate is the move into a state that a role other than the module's Manager role usually takes, found by listing each state with the role that takes it in the leading products; authorizing and reversing states are examples of where the role changes. "Roles that take gates" gives each such role its own bundle `<slug>:<role_key>`, which includes `<slug>:manage` and its gates, while `<slug>:admin` still includes every gate, so a gated module no longer needs `raci` for a second holder. Step 5 adds a sequence rule so a record cannot skip past a gated state. Dropping a gate removes its rules, permission and hierarchy rows, asks before moving a role's users to the Manager role, and resets the class and access level. `spend:close_contract` became `spend:terminate_contract`, and `spend:issue_po` became `spend:issue_purchase_order`. "Controls on a gate" defines an approval gate (`approved`, `signed`, `posted`, `released`, `verified`), its waiting state and one check per gate, used by every rule of the gate, with complete rules for a purchase request, its lines and a hire. On an approval gate: the requester may not approve (an insert-only `requested_by_user_id` stamp, and only an admin creates a record straight into a gated state), which also holds on a payout gate (`paid`, `reimbursed`, `disbursed`); only a waiting record is approved; only its requester or an admin recalls it or reopens it after a rejection; the rejection and any move back out of the gated state take the same check; every field and line is locked from the waiting state on, deletes included, with any admin still able to correct a locked record; and `approved_by_user_id` and `approved_at` record the approval. A step the products assign to one person per record takes a `<role_key>_user_id` on the record or its parent, which only that person, holding the gate, or an admin uses while someone is named; where the products limit the role to its own records, a `select_rule` hides every other record, unassigned ones included, from the role's holders. A parent that reads as `null` admits only an admin. "The access line" defines the access summary that builds and reviews show. `build-module.md`: the entity-list confirmation works out each state's role without showing it, names each gated step with its role, named person and controls, and ends with one line on access; step 5.4 creates the gates, the roles and their bundles before the first `create_entity` and makes exactly those entities `operational_workflow`; the verification reads rules, read rules, hierarchy, roles and grants; the final response always has the access line. `SKILL.md` Golden Rule 9 lists the new reads. `module-rbac-setup.ts` no longer prints a call that sets `gated` without a gate, warns when no validation rule of a `gated` module checks a permission other than its read, manage or admin, and its admin descriptions say the admin takes every gated step. `data-modeling.md`: the lifecycle field is titled with the domain's word ("Stage" or "Status"), with "Workflow State" when none fits; the departments and products examples use enum objects; gates, their roles and the view access to a reused entity are the exceptions to creating access only with the script; the line lock is not a gate of the child, so lines keep `cascade`. `jsonlogic.md` names its delete gate `sales:delete_order` and documents `in`, `==` and `!=` with `null`. `rollup-fields.md` sets `include_hidden_rows` without asking where a child shows exactly when its parent does. `seed-data.md` treats `$user_id` and `$now` stamps as constant by design. `review-module.md` reads the RACI matrix of a `raci` module and its mode across the instance, accepts per-entity gate names, checks each role's bundle, reports a missing gate (with its role, class and access level as the fix), a missing approval control and a missing named-person control as To confirm and a missing sequence rule as To fix, never reports the lifecycle title, makes a class and permission disagreement To confirm, and puts an "Access:" section in every report. `flows.md` rows 8.7, 8.9 and 9.2 follow, row 9.5 is new and the review close-out became row 9.6. The file format is unchanged; `version` stays `3.1`.

## A date, a real number or an amount is never an enum

2026-11-10. Asked for by Martin Amm, to match the rule `semantius-importer` enforces. `data-modeling.md` → "Field Format Quick Reference": an `enum` is never used for a date, a real number or an amount, however few distinct values it has. The file format is unchanged; `version` stays `3.1`.

## Only `users` is compared among the platform's own entities

2026-11-10. Asked for by Martin Amm, after a new `events` entity was left out because it matched `queue_table_events` and `raci_events`. `entity-match-checker.ts` compares only `users` from the `_core` module, and a similar name to `users` is asked like any other. The exact name of another `_core` table is reported as a reserved name, and the new entity takes another name with no question. When `module-rbac-setup.ts` ends in exit 3 and the platform keeps refusing, the agent tells the user and may finish with the calls in `rbac.md`. `flows.md` rows 8.2, 8.3 and 8.9 follow. The file format is unchanged; `version` stays `3.1`.

## Relationship labels are tested before the field write

2026-11-10. Asked for by Martin Amm, after a label written from the wrong side parsed, passed the build and was caught only by the module review. `data-modeling.md` → "Relationship labels": a sentence that parses but is not true also fails, and every label is tested before the write that carries it, with each side of the sentence named from `reference_table`, `table_name` and the part the field names. `build-module.md` step 5 writes the sentences to `.tmp_deploy/relationship-labels.txt` before the first `create_entity`, "Mandatory Creation Order" step 7 requires the test on every path, and `review-module.md` names the sides the same way. Examples that failed the test change: `assigned` becomes `works on`, `parent of` becomes `is parent of`, `applied to` becomes `is applied to`, and `reports to` is no longer offered for a self-reference. `flows.md` is unchanged. The file format is unchanged; `version` stays `3.1`.

## One script creates a module and its access

2026-11-09. Asked for by Martin Amm, after a one-entity build spent half its calls on module setup and modules ended up without a color. `references/module-rbac-setup.ts` creates the module with its icon, color, permissions, hierarchy, roles, grants and default roles, and `--slug <slug>` fills what an existing module is missing; `build-module.md` step 5 runs it first and "Verify, then stop" runs it again. A color not given is a dark shade picked from the slug, and `review-module.md` checks `logo_color`. `rbac.md` → "Step-by-Step" becomes "Adding permissions and roles to an existing module". Icons: `lucide-icon-finder.ts` refuses a `--batch` value that is not an array and hints at `--batch` after a plain run, and a build makes one or two finder calls and one checker call. Payloads: the multi-line `create_entity` and `create_field` examples go through a file and `references/call-file.ts`, which reaches the CLI with no shell in between, the heredoc in `cli-usage.md` quotes its delimiter so `$old` and `$mode` survive, and `semantius tools <server> <tool>` is for tools the references do not cover. `flows.md` row 8.9 names what the final check repaired. The file format is unchanged; `version` stays `3.1`.

## A review ends with reply hints instead of a dialog

2026-11-09. Asked for by Martin Amm, after `AskUserQuestion` left users with "Which of these should I apply?" and no findings above it. `review-module.md` → "Report": the report, the reply hints and the question are one plain-text message with no tool call, and that question is never asked in a dialog or picker, on any host. `SKILL.md` Golden Rule 11 makes `AskUserQuestion` the only tool call of its response, because a tool call beside it cancels the pause. `flows.md` row 9.3 and its note on question formats follow. The file format is unchanged; `version` stays `3.1`.

## Fewer failed calls when building a module

2026-11-09. Asked for by Martin Amm, after a Talent Management build wasted about a third of its calls. "Mandatory Creation Order" step 7 names the label column, which never goes in a `create_field` call. `rbac.md` → "Viewing an entity of another module" gains a step: before a reused entity gets its own view permission, each rollup that would refuse it with `90269` gets `include_hidden_rows: true`, without asking, and the final response names it. `rollup-fields.md` and the high-risk list in `data-modeling.md` carry that exception. `rbac.md` says the built-in `Administrator` role already holds a new module's permissions. `jsonlogic.md` sends several test cases over stdin from a Bun script and tests every combination of a rule that maps values. Icon finder queries are one or two words each, with a second run of single words when every query returns `(none)`. `seed-data.md` states the `rng` rule where the function is listed. A module's `description` is at most 60 characters, one short phrase for a non-acronym, and `review-module.md` follows. `SKILL.md` says to pipe JSON on Windows PowerShell 5.1, where inline JSON fails. `flows.md` row 8.9 names the rollups switched to show hidden rows. The file format is unchanged; `version` stays `3.1`.

## A child with a different `edit_permission` is a `reference`

2026-11-09. Asked for by Martin Amm. `edit_permission` also gates inserts, so a child whose entity has a different one from its parent's is created by other people and fails the creation test in `data-modeling.md` → "Choosing the Right Format". The divergent-permission-scope rule now covers a permission gate on the child's own step and a junction or association class leg whose tier differs; it stays `parent` with `restrict`. The two Relationships rows in `review-module.md` follow. `flows.md` is unchanged: the change asks and shows nothing new. The file format is unchanged; `version` stays `3.1`.

## A child that people work on by itself is a `reference`

2026-11-09. Asked for by Martin Amm, after a review found that a chain built by one team stayed fully nested and that parts of the two tests gave no single answer. The independence test in `data-modeling.md` → "Choosing the Right Format" also makes the relationship a `reference` when people open and work on the child by itself, from its own list, so tasks and subtasks are no longer `parent` children. Its state condition now counts only work unrelated to completing the parent, so an order line stays a `parent` when invoicing waits on delivered. The creation test says that time alone does not count, covers generated, imported and portal-created records, and makes an unknown creator a `reference`. An association class is defined by its purpose rather than by `parent` legs, and an order line is named as not being one. The marketing planning example now rests only on who creates each level. The Relationships row in `review-module.md` follows. `flows.md` is unchanged: the change asks and shows nothing new. The file format is unchanged; `version` stays `3.1`.

## A `parent` depends on who creates the child and whether it stands on its own

2026-11-09. Asked for by Martin Amm, after an agent built a module of nested `parent` relationships that were hard to edit. `data-modeling.md` → "Choosing the Right Format" gains two tests before the table. The creation test asks whether the people who work on the parent create the child from inside it, in the same work; who moves it through its states later does not count. The independence test makes the relationship a `reference` when the child is self-identifying or a record or process outside the parent waits on its state; a `workflow_state` or a gated step alone settles nothing. Junction and association class legs skip the tests, and a new row gives an association class with its own `workflow_state` `parent` with `restrict` on every leg. A retention record never cascades, on either format. A worked example makes a marketing planning ladder required `reference` fields with `restrict`. The divergent-permission-scope rule no longer says that a `reference` makes the field optional, which a required `reference` with `restrict` disproves. `parent` depth has no limit of its own. `review-module.md` gains a Relationships row for the same checks. `flows.md` is unchanged: every row was re-read and the change asks and shows nothing new. The file format is unchanged; `version` stays `3.1`.

## One real-world thing is one entity

2026-11-08. Asked for by Martin Amm, after agents building a module created a prefixed copy of an entity that already existed, while the build rules allowed no question about it. `SKILL.md` gains "Before any new entity: compare it with the instance", which outranks every limit on questions and every no-answer default on every path that creates an entity; Golden Rule 1 and a Quick Decision Guide entry lead to it. The new `references/entity-match-checker.ts` compares each new entity's name and the other words the agent gives for it with every entity on the instance, and must exit 0 before the first `create_entity`. A same-name match suggests using the existing entity and uses it with no answer. A similar-name match (vendors and suppliers) asks whether they are the same thing and creates nothing with no answer. A reused entity is view only: `rbac.md` gains "Viewing an entity of another module", which gives the entity its own view permission when its current one is shared, and a missing field is added only after the user approves it. `build-module.md` confirms the entity list on every build, one line per entity with its purpose and key relationships; with no answer it still builds the four most central entities. Beyond the questions it names, a build asks what only the user can answer and where a wrong guess is costly to undo, and `data-modeling.md` Agent Workflow Tip 6 says the same. In `flows.md`, section 8 gains rows for the same-name and similar-name questions, the missing fields and any other question; sections 8 and 9 are renumbered, and every row was re-read against the changed files. The file format is unchanged; `version` stays `3.1`.

## Fields that apply only to some enum or boolean values are hidden and required by that value

2026-11-08. Asked for by Martin Amm, after generated forms kept showing `sold_date` and `sale_price` on records that were not sold, and the new review would have passed them. `data-modeling.md` gains "Fields that apply only to some enum or boolean values", a required pass before the write: each such field gets an `input_type_rule`, and a field needed in those values also gets a validation rule that refuses a missing value, tested by format because only `date`, `date-time` and `reference` columns can be `NULL`. "Mandatory Creation Order" and step 5 of `build-module.md` call the pass. `review-module.md` always reads `jsonlogic.md` and gains a Fields row that puts a field with no rule under To confirm. In `jsonlogic.md`, one hidden-to-required example replaces two that returned no `required` or read `$old`, and says the form re-evaluates the rule after each change, as `semantius-app` does. `flows.md` is unchanged: every row was re-read and the pass asks and shows nothing. The file format is unchanged; `version` stays `3.1`.

## A relationship field may name the record's part in the relationship

2026-11-08. Decided by Martin Amm, after a review dry run questioned `manager_id`: the rule said `<target_singular>_id`, while the skill's own examples used `manager_id`, `sales_rep_id` and `creator_id`. "Field Naming Rules" in `data-modeling.md` now also accepts a name that states the record's part in the relationship and ends in `_id`, and the matching row in `review-module.md` follows. `flows.md` is unchanged: no question or shown step moved. The file format is unchanged; `version` stays `3.1`.

## A live module can be reviewed against the skill's rules

2026-11-08. Asked for by Martin Amm, because a deployed agent had no way to review a live module: the existing audits check blueprint and spec files and sit in maintenance-mode skills. The new `references/review-module.md` reads the whole module through the catalog tools, verifies the module setup, permissions and roles, entities, fields, relationships and rules row by row, each row naming the section that holds its rule, and suggests optional entities and other additions from the leading products of the domain. It reports findings as to fix, to confirm and optional additions, and writes nothing until the user names what to apply. It reads the catalog rather than `generate_spec`, which leaves out `select_rule`, `input_type_rule`, the parent labels and the module wiring. `SKILL.md` gains a Reference Files row, a Quick Decision Guide entry and a trigger in its description. `flows.md` gains a row in "Which flow a run uses" and section 9 (rows 143 to 147); every other row still matches. The file format is unchanged; `version` stays `3.1`.

## A build chooses its icons after the scope is confirmed, and every entity and module gets one

2026-11-08. Asked for by Martin Amm, after a build that ran `lucide-icon-finder.ts` for its module, entities and enums before the scope question was answered. "Order of a build" in `build-module.md` says that neither `lucide-icon-finder.ts` nor `lucide-icon-checker.ts` runs in steps 1 to 4: icons are chosen in step 5, from the confirmed model. Every entity and every module now gets an icon, in a build and when an entity is added to an existing module: the `icon_name` row in `data-modeling.md` no longer says to leave it unset, a sentence with no recorded reason that its own `create_entity` example contradicted. An entity with no fitting icon has none and a module has `box`. "Mandatory Creation Order" and step 5 of the build check every entity's icon before the first `create_entity`. Step 5 of the build now finds icons first and checks them second, and names the finder for the module, every entity and every enum entry the "Enum icons" table does not cover, after a Haiku run took them from memory. `flows.md` is unchanged: no question or shown step moved. The file format is unchanged; `version` stays `3.1`.

## A build reads the references after its questions, and two build rules are exact

2026-11-08. Asked for by Martin Amm, after a build report and two blind Haiku dry runs. "Order of a build" in `build-module.md` says that steps 1 to 4 need only that file, plus `entity-families.md` for a family, and step 5 names what to read, so the scope and sample-data questions no longer wait for `data-modeling.md`. The scope rule counts every entity the build would create, including the base of a family, and the sample-data total is the sum of the rows planned for each table, with each record of a family counted once. `data-modeling.md` says a deprecated Lucide alias is reported unknown too, and `cli-usage.md` gives the measured size of one tool's schema. `flows.md` row 140 follows; every other row still matches. The file format is unchanged; `version` stays `3.1`.

## Field limits, every format, and lists that replace

2026-11-08. Asked for by Martin Amm, after upstream feedback on `create_field` and `create_entity` was checked against the live schema and the platform migrations. `data-modeling.md` and `jsonlogic.md` say that a partial `computed_fields` or `validation_rules` list deletes the rest, so the current list is read first and sent back in full. The format table in `data-modeling.md` now names all 47 formats, and says that the other text formats are plain `TEXT` columns and that `password` only masks the input. `unique_value` is described as a partial index that exempts `NULL` and `''`; `default_value` gains its 200-character limit, its forbidden sequences and the SQL expressions it evaluates; removing an enum value still in use is refused (`23514`). `cli-usage.md` shows how to filter one tool's schema with `jq`, and `scripts/crud-tools-drift.test.ts` fails when a live format is missing from `data-modeling.md`. `flows.md` is unchanged: no question or shown step moved. The file format is unchanged; `version` stays `3.1`.

## Seed runs say what they did, and a child needs no name to be keyed

2026-11-08. Asked for by Martin Amm, after three blind Haiku runs and the review's open items. `seed-data.md` says how to key a child with no name or a label that repeats across parents, and that `assertJunction` is only for connecting records, and how to check a computed column on a connecting record. A script that only clears now ends `Clear finished` instead of `Seed finished`; a halted clear says whether anything was deleted and to stop and tell the user; a computed-value halt says a plain re-run changes nothing. `seed-data.md` no longer says whether the seed and clear scripts are kept or deleted. Step 8 of the creation order says never on a junction, and the summaries in `SKILL.md`, `seed-data.md`, `build-module.md` and the `seed-lib.ts` header name the new checks. `flows.md` is unchanged: no question or shown step moved. The file format is unchanged; `version` stays `3.1`.

## A parent's figure is checked before the write, and clearing a seed cannot reach other records

2026-11-08. Asked for by Martin Amm, after a Haiku dry run and a review of the entry below. The new `assertItemized` in `seed-lib.ts` runs before the first write and halts when a parent's stored figure is below the number of its child rows or above twice that, since a read-back cannot catch a plan that is wrong in itself. `seed-data.md` and `build-module.md` give parents different numbers of children, because a rollup that counts them is otherwise identical on every parent and halted a valid seed; the worked example checks that before the first write. `assertComputedVary` is called at the very end of the script and is now in the worked example, "constant by design" is defined so a column that halted is not dropped, and a computed or rollup column never goes in a row and is never patched. The verification rule in `build-module.md` names its two exceptions, a one-row table and a column left out as constant by design, and the final response names such a column. For `clearSeeded`, a build that created only a subtype lists that subtype's own table and never the root, a count mismatch means stop and tell the user rather than copy the number from the error, and a delete refused by a validation rule is covered. `flows.md` row 142 follows. The file format is unchanged; `version` stays `3.1`.

## `label_parent` is set after the fields, seeded figures are checked, and a seed can be cleared

2026-11-08. Asked for by Martin Amm, after a build report. `create_entity` with `label_parent` fails with `90226` because the field it names does not exist yet, so "Mandatory Creation Order" in `data-modeling.md` gains a step 8 that sets it with `update_entity` after the fields, `build-module.md` step 5 names it, and the property's row says so and adds the self-reference refusal (`90228`). `seed-data.md` and `build-module.md` keep a parent's figure at the scale of the child rows that itemize it. The new `assertComputedVary` in `seed-lib.ts` reads `computed` and `rollup` columns back and halts when one holds a single value on every row, and `seed-data.md`, `build-module.md` and Golden Rule 9 name its output. The new `clearSeeded` empties tables children first after checking that each holds the expected count, and "Changing what was seeded" in `seed-data.md` says when to use it, since `seedEnsureMany` never changes a row that is already there. `scripts/seed-lib.test.ts` covers both. `flows.md` is unchanged: no question or shown step moved. The file format is unchanged; `version` stays `3.1`.

## Relationship labels are required, and the parent label pair is defined

2026-11-08. Asked for by Martin Amm, after a module diagram whose arrows all read `has`. `data-modeling.md` no longer calls `relationship_label` optional: it is set on every `reference` and `parent` field in the `create_field` call that creates it, because the platform writes `has` otherwise. A new "Relationship labels" section gives the voice (the referenced entity speaks, read as `<Referenced Entity> <label> <Holding Entity>`), the filler verbs to avoid, one verb per field, junction legs and two `parent` fields from one child to the same parent. `singular_label_parent` and `plural_label_parent` are defined as the add button noun and the child list button title on the parent's page, set on every junction leg and when one child has two or more `parent` fields to the same parent. The M:N junction example sets the label and the pair on both legs. The file format is unchanged; `version` stays `3.1`.

## The pre-build step uses what the agent knows, tells the user, and names by our rules

2026-11-07. Asked for by Martin Amm, after a build that reported its module as modeled on three vendors although no search had run. `build-module.md` "Model it like the leading products" no longer requires a search: the shape comes from the agent's knowledge of the category, and a search runs only for a niche domain, a category newer than that knowledge, a product the user wants mirrored, or regulated identifiers. The module also keeps the mechanism the user's goal turns on, even when only one product has it. Before the first question the user is told, in two or three lines, what is being built, whether the shape comes from knowledge or a search, and that mechanism; a product is called verified only when a search returned it, and the final response repeats the mechanism. Names follow the agent-first rules, now in `data-modeling.md` ("Entity Naming Rules", new "Field Naming Rules"); a product's own names are used, through `vendor-names.ts`, only when the user asks for them, and the `vendor-names.ts` row in `SKILL.md` says so. `flows.md` rows 138 and 142 follow. The file format is unchanged; `version` stays `3.1`.

## A repeated artifact is pasted from a tool result in the same turn

2026-11-07. Asked for by Martin Amm, after a user-reported session in which a SaaS Management diagram was pasted correctly the first time and, two turns later, re-sent for a smaller selection from memory with one `classDef` property separator typed as `;` instead of `,` (Mermaid folds `color:` into the `stroke` value and the class styling dies without an error). Golden Rule 10 now says where the bytes of every send come from: a tool result in that same turn, never an earlier message. A different selection runs the generator again; the same selection reads the saved file. The rule that a subset calls the tool with `module_slugs` and `table_names` is unchanged. The file format is unchanged; `version` stays `3.1`.

## Seed runs are checked the same way in every shell, and re-runs converge

2026-11-07. Asked for by Martin Amm, after a weak-model dry run and a second review of the seeding change. `seed-lib.ts` takes `--check` as well as `SEED_CHECK=1`, so the check run is the same command in bash and PowerShell, and the commands in `seed-data.md` are two separate lines (no `&&`). A check run now proves, with one `limit=0` read per table, that the table and every column of the first row exist, no longer swallows a failing live read, and tags every success line `[check run]` so it never reads like a seeded table; its last line says nothing was seeded. `assertParents` takes `null` for an optional relationship that is meant to be empty, and the new `assertJunction` reads a connecting record back with both `<fk>_label` columns and halts on a pair that is missing, wrong or left over from an earlier run. `seedEnsureMany`, keyed on the label column or a code, is the insert for every table, so a re-run after a halt skips the rows that landed; `postMany` stays for a table with no column that differs on every row. `seed-data.md` gains a "Before you write" step (read the target's `id_type`, `label_column` and fields), a list of the library's functions (so the library is never read), the PATH pointer to `cli-usage.md`, the null and zero-value rule by format (only `reference`, `date` and `date-time` accept `null`), the family rule as `entity-families.md` states it (an `is_a` record is one insert at its own table), and a report rule: a seed is reported only from the real run's output. `build-module.md` states what a verified seed looks like (`Seed finished`, every count, a ✓ line per child table; a `CHECK RUN passed` or `SEED HALTED` ending is not verified), reads an existing entity's rows with their labels, and gives the icon check its own paragraph with the enum-icon table before the finder. `SKILL.md` defines `<skill-folder>` once. `data-modeling.md` step 1 takes the module id from `read_module`, never from the `create_module` response. The file format is unchanged; `version` stays `3.1`.

## Ids come from a read, and icons are checked before they are written

2026-11-07. Asked for by Martin Amm, after a weak-model review of the seeding change. `SKILL.md` "Response handling" no longer teaches reading an id from a create response first: it keeps the array-versus-object lesson for `read_*` responses and states, as its own paragraph, that a new row's `id` is never read off its own create response (a position in a bulk response is not a mapping back to the input; re-read by natural key). `rbac.md` says the three role ids for the grants come from one `read_role` filtered by `slug`, matched by `slug`, never by the position of a row in the `create_role` response. `build-module.md` step 5 gives the exact `lucide-icon-checker.ts` command and the two points to run it (the module's own icon before `create_module`; every enum and field icon in one call before the first `create_field`), and the creation list in `data-modeling.md` repeats the second point in its field step. The file format is unchanged; `version` stays `3.1`.

## Sample data is seeded by a checked script, children mapped by label

2026-11-07. Asked for by Martin Amm: `use-semantius` carries the seeding logic it needs and no longer depends on a maintenance-mode skill for it. The new `references/seed-lib.ts` holds the helpers a seed script imports: `postMany` (one POST per table, identical keys asserted, short RETURNING halts), `seedEnsureMany` (re-run-safe), `idsByKey` (a parent's label becomes its id by a read-back on the natural key, with `in.()` values quoted and encoded), `assertParents` (reads each child back with its `<fk>_label` and halts on a child that names the wrong parent), `assertSeedCounts`, `assertSeedDistinct`, a seeded random generator (`rng`), `patchById` and `runSeed`. `SEED_CHECK=1` runs the whole script without sending a write. Real company and product names are fine in sample data; every email address must be at a subdomain of `example.com`, and `postMany` refuses any other address in any text column (`assertExampleEmails`). The new `references/seed-data.md` is the method: set-up and run, one worked example (vendors and contracts), parents and children, one call per table, values, and rows that read as records (decide the state first and derive dates and notes from it, text that names a parent is built from that parent, no base plus index). `build-module.md` points to it from step 6, "How to write them" states the essentials (never type an id, map by array position or take an id from an insert response), and "Verify, then stop" reads the seed script's output: every table at its count and a checked relationship for every child table. `SKILL.md` lists both files, routes "adding made-up sample or demo records" to `seed-data.md`, and Golden Rule 9 names the same verification. `scripts/seed-lib.test.ts` tests the library against an in-memory platform, including a scrambled insert echo and the wrong-vendor case, and runs the example in `seed-data.md`. The file format is unchanged; `version` stays `3.1`.

## Seeded children resolve by label, and are read back

2026-11-07. Asked for by Martin Amm, after a user-reported build of a SaaS management module in which three seeded contracts named the wrong vendor. `build-module.md` "How to write them" no longer tells the agent to take a parent's `id` from the insert response (which contradicted `SKILL.md` "Response handling"): it re-reads the parents by natural key in one `in.(...)` read and maps each child by that label, never by array position. It also tells the agent to read each row against its own text before writing it (a note that says "still billing" does not go with a terminal status). "Verify, then stop" adds, when sample data was seeded, one read of each child table that holds a relationship with its `<fk>_label` columns, to confirm every row names the intended parent; Golden Rule 9 states the same scope. Step 5 of "Order of a build" says every icon the module writes comes from `lucide-icon-finder.ts` and passes `lucide-icon-checker.ts` once before the first `create_field`. Verification is still not analysis. The file format is unchanged; `version` stays `3.1`.

## No catalog tool, write tier stated, servers by plan

2026-11-07. Asked for by Martin Amm, after a user-reported build of a SaaS management module. `data-modeling.md` says plainly that `use-semantius` exposes no tool to look up or install a catalog blueprint: a module is built by hand and its `catalog_*_code` values stay empty. The classification summary names each class's write tier in plain words, `vendors` leaves the `catalog` examples, and an entity the module exists to hold (its everyday inventory) is never a `catalog`, so its managers can add to it. `SKILL.md` names only `crud` and `utils` as always available, says the plan can add more (such as `cube`) and tells the agent to run `semantius` to see which; the section heading is "The Servers". `data-modeling.md` also states the lifecycle state field rule once: a lifecycle is stored in one required `enum` named exactly `workflow_state` (never `status`, `state` or `lifecycle_state`), and the `gated` description reads "gates on `workflow_state` transitions". Approved by Martin Amm. The file format is unchanged; `version` stays `3.1`.

## Generated artifacts are used exactly as returned

2026-11-07. Asked for by Martin Amm: after `generate_module_diagram` returned a styled Mermaid diagram, the agent retyped a condensed copy in the reply, dropping the `classDef` and `class` lines and the status line, so referenced-only entities looked like selected ones. `SKILL.md` gains Golden Rule 10: a diagram is pasted verbatim, a document (spec, export, CSV schema) is saved to a file by redirecting stdout, and neither is retyped, condensed, re-styled, quoted in part or paired with a hand-made version. A subset or a view across modules uses the tool's `module_slugs` and `table_names`, length is no reason to shorten, and a failing tool is reported, not replaced by a hand-drawn diagram. "Show me the data model", an ERD or a schema picture counts as asking for the diagram in the Quick Decision Guide. Golden Rule 9 now says smallest means narrowest scope, never a compressed rendering. `build-module.md` states that the tool's output is the artifact. The file format is unchanged; `version` stays `3.1`.

## A build request has a scope contract

2026-11-07. Asked for by Martin Amm: `use-semantius` covers a request to build a module, app or platform on its own. The new `references/build-module.md` defines the default deliverable (module, entities, fields, relationships, permissions, roles, UI links), the sample-data question and its consent gate (never seeded without an explicit yes; a plain "ok" or "sure" counts; a reply with counts is consent; a company size is not a row count), the size (5 to 10 rows per parent entity, about 3 per parent for child entities, at most 20 per entity), which tables may receive rows, the step that models a module like the leading products of its domain when the request resembles a well-known one (reference products, names through `vendor-names.ts`), the order of a build, the confirmation of a choice locked at creation (`is_a` / `has_a`) and of the scope when more than 4 entities are relevant, each asked on its own before the sample-data question (with no answer to the scope question the four most central entities are built), the preflight, which an agent other than the Semantius agent reads and runs first (`SKILL.md` → "Environment Setup") and which sets the question format, verification as one read-back per entity, the artifacts produced only on request (spec, diagram, export, report, analytics) and the final response. `data-modeling.md` "Agent Workflow Tips" (clarifying questions) and `crud-tools.md` "Order for a new module" point to it, and the `SKILL.md` description triggers on a build request. The build trigger is open ("build or set up something new that needs its own records, however it is phrased"), and an analytics request answers only the question asked, never changes the schema, and with no matching data says so and stops. `SKILL.md` gains a Quick Decision Guide entry, a gate on the "build a script, diagram, document, report or export" entry, and Golden Rule 9. The file format is unchanged; `version` stays `3.1`.

## One creation order, stated once

2026-11-07. Asked for by Martin Amm: `data-modeling.md` "Mandatory Creation Order" is the single source for the creation order. Golden Rule 2 in `SKILL.md` and Agent Workflow Tip 2 now point to it instead of restating it, so the module-wiring step (`update_module`) is never dropped. The classify-without-asking, state-the-result and read-back clause moved into the section's entity step. The two "DUPLICATE … Edit both" markers became "Family variant" notes naming `entity-families.md` "Creating a family" as the section that governs families. `rbac.md` cites the wiring step by title, not by number. The section now covers the whole module setup (permissions, `update_module` wiring, permission hierarchy, roles, role grants, default-role wiring, entities, fields), so `crud-tools.md` "Order for a new module" is a pointer to it and `rbac.md` no longer restates the wiring position.

## Every enum entry gets an icon that fits

2026-11-07. Asked for by Martin Amm: in `data-modeling.md` "Enum values and labels", every entry of every enum gets an icon that fits its meaning; there is no distinction between state and other enums. A new "Enum icons" table maps entry meanings to Lucide icons, `lucide-icon-finder.ts` covers labels the table does not (an entry the finder finds nothing for has no icon), and one `lucide-icon-checker.ts` call checks all of a module's enums. The `contract_type` example gives every entry an icon. The file format is unchanged; `version` stays `3.1`.

## Find the built-in tool before building

2026-11-06. Asked for by Martin Amm: `SKILL.md` gains a Quick Decision Guide entry and the section "Find the built-in tool before building". Before building a script, diagram, document, report or export from the model, the agent searches the CLI for a tool that already produces it (`search_tools` over names and descriptions, `tools <server> <tool>` for the signature). The rule names no tool, so generators added to the CLI later are found the same way. The file format is unchanged; `version` stays `3.1`.

## Entity classification and write permissions live here

2026-11-06. Asked for by Martin Amm: `use-semantius` owns the whole concept of classifying an entity and of giving it the right permissions, so an entity built without the architect, analyst or modeler is classified and permissioned correctly. `data-modeling.md` gains "Classifying an entity" (the six classes, the derivation ladder, the class-to-write-tier table, junction rules, reclassification, the read-back check); `rbac.md` gains "Choosing an entity's permissions" (write tier to `view_permission` and `edit_permission`, for hand-built and spec-deployed modules) and its setup steps create `<slug>:admin`, an admin role and `access_scope: advanced`. Every `create_entity` example and the creation-order steps carry `entity_type`, `view_permission` and `edit_permission`. The pipeline skills reference these sections. The class is chosen without a question and named in the summary. `rbac.md` also gains "Restricted steps (gates)": a module with a restricted step is `gated` (or stays `raci`), each gate is a `<slug>:<verb>_<noun>` permission included by `<slug>:admin`, and a validation rule checks it with `has_permission`. The file format is unchanged; `version` stays `3.1`.
