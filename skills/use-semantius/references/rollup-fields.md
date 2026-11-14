# Semantius Rollup Fields (aggregates over child records)

A rollup field holds a `sum`, `min`, `max`, `avg` or `count` over the records of a child entity, and the database keeps it current. Use one whenever a value depends on **other** records: `computed_fields` see only the record being written (see `jsonlogic.md`). A value summed, counted or otherwise aggregated from child records is a rollup, never a `computed_fields` rule and never a value the client maintains.

A rollup is not a format: the field keeps an ordinary `format`, and its `rollup` definition makes it a rollup. Its `ctype` becomes `rollup`.

---

## The definition

| Key | Required | Purpose |
|-----|----------|---------|
| `link_field` | yes | `<child table_name>.<field_name>`: a `reference` or `parent` field of the child that points at this entity (`90262`). The child may be this entity itself (a tree). |
| `function` | yes | `sum`, `min`, `max`, `avg` or `count` (`90263`). |
| `value_field` | except with `count` | The field of the child to aggregate; not allowed with `count` (`90264`). It may itself be a rollup, unless the chain comes back to this field (`90267`). |
| `filter` | no | JsonLogic over the child record, limited to the subset below (`90265`). |
| `include_hidden_rows` | no | `true` accepts aggregating child records that readers of this entity may not see. See *Hidden child rows*. |

A `sum` or `avg` value field is one of `number`, `integer`, `int32`, `int64`, `float`, `double` or `rating`; `min` and `max` also take any text-typed format, `date` and `date-time`. Anything else (booleans, times, durations, UUIDs, binaries, JSON) is refused (`90264`).

The rollup field's `format` must fit the result (`90268`):

| `function` | Rollup field format |
|------------|---------------------|
| `count` | `int64` (recommended), another integer format, or `number` |
| `sum` | `number` keeps every digit; an integer format can overflow. The field may be any of the numeric formats above |
| `avg` | `number`, `float` or `double` |
| `min`, `max` | the same column type as the value field: `email` over `text` works, `date` over `date-time` does not |

---

## Creating one

The child entity must already exist, and `link_field`, `value_field` and every field the `filter` reads must exist or come earlier in the same `create_field` array, so a rollup goes last, in the model's one `create_field` call or a later one. A rollup ahead of its `link_field` or `value_field` fails with `90264`, one ahead of a field its filter reads fails with `90265`, and nothing in the call lands. Several rollups can go in one `create_field` array. `writeModel` and `call-file.ts` refuse a `link_field` that is not a `reference` or `parent` field of the child pointing at the rollup's own entity (`90262`), or that names no field (`90264`), before anything is sent: a count of interviews on the job openings needs a field of the interviews that points at the job openings, and a field that points at the applications puts the count on the applications.

`.tmp_deploy/orders-rollups.json`:

```json
{
  "data": {
    "table_name": "orders",
    "field_name": "open_amount",
    "title": "Open Amount",
    "format": "number",
    "rollup": {
      "link_field": "order_lines.order_id",
      "function": "sum",
      "value_field": "amount",
      "filter": { "==": [{ "var": "status" }, "open"] }
    }
  }
}
```

```bash
bun "<skill-folder>/references/call-file.ts" create_field .tmp_deploy/orders-rollups.json
```

- Omit `ctype`: it becomes `rollup` by itself. Omit `precision` too: it is copied from a `number` value field.
- `input_type` `default` and `readonly` become `disabled`; `hidden` stays.
- `required`, `searchable` and `unique_value` are refused (`90261`), and so is a definition on a key, a core field, a `reference` or `parent` field, or a field a `computed_fields` rule names.
- Neither side can be an `is_a` or `has_a` entity (`90249`). On an unmanaged entity the definition is kept as metadata and takes effect once both sides are managed.

## The filter

The filter is compiled to SQL, so only this subset is accepted: `and`, `or`, `!`, `!!`, `==`, `===`, `!=`, `!==`, `<`, `<=`, `>`, `>=`, `in` with a non-empty list of literals, literals, and `var` naming a text, boolean, number, date, time, timestamp, UUID or TypeID column of the child (a bare boolean column or boolean literal also works as a condition, and `<` and `<=` take three operands). Everything else is refused on save (`90265`, and the error names it): other operators such as `if`, arithmetic, `cat` and `missing`, the variables `$user_id`, `$now` and `$today`, dotted paths, and a `var` with a default. `==` and `!=` treat `null` as a value; an ordering comparison with a NULL column excludes the record.

The date operators (`date_add`, `date_diff`, `date_part`, `date_trunc`, `to_date`, `date_format`) can be used as values, for example `{"==": [{"date_part": [{"var": "ship_date"}, "quarter"]}, 4]}`. Their date is a date or date-time column, an ISO 8601 literal or another date operator; their unit, part or pattern is a literal; their amount is a literal or an integer column; a `duration` column works only on a date-time. A date literal compared with a date or date-time column must be ISO 8601 and is read in UTC.

## How it behaves

- The value cannot be written by hand. On create it starts as the empty aggregate, and on update a changed value is recomputed, with no error. Change the child records instead.
- With no matching child records the value is `0` for numbers, `''` for text, and NULL for `date` and `date-time`.
- A child write that moves a total runs the parent's own `computed_fields`, `validation_rules`, queue mappings and RACI triggers, with its rules evaluated as the user who wrote the child. So a parent rule can test a rollup (a total under a credit limit) and refuse the child write, and a parent rule that tests the writer's permission blocks child writes by users who cannot edit the parent. A parent computed field can read a rollup (`total` = `subtotal` + `freight`).
- A child write that changes nothing but rollup columns moves no `updated_at` and writes no audit row on the parent.
- Rollups over a tree (a child that is its own parent) climb from parent to parent, and two such writers can deadlock; the database aborts one write with `40P01`, so retry it.

## Hidden child rows (`90269`)

The aggregate covers every child record, and every reader of the parent sees it. When the child has a `select_rule`, or a `view_permission` other than the parent's, the rollup is refused unless its definition sets `include_hidden_rows: true`. That setting shows those readers a sum, count, minimum or maximum over rows they cannot open: the value is stored once per parent record, so no reader gets a total over only the rows they can see. Set it without asking, and name each such rollup in the final response. `module-rbac-setup.ts --access` sets it on every rollup over an entity whose `select_rule` it writes (`rbac.md` → "The access record"), a reused entity that gets its own view permission gets it the same way (`rbac.md` → "Viewing an entity of another module"), and a rollup created over such a child carries it in its definition. The refusal also applies later: adding a `select_rule` to the child, or changing a `view_permission` on either side, fails while it would affect a rollup without the flag.

## Changing and removing

- Saving a new or changed definition recalculates the records whose value differs. This is not an edit: no `updated_at`, audit row, queue message or RACI event, on this entity or any rollup parent above it. Those tables take no other writes until the save commits, so warn the user before doing this on a busy table.
- A definition that needs another column type (`sum(amount)` to `max(ship_date)`) is a format change (`90223`): drop and recreate the field.
- `rollup: {}` removes the definition. The field stays with its last values as ordinary data, `ctype` clears, and `input_type` stays `disabled` until you change it.
- Renames of the tables and fields a definition names are followed automatically.
- The `link_field`, the value field and the child entity cannot be deleted while another entity's rollup depends on them (`90266`, which names the rollups), unless the same module delete removes both sides. The rollup field itself is deleted like any other field.
- Find rollups with `read_field(filters: "ctype=eq.rollup")`. `get_schema` (`POST /rpc/get_schema`) shows `ctype: "rollup"`, `is_core: false` and the definition under `rollup`.
