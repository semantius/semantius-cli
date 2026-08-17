# semantius-importer

Imports a CSV file into Semantius: introspect the file's schema with the CLI's built-in `utils/get_csvschema`, create or reuse a matching entity (module first if needed), then bulk-load the rows in batches. `SKILL.md` is the runtime contract; this README is the honest status of what the skill can and cannot do right now.

## Works today

- **Introspection** against the v0.8.3 csvschema contract: wrapper output (`id_mode`, `record_count`, `fields`), derived `input_type`, open format set with passthrough for formats the skill does not special-case (`email`, `url`, and anything future CLI versions add).
- **Three run modes**: full import, schema-only (create the entity, import nothing), compare-only (classified diff report, zero writes).
- **Entity + module creation** with correct label-column mechanics, plus a field-by-field diff against existing entities with every needed change classified **possible** (executed on request) or **impossible** (alternatives offered).
- **Target-entity selection**: when no table matches, candidates are ranked by name similarity and field overlap and the user chooses create-new vs use-existing.
- **Batched import**: streaming `csv-parse`, uniform-key batches via stdin-piped `postgrestRequest`, retries, per-row coercion validation, `failed-batches.json`, count verification against the server and against the introspection's `record_count`. The script ships as a real file (`references/import.template.ts`) copied byte-for-byte into the run folder; it reads all run configuration from `mapping.json` at startup — no hand transcription, no per-run placeholders.
- **Deterministic plan rendering**: `references/render-plan.ts` prints the mapping table and every plan count straight from `mapping.json`, so the reviewed table, the pre-write plan, and what executes always agree.
- **Bulk field creation**: `references/create-fields.ts` creates all new fields in **one `create_field` call** (`data` is an array of the field objects, up to 100 per call; the typed tool takes items with different keys and inserts them in one transaction) with explicit `field_order` in increments of 10 starting at 30 (10 and 20 belong to each entity's auto-created fields; the platform preserves explicit order, so the position in the array carries no meaning). Idempotent (skips existing fields; a re-run issues zero calls), verified by re-read, fail-fast, and loud: per-field status and the platform's stderr in a result table, nothing swallowed. Both baseline permissions of a new module likewise go out in one `create_permission` call.
- **Write modes** (prompted, recorded in `mapping.json` as `on_exists`):
  - `insert` — only new rows are written; rows whose natural key already exists are skipped.
  - `update` — existing records are synchronized with the CSV: unchanged rows are left untouched, changed rows are updated (per-row `PATCH` after a local diff), new rows are batch-inserted. Requires a unique natural key (`unique_value: true` field).

## Disabled this iteration

**id preservation (`id_mode: "id"` / `"move"` — new-entity path).** When the skill creates a fresh entity from a file, the introspector detects whether the file brings its own usable primary key; for existing target entities `id_mode` plays no role (their primary key stays untouched, whatever their `id_column` is named). The platform accepts explicit id inserts — but the id **sequence does not advance past them** (verified live: after importing ids 1..30 into a fresh table, the first normal insert fails with `23505 duplicate key`, and there is no PostgREST-level remedy). Until the sequence-fix RPC below is installed platform-side, the skill reports the detection but applies the classic policy instead: an id-named column is renamed to `external_id` (usable as the unique natural key), and an `id_move_column` stays an ordinary integer field. As a hard guard, the import script also **silently strips the entity's primary key column from every payload** (inserts and updates alike) — keyed on `mapping.json`'s `id_column`, copied from the target entity's live `id_column` property (default `id`, customizable per entity), so no mapping mistake can smuggle explicit ids in, whatever the column is named.

### Deferred design (kept here, out of the runtime contract)

The full preservation design lives here so the skill's runtime files spend no reasoning on a disabled feature. Re-enabling means moving these rules back into `references/schema-mapping.md` section 4 (id policy), section 8 (mapping entry), and the import script.

**Per-`id_mode` behavior for NEW entities (create path only; existing entities keep their primary key untouched):**

| `id_mode` | Default behavior | Alternative (offered in the mapping review) |
|---|---|---|
| `"id"` | Import the CSV `id` column **into the platform `id` primary key**: the mapping includes an entry with `field_name: "id"`, no `create_field` happens for it (auto-generated), and the script's natural key defaults to `id` (idempotent re-runs for free) | Rename to `external_id`; the platform assigns fresh ids |
| `"move"` | The `id_move_column`'s data is **moved into `id`**: its raw header maps to `field_name: "id"`, and **no separate field is created for it** — moved, never duplicated | Keep it as its own `integer` field; the platform assigns ids |
| `"none"` | The platform assigns ids. When an `id`-named column exists anyway (detection suppressed by introspection quirks 1/3), surface that and apply the classic policy | |

**Mapping entry rule:** an entry with `field_name: "id"` targets the platform primary key; the import writes it, `create_field` never does, and it appears exactly once (a moved column never also exists as its own field; in move mode the entry's `header` is the `id_move_column`).

**Sequence rule (verified on the platform):** explicit `id` inserts are accepted, but the id sequence does not advance past them — a fresh table filled with ids 1..N collides on the first platform-side record creation. After a preserve-ids import, always call `POST /rpc/fix_id_sequence {"p_table": "<table>"}`, confirm the returned value exceeds the imported maximum, state the id decision in the pre-write plan, and confirm the RPC result in the post-import report. The import script calls the RPC after the last batch when ids were preserved, and `NATURAL_KEY` defaults to `id`.

## Pending platform/tooling work (roadmap)

1. **Batched upsert — needs an MCP change.** The `postgrestRequest` tool currently has no `prefer` input; the server hardcodes `Prefer: return=representation`, so `resolution=merge-duplicates` cannot reach PostgREST. A `prefer` passthrough in `postgrest-mcp` (`src/tools/postgrestRequest.ts`) unlocks batched upsert; until it is deployed, update mode uses diff-then-PATCH (correct, slower when many rows changed).
2. **Sequence-fix RPC — needs a platform DB function.** To make id preservation safe, install this function in the Semantius platform database (same place as the existing `/rpc/get_userinfo`-style functions) and grant execute to the appropriate role only:

   ```sql
   create or replace function fix_id_sequence(p_table text)
   returns bigint
   language plpgsql
   security definer
   as $$
   declare
     v_next bigint;
   begin
     execute format(
       'select setval(pg_get_serial_sequence(%L, ''id''), coalesce(max(id), 0) + 1, false) from %I',
       p_table, p_table
     ) into v_next;
     return v_next;
   end
   $$;
   -- grant execute on function fix_id_sequence(text) to <admin role>;
   -- revoke execute on function fix_id_sequence(text) from public;
   ```

   Call site (no MCP change needed): `postgrestRequest {"method":"POST","path":"/rpc/fix_id_sequence","body":{"p_table":"<table>"}}` right after a preserve-ids import.
3. **id preservation re-enable** once 1 and 2 are live: import explicit ids, call the RPC, sequence healthy — the deferred blocks in the references become active again.

## Layout

```
SKILL.md                              runtime contract (stages, gates, decision points)
references/importer-essentials.md     Step 0 hard-gate read: distilled use-semantius subset
references/schema-mapping.md          csvschema contract + mapping/decision rules + mapping.json contract
references/import-script-template.md  run workspace, design rules, mapping.json checklist
references/import.template.ts         the import script (copied byte-for-byte as import.ts)
references/create-fields.ts           bulk create_field runner (one array call per ≤100 fields, fail-fast, --dry-run)
references/render-plan.ts             renders the mapping table + plan facts from mapping.json
evals/trigger-eval.json               trigger boundary cases
evals/quirks.csv, evals/move-mode.csv introspection fixtures (id/enum/bool/email/url/move quirks)
CHANGELOG.md                          history (not loaded at runtime)
```
