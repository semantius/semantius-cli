# Seeding sample data

_Read this before writing any generated rows: sample data after the user said yes to the question in `build-module.md`, or any request to insert made-up records. Real records from a file go through the `semantius-importer` skill._

One script writes everything. It uses `seed-lib.ts`, which halts on every failure and checks the result, so the mistakes that matter (a child pointing at the wrong parent, a short insert, a wrong count, a figure out of scale with its child rows, a computed column that never moves) cannot pass unnoticed.

## Before you write

Read what you are about to fill; column names, enum values and the key type come from the platform, never from memory:

- `read_entity` with `table_name=in.(<the tables>)` and `select: "table_name,id_type,label_column"`. An entity whose `id_type` is `bigint` or `text` needs its own `id` on every row, and foreign key values into it are those ids. For any other key type never send `id`, except to attach a `has_a` row to an existing base record (below).
- `read_field` for the same tables, with `select: "table_name,field_name,format,input_type,enum_values,reference_table,ctype"`. `ctype` marks the `computed` and `rollup` columns.

## Set up and run

```bash
mkdir -p .tmp_deploy
# <skill-folder> = the directory this skill's SKILL.md was read from (absolute path)
cp "<skill-folder>/references/seed-lib.ts" .tmp_deploy/seed-lib.ts
```

Write the script as `.tmp_deploy/seed_<module_slug>.ts` and run it from the repo root by path (`preflight.md`). Run the check first and the real run only when the check exits 0, as two commands (not chained, so it works in every shell):

```bash
bun run .tmp_deploy/seed_<module_slug>.ts --check
bun run .tmp_deploy/seed_<module_slug>.ts
```

The check run records every insert and sends no write. It does prove that each table and each column of the first row exist, but it does not validate values (enums, required fields, rules): the platform does that on the real run. Its output says `[check run]` and ends `CHECK RUN passed … nothing seeded`; that is not a seed. If `semantius` is not found, put its folder on PATH in the same command (`cli-usage.md` § "Installing from an agent").

Never retype `seed-lib.ts` and never read it: the functions are listed below. No other write path: no hand-run `postgrestRequest` inserts, no probe or test rows.

## The pattern

```typescript
import { seedEnsureMany, idsByKey, assertParents, assertComputedVary, assertSeedCounts, assertSeedDistinct, days, exampleDomain, rng, runSeed } from "./seed-lib";

await runSeed(async () => {
  const counts: Record<string, number> = {};

  // The plan comes first. It names each contract's parent by label and fixes its state; the rest follows from them.
  const plan = [
    { contract_name: "Adobe Creative Cloud for Teams", vendor: "Adobe",   state: "active" },
    { contract_name: "Figma Organization",             vendor: "Figma",   state: "active" },
    { contract_name: "Datadog Pro Trial",              vendor: "Datadog", state: "renewal_pending" },
    { contract_name: "Adobe Acrobat Pro",              vendor: "Adobe",   state: "expired" },
  ];

  // vendors. Drivers: the vendor name (→ website, support email at an example.com subdomain).
  const vendorRows = [
    { vendor_name: "Adobe",   website: "https://www.adobe.com",     support_email: `support@${exampleDomain("Adobe")}` },
    { vendor_name: "Figma",   website: "https://www.figma.com",     support_email: `support@${exampleDomain("Figma")}` },
    { vendor_name: "Datadog", website: "https://www.datadoghq.com", support_email: `support@${exampleDomain("Datadog")}` },
  ];
  assertSeedDistinct("vendors", vendorRows, ["vendor_name"], vendorRows.length);   // before the write: a failure sends nothing
  // vendors.contract_count is a rollup that counts contracts, so vendors get different numbers of contracts.
  assertSeedDistinct("contracts per vendor", vendorRows.map((v) => ({ contracts: plan.filter((p) => p.vendor === v.vendor_name).length })), ["contracts"], 2);
  counts.vendors = (await seedEnsureMany("/vendors", vendorRows, "vendor_name")).length;   // keyed on the label: a re-run inserts only what is missing
  const vendorId = await idsByKey("/vendors", "vendor_name", vendorRows);   // label → id, read back by natural key

  // contracts. Drivers: the vendor (→ vendor_id) and the state (→ end_date, notes).
  const r = rng("contracts");
  const contractRows = plan.map(({ contract_name, vendor, state }) => ({
    contract_name,
    vendor_id: vendorId(vendor),                                          // throws on a label that was not seeded
    workflow_state: state,
    end_date: state === "expired" ? days(-r.int(15, 120)) : days(r.int(30, 400)),   // in the past only when expired
    notes: state === "expired" ? "Not renewed." : state === "renewal_pending" ? "Renewal quote requested." : "Renews automatically.",
  }));
  counts.contracts = (await seedEnsureMany("/contracts", contractRows, "contract_name")).length;
  await assertParents("/contracts", "contract_name", "vendor_id", contractRows, plan.map((p) => p.vendor));

  // Last, when every table has landed: the computed and rollup columns, then the counts. contract_count is never sent in a row.
  await assertComputedVary("/vendors", "vendor_name", vendorRows, ["contract_count"]);
  assertSeedCounts(counts, { vendors: 3, contracts: 4 });                // the counts the question named
});
```

