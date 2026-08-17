# semantius-importer CHANGELOG

This file is history, not contract: it is **not** loaded into context at runtime. The body of `SKILL.md` is always the current contract. Newest entries first.

## 1.4

Bulk field creation: one `create_field` call instead of one per column.

- The crud server (postgrest-mcp "array inserts") and the CLI ("add array support") now take `data` on every typed `create_*` as one object **or an array** (items may have different keys — the server sends `?columns=<union>` with `Prefer: missing=default`; one request, one transaction, all-or-nothing; the response is always an array), and `id` / `table_name` on `update_*` / `delete_*` as a value or an array. `--single` is rejected (`SINGLE_ARRAY_INPUT`) with any array argument. Platform golden rule: more than one record of the same kind pending → ONE call.
- `references/create-fields.ts` rewritten around that: every `disposition: "create"` column goes into **one bulk `create_field` call** (up to 100 per call; the pool-of-5 concurrency runner is gone). Kept: `mapping.json` in, `--dry-run` (now prints the exact `{ "data": [ … ] }` payload per call), read-before-create idempotency, exit-3 retry with 1s/3s/9s backoff (now per call, and re-reading the live fields before each retry so rows that landed despite a lost response are never resent), fail-fast on exit 4/5, the `ok / failed / skipped-exists / not-run` result table, exit codes 0/1/5. New: after the calls succeed the live fields are re-read and every requested name must be present; a failed call is reported as "nothing from this call landed" (one transaction) with the platform's first stderr line, and there is deliberately no per-field fallback loop. Verified live: 6 heterogeneous fields in one call, re-run issues zero calls.
- Both baseline permissions of a new module go out in one `create_permission` call (SKILL.md Stage 4 step 1, importer-essentials.md module block).
- Docs aligned: SKILL.md Stage 4 step 3 and the safety-net table (new "Several records of one kind" row; the `postgrestRequest` row now says the typed tools take mixed-key arrays while the raw path still needs uniform keys or `?columns=` with NULL for omitted keys), import-script-template.md (runner contract, design rule 4), importer-essentials.md (response shapes, order line, fields example as an array), schema-mapping.md section 2 ("one bulk call" instead of "concurrently"), README.

## 1.3

Run workspace moved out of the OS temp directory.

