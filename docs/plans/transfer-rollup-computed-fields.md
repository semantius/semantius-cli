# Plan: export and import rollup and computed fields

Status: **implemented and verified on a real platform 2026-11-03** (§6), committed as `b0211a0` with
ubuntu and Windows CI green. The work also found a Linux hang that is already shipped (§8) and a
platform bug that loses rollup totals (§7). Raised while syncing `postgrest-mcp` with the platform's
rollup commits (`semantius` `a933308`, `4dd0339`).

The transfer tools (`export_module`, `export_entities`, `import_module`, `import_entities`)
were written when a non-empty `ctype` meant "core column". The platform has since added two
derived values, `rollup` and `computed`, that do not mean that. As a result a module with a
computed field can no longer be restored from its export, and rollup definitions are not
exported at all.

Line numbers refer to the code as of `64e8895` (CLI) and `4dd0339` (`semantius`).

## 1. What is broken today

| # | Problem | Where | Effect | Evidence |
|---|---|---|---|---|
| 1 | A new field with a derived `ctype` counts as core and is skipped | `import.ts:576-578` | With records, the import stops at `records of accounts: the target has no column score`, after the schema was written, and a re-run fails the same way. With `exclude_data`, it reports success and the field is missing. | Reproduced (below) |
| 2 | An existing derived field counts as core | `import.ts:576,587` | A changed `format` or `default_value` in the file is never applied | Read |
| 3 | `rollup` is not in the file | `format.ts:143` takes `FIELD_COLUMNS` from the vendored `fieldSchema`, which has no `rollup` at `64e8895` | Export drops every definition. The file keeps `ctype: "rollup"` and the values, so the backup looks complete. | Read |
| 4 | Fields are written in file order | `import.ts:570-617` | Once 1 and 3 are fixed, a rollup whose link or value field comes later in the file is refused (`90262`, `90264`). `exportModule` sorts entities by name, so `customers` over `orders` hits this. Patches to existing fields run before any insert, so they can hit it too. | Read |
| 5 | Rollup columns are written as record data | `import.ts:754-759` skips audit and computed columns only | The platform ignores the written value, but the import still compares it. When the target's total differs from the file's (the child records are not in the file, for example), the row counts as changed and is rewritten on every run. | Read |

**Reproduction of 1.** A scratch copy of `tests/transfer.test.ts` seeded `accounts.score` with
`ctype: 'computed'` and `input_type: 'disabled'`, the state the platform leaves, and imported
the export onto an empty target:

- With records: `Error: records of accounts: the target has no column score`.
- With `exclude_data`: success, and `target.row('fields', 'accounts.score')` is missing.
- Control, the same field with `ctype: ''`: imports correctly.

**Why the tests pass.** `tests/helpers/fake-postgrest.ts` never derives a `ctype`, and the test
at `tests/transfer.test.ts:959` seeds its computed field with an empty one.

**Who is affected.** Any module with a computed field that is not the label column; no rollup
is needed. The platform marks a field when the field or its rule is written
(`0210_computed_validation.sql:587-605`). I found no migration that marks existing rows, so on
an upgraded database a field becomes affected the next time either is saved.

## 2. Platform behaviour this relies on

Full rules are in `semantius/docs/rollup-fields.md`.

- **Core or not.** `dd_ctype_is_core` is `coalesce(ctype, '') NOT IN ('', 'rollup', 'computed')`
  (`0160_dd_functions.sql:1442`). `get_schema` and `ensure_entities` key on it too.
- **`ctype` is never taken from a client.** A value sent on insert is replaced, and changing
  one on update fails with `90214`. The CLI already never writes it (`FIELD_READ_ONLY`).
- **Rollup validation needs its fields to exist.** The BEFORE trigger on `fields` looks up
  `link_field` (`90262`) and `value_field` (`90264`) when the definition is saved.
- **A filter needs its columns too.** Each `var` of a rollup's `filter` is looked up in
  `pg_attribute` of the child when the definition is saved, and a missing column is refused with
  `90265` (`0440_rollup.sql:149-158`). A filter can depend on another rollup just as `value_field`
  can.
