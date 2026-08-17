# Import Run Reference

The import script is a Bun (TypeScript) one-shot that streams the CSV with `csv-parse`, coerces per `mapping.json`, and bulk-inserts uniform-key batches through `semantius call crud postgrestRequest`. Python is not used in this skill; Bun runs identically on every platform.

**The script ships as a real file: [`import.template.ts`](import.template.ts), next to this document.** It carries no generation-time placeholders — all run configuration comes from `./mapping.json` (schema-mapping.md section 8), which it reads at startup. "Generating" the script means copying the file byte-for-byte **as `import.ts`** — done once, in the Stage 2 setup block below, never deferred to Stage 5:

```bash
cp <skill-folder>/references/import.template.ts <run-folder>/import.ts
```

**Never retype, transcribe, or per-run edit the script.** Hand-transcription is how escaping bugs and silent divergence happen; the file plus the mapping artifact make it unnecessary. The same rule covers the two helpers, [`create-fields.ts`](create-fields.ts) and [`render-plan.ts`](render-plan.ts): copy, never re-author.

## Workspace layout

Every import run gets its own scratch folder under the **current working directory**, joining the plugin's scratch-folder family beside the modeler's `.tmp_deploy/` and the admin's `.tmp_admin/`. `<cwd>` is the one path every shell, the Write tool, and the harness already agree on — no translation, no surprises — and unlike the OS temp directory it survives a sandbox restart mid-run, so an approved `mapping.json` is never lost between review and import. Do **not** write to `$TMPDIR` / `/tmp/` / `$env:TEMP`: those paths resolve differently between Git Bash and Windows-native runtimes, a recycling sandbox may wipe them, and the user cannot inspect them by path if a run fails. Add `.tmp_import/` to `.gitignore` once.

```
<cwd>/.tmp_import/run-<yyyymmdd-hhmmss>/
├── package.json          # {"dependencies": {"csv-parse": "^6"}} — created by `bun add csv-parse`
├── mapping.json          # the approved mapping (schema-mapping.md section 8) — the single runtime input
├── <file>.csvschema.json # copied introspection output
├── render-plan.ts        # copied helper: renders the mapping table + plan facts (Stage 2/4)
├── create-fields.ts      # copied helper: parallel create_field runner (Stage 4)
├── import.ts             # byte-for-byte copy of import.template.ts (copied at Stage 2 setup, run in Stage 5)
├── failed-batches.json   # written only when something fails
└── import-summary.json   # written at the end of every run
```

The workspace is created at the start of Stage 2 (the helpers need `mapping.json` beside them from the first review round). **One canonical setup block, run in full at Stage 2** — every copy lands under its **final name**, so no later stage renames anything. In particular `import.template.ts` becomes `import.ts` here; defer that rename to Stage 5 and `bun run import.ts` dies with "Module not found":

```bash
mkdir -p .tmp_import/run-<ts>                                          # from <cwd>
cp <csv-folder>/<file>.csvschema.json     .tmp_import/run-<ts>/
cp <skill-folder>/references/render-plan.ts    .tmp_import/run-<ts>/render-plan.ts
cp <skill-folder>/references/create-fields.ts  .tmp_import/run-<ts>/create-fields.ts
cp <skill-folder>/references/import.template.ts .tmp_import/run-<ts>/import.ts   # note the final name
cd "<cwd>/.tmp_import/run-<ts>" && bun add csv-parse
```

Run commands (inside the run folder, as each stage arrives):

```bash
bun run render-plan.ts                       # Stage 2: mapping table + facts
bun run create-fields.ts --dry-run           # Stage 4: exact create_field payloads
bun run create-fields.ts                     # Stage 4: create the fields (one bulk create_field call)
bun run import.ts <absolute-path-to>/<file>.csv   # Stage 5
```

The workspace lives under the project's working directory but stays out of `git status` via the `.tmp_import/` gitignore entry; it never goes into the CSV's folder or the skill folder. Always report the run folder's **absolute path** in the final summary so the user can open `failed-batches.json` and `import-summary.json` directly. Re-running an import for the same table: prefer updating `mapping.json` in the existing run folder over generating a fresh one, so `failed-batches.json` history stays in one place.

