# Semantius Webhook Import Reference

When importing many records from a CSV, Excel, or TXT file, use the webhook-based import rather than calling `create_*` tools one record at a time.

---

## Choose Your Approach

| Approach | Best for | Requires |
|----------|----------|---------|
| **Bun script** | Any file, clean code, fast | `bun` installed |
| **Pure shell** (curl + openssl) | Simple CSVs, no extra deps | `curl`, `openssl`, `awk` or `node` |
| **Python script** | Already have Python, complex transforms | `python3`, `requests` |

---

## Step 1 — Identify Target Entity and Fields

```bash
semantius call crud read_entity '{"filters": "table_name=eq.<table_name>"}'
semantius call crud read_field '{"filters": "table_name=eq.<table_name>"}'
```

Note which fields have `input_type: "readonly"` — **never import into those**.

---

## Step 2 — Find or Create Webhook Receiver

```bash
semantius call crud read_webhook_receiver \
  '{"filters": "label=eq.Agent Import&table_name=eq.<table_name>"}'
```

If not found, create one:
```bash
semantius call crud create_webhook_receiver '{
  "data": {
    "label": "Agent Import",
    "table_name": "<table_name>",
    "auth_type": "hmac",
    "secret": "aB3kP9mXqZ"
  }
}'
```

---

## Step 3 — Get API Base URL

```bash
semantius call crud getCurrentUser '{}'
# Extract api_baseurl from response
# Endpoint: {api_baseurl}/hook/{webhook_receiver_id}
```

---

## Step 4 — Map Columns to Fields

| Match type | Action |
|------------|--------|
| Exact or obvious (`first_name` → `first_name`) | Auto-map silently |
| Reasonable (`Email Address` → `email`) | Auto-map, mention in summary |
| Ambiguous | Ask user before proceeding |

Never map to `input_type: "readonly"` fields.

---

## Signing Scheme (Standard Webhooks)

All three approaches use the same scheme:

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

---

## Approach 1: Bun Script (recommended)

No dependencies beyond Bun itself. Uses native `fetch`, `crypto`, and `Bun.file()`.

```typescript
#!/usr/bin/env bun
import { createHmac, randomUUID } from "crypto";

const WEBHOOK_URL = "<api_baseurl>/hook/<receiver_id>";
const SECRET = "<raw_secret>";

// Map CSV header -> entity field name
const MAPPING: Record<string, string> = {
  "Product Code":  "product_code",
  "Product Title": "product_title",
  "Category":      "category",
  "List Price":    "list_price",
  "Stock Count":   "stock_count",
  "Is Active":     "is_active",
};

function sign(msgId: string, timestamp: string, body: string): string {
  const signed = `${msgId}.${timestamp}.${body}`;
  const sig = createHmac("sha256", SECRET).update(signed).digest("base64");
  return `v1,${sig}`;
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let cur = "", inQuote = false;
  for (const ch of line) {
    if (ch === '"') { inQuote = !inQuote; continue; }
    if (ch === "," && !inQuote) { result.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  result.push(cur.trim());
  return result;
}

const file = Bun.file(process.argv[2] ?? "import.csv");
const text = await file.text();
const lines = text.split("\n").filter(Boolean);
const headers = parseCSVLine(lines[0]);

let ok = 0, failed = 0;
const failedRows: object[] = [];

for (let i = 1; i < lines.length; i++) {
  const values = parseCSVLine(lines[i]);
  const raw = Object.fromEntries(headers.map((h, j) => [h, values[j] ?? ""]));
  const payload = Object.fromEntries(
    Object.entries(raw)
      .filter(([k]) => MAPPING[k])
      .map(([k, v]) => [MAPPING[k], v])
  );

  const body = JSON.stringify(payload);
  const msgId = `msg_${randomUUID().replace(/-/g, "")}`;
  const timestamp = String(Math.floor(Date.now() / 1000));

  const resp = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "webhook-id": msgId,
      "webhook-timestamp": timestamp,
      "webhook-signature": sign(msgId, timestamp, body),
    },
    body,
  });

  if (!resp.ok) {
    const err = await resp.text();
    console.error(`Row ${i} FAILED (${resp.status}): ${err}`);
    failedRows.push({ row: i, payload, error: err });
    failed++;
  } else {
    ok++;
  }

  if (i % 100 === 0) console.log(`Progress: ${i}/${lines.length - 1} rows`);
  await Bun.sleep(50); // ~20 req/s — adjust as needed
}

console.log(`\nDone: ${ok} ok, ${failed} failed`);
if (failedRows.length > 0) {
  await Bun.write("failed_rows.json", JSON.stringify(failedRows, null, 2));
  console.log(`Failed rows saved to failed_rows.json`);
}
```

**Run:**
```bash
bun run import.ts import.csv
```

**For Excel files**, add the `xlsx` package:
```bash
bun add xlsx
```
```typescript
import * as XLSX from "xlsx";
const wb = XLSX.readFile(process.argv[2]);
const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
// rows is already an array of objects — skip the CSV parsing above
for (const raw of rows) { ... }
```

---

## Approach 2: Pure Shell (curl + openssl)

No runtime needed. Works anywhere `curl` and `openssl` are available. Good for simple CSVs without quoted commas.