- **Concurrent child writes are not safe.** Two statements over shared parents can leave a total
  wrong with no error (measured, §6 and §7). The platform's doc also says they can deadlock with
  `40P01` (`rollup-fields.md`, "Cost and concurrency"), since the generated trigger updates parents
  in no fixed order (`0440_rollup.sql:847-850`). That happens too: 2 of 9 runs at 50,000 lines (§6).
- **`ensure_entities` is the precedent for order.** It applies a field with a non-empty `rollup`,
  new or changed, after every other field of every entity and before the deferred entity
  columns (`0290_ensure_entities.sql:693-716`).
- **The guard ignores written values, with no error.** On insert a rollup column starts as the
  empty aggregate; on update a changed value is recomputed.
- **Derived `input_type`.** `default` and `readonly` become `disabled` on both kinds of field.
- **Saving `computed_fields` recalculates existing records.** A record that cannot take its new
  value refuses the save with `90908`, which the import reports like any other error.

## 3. Decisions

**D1. Copy the platform's rule.** `isCoreCtype(ctype)` is true for a non-empty value other than
`rollup` and `computed`, as in `dd_ctype_is_core`. A future unknown value counts as core there
too.

**D2. No format version bump.** `TRANSFER_VERSION` stays 1. `rollup` is one more key on a field,
and a file without it still imports, because `changes()` skips a key the file does not set.

**D3. Export `rollup: {}`, but leave it out when inserting an ordinary field.** Exporting the
empty value is how removing a definition reaches a re-import, and it matches `input_type_rule`.
The cost is one more line per field on the next export. On insert `{}` is the column default,
and leaving it out lets the file still import onto a platform without the column, where
PostgREST would refuse it (the older-platform guard in `changes()` covers patches only).

**D4. Rollups go last, whole, one request each, dependencies first.**
- *Last:* the same rule as `ensure_entities`, and before the deferred entity columns.
- *Whole:* the entire patch of the field waits, not just its `rollup` column, because `90268`
  checks the format and the definition together.
- *One request each:* there are few rollups, each one runs DDL anyway, and a failure names
  the field.
- *Dependencies first:* a rollup may sum another rollup or filter on one, and the file order
  does not respect that. `ensure_entities` does not sort these; the CLI must, since it controls
  neither name order nor what users model.

**D5. Rollup columns stay in exported records and are skipped on import.** This is what already
happens with computed columns. The target's `ctype` decides, so a value is written when the
target's field is an ordinary one.

**D6. Refuse a file with the marker but no definition.** Accepted 2026-11-03.
A field with `ctype: "rollup"` and no non-empty `rollup` comes from a CLI affected by problem 3.
Importing it would silently create a plain column frozen at the exported values. Refuse before
any request, and say how to proceed:

> `orders.subtotal: the file marks it as a rollup but carries no definition, so an older CLI
> exported it. Export it again, or add the definition under "rollup" in the file.`

The alternative, rejected, was to warn and restore the plain column. That restores more without
a hand edit, but a report of success would hide the lost derivation. The source may be gone (the
backup was taken before a delete), which is why the message offers the hand edit.

The refusal comes before any request, so it also covers a re-import onto a host that still has
the definition, where the file would do no harm. Few files are affected: no tagged platform has
rollups yet (`semantius` is at `v0.5.0-beta1-5-g4dd0339`), so only a CLI up to 0.8.26 exporting
from an untagged build can have written one.

**D7. Write a table a rollup aggregates over one batch at a time.** Import writes up to four
batches of a table at once (`import.ts:62,839`). D4 puts the rollups in place before the records,
so each batch of a child table now updates its parents, and batches share parents. On a real
platform that leaves totals wrong with no error (§6, §7). Use the mechanism self-referencing tables
already use. It costs almost nothing: about 3.2 s against 3.1 s for 50,000 rows. The list of tables
comes from the target's `fields?ctype=eq.rollup`, not from the file, because the parent may not be
in the file.