## The functions

- `seedEnsureMany(path, rows, keyField)`: the insert for every table. `keyField` is a column that differs on every row (the label column, or a code); the platform need not enforce it. It reads the rows whose key is already there, inserts only the missing ones in one POST and returns all rows with their ids in input order. Use it only on entities this build created.
- `postMany(path, rows)`: a plain bulk insert, for a table with no column that differs on every row. A re-run appends a second set.
- `idsByKey(path, keyField, rows)`: returns `(label) => id`, read back from the platform by natural key. Halts on a label that is missing or appears twice.
- `assertParents(path, keyField, fkField, rows, parentLabels)`: reads the child rows back with their `<fk>_label` and halts, naming the rows, if one names a different parent than `parentLabels[i]` (`null` for an optional relationship meant to be empty).
- `assertJunction(path, fkA, fkB, pairs)`: for a connecting record. Reads the whole table back with both `<fk>_label` columns and halts on an intended `[labelA, labelB]` pair that is missing or wrong, and on a stored row that was not intended.
- `assertComputedVary(path, keyField, rows, columns)`: reads `computed` and `rollup` columns back for the seeded rows and halts when a column holds one value on every row. A check run only proves the columns exist.
- `assertItemized(column, parents)`: before the first write. Each entry is `[parent label, figure, number of child rows]`, as in `assertItemized("subscriptions.seats_purchased", plan.map((p) => [p.name, p.seats_purchased, p.seats.length]))`. Halts, naming the parents, when a figure is below its child count or above twice it.
- `assertSeedCounts(counts, expected)`, `assertSeedDistinct(table, rows, columns, minDistinct?)`: halt on a wrong count, or on a column that should vary and does not.
- `patchById(table, id, body)`: fixes one row.
- `clearSeeded([[path, count], …])`: empties tables, children first, after checking that each holds `count` rows. See "Changing what was seeded".
- `rng("<table>")` with `.pick(pool)`, `.int(min, max)`, `.chance(p)`, `.deal(pool, n)`, `.distinct(pool, n)`, `.tuples(n, [poolA, poolB])`: the only source of random values in the script, never `Math.random()` or a helper of your own: an unchanged script draws the same values again (dates are relative to the run day).
- `days(n)` (a date n days from today), `uniq("INV-", i)`, `exampleDomain(company)`, `slugify(text)`.
- `runSeed(async () => { … })`: wraps the script; any thrown error exits non-zero and prints `SEED HALTED`.

## Parents and children

