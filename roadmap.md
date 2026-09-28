# Roadmap

Pending work on semantius-cli. Remove an item when it ships.

## Transfer of `is_a` and `has_a` entities

Platform 0.5.0 (semantius `fa0a92e`) added two key types, `is_a` (a subtype)
and `has_a` (an optional extension). Their records share the TypeID key of the
entity named in `entities.id_refentity`. Such an entity is the view `<entity>`
over its own fields in `<entity>_ext` and the tables of its bases, written
through an INSTEAD OF trigger. The vendored tools and skill already cover them.
`id_refentity` is create-only in the transfer, as in the platform. The
transfer tools (`src/local-tools/transfer/`) do not handle them yet.

The reference is the platform's `public.ensure_entities()`, which applies files
in this CLI's export format. In the semantius repo, see:

- `apps/_core/migrations/0290_ensure_entities.sql`, which writes the records of
  these entities;
- `apps/_core/migrations/0160_dd_functions.sql`, which defines
  `dd_family_fields`, `dd_ancestors` and `check_entity_family`;
- `apps/test/tests/0490_test_ensure_entities.sql` part 3, which shows the file
  layout for a family;
- `docs/error-contract.md`, which lists codes 90240–90252 and explains 42P10.

### 1. A base before the entities based on it

The platform creates entities in file order. A derived entity named before its
base fails on `entities_id_refentity_fkey` (23503). The BEFORE INSERT trigger
`check_entity_family` also reads the base row to set `id_column` and
`label_column`, so the order matters inside one bulk insert too.

- Export: both tools write a base before every entity based on it, and keep the
  current order otherwise. `export_module` sorts by `table_name` today, which
  can put `persons` (is_a `parties`) first.
- Import: new entities are created base first, whatever the file order.

### 2. Export the whole record

The records of an `is_a`/`has_a` entity carry the fields of the whole record.
Those are the `dd_family_fields` rule: the entity's own fields, plus each
base's fields except the bases' id and audit fields. Today `writeRecords` (`export.ts`) selects
the entity's own fields only, so a new target gets the base part at its
defaults, or refuses it for a required base field. The user columns
(`reference_table = 'users'`) come from the family fields too. The entity's
`fields` in the file stay its own: an inherited field belongs to, and is
changed through, the entity that owns it.

### 3. Import against the family's fields

`importRecords` (`import.ts`) builds its catalog from the entity's own fields,
so an inherited column is refused ("the target has no column …"). Use the family fields for:

- the known columns;
- the skipped columns: the family's audit fields, plus the computed fields of
  every level (`dd_ancestors`);
- the references that order the writes.

### 4. Insert, then update: no upsert

An upsert on the view (`on_conflict` with `resolution=merge-duplicates`, or
`PUT`) fails with 42P10 while it is planned. For these entities:

- new rows are inserted with a plain POST;
- changed rows are updated with one PATCH each, since PostgREST has no bulk
  update with values per row.

A `has_a` row whose base record already exists on the target attaches to it.
If a base value in the insert differs from the stored one, the attach is
refused (90246). So such an insert carries only the entity's own fields and
the key, and the base fields that differ follow in the PATCH. Upstream does
the same in `derivedUpsertColumns` (postgrest-mcp `src/db/hook.ts`). The view
gives each column the default of its physical column, so the omitted columns
pass the attach check. `fix_id_sequence` answers null for these entities (no
sequence) and needs no change.

### 5. Base records that belong to a subtype — decision needed

A read of a base returns the records of all its subtypes too: `activities`
lists every email. Written as records of the base, those rows fail on import
with 90237 (a direct insert into an is_a root with a subtype's prefix). That
happens in this CLI and in `ensure_entities` alike.

Recommended: export each record only with its own type. Drop from a base's
records every row whose id prefix is the `id_prefix` of an `is_a` descendant.
The prefix is the part before the last `_`, because a prefix may itself contain
underscores.
`has_a` is unaffected: an extension takes its base record's id, and every
base record is the base's own. The consequence is that exporting a base alone
does not carry its subtypes' records. The export summary should report how
many rows it left out.

The alternative is to import subtypes before their bases. The base's subtype
rows then exist and compare unchanged. That still fails for a subtype missing
from the file, and in `ensure_entities`.

### 6. Tests and docs

- `tests/helpers/fake-postgrest.ts` does not model families. It needs:
  - a family entity as a view over its base and `<entity>_ext`;
  - reads that span every level, including a base read listing its subtypes'
    rows;
  - inserts through the view that write every part;
  - 42P10 on `on_conflict`;
  - 90237 and 90246.
- Add a round-trip test of a family (typeid base, `is_a` and `has_a`
  entities, records at every level).
- Update the "Transfer files carry names, not host ids" section of AGENTS.md,
  and the tool descriptions in `src/local-tools/import-*.ts`, which say records
  are upserted by id.