Also add `40P01` to `RETRY_CODES`, because such statements do deadlock (§6) and other writers on a
live target remain possible. PostgreSQL rolled the statement back, so replaying it is safe.

**D8. Modules that depend on each other through a rollup: document, do not defer.** Accepted
2026-11-03. Take a rollup in `crm` over `orders` in `sales`, where `orders.customer_id` references
`crm`. Neither module can be restored first: `crm` needs the link field (`90262`), and `sales` needs
the entity it references. The imports still converge, because each one resumes where it stopped:

1. `import_module crm` creates its entities and ordinary fields, then stops at the rollup.
2. `import_module sales` creates its schema, then stops at the records that reference `crm`.
3. `import_module crm` again: the rollup saves and the records are written.
4. `import_module sales` again: the records are written and the totals move.

Deferring the rollup on `90262` would avoid the failures, but only by making an import report
partial success, a state these tools do not have. Step 8 documents the sequence instead.

## 4. Steps

Land steps 1-8 together: after step 1 alone, export includes rollups but import writes them in
the wrong order.

### Step 0: commit in `postgrest-mcp`

Done: `9b702d5`, pushed to `origin/semantius`.

### Step 1: sync

Done, uncommitted: `UPSTREAM` moved from `9f48854` to `9b702d5`, which also brings in `bcb951a`.
With only this in place, `sync-mcp-tools:check` passes and the full suite is green (798 pass,
31 skip). Commit it with the steps below, not alone.

### Step 2: `format.ts`

Add `isCoreCtype` (D1) next to `CORE_FIELD_FIXED`, and correct that constant's comment, which
says `ctype ≠ ''`.

### Step 3: `import.ts`, `importSchema`

Split the field step (`:559-617`) in two, sharing one helper for the patch logic so `core` and
`fixed` live in one place:

```ts
const hasRollup = (f: Row) =>
  !!f.rollup && Object.keys(f.rollup as object).length > 0;

// 2a. Every other field, as today. `rollup: {}` stays here: removing a
//     definition depends on nothing, and a new ordinary field omits the key.
// 2b. Then the rollups, new or changed, one request each.
for (const { table, field } of orderRollups(pending)) { /* insert or patch */ }
```

Replace line 576 with `isCoreCtype(f.ctype) || isCoreCtype(current?.ctype)`. Use
`creating rollup field <table>.<field>` as the `withContext` text in 2b.

### Step 4: `graph.ts`

Add `orderRollups`, a stable topological sort. A rollup waits for another pending rollup when
its `value_field`, or any `var` of its `filter`, is that rollup's `field_name` on the `link_field`
entity. A cycle or a malformed `link_field` keeps file order, so the platform answers with `90267`,
`90265` or `90262`. The CLI does not reimplement those checks.

### Step 5: `import.ts`, `importRecords`

Add `f.ctype === 'rollup'` to the `skip` set (`:754-759`), and update the `skip` comment on
`TableState` (`:676`). `prepare` and `writeBatch` then leave those columns out of both the write
and the comparison.

For D7, read the target's rollups once, mark the tables their `link_field`s name, and give those
tables `new InFlight(1)` in `writeTable` (`:839`), as a self-referencing table has. Read with
`select=*`: a target on an older platform has no `rollup` column and simply returns no row.

### Step 6: `import.ts`, `importTransfer`

Add the D6 refusal right after the `kind` check (`:102`), before `importModule` sends anything.

### Step 7: `postgrest.ts`

Add `40P01` to `RETRY_CODES` (`:39`), and say why in its comment (D7).

### Step 8: text

- The header comment of `import.ts`, step 2.
- The descriptions in `src/local-tools/import-module.ts` and `import-entities.ts`: rollup and
  computed columns are calculated by the target, never written from the file, and a rollup's child
  entity must be in the file or already on the target. `import_module` also gets the D8 sequence:
  modules that depend on each other through a rollup are restored by re-running each.
- `AGENTS.md`, "Transfer files carry names, not host ids": a new rule covering D1, D4 and D7.

### Step 9: gates

