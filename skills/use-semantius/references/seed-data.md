# Seeding sample data

_Read this before writing any generated records: sample data after the user said yes to the question in `build-module.md`, or any request to insert made-up records. Real records from a file go through the `semantius-importer` skill._

Sample data is one file of records. You write the records; the CLI checks the file and imports it. There is no script to write: the import orders the tables, writes parents before children, and a second run writes only what differs.

## Set up

```bash
semantius tools utils import_entities
# <skill-folder> = the directory this skill's SKILL.md was read from (absolute path)
bun "<skill-folder>/references/seed-lib.ts" --describe <table>,<table>
```

- `import_entities` must list a `check` parameter. When it does not, the CLI is too old to load sample data: finish the build without it, and say in the final response that sample data needs a newer CLI (`cli-usage.md` → "Installation").
- `--describe` prints the file's skeleton and, for each table:
  - how a record names itself;
  - every column with its format, whether it is required and its default;
  - the values of each enum;
  - the columns the platform fills, which a record never carries;
  - the approval stamps, with the states they go in.

  After the tables it lists the tables whose states must agree and the users a record may name.
- Write the file from that output. Column names, enum values and ids come from the platform, never from memory.
- Never read `seed-lib.ts`: its four commands are all described here.

## The file

Write it as `.tmp_deploy/seed_<module_slug>.json`, with your file-write tool:

```json
{ "version": 1, "entities": [
  { "entity": { "table_name": "vendors" }, "records": [
    { "id": "vendor_sr1", "vendor_name": "Adobe", "website": "https://www.adobe.com", "support_email": "support@adobe.example.com" },
    { "id": "vendor_sr2", "vendor_name": "Figma", "website": "https://www.figma.com", "support_email": "support@figma.example.com" }
  ] },
  { "entity": { "table_name": "contracts" }, "records": [
    { "id": "contract_sr1", "contract_name": "Adobe Creative Cloud for Teams", "vendor_id": "vendor_sr1", "workflow_state": "active", "end_date": "2027-03-31", "notes": "Renews automatically." },
    { "id": "contract_sr2", "contract_name": "Adobe Acrobat Pro", "vendor_id": "vendor_sr1", "workflow_state": "expired", "end_date": "2026-08-31", "notes": "Not renewed." },
    { "id": "contract_sr3", "contract_name": "Figma Organization", "vendor_id": "vendor_sr2", "workflow_state": "active", "end_date": "2027-06-30", "notes": "Renews automatically." }
  ] }
] }
```

- **Ids.** A record of an entity with a TypeID key names itself `<prefix>_sr<n>`: its entity's prefix, `_sr`, and a number from 1 (`vendor_sr1`, `vendor_sr2`). `--describe` gives each table's first id. The import stores a full id built from that name. The records of an entity with an `auto_increment` key take the numbers 1, 2, 3.
- **Relationships.** A relationship column holds the id of the record it means, as that record writes it: `"vendor_id": "vendor_sr1"`. Never a label and never an id you made up. A record that is already on the host is named by its stored id.
- **Users.** A column that references `users` takes `{"external_id": "…"}` of a user `--describe` lists, or `null`. Never invent a user.
- **Columns.** Every record of a table carries the same columns, the `id` among them.
  - An empty value is `""` for text and `0` for a number.
  - `null` goes only in a `reference`, `date` or `date-time` column, never in a `parent` column.
  - A column the platform fills (a computed or rollup column, `created_at`, `updated_at`) is never written. The one exception is an approval stamp ("Approval stamps").
- **Dates** are written out (`2026-11-05`, `2026-11-05T14:00:00Z`), worked out from today's date.
- **Order.** Tables go in any order, and so do the records of a table.
- **Families** (`is_a` / `has_a`, `entity-families.md` → "Writing"):
  - An `is_a` record is listed once, under its own table, with its base's columns in the same record. Never list it under the base as well.
  - A `has_a` record takes the id of the base record it extends and its own columns only.
- Never add a field to the schema to ease a seed.

## Run

One command, four steps. Each runs only when the one before it succeeded. Run it from the repo root (`preflight.md`):

```bash
F=.tmp_deploy/seed_<module_slug>.json
bun "<skill-folder>/references/seed-lib.ts" --emails "$F" \
  && semantius call utils/import_entities "{\"path\":\"$F\",\"check\":true}" \
  && semantius call utils/import_entities "{\"path\":\"$F\"}" \
  && bun "<skill-folder>/references/seed-lib.ts" --report "$F"
```

If `semantius` is not found, put its folder on PATH in the same command (`cli-usage.md` → "Installing from an agent").

1. **The file and its email addresses.** The step counts the run first (below), then reads the file. A file that is not valid JSON is refused with the line and column of the mistake and the lines around it: fix that place, never write the file again. Then every email address in it is at a subdomain of example.com, so sample data never reaches a real inbox; the step lists every other address. It writes nothing.
2. **The check** writes nothing. It reads the file and the catalog and lists every problem in one answer: an unknown column, a required value that is missing, a value an enum does not have, an id used twice, a relationship that names no record.
3. **The import** writes the records. The check does not evaluate the module's rules, so the import can still stop at one record that a validation rule, an approval gate or an `input_type_rule` refuses. The records written before it stay.
4. **The report** reads the records back: each table's count, each column the platform filled with its number of distinct values, and each parent state with the states of its child records.

**When a step stops,** fix what it names in the file and run the same command again.