- Parents first, children after. A child names its parent by label in the plan, and `idsByKey` turns the label into the id. Never type an id, never map by array position, never take an id from an insert response (`SKILL.md` → "Response handling").
- Give every parent its own label. `idsByKey` halts on a repeated label or a label it cannot find.
- After each child table, `assertParents` reads the rows back with their `<fk>_label` (`crud-tools.md` § "Composed labels") and compares each with the parent from the same plan. `keyField` is a column that differs on every child row (its label or a code). A mismatch halts and names the rows; fix them with `patchById`.
- A child with no name, or whose label repeats across parents (one person holding seats on two subscriptions), keys on any column that differs on every row of the table, such as a date or a code, or gets labels that differ in the sample data. `assertParents` takes that same column. `assertJunction` is only for connecting records.
- A connecting record (junction) has no column that differs on every row. Seed it with `postMany`, each row carrying the ids of its two parents from their `idsByKey` lookups, and keep the intended `[labelA, labelB]` pairs in the plan. Then `assertJunction(path, fkA, fkB, pairs)` instead of `assertParents`:

  ```typescript
  const seatPairs = [["Slack", "Maria Lopez"], ["Figma", "Tom Becker"]] as const;
  await postMany("/seats", seatPairs.map(([app, person]) => ({ application_id: applicationId(app), user_id: personId(person) })));
  await assertJunction("/seats", "application_id", "user_id", seatPairs);
  ```
- A required relationship into an existing entity (such as `users`): read that entity once with `select=id,<label column>`, choose rows from that read and use each chosen row's own `id`, and name that row's label in `parentLabels`. Never a bare list of ids.
- An optional relationship that is empty on a row is `null` in the row and `null` in `parentLabels`.
- A family (`is_a` / `has_a`): insert an `is_a` record once, at its own table, with the base's fields in the same row; never a base row and then a subtype row. A `has_a` row without `id` creates its base record too; with the `id` of an existing base record it attaches and carries only the extension's own fields (`entity-families.md` → "Writing").

## One call per table

- Every table goes through one `seedEnsureMany` (or `postMany`) call: one POST for the whole table. Every row carries the same keys: a column you send on one row you send on every row. Only `reference`, `date` and `date-time` accept `null`. Every other format is NOT NULL, required or not, so an empty one is `""` (text, email, url, …) or `0` (numbers); a column you leave out of every row takes the platform's zero value. Never leave a key `undefined`.
- Tally each table from its own insert (`counts.vendors = (await seedEnsureMany(…)).length`) and end with `assertSeedCounts` using the per-table counts the sample-data question named. A lower count needs a stated reason in the report.
- After a halt, fix the cause and run the script again: `seedEnsureMany` skips the rows that landed. A fix to a value in a row that landed needs `patchById` or a reset ("Changing what was seeded"). A table seeded with `postMany` needs a look at what landed first, because a re-run appends a second set.

## Values

- An enum field takes one of its `value` entries, exactly, never its label. Fields that look alike have different values: read the field's own `enum_values`.
- A `rating` is an integer from 0 to 5 (1 to 5 when required). An `icon` is a Lucide name from `lucide-icon-finder.ts` or the "Enum icons" table in `data-modeling.md`, and passes `lucide-icon-checker.ts` before it is written. Other formats: `data-modeling.md` → "Field Format Quick Reference".

## Rows that read as records

- Decide a row's drivers first (its state, its parent, its place), then derive every field that must agree with them. A terminal state (revoked, canceled, expired, closed) gets a note that says so or no note, never an ongoing one such as "still billing"; an active state never a note about ending; an end date is after its start date; a closed date exists only on a closed row.
- A parent's stored figure that its child rows itemize (a number a person enters, such as seats purchased over seat rows) stays at the scale of those rows, since a small dataset cannot carry a real company's numbers: at least the number of child rows and at most twice that, so with 3 seat rows, 3 to 6 seats purchased, never 120. Set the figure in the plan next to the parent's children, vary the gap between parents (none on one, a few on another), and check the plan with `assertItemized` before the first write. A figure the platform counts from the child rows is a `rollup`, not a stored figure: it needs no such check and is not in the plan.
- Give parents different numbers of children (1 to 5, about 3 on average), never the same number each: a rollup that counts them would be identical on every parent and halt the run. Check it before the first write with `assertSeedDistinct` over the per-parent counts, as the example does.
- When a computed or rollup column depends on a state of the children (inactive seats, overdue invoices), give some parents children in that state and others none, so the column differs between parents.
- Spread every enum across its values: set the state in the plan, or use `r.deal(values, n)` so every value appears before any repeats. Then derive from it, as above.
- Text that names another record (a title or summary that mentions its parent) is built from the parent in the plan, never drawn separately.
- Nothing a person reads is a base plus an index (`100 + i`, `Slack 0`, `days(-7 * i)`). Write it or draw it (`r.int`, `r.pick`). An index belongs only in a code-like unique field, through `uniq("INV-", i)`.
- Names, cities and companies vary. `assertSeedDistinct(table, rows, [columns])` fails when a column that should vary does not; use `r.tuples` for names built from two pools.
- Real company and product names are fine. Every email address is at a subdomain of `example.com`, which never receives mail: build it with `exampleDomain(company)` (`support@adobe.example.com`), never with the company's real domain. The insert refuses any other address, in any text column. A US phone uses `555-0100` to `555-0199` behind the area code; a phone in any other country stays empty.

