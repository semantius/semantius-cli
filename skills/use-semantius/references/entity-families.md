# Entity Families: `is_a` and `has_a`

> **Terms used here.** A **base** is the entity others share a key with. An **`is_a` entity** is a subtype of its base (every record is exactly one kind, fixed at creation); a **`has_a` entity** is an optional extension a base record can also have.
> Either one is a **based entity** (its `id_refentity` names the base). A base plus at least one based entity is a **family**.
> This file is the canonical home of the platform facts. Other files restate a rule only where acting on it, marked as a copy.

## Contents

- [Vocabulary](#vocabulary)
- [Choose the right tool](#choose-the-right-tool)
- [Creating a family](#creating-a-family)
- [Reading](#reading)
- [Writing](#writing)
- [Limits](#limits)
- [Deleting](#deleting)
- [Error codes](#error-codes)

---

## Vocabulary

One vocabulary across every Semantius skill. The "never use" column names words that already mean something else here.

| Concept | Skill text | User-facing | Never use for it |
|---|---|---|---|
| The entity others share a key with | **base** | "the shared record", or its plural label | "parent" (the FK format) |
| `id_type: is_a` | **`is_a` entity** | "a kind of <Singular>" | "derived" |
| `id_type: has_a` | **`has_a` entity** | "something a <Singular> can also be" | "role" (the blueprint `role` column and RBAC roles) |
| Either of the two | **based entity** (matches `**Based on:**`) | describe it; don't name it | "derived" (the `derived` role value, derived gates, derived tiers) |
| A base plus at least one based entity | **family** | "kept once as <Plural>" | "cluster" |
| The alternative: one entity plus an enum field | **type enum** | "a type choice on <Plural>" | bare "kind" (the §4 `kind` column, `module_kind`) |

Users never see `is_a`, `has_a`, `id_refentity`, `_ext`, "subtype", "inheritance", or "normalization". Talk about the business facts instead.

---

## Choose the right tool

When a user says *"Emails and tasks are both activities"*, *"Customers and suppliers are business partners"*, or *"A person can also be a customer"*.

Inheritance is not a way to reuse fields:

| Situation | Use |
|---|---|
| The kind of record is fixed when it is created, and every subtype record is also a valid record of the base (an email *is* an activity) | `is_a` |
| An optional role a record may take on or drop (a partner becomes a customer) | `has_a` |
| A classification that can change during the record's life (lead → customer, draft → approved) | an `enum` field, plus `input_type_rule` to show fields per value |
| 1:n data per organizational level (a customer's data per sales area or company code) | a child entity with a `parent` field |
| Two entities that merely share some field names | nothing: give each its own fields |

Kinds that differ by only a few fields stay one entity with a type enum even when the kind is fixed at creation. The architect's `normalization.md` holds the full decision order.

- **`is_a`, a subtype.** `activities` > `emails` > `classified_emails`, and `tasks` is_a `activities`; `persons` and `organizations` is_a `business_partners`. Every record is exactly one type, fixed when it is created: an email has an `eml_…` id, and `activities` lists it with every other activity. The base must be a managed `typeid` or `is_a` entity (`90240`). The subtype needs its own `id_prefix`. Chains may go several levels deep.
- **`has_a`, an optional extension.** `customers` and `suppliers` has_a `business_partners`: a partner has at most one customer record and at most one supplier record, and both use the partner's `bp_…` key. The base must be a managed `typeid` entity (`90240`). One level only: nothing can be based on a `has_a` entity.
- **A platform built-in is never a base.** Reference `users` with a `reference` field instead.

Choosing either type is high-risk: `id_type`, `id_refentity` and an `is_a` prefix are fixed at creation, and a record's type never changes. Confirm with the user before creating.

---

## Creating a family

1. **Create the base** as a `typeid` entity (or use an existing managed `typeid` / `is_a` one), with its fields.
2. **Create each based entity** with `create_entity`:
   - `id_type: "is_a"` plus its own `id_prefix`, or `id_type: "has_a"` (no prefix);
   - `id_refentity: "<base table_name>"`;
   - **no** `label_column` or `label_parent`: they come from the base (`90242`);
   - **no** `order_column` (`90249`).

   The entity's storage table is `<table_name>_ext`, so that name must be free too (`90250`).
3. **Order: one `create_entity` call per level, bases first.** Plain entities and the family roots go in the first call; entities based on them in the next; and so on. Entities of the same level share one call. A based entity named before its base fails (`23503` on `entities_id_refentity_fkey`).
4. **Only then the fields**, each entity's own fields in one `create_field` call, after every level exists. FK targets never change the levels.
   - A field name may not repeat one of the base's or of an entity based on this one (`90243`); siblings (emails and tasks) may share names.
   - An inherited field belongs to its owner and is changed through the owner.
5. **On an `is_a` entity, set `reference_delete_mode` explicitly on every `reference` and `parent` field**: `restrict` or `clear`, never `cascade` (`90249`). `parent` defaults to `cascade`, so leaving it out fails.

The platform creates only `id`, `created_at` and `updated_at` for a based entity. Its label field, and every other field of its base, are the base's.

```bash
# Level 0: the plain entities and the family roots, one call
semantius call crud create_entity '{"data": [
  {"table_name": "business_partners", "singular_label": "Business Partner", "plural_label": "Business Partners",
   "label_column": "partner_name", "id_type": "typeid", "id_prefix": "bp",
   "module_id": 7, "view_permission": "crm:read", "edit_permission": "crm:manage"},
  {"table_name": "activities", "singular_label": "Activity", "plural_label": "Activities",
   "label_column": "subject", "id_type": "typeid", "id_prefix": "act",
   "module_id": 7, "view_permission": "crm:read", "edit_permission": "crm:manage"}
]}'

# Level 1: entities based on level 0, one call; no label_column / label_parent / order_column
semantius call crud create_entity '{"data": [
  {"table_name": "customers", "singular_label": "Customer", "plural_label": "Customers",
   "id_type": "has_a", "id_refentity": "business_partners",
   "module_id": 7, "view_permission": "crm:read", "edit_permission": "crm:manage"},
  {"table_name": "emails", "singular_label": "Email", "plural_label": "Emails",
   "id_type": "is_a", "id_prefix": "eml", "id_refentity": "activities",
   "module_id": 7, "view_permission": "crm:read", "edit_permission": "crm:manage"}
]}'

# Then fields: each entity's OWN fields only
```

Never send `id_refentity` on `update_entity` (`90241`). The one change it takes is a rename of the base, which the platform carries over itself.

---

## Reading

- **Each entity is read at its own `table_name`**, which shows the whole record: the base's fields and its own.
- **A base read lists its subtypes' records too.** `GET /activities` returns every email and task as well, with the activity fields. Count and filter with that in mind.
- **Inherited fields are not in `read_field` under the based entity.** A field belongs to the entity that owns it. To list every field of a based entity, walk up the chain, then read all levels at once:

  ```bash
  semantius call crud read_entity '{"filters": "table_name=eq.emails", "select": "table_name,id_type,id_refentity"}'
  # -> id_refentity: activities; repeat until id_refentity is null
  semantius call crud read_field '{"filters": "table_name=in.(emails,activities)"}'
  ```

  `get_schema` lists inherited properties with `"inherited_from": "<owner>"`, and a `has_a` base lists its `extensions: [{table, properties, required}]`.
- **Permissions span every level.** A reader needs the view permission of every level; a writer needs the edit permission of every level it writes. A record the caller cannot write whole is skipped, never half-written. A role that writes a based entity must also be granted edit on its base, including a cross-module grant when the base lives in another module.
- **Search spans every level.** `search_vector` covers the searchable fields of the base as well as the entity's own. That search cannot use an index, so on large tables add a narrowing filter.

---

## Writing

- **Writes through any level reach the record's own type.** `PATCH /activities?id=eq.<eml id>` runs the emails rules too. `DELETE /activities?id=eq.<eml id>` deletes the email completely, running the delete rules of every level (any of them may refuse). An update writes the level that changed and the levels below it.
- **Insert an `is_a` record once, at its own table**, with the base's fields in the same payload. Never insert a base row and then a subtype row: that creates two records, and a record's type cannot change afterwards. A direct insert into the base with a subtype's prefix fails (`90237`).
- **Create a `has_a` record:**
  - without an `id`, it creates the base record too (send the base's fields with it);
  - with the `id` of an existing base record, it **attaches** to it. Only the extension's fields are written. A base value that differs from the stored one is refused (`90246`), so send only the extension's own fields plus the id, and change base values through the base.
  - An `id` that no base record has creates the base record with that id, which must carry the base's prefix (`90237`).
- **Never upsert a based entity.** `Prefer: resolution=merge-duplicates`, `on_conflict` and `PUT` fail with `42P10` when the statement is planned. Insert new rows with a plain `POST`, then update changed rows with one `PATCH` each.
- **Never write `<table_name>_ext` directly** (`90244`). It stores the entity's own fields; the entity's write routines write it.
- **A record's key never changes** (`90236`), and neither does its type.

---

## Limits

| Not available | Error | Instead |
|---|---|---|
| `cascade` on a `reference` / `parent` field of an `is_a` entity | `90249` | `restrict` or `clear`, set explicitly |
| `order_column` on an `is_a` / `has_a` entity | `90249` | none |
| Queue mappings (`queue_table_events`) on an `is_a` / `has_a` entity | `90249` | none |
| RACI process gates (`process_gates`) on an `is_a` / `has_a` entity | `90249` | none |
| `label_column` / `label_parent` on an `is_a` / `has_a` entity | `90242` | they come from the base |
| Switching a base to `managed: false` while entities are based on it | `90252` | none |
| Upsert (`merge-duplicates`, `on_conflict`, `PUT`) on an `is_a` / `has_a` entity | `42P10` | insert, then `PATCH` |
| Changing `id_type`, `id_refentity`, or an `is_a` prefix | `90233`, `90241`, `90245` | rebuild the entity |

Names generated from a long entity name (`<entity>_ext_<field>_fkey`, `record_write_<entity>`) are truncated at 63 bytes, so keep family table names short.

---

## Deleting

- **Deleting a `has_a` record detaches it**; the base record stays.
- **A base record with an extension cannot be deleted** (`90251`): remove the extensions first.
- **An `is_a` / `has_a` entity, or the base of one, cannot be deleted while it has records** (`90247`).
- **A base cannot be deleted while entities are based on it** (`90248`).
- Deleting a module is refused the same way while one of these entities in it has records (`90247`); entities of the same module that are based on each other do not block it.

Before deleting an entity, check its dependents:

```bash
semantius call crud read_entity '{"filters": "id_refentity=eq.<table_name>", "select": "table_name,id_type"}'
```

---

## Error codes

| Code | Meaning | What to do |
|---|---|---|
| `90233` | `id_type` is set on create and cannot change | Rebuild the entity |
| `90236` | A record key cannot change | Don't send a different `id` on update |
| `90237` | The id lacks the required prefix (a subtype id inserted into the base, a `has_a` create with an id lacking the base's prefix) | Insert at the record's own table; use the base's prefix |
| `90240` | Wrong base: `is_a` needs a managed `typeid` / `is_a` base, `has_a` a managed `typeid` base, and nothing is based on itself | Pick or create a valid base |
| `90241` | `id_refentity` is set on create only | Never send it on update |
| `90242` | `label_column` / `label_parent` come from the base | Leave them out |
| `90243` | A field name repeats one of the base's or of an entity based on this one | Rename the field, or keep it on its owner |
| `90244` | Direct write to `<table_name>_ext` | Write through the entity |
| `90245` | An `is_a` prefix is fixed at creation | Rebuild the entity |
| `90246` | Attaching a `has_a` record with a base value that differs from the stored one | Send only the extension's fields; change the base through the base |
| `90247` | The entity (or its module) still has records | Delete the records through the entity first |
| `90248` | Entities are still based on this one | Delete the dependents first |
| `90249` | Feature not available on a based entity (`order_column`, `queue_table_events`, `process_gates`, `cascade` on an `is_a` FK) | See [Limits](#limits) |
| `90250` | `<table_name>` or `<table_name>_ext` is already in use | Pick another name |
| `90251` | A base record still has an extension | Delete the extension record first |
| `90252` | A base cannot become unmanaged while entities are based on it | none |
| `42P10` | Upsert on a based entity | Insert, then `PATCH` |
| `23503` on `entities_id_refentity_fkey` | A based entity was created before its base | Create bases first, one call per level |