`bun run typecheck`, `bun run lint`, `bun test --timeout 60000` and the ubuntu CI job, as
`release.sh` checks them. The 6 `typecheck` errors seen during review were stale local packages:
`bun install --frozen-lockfile`, which the release script runs first, clears them.

Local results, before any commit:

- Windows: typecheck and lint clean, 821 pass, 31 skip, 0 fail.
- Linux (`oven/bun:1.3.12` with Node, in Docker): typecheck and lint clean, 837 pass, 10 skip, 1 fail.
  The failure is `requests go direct again once the daemon is gone`
  (`tests/postgrest-proxy.test.ts`). It fails the same way on a clean `64e8895` in that container
  when the whole file runs, passes alone, and the ubuntu CI job is green at `64e8895`.
- A second test, `pipes the PostgREST body to stdout byte for byte` (`tests/stream.test.ts`), later
  began failing in that container when its whole file runs, and fails the same way on a clean
  `b0211a0`. It passes alone and in CI. Why it flipped was not found.
- The ubuntu CI job is green on `b0211a0`. The later fix for unfilled platform errors (§8) has not
  been through CI yet.

## 5. Tests

**Fake (`tests/helpers/fake-postgrest.ts`).** Imitate only what the import depends on:

- A `rollup: {}` default on `fields` (`:331-352`).
- On a `fields` write with a definition: refuse a missing or wrong link field (`90262`) and a
  missing value field (`90264`), a `filter` `var` with no column on the child (`90265`), set
  `ctype: 'rollup'`, and turn `default` and `readonly` into `disabled`. With `{}`: clear the marker.
- On an `entities.computed_fields` write: mark and unmark the named fields as the platform does,
  leaving the label column alone.
- In `triggers` (`:808`): the rollup guard, where an insert stores the empty value and an update
  keeps the stored one.

Do not model the aggregates. Whether totals are right is the platform's job, covered in §6.

**`tests/transfer.test.ts`:**

1. Computed field round trip, with records and with `exclude_data` (the §1 reproduction).
2. An existing computed field takes a changed `format`; a label field still does not.
3. Rollup round trip where the parent sorts before the child: the link field is written first.
4. Nested rollup with the outer one first in the file, through `value_field` and through a
   `filter` `var`.
5. A rollup added to an existing field, with its link field new in the same file.
6. `format` and `rollup` changing together arrive in one PATCH.
7. `rollup: {}` removes a definition on re-import; the field and its values stay.
8. An ordinary new field's POST has no `rollup` key, a rollup's POST has one, neither has `ctype`.
9. Upserts leave out rollup columns, and a target total that differs from the file's is not a
   change.
10. Re-importing an unchanged file with both kinds of field sends no write.
11. D6: refused before any request, naming the field. This follows the existing "a file of another
    version" test.
12. `orderRollups` on its own: dependency order through `value_field` and `filter`, stability, a
    cycle, a field that sums itself, a malformed `link_field`.
13. D7: batches of a table a rollup aggregates over never overlap, including when the parent is
    not in the file; batches of any other table still may.
14. D7: a `40P01` answer to an upsert is replayed.
15. D8: the four commands, against the fake.
16. D2: a file with no `rollup` key at all still imports.
17. §8: a records block with far more of the file after it ends.

## 6. Verification on a real platform

The fake cannot prove the platform's side, so run this against disposable hosts. No tag contains the
rollup commits, and `semantius-self-hosted` runs published images, so the hosts need a local image.
Do not use `semantius/docker-compose/test.sh` for it: it wipes the `semantius` stack's data volume
and overwrites `ghcr.io/semantius/postgres:latest`. Use a compose project of its own instead: two
`postgres18-ext:local` databases (`deno task extension <version> --check` shows whether that image's
source is current), two PostgREST instances on a local HS256 secret, and a proxy for the `/rest`
prefix. On a fresh database the first user to sign in is the administrator, so a locally signed token
is enough. Give the CLI `SEMANTIUS_HOST` and `SEMANTIUS_JWT`, since `--host` ignores credentials from
the environment, and redirect `APPDATA`, `LOCALAPPDATA` and `HOME` as for any spawned CLI.

