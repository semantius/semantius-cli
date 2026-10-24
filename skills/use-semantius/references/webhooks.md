# Semantius Webhook Receivers

A webhook receiver lets an external system (a SaaS integration, a nightly job) push records into one table, one signed HTTP request per record. Each delivery is recorded in the webhook receiver logs.

To import a file, use the `semantius-importer` skill; this is not a webhook task.

---

## Step 1: Identify Target Entity and Writable Fields

```bash
semantius call crud read_entity '{"filters": "table_name=eq.<table_name>"}'
semantius call crud read_field '{"filters": "table_name=eq.<table_name>"}'
```

Note which fields have `input_type: "readonly"` or `input_type: "disabled"`: **the payload never writes to those**. `disabled` is the mode the deployer assigns to computed fields (the platform overwrites caller values on every write); `readonly` marks the same intent (manual lock). Either is a signal: the field is not caller-writable in any meaningful sense.

The composed-label columns — the entity's own `_label` and any FK companion `<fk>_label` (e.g. `customer_id_label`) — are likewise **never payload fields**. They are platform-owned, read-time projections, not real columns, and don't appear in `read_field` at all.

**Enum fields.** An enum field accepts only the values of its `enum_values`. When the producing system sends labels instead (e.g. "On hold" for `on_hold`), the payload must carry the `value` of the matching `{"value", "label"}` entry (an entry may also carry a `description`, `color` and `icon`; ignore them).

**The key field depends on the entity's `id_type`:**

| `id_type` | Payload carries `id`? |
|---|---|
| `bigint`, `text` | Yes: the producing system supplies the key on every record |
| `auto_increment`, `uuid`, `typeid`, `is_a` | No: the database generates it |
| `has_a` | Only when the record attaches to an existing base record (its id); without it, each record creates a base record too |

**Inherited fields.** For an `is_a` / `has_a` entity the fields include the ones it inherits from its base (`get_schema` marks them `inherited_from`), and the payload may set them like the entity's own fields. See `entity-families.md`.

---

## Step 2: Find or Create the Webhook Receiver

The label names the producing system (e.g. the integration or job that sends the records).

```bash
semantius call crud read_webhook_receiver \
  '{"filters": "label=eq.<label>&table_name=eq.<table_name>"}'
```

If not found, create one. Generate the secret per receiver, at least 32 random characters (`openssl rand -hex 32`), and hand it to the producing system:
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
- **Algorithm:** HMAC-SHA256 with the raw secret as key
- **Header value:** `v1,{base64_signature}`

Required headers on every request:

| Header | Value |
|--------|-------|
| `Content-Type` | `application/json` |
| `webhook-id` | Unique per message, e.g. `msg_<uuid>` |
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

## Monitoring Deliveries

```bash
semantius call crud read_webhook_receiver_log '{
  "filters": "receiver_id=eq.<receiver_id>",
  "order": "created_at.desc",
  "limit": 20
}'
```