## Computed and rollup columns

Every `computed` and `rollup` column of a seeded table (`ctype` in the read under "Before you write") goes through `assertComputedVary`, at the very end of the script, immediately before `assertSeedCounts`:

```typescript
await assertComputedVary("/subscriptions", "subscription_name", subscriptionRows, ["used_seats", "wasted_annual_cost"]);
```

On a connecting record, which has no column that differs on every row, pass the rows `postMany` returned and key on `id`: `await assertComputedVary("/seats", "id", seats, ["annual_cost"])`. This reads those rows back as a set, so it is not the position mapping that "Parents and children" rules out.

A `computed` or `rollup` column never goes in a row and is never patched: the platform writes it and overwrites what you send. Change its inputs instead.

A column with one value on every row halts the run. Fix the inputs in the plan, clear the seed and write it again (next section). Constant by design means the formula gives the same value for every possible row; a column that came out 0 on every row never qualifies. A `$user_id` stamp such as `requested_by_user_id` (`rbac.md` → "Controls on a gate") qualifies too, because a seed run creates every row as one user. Leave a column out only in those cases, never because it halted, and name it in the report.

## Changing what was seeded

`seedEnsureMany` never changes a row that is already there. A re-run of an edited script leaves the old values in place and still ends `Seed finished`, with `0 write call(s)` when every key exists. To correct one or two rows, use `patchById` on their input columns. To change a table's numbers, clear the tables and seed again:

```typescript
import { clearSeeded, runSeed } from "./seed-lib";

await runSeed(async () => {
  await clearSeeded([["/contracts", 4], ["/vendors", 3]]);   // children first, each with the count it holds
});
```

Write it as `.tmp_deploy/clear_<module_slug>.ts` and run it the way the seed script runs (check, then real). It ends `Clear finished`, which is not a seed. Then check and run the seed script.

- Only on entities this build created, and only during the build that seeded them. Later, clear a table only when the user asks: by then it may hold real records.
- List children before parents, and connecting records before either. A `restrict` relationship refuses the parent's delete, and a `cascade` relationship removes the child first, which halts the run.
- A validation rule can refuse a delete (a gate on a terminal state, for example), and a check run cannot see that because it sends no delete. When a delete is refused, stop and tell the user. The tables listed before it are already empty.
- An `is_a` family the build created whole is cleared at its root, whose count covers the records of every subtype. When the build created only a subtype on an existing base, list the subtype's own table and never the root: a delete there removes the whole record, and the root also holds records this build did not write. Never list a subtype together with its root. A `has_a` table goes before its base.
- Each count is the number of rows the seed wrote to that table: the count the last real run reported or, after a halted run, the sum of its `✓ POST` lines for that table. Every table is counted before the first delete, and a count that differs halts with nothing deleted. A difference means rows the seed did not write: stop and tell the user. Never copy the number from the error into the script.

## Report

Report a seed only from the real run's output: it ends `Seed finished: <n> write call(s) applied with no errors.`, shows every table at its count and a `✓ <table>.<fk>: all <n> row(s) name the intended parent` line for each child table (`… name the intended parents` for a connecting record) and a `✓ <table>.<column>: <n> distinct value(s)` line for each computed or rollup column (a one-row table prints `one row, so … cannot be compared` instead). State how many rows landed in each table, and name any column left out as constant by design. A check run, a run that ended `SEED HALTED` or one that ended `Clear finished` seeded nothing you can report. Do not summarize the data's meaning: that is analytics, which is a separate request.