## Design rules the script implements

These are the contract `import.template.ts` fulfills — read them to understand the run's behavior, not to re-derive the code.

1. **Stream, never slurp.** `csv-parse`'s async iterator with `{columns: true, bom: true, skip_empty_lines: true}`. `columns: true` keys each row by raw header, matching `mapping.json`'s `header` keys. Works on multi-GB files.
2. **The primary key never travels (hard guard).** While id preservation is deferred (design in the README), the script strips the entity's primary key column from **every** outgoing payload — insert batches and PATCH bodies alike — silently and unconditionally, after coercion. The mapping's `id_column` is **not** assumed to be `id`: it is copied from the target entity's `id_column` property (`read_entity`). This is a runtime safety net, not a mapping convention: even a mapping that wrongly targets the primary key cannot reintroduce explicit-id inserts and the sequence desync they cause.
3. **Write modes.** With `natural_key` set, `on_exists` decides what happens to rows whose key already exists: `"insert"` skips them (counted `skipped`); `"update"` synchronizes them — the preload fetches the mapped fields too, rows whose coerced CSV values equal the live values are untouched (counted `unchanged`), differing rows are updated with a per-row `PATCH` (counted `updated`). Update mode requires the key field to be unique. A key seen twice in the same file sends the second row to the failed capture (`duplicate key in file`) — deterministic, never last-wins.
4. **Uniform keys.** Every record object carries every non-skipped mapped field, empties filled from `empty_value`. `postgrestRequest` is the raw PostgREST path: it rejects heterogeneous arrays with `PGRST102` and has no `missing=default` (the tool exposes no `prefer` input). Only the typed catalog tools (`create_field` etc.) accept mixed-key arrays — that is why the field runner can, and the row loader cannot, send ragged items.
5. **Stdin transport.** The batch payload is piped to the CLI via stdin (`Bun.spawn` with `stdin: "pipe"`); no inline JSON argument, so Windows argument-length limits and shell quoting never apply. The interactive "always pass inline JSON" gotcha is about a human shell with an empty stdin; a script that pipes and closes stdin is the documented preferred form.
6. **Batches of 250 by default** (`batch_size` in mapping.json, sane range 200 to 500) for inserts. No `prefer` key is sent: the current server strips it and always uses `Prefer: return=representation` (the tool returns a `{request, response}` envelope; the script ignores it on success). Batched upsert (`resolution=merge-duplicates`) becomes possible once the MCP passes `prefer` through — see the README roadmap; until then updates go per-row via `PATCH`.
7. **Exit-code-aware error handling.** Exit 3 (transient, CLI retries already exhausted) retries the batch up to 3 times with 1s/3s/9s backoff. Exit 5 (auth) aborts immediately. Exit 4 or anything else captures the batch (index, row range, stderr, rows) into `failed-batches.json` and continues; the run ends with exit 1 if anything failed.
8. **Row-level validation before batching, coercion by exception.** The coercion switch handles only the families that genuinely need it (`integer`/`number` parse, `boolean` via `bool_pair`, `date`/`date-time` validation); its `default` branch passes every other format through verbatim, so `email`, `url`, and any future format flow untouched (server-side validation failures land in the batch-level capture). A cell that cannot coerce (unparseable number, unknown bool token, invalid date) sends the whole row to the failed capture with a reason instead of poisoning its batch. `ColumnSpec.format` is a plain `string` — known values are a comment, never a closed union the script enforces.
9. **Preload doubles as the diff source.** With `natural_key` set, page `GET /<table>?select=<key>,<mapped fields>&order=<key>&limit=1000&offset=N` until a short page, building a map of key → live values. Insert mode uses only the key set; update mode compares coerced CSV values field-by-field against the live values (strict equality after coercion, so `"1"` vs `1` is not a change) to decide untouched vs `PATCH`. Without a natural key the script is a plain insert; re-running it duplicates rows and the script says so in its banner.
10. **Progress on stderr, summary on stdout.** One line per batch (`batch 12/40 ok - 3000/9873 rows`) and a periodic update-progress line in update mode; the final line of stdout is the JSON summary (`parsed / inserted / updated / unchanged / skipped / failed / ...`), also written to `import-summary.json`, so the calling skill parses one object.
11. **Built-in count verify.** After the last batch the script compares the server row count (`GET /<table>?select=count`, reading `[{"count": N}]`) against `preexisting + inserted` and exits non-zero on mismatch. Skipped and failed rows are excluded from the expectation. It also checks `parsed` against `expected_records` (the introspection's `record_count` on full scans) and flags a mismatch as a parsing defect.

## The field-creation runner (`create-fields.ts`)

Stage 4's field creation goes through the copied runner, never an ad-hoc shell loop and never one `create_field` per column. Its contract:

- Selects `disposition: "create"` columns from `mapping.json` and creates them in **one bulk `create_field` call**: `data` is an array of every field object (up to 100 per call — a wider file is chunked into a few calls). The typed tool accepts items with different keys (`enum_values` on one, `precision` on another; the server sends `?columns=<union>` with `Prefer: missing=default`), inserts the whole array in one request and one transaction (all-or-nothing per call), and answers with an array. Explicit `field_order` from the mapping (increments of 10 starting at 30) makes the position in the array meaningless.
- **Idempotent**: reads the live fields first and skips names that already exist, so a re-run after a failure never double-creates (a re-run over an already-created entity issues zero `create_field` calls).
- **Transient-tolerant, fail-fast on real errors, loud always**: exit 3 (transport) is retried per call up to 3 times with 1s/3s/9s backoff, the same policy as the import script — and before each retry the live fields are re-read so rows that landed despite the lost response are dropped from the resend (a blind resend would 409 and fail the whole call). Exit 4 (validation: a bad mapping, where continuing is genuinely pointless) and exit 5 (auth) never retry; because the call is one transaction, a failed call landed **nothing** — every field of it is `failed` with the platform's first stderr line, later calls are `not-run`, and there is deliberately no per-field fallback loop (fix the cause and re-run). Every requested field gets a row in the final result table (`ok` / `failed` / `skipped-exists` / `not-run`). The script exits 1 on any failure (5 on auth) — a failed create can never scroll past silently.
- **Verified**: after the calls succeed it re-reads the live fields and asserts every requested name is present (never trusts the create response); a missing name is reported `failed`.
- `--dry-run` prints the exact bulk payload(s) — `{ "data": [ …field objects… ] }` per call — without writing (offline, no read); used for the pre-write confirmation gate and for verification.

## mapping.json checklist (before running anything)

The old generation-time checklist is now a checklist on the artifact, verified once after the review loop approves it (`render-plan.ts` warns about several of these automatically):

- [ ] Every column has a `disposition`: `create` / `exists` / `label` / `skip` — and skipped columns carry a `reason`.
- [ ] Exactly one column has `disposition: "label"` for a new entity (the auto-created label column: imported, never `create_field`), and no `field_name` targets an auto-generated column (`created_at`, `updated_at`, `label`) or the entity's primary key.
- [ ] Every `create` column carries `title`, `format`, and `field_order` in increments of 10 starting at 30 (10 and 20 belong to the auto-created fields); `precision` on `number` columns; `enum_values` on confirmed enums; `input_type` per the review; `unique_value: true` on the natural key when update mode is planned.
- [ ] Every `boolean` column carries its `bool_pair` from the introspection.
- [ ] Digit-leading field names were renamed during the review.
- [ ] `natural_key` is a **field name** present among the non-skipped columns, or absent/null.
- [ ] `on_exists` matches the review decision; `"update"` only when the key field is unique (`unique_value: true`).
- [ ] `id_column` equals the target entity's live `id_column` (from `read_entity`; `id` only for entities this skill just created).
- [ ] `expected_records` carries the introspection's `record_count` on full scans, `null` when the scan was capped.
- [ ] When the diff chose coerce-into-live for a mismatched column, that column's `format` is the **live** field's format, so validation routes incompatible rows to the failed capture.
- [ ] After a successful run, report the summary with the run folder's absolute path and leave the folder in place (the user may want `failed-batches.json` and `import-summary.json`); `.tmp_import/` is gitignored and the user manages cleanup — the next run gets its own folder.