- The run workspace is now `<cwd>/.tmp_import/run-<ts>/` (gitignored; same scratch-folder family as the modeler's `.tmp_deploy/` and the admin's `.tmp_admin/`) instead of `<os-tmpdir>/semantius-import/run-<ts>/`. Sandboxes can wipe the OS temp directory when they restart mid-run, which lost the approved `mapping.json` and the `failed-batches.json` history; cwd survives a restart and stays inspectable by path. The `bun -e 'os.tmpdir()'` resolution step is gone.
- Retention unchanged: run folders persist after the run (re-run reuse, failure history in one place); the user manages cleanup. The three run scripts needed no changes — they resolve `mapping.json` and their outputs relative to their own location.
- The use-semantius webhook-import pure-shell variant likewise dropped its literal `/tmp/wh_response` for a cwd-relative `wh_response.tmp` (also fixes the fixed-filename collision across concurrent runs).
- `field_order` for created fields now starts at 30 (30, 40, 50, ...) instead of 10 — positions 10 and 20 are already occupied by every entity's auto-created fields. `render-plan.ts` warns on `create` columns with `field_order` below 30.
- Four fixes from a live test run (each failure observed once, now structural):
  - Workspace setup is one canonical block at Stage 2: mkdir plus all four copies under their **final names** — including `import.template.ts` → `import.ts` — plus `bun add csv-parse`. Previously the `import.ts` rename was documented only in Stage 5 while setup ran in Stage 2, so the copy kept the template name and Stage 5 failed with "Module not found".
  - `create-fields.ts` retries exit 3 (transport) per field up to 3 times with 1s/3s/9s backoff, matching `import.template.ts`; fail-fast is reserved for exit 4 (validation, where continuing is pointless) and exit 5 (auth). One transient `SERVER_CONNECTION_FAILED` no longer kills a 30-field run.
  - New per-stage command checklist at the top of the SKILL.md workflow: a stage counts as run only when its listed commands ran; substituting a variant call (a bare `read_entity '{}'` for Stage 3's `--single` read + field-overlap sweep) is skipping the stage. The Stage 3 sweep is what prevents duplicate entities on a populated instance.
  - Stage 6 spot-reads select `<id_column>,<label_column>,<sample fields>`, never `select=label` — the computed `label` is a read-time projection, not a PostgREST column, and the probe fails with `42703` (verified live; also noted in importer-essentials.md). New rule: probe errors are findings — an errored verification probe goes into the report verbatim as failed/not-verified, never reasoned away into a pass.

## 1.2 

Determinism and throughput rev, driven by a real HubSpot-leads import: no more hand-transcribed scripts, no more prose arithmetic, no more serial field creation, plus the "introspection verdict is gold" rule.

- Verdict is gold: the `get_csvschema` output is the authoritative default for every `format` (and `precision`, `enum_values`, `input_type`, boolean pair). Overrides are user decisions raised via `AskUserQuestion` (defaulting to the introspected format), never silent mapping edits; a mapping that deviates without a recorded user answer is a defect (schema-mapping.md section 2, quirk 3, SKILL.md Stage 2).
- The import script ships as a real file, `references/import.template.ts`, copied byte-for-byte into the run folder; it reads all run configuration from `./mapping.json` at startup. The fenced markdown template and its generation-time placeholder filling are gone (transcription was a standing escaping/divergence risk; a nested-template-literal failure burned a cycle in the field).
- mapping.json contract v2 (section 8): per-column `disposition` (`create` / `exists` / `label` / `skip`) replaces the `skip` boolean; columns carry the full `create_field` payload data (`title`, `precision`, `enum_values`, `input_type`, `unique_value`, `reference_*`, `default_value`); new top-level `expected_records` and optional `batch_size`. The artifact is the single runtime input for all three scripts.
- New helper `references/render-plan.ts`: renders the Stage 2 mapping table and every plan/report count straight from mapping.json. The skill pastes its output instead of restating numbers in prose ("35 → 33 → created 34" can no longer happen).
- New helper `references/create-fields.ts`: parallel field creation (concurrency 5) with explicit `field_order` in increments of 10 — the platform preserves explicit order, which removes the old "create serially in CSV column order, no field_order" constraint (34 serial creates took 158s, about two thirds of the run's wall time). Idempotent via read-before-create, fail-fast, per-field exit code and stderr in a result table (the ad-hoc bash loop it replaces swallowed errors), `--dry-run` feeds the pre-write gate.
- Step 0 hard gate trimmed: reads the new `references/importer-essentials.md` (a ~150-line distillation) instead of ~2100 lines of use-semantius up front; the full references are consulted on demand and still win on conflict. The run workspace is now created at the start of Stage 2 so mapping.json and the helpers live together from the first review round.
- Writing conventions inlined into SKILL.md (US English, no em-dashes in chat, plain language, narration restraint, data fidelity) — the old cross-skill pointer to the modeler sat outside the hard gate and was never read.
- The deferred id-preservation design (Status banner, two DEFERRED comment blocks) moved wholesale into the README's "Deferred design" section, out of the runtime contract.
- Shared preflight (in `semantius-admin`): a successful `getCurrentUser` probe now ends credential handling regardless of auth mechanism (API key, JWT preauth); only explicit auth evidence (exit 5 / 401 / 403) triggers the API-key path, and transient errors re-probe once instead of touching `.env`.

## 1.1

Updated for semantius-cli v0.8.3 (vendored csv-schema 2.0.0), added the update write mode, and deferred id preservation. A `README.md` now carries the skill's visible status: what works, what is disabled and why, and the roadmap (MCP `prefer` passthrough for batched upsert; platform `fix_id_sequence` RPC).

- Contract: `get_csvschema` now returns a wrapper `{id_mode, id_move_column?, record_count, fields}`; per-field `input_type` ("required", present only when no empties were seen) is passed through to `create_field` as the proposal; the format set is documented as open (`email` / `url` arrived) with a passthrough fallback rule — unlisted formats go to `create_field` and through the script verbatim.
- Write mode: with a natural key, the mapping review now asks `on_exists` — `insert` (existing keys skipped) or `update` (default offer): existing records are synchronized via diff-then-PATCH (unchanged rows untouched, changed rows updated, new rows batch-inserted); requires a unique key field. Batched upsert replaces the PATCH path once the MCP passes the `prefer` header through (today the server strips it — earlier `prefer` payload keys were silently ignored, now removed from the template).
- id handling: preservation of source ids into the platform primary key (`id_mode` "id"/"move") was implemented, then **deferred**: explicit-id imports leave the id sequence behind and the first platform-side insert collides (verified live). The design is kept under marked DEFERRED blocks and returns once the `fix_id_sequence` RPC (SQL in the README) is installed. Active policy: id-named columns rename to `external_id` (offered as the unique natural key); an `id_move_column` stays an ordinary integer field.
- Detection: when no matching table exists, the skill now asks whether to create the derived entity or target an existing one (candidates ranked by name similarity and field overlap) instead of silently creating.
- Verification: `parsed` is checked against the wrapper's `record_count` on full scans (script `EXPECTED_RECORDS`); capped scans are warned against (they degrade formats and suppress id detection).

## 1.0

Initial release.

- Workflow: introspect (`utils/get_csvschema`) → map & review → detect & diff → decide & create → batched import → verify.
- Three operating modes: full import, schema-only (create the entity, import nothing), compare-only (classified diff report, zero writes).
- Assumes the aligned csvschema vocabulary (CLI ≥ the version that emits `header` + normalized `field_name`, `precision`, `boolean`, `date` / `date-time`).
- Import script: Bun + `csv-parse`, streaming, uniform-key batches of 250 via stdin-piped `postgrestRequest`, exit-code-aware retries, `failed-batches.json` capture, optional natural-key dedupe, built-in count verify.
- Change classification for existing entities: possible (`create_field`, `input_type`, `precision`, enum-value additions, same-primitive format changes) vs impossible (cross-primitive format changes; alternatives: coerce-in-script, drop, abort).