Use Northwind, plus two rollups added by hand. Northwind alone would pass by luck: `order_details`
sorts before `orders`, so its one rollup never meets the ordering problem.

- `customers.order_count`: `count` over `orders.customer_id`, format `int64`.
- `customers.orders_subtotal`: `sum` over the same link with `value_field: "subtotal"`, a nested
  rollup, format `number`.

Then:

1. `export_module`: the file carries all three definitions.
2. `import_module` onto an empty target: no error, and `/fields?ctype=in.(rollup,computed)` lists
   the same fields as the source.
3. `order_details.amount`, `orders.subtotal`, `orders.total` and both `customers` rollups match the
   source.
4. Re-import: every count is `unchanged`, and the debug log shows no write.
5. Add an order line on the target: the totals move up both levels, and the customer's
   `updated_at` does not, because only rollup columns changed there. Do not check this on the
   order: `orders.total` is computed from the rollup, so an ordinary column moves too.
6. `bun run sync-mcp-tools:check` passes. It is the release gate (`release.sh:122`).
7. D7: Northwind cannot exercise this, since `order_details` (2155 rows) makes two batches over
   mostly separate parents and `orders` (830) makes one. Add a child table of about 10,000 rows over
   a few parents, give the parent a rollup over it, and import: no `40P01`, and the totals match.
8. D8: split a child and its parent into two modules, export each, and restore them onto an empty
   target with the four commands of D8. The third and fourth succeed, and the totals match.

### Results, 2026-11-03

Platform `v0.5.0-beta1-5-g4dd0339`, in a disposable compose project, with a third rollup added to
Northwind: `customers.big_orders`, a count filtered on the rollup `orders.subtotal`.

| Step | Result |
|---|---|
| 1-3. Northwind, source to empty target | All definitions in the file; the same 7 rollup and computed fields on both hosts; 0 of 2155, 830 and 91 rows differ |
| 4. Re-import | Everything `unchanged`; the proxy log shows no write |
| 5. New order line | Subtotal, total and the customer's total each move by 200; the customer's `updated_at` does not move |
| 6. Drift check | Passes |
| 7. D7, 50,000 lines over 2,050 parents and 5 groups | Correct in 3 of 3 runs on Windows and 1 of 1 on Linux; also 15 of 15 at 10,000 lines |
| 8. D8, the four commands | `90262`, then `23503`, then both succeed; totals match; both re-imports write nothing |

The fixes, each removed in a patched copy of the CLI, to show it is needed:

| Removed | Result on the real platform |
|---|---|
| D7 | 50,000 lines, 9 runs: 7 report success with wrong totals, 28 to 62 parents and all 5 groups, and 2 stop with `40P01`. 10,000 lines: 3 of 7 runs wrong, 1 parent and its group each. |
| `filter` in `orderRollups` | Northwind is refused: `90265`, `column subtotal does not exist on orders` |
| The `sliceStream` fix, on Linux | The import stalls until the call times out. The fix then finishes it on the same target in 2.7 s. |

## 7. Out of scope

- **Files exported before the platform upgrade.** A computed field stored as `readonly` is coerced
  to `disabled`, so that one file patches it on every import. It is harmless, and a new export
  fixes it.
- **Rollups whose child is neither in the file nor on the target.** `90262` is the right answer
  when the child is not coming. When it is coming from another module, see D8.
- **Rare re-imports onto an existing target.** From reading only. The first two stop with an honest
  error; the last two end correct or harmless:
  - The file narrows a child's `view_permission` and adds `include_hidden_rows`: `90269` at the
    entity step, before the flag is written, and a re-run fails the same way
    (`0440_rollup.sql:1409-1416`).
  - A field changes from computed to rollup: `90261`, because rollups are saved before
    `computed_fields` (`0440_rollup.sql:506`).
  - A computed rule is removed and the file sets `input_type: default`: it stays `disabled` while the
    rule is still named (`0210_computed_validation.sql:596-600`), and the next import corrects it.
  - A value field's `precision` changed after its rollup was created: the file keeps the old one and
    the platform replaces it on save (`0440_rollup.sql:1193`), so that field is patched on every
    re-import.