```bash
#!/usr/bin/env bash
set -euo pipefail

WEBHOOK_URL="<api_baseurl>/hook/<receiver_id>"
SECRET="<raw_secret>"
CSV_FILE="${1:-import.csv}"

sign() {
  local msg_id="$1" timestamp="$2" body="$3"
  local signed="${msg_id}.${timestamp}.${body}"
  local sig
  sig=$(printf '%s' "$signed" | openssl dgst -sha256 -hmac "$SECRET" -binary | base64 -w0)
  echo "v1,${sig}"
}

build_json() {
  # Uses node for safe JSON encoding (handles quotes, special chars)
  local code="$1" title="$2" category="$3" price="$4" stock="$5" active="$6"
  node -e "process.stdout.write(JSON.stringify({
    product_code: process.argv[1],
    product_title: process.argv[2],
    category: process.argv[3],
    list_price: parseFloat(process.argv[4]),
    stock_count: parseInt(process.argv[5]),
    is_active: process.argv[6] === 'true'
  }))" "$code" "$title" "$category" "$price" "$stock" "$active"
}

ok=0; failed=0; row=0
failed_file="failed_rows.txt"
> "$failed_file"

while IFS=',' read -r code title category price stock active; do
  ((row++)) || true
  [ "$row" -eq 1 ] && continue  # skip header

  BODY=$(build_json "$code" "$title" "$category" "$price" "$stock" "$active")
  MSG_ID="msg_$(node -e 'process.stdout.write(crypto.randomUUID().replace(/-/g,""))' 2>/dev/null || echo "${RANDOM}${RANDOM}")"
  TIMESTAMP=$(date +%s)
  SIG=$(sign "$MSG_ID" "$TIMESTAMP" "$BODY")

  HTTP_STATUS=$(curl -s -o /tmp/wh_response -w "%{http_code}" -X POST "$WEBHOOK_URL" \
    -H "Content-Type: application/json" \
    -H "webhook-id: $MSG_ID" \
    -H "webhook-timestamp: $TIMESTAMP" \
    -H "webhook-signature: $SIG" \
    -d "$BODY")

  if [ "$HTTP_STATUS" -ge 300 ]; then
    echo "Row $row FAILED ($HTTP_STATUS): $(cat /tmp/wh_response)" | tee -a "$failed_file"
    ((failed++)) || true
  else
    ((ok++)) || true
  fi

  [ $((row % 100)) -eq 0 ] && echo "Progress: $row rows processed"
  sleep 0.05
done < "$CSV_FILE"

echo "Done: $ok ok, $failed failed"
[ "$failed" -gt 0 ] && echo "Failed rows in $failed_file"
```

**Run:**
```bash
chmod +x import.sh
./import.sh import.csv
```

> ⚠️ Shell's `IFS=','` split breaks on quoted fields containing commas. If your CSV has quoted commas, use the Bun or Python approach instead.

---

## Approach 3: Python Script

Use if Python is already your environment or you need complex data transforms (pandas, openpyxl).

```python
#!/usr/bin/env python3
import csv, json, hmac, hashlib, base64, time, uuid, sys
import requests

WEBHOOK_URL = "<api_baseurl>/hook/<receiver_id>"
SECRET = "<raw_secret>"

MAPPING = {
    "Product Code":  "product_code",
    "Product Title": "product_title",
    "Category":      "category",
    "List Price":    "list_price",
    "Stock Count":   "stock_count",
    "Is Active":     "is_active",
}

def sign(msg_id: str, timestamp: str, body: str) -> str:
    signed = f"{msg_id}.{timestamp}.{body}"
    sig = hmac.HMAC(SECRET.encode(), signed.encode(), hashlib.sha256).digest()
    return "v1," + base64.b64encode(sig).decode()

failed_rows = []
csv_file = sys.argv[1] if len(sys.argv) > 1 else "import.csv"

with open(csv_file, newline="", encoding="utf-8") as f:
    for i, row in enumerate(csv.DictReader(f), 1):
        payload = {MAPPING[k]: v for k, v in row.items() if k in MAPPING}
        body = json.dumps(payload, separators=(",", ":"))
        msg_id = f"msg_{uuid.uuid4().hex}"
        ts = str(int(time.time()))
        resp = requests.post(WEBHOOK_URL, data=body, headers={
            "Content-Type": "application/json",
            "webhook-id": msg_id,
            "webhook-timestamp": ts,
            "webhook-signature": sign(msg_id, ts, body),
        })
        if resp.status_code >= 300:
            print(f"Row {i} FAILED ({resp.status_code}): {resp.text}")
            failed_rows.append({"row": i, "data": payload, "error": resp.text})
        else:
            if i % 100 == 0: print(f"Progress: {i} rows")
        time.sleep(0.05)

if failed_rows:
    with open("failed_rows.json", "w") as f:
        json.dump(failed_rows, f, indent=2)
    print(f"{len(failed_rows)} failed rows saved to failed_rows.json")
```

**For Excel:**
```python
import openpyxl
wb = openpyxl.load_workbook("import.xlsx")
ws = wb.active
headers = [c.value for c in ws[1]]
for i, row in enumerate(ws.iter_rows(min_row=2, values_only=True), 1):
    payload = {MAPPING[h]: v for h, v in zip(headers, row) if h in MAPPING and v is not None}
    # ... same send logic
```

---

## Monitoring After Import

```bash
semantius call crud read_webhook_receiver_log '{
  "filters": "receiver_id=eq.<receiver_id>",
  "order": "created_at.desc",
  "limit": 20
}'
```