- Fix every listed problem in one edit, with your file-edit tool, or `edit-file.ts` when there is none (`cli-usage.md` → "Ad-hoc JSON and file work in Bun"). Never write the whole file again, and never use Python.
- After the import stopped at a record, the next run skips the records that are already there and goes on from it.
- Fix the record, never the rule. The one exception is an approval stamp on a state the gate leaves out ("Approval stamps").
- **The command stops itself.** The first step counts each run of the command for the file in `.tmp_deploy/seed-runs.json`, and a finished report ends the count. Ten runs go on; the eleventh, with no finished report between, prints `SEED STOPPED` and exits 5, and so does every later one. Then run nothing more, write nothing to the tables by hand, and do what the next point says. Run the command as one chain: every `--emails` run counts, also one sent alone. Only the user can allow more runs, by deleting `seed-runs.json`.
- **The same problem on five runs in a row ends the seed.** When five runs in a row name the same problem, although you changed the file for it between them, do not run a sixth time (Golden Rule 13). Finish the build, and say in the final response which tables hold records and what stopped the rest (`build-module.md` → "Final response").

No other write path: no hand-run `postgrestRequest` inserts, no probe or test records.

## Records that read as records

- Decide where each chain of records stands first: the state each parent ends in, and the states of its child records that agree with it. An application at `hired` has an `accepted` offer; an application at `applied` has no offer. `--describe` lists the tables whose states must agree; write each parent with its children in mind.
- Then decide each record's drivers (its state, its parent, its place) and derive every field that must agree with them:
  - a terminal state (revoked, canceled, expired, closed) gets a note that says so or no note, never an ongoing one such as "still billing";
  - an active state never gets a note about ending;
  - an end date is after its start date;
  - a closed date exists only on a closed record.
- A parent's stored figure that its child records itemize (a number a person enters, such as seats purchased over seat records) stays at the scale of those records: at least their number and at most twice it. With 3 seat records, 3 to 6 seats purchased, never 120. A figure the platform counts from the child records is a rollup and is never written.
- Give parents different numbers of children (1 to 5, about 3 on average), never the same number each: a rollup that counts them would hold one value on every parent.
- When a computed or rollup column depends on a state of the children (inactive seats, overdue invoices), give some parents children in that state and others none, so the column differs between parents.
- Spread every enum across its values.
- Text that names another record (a title or summary that mentions its parent) is built from that record, never invented apart from it.
- Nothing a person reads is a base plus an index (`Slack 1`, `Slack 2`). Write it.
- Names, cities and companies vary. Real company and product names are fine.
- Every email address is at a subdomain of `example.com`, named after the company the record belongs to: `support@adobe.example.com`, `ana.silva@globex.example.com`. Never at the company's real domain, and never at `example.com` itself.
- A US phone uses `555-0100` to `555-0199` behind the area code; a phone in any other country stays empty.
- A `rating` is a whole number from 0 to 5 (1 to 5 when required). An `icon` is a Lucide name from `lucide-icon-finder.ts`. Other formats: `data-modeling.md` → "Field Format Quick Reference".

## Approval stamps

A record written straight into a state at or past an approval (`approved`, `ordered`, `signed`) carries its `<step>_by_user_id` and `<step>_at`, because the rule keeps what an insert sends there (`rbac.md` → "Controls on a gate", control 5). `--describe` names both columns and the states they go in.

- **The date** falls after the record's own earlier dates.
- **The approver** is the user the record names as its approver when it names one. Otherwise it is a user from the `--describe` list other than the user who seeds: that user is the requester of every record it writes, and a requester never approves their own record.
- **A record before the step** writes `null` in both.
- **The user who seeds must hold `<slug>:admin`**: only an admin may create a record at or past an approval (`rbac.md` → "Restricted steps (gates)", step 5). When that user is no admin, or is the only user, write no record at or past an approval, and say in the final response why no sample record is past it.
- **When the import refuses a stamp on a record,** there are two readings, and only one is right. When the record's state comes before the step, the record is wrong: write `null`. When the state is reached only after the gated one (an offer is sent only once approved), the record is right and the gate's `after` in `.tmp_deploy/access.json` leaves the state out: add it there, run `module-rbac-setup.ts --slug <module-slug> --access .tmp_deploy/access.json`, then run the seed command again. Never null a stamp that a record past the step carries.

## Changing or removing what was seeded

- **To change values,** edit the file and run the command again: the import updates the records that differ. A rule may refuse the update of a record it let in (a record locked once it is submitted); then clear and import again.
- **To remove the records:**

  ```bash
  bun "<skill-folder>/references/seed-lib.ts" --clear .tmp_deploy/seed_<module_slug>.json
  ```

  It deletes the file's records, children first, and ends `Clear finished`, which is not a seed.
  - Only on entities this build created, and only during the build that seeded them. Later, clear only when the user asks: by then a table may hold real records.
  - When it stops (a delete the platform refuses, or a record that is not the one the file wrote), stop and tell the user. The tables it names as done are already empty.

## Report

Report sample data only from a command that ran through to the report, which prints `Report finished: <n> record(s) in <k> table(s) on the host.` Its last line says what comes next: after a complete seed, the final response itself, with no other message before it.

- State how many records each table holds, from its `✓ <table>: <n> records` lines.
- Name every line under `Look at`: a column that holds one value on every record, or records of the file that are not on the host.
- A command that stopped before the report seeded nothing you can report as complete: say which step stopped, what it named, and which tables hold records.
- Do not summarize the data's meaning: that is analytics, which is a separate request.