- **Partial totals during an import.** Parents are written before children, so a parent rule that
  tests a rollup sees partial totals and may refuse a child write. Ordinary writes behave the
  same way.
- **Locks from saving `computed_fields`.** The tables it writes take no other writes until that
  request commits, on any target with records.
- **Elsewhere, to raise separately:**
  - `semantius`, **a data bug: concurrent child writes can lose a rollup total, with no error.** It
    needs no CLI and no bulk write. In one session, `BEGIN`, insert a child with amount 5, and wait.
    In another, insert a child of the same parent with amount 5. Commit the first. The stored total
    is 5 short of the sum of its rows, in 3 of 3 runs; with amounts 5 and 7 it is correct, in 3 of 3.
    The next write to a child of that parent corrects it. The likely cause, from reading the generated
    SQL: each statement computes its total from its own snapshot, and after the lock wait PostgreSQL
    re-checks the `IS DISTINCT FROM` gate (`0440_rollup.sql:848`) against the first writer's committed
    total. If the two are equal the row is skipped, so the guard that would recompute (`:958-959`)
    never runs. D7 keeps an import's own batches apart, but not an import from other writers, and
    `rollup-fields.md` says writers to one parent serialize, which does not hold for the aggregate.
    A `count` loses one on every overlapping pair, whatever the amounts. The report, with a
    reproduction and a tested fix, is `semantius/plans/2026-11-03-1130-rollup-lost-totals.md`.
  - `semantius`: `ensure_entities` applies rollups in document order, so a `.jsonc` listing a
    nested rollup before the one it sums would hit `90264`. From reading only.
  - `postgrest-mcp`: `delete_module` tells agents to back up with `export_module`, which only the
    CLI has.
  - `postgrest-mcp`: `src/db/hook.ts` drops only `readonly` fields, so webhook payload values for
    derived fields now reach the write.
  - `semantius-agent`: `skills/` is synced from there, so any rollup guidance for the skills
    belongs in that repo.

## 8. Found during implementation: imports hang on Linux

This has nothing to do with rollups, and it is in `v0.8.26`. On Bun 1.3.12 for Linux,
`Bun.file(p).slice(a, b).stream()` delivers the slice's bytes and then never closes, unless the
slice reaches the end of the file or stops close to it. `sliceStream` only looked at its byte count
when the next chunk arrived, so it waited forever and the import stopped making progress.

- **Without any CLI code:** on a 4 MB file, `slice(0, 1000).stream()` hangs on Linux. A slice that
  reaches the end of the file ends. On Windows the same call returns about 3.9 MB, the half of this
  that `sliceStream` already handled.
- **On a clean `64e8895` on Linux:** restoring a small table followed by a large one (a 2 MB file)
  never finishes.
- **Why the tests missed it:** small files do not show it. A 1 KB slice ended with 512 KB after it
  and hung with 1 MB after it, and the largest existing test file is about 200 KB. D7's test found
  it. The exact size is not a rule to rely on.

- **On a real platform on Linux:** with the old stream, an 8.6 MB import stalls until the call times
  out, which the user sees as `Request timed out`. The fix finishes it on the same target in 2.7 s.

The fix leaves the stream as soon as the bytes are in, instead of waiting for the next chunk.
`AGENTS.md` records both halves. It goes in the same commit as the rollup work.

**Also found: platform errors were shown unfilled.** The platform's messages are templates that the
client must fill from the JSON hint (`semantius/docs/error-contract.md`, client rule 3), and no path in
the CLI did. It first showed in D8's expected error, `Rollup ${field_name} on ${table}: …`, and it
applies to every platform error, not just rollups. The transfer client printed the raw JSON after the
template, and `--stream` and the crud tools dropped the hint, so there the values appeared nowhere.
`formatPostgrestError` in `postgrest-mcp` (`5ca01ef`) now serves all of them, the CLI through its
vendored copy, and also keeps the parameters no template named. The `--crud-mcp` route shows the fix
once the remote server is deployed from that commit.
