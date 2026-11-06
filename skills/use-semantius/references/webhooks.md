# Semantius Webhook Receivers

A webhook receiver lets an external system (a SaaS integration, a nightly job) push records into one table, one signed HTTP request per record. Each delivery is recorded in the webhook receiver logs.

To import a file, use the `semantius-importer` skill; this is not a webhook task.

---

## Step 1: Identify Target Entity and Writable Fields

```bash
semantius call crud read_entity '{"filters": "table_name=eq.<table_name>"}'
semantius call crud read_field '{"filters": "table_name=eq.<table_name>"}'
```

Note which fields have `input_type: "readonly"` or `input_type: "disabled"`. The receiver drops a payload value for a `readonly` field before it writes. It does not drop a `disabled` field: `disabled` is the mode the platform gives computed and rollup fields, whose value it overwrites on every write, so a payload value for one has no lasting effect. Leave both kinds out of the payload.

The receiver writes only the keys that match a field of the table; other keys are ignored, and a payload with no matching key is refused (`400`, "No matching fields found").

The composed-label columns — the entity's own `_label` and any FK companion `<fk>_label` (e.g. `customer_id_label`) — are likewise **never payload fields**. They are platform-owned, read-time projections, not real columns, and don't appear in `read_field` at all.

**Enum fields.** An enum field accepts only the values of its `enum_values`. When the producing system sends labels instead (e.g. "On hold" for `on_hold`), the payload must carry the `value` of the matching `{"value", "label"}` entry (an entry may also carry a `description`, `color` and `icon`; ignore them).

**The key field depends on the entity's `id_type`:**

| `id_type` | Payload carries `id`? |
|---|---|
| `bigint`, `text` | Yes: the producing system supplies the key on every record |
| `auto_increment`, `uuid`, `typeid`, `is_a` | No: the database generates it. A payload that does carry the key is used as the record's key and written, so omit it unless the delivery is meant to address an existing record |
| `has_a` | Only when the record attaches to an existing base record (its id); without it, each record creates a base record too |

**Inherited fields.** For an `is_a` / `has_a` entity the fields include the ones it inherits from its base (`get_schema` marks them `inherited_from`), and the payload may set them like the entity's own fields. See `entity-families.md`.

---

## Step 2: Find or Create the Webhook Receiver

The label names the producing system (e.g. the integration or job that sends the records).

```bash
semantius call crud read_webhook_receiver \
  '{"filters": "label=eq.<label>&table_name=eq.<table_name>"}'
```

If not found, create one. Generate the secret per receiver, at least 32 random characters (`openssl rand -hex 32`; the receiver sets no minimum), and hand it to the producing system. `auth_type` is `none`, `hmac` or `header` (default `none`); the receiver verifies a signature only for `hmac`, and accepts every request for the other two, so use `hmac` (with `hmac`, a missing secret, `webhook-id` or `webhook-signature` is answered 401):
```bash
semantius call crud create_webhook_receiver '{
  "data": {
    "label": "<label>",
    "table_name": "<table_name>",
    "auth_type": "hmac",
    "secret": "<secret>"
  }
}'
```

---

## Step 3: Get the Endpoint

```bash
semantius call crud getCurrentUser '{}'
# Extract api_baseurl from response
# Endpoint: {api_baseurl}/hook/{webhook_receiver_id}
```

---

## Signing Scheme (Standard Webhooks)

- **Signed string:** `{webhook-id}.{webhook-timestamp}.{body}` (body = compact JSON, no extra spaces)
- **Algorithm:** HMAC-SHA256 with the secret as key. A secret that starts with `whsec_` is base64-decoded after the prefix first, and the decoded bytes are read as UTF-8 text, so use such a secret only when they are text (random bytes make every signature fail); any other secret is used as typed
- **Header value:** `v1,{base64_signature}`

Required headers on every request:

| Header | Value |
|--------|-------|
| `Content-Type` | `application/json` |
| `webhook-id` | Unique per message, e.g. `msg_<uuid>`. With `hmac`, a request whose `webhook-id` already succeeded is answered `200` "Duplicate request ignored" and writes nothing; reuse the id only to retry a delivery that failed |
| `webhook-timestamp` | Unix timestamp as integer string |
| `webhook-signature` | `v1,{signature}` |

```typescript
import { createHmac } from "crypto";

function sign(secret: string, msgId: string, timestamp: string, body: string): string {
  const signed = `${msgId}.${timestamp}.${body}`;
  const sig = createHmac("sha256", secret).update(signed).digest("base64");
  return `v1,${sig}`;
}
```

---

## How the receiver writes

The receiver upserts: it looks for the record by the entity's key (`id_column`), then by a `unique_value` field, whichever the payload carries. A match is updated with the payload's other keys; otherwise the record is inserted. A configured JSONata expression runs first. Answers: `401` signature failed, `400` invalid JSON, JSONata error or no matching field, `404` receiver or table not found, `500` write failed, `200` done or duplicate.

---

## Monitoring Deliveries

```bash
semantius call crud read_webhook_receiver_log '{
  "filters": "webhook_receiver_id=eq.<receiver_id>",
  "order": "created_at.desc",
  "limit": 20
}'
```

Each log row carries `result` (10 success, 20 signature failed, 30 invalid JSON, 40 table not found, 50 write failed, 60 JSONata error) and `error_message`.
