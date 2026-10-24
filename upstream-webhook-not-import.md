  # Instructions: webhooks are not an import path (semantius-agent skills)

  Work in `semantius-agent/semantius-plugin/skills/`. All line numbers below refer to that tree.

  ## Goal

  Webhook receivers let **external systems** (a SaaS integration, a nightly job) push records into one table, one signed
  HTTP request per record. **Importing a file is `semantius-importer`'s job**, never a webhook's. Remove every instruction
  that presents a webhook as a way to import data. Change nothing else about webhooks.

  Rules:
  - No Python anywhere.
  - No sample secret values.

  The same section has already been removed from the MCP instructions (`postgrest-mcp` `src/SKILL.md`, not yet committed).

  ## Changes

  ### 1. `use-semantius/references/webhook-import.md` → `webhooks.md`
  Rename the file with `git mv`, then rewrite it as a reference for receivers.

  - **New title and opening:** use "Semantius Webhook Receivers". The opening says what a receiver is (see Goal) and adds
    one line: "To import a file, use the `semantius-importer` skill; this is not a webhook task."
  - **Keep, reframed for the payload an external system sends:**
    - **Step 1, target entity and writable fields.** Keep the rules: never write to `readonly` / `disabled` fields, nor to
      `_label` / `<fk>_label`.
    - **Step 2, find or create the receiver:**
      - The label names the producing system, not "Agent Import": filter on `label=eq.<label>&table_name=eq.<table>`.
      - The secret is generated per receiver with at least 32 random characters (`openssl rand -hex 32`). Give no example
        value; delete `aB3kP9mXqZ`.
    - **Step 3, endpoint:** `getCurrentUser` → `{api_baseurl}/hook/{webhook_receiver_id}`.
    - **The enum, `id_type` and inherited-field rules.** Phrase them as rules for the fields of the payload, not for
      "source columns".
    - **"Signing Scheme (Standard Webhooks)"** stays, with one short TypeScript `sign()` function taken from the current
      Bun script (`createHmac("sha256", secret)` over `{webhook-id}.{webhook-timestamp}.{body}`, header `v1,<base64>`).
    - **"Monitoring After Import"** is renamed "Monitoring deliveries" (`read_webhook_receiver_log`).
  - **Delete:**
    - the opening "two batched paths" text;
    - "Choose Your Approach";
    - the Step 4 CSV column → field auto-mapping table;
    - Approach 1 (Bun), Approach 2 (pure shell), Approach 3 (Python), and the Excel snippets;
    - all `Run:` blocks;
    - the `failed_rows` handling.

  ### 2. `use-semantius/SKILL.md`
  - **Line 66**, reference table row: change it to `references/webhooks.md` | "Receiving records from external systems
    through signed webhook receivers: setup, signing, logs".
  - **Line 105** ("Importing a CSV file?"): keep the `semantius-importer` pointer, and delete the sentence about
    `references/webhook-import.md`.

  ### 3. `use-semantius/references/data-modeling.md:819`
  In the `webhook_receivers` row, change "Import/integration endpoints" to "Integration endpoints for external systems".

  ### 4. `use-semantius/references/crud-tools.md:505`
  In `read_webhook_receiver`, change the key filter `"label=eq.Agent Import&table_name=eq.<table>"` to
  `"label=eq.<label>&table_name=eq.<table>"`.

  ### 5. `semantius-importer/SKILL.md:16`, `:39`, `:251`
  Point all three references to `use-semantius references/webhooks.md`. They already describe webhooks as "external
  systems pushing rows" / "not this skill's path"; keep that.

  ### 6. Evals
  - Delete `use-semantius/evals/` entirely: `evals.json`, `README.md`, `test-import.csv` and `trigger-eval.json`.
    - It is skill-creator scaffolding with a Python runner, and nothing uses it.
    - Its eval 2 (`import-large-csv-via-webhook`) and `trigger-eval.json:12` make the webhook a CSV import path.
    - Other skills' `evals/` folders stay. `semantius-optimizer` runs `evals/round-trip/check.ts` at runtime.
  - `semantius-importer/evals/trigger-eval.json:10` ("Generate 50k product records from a CSV into our webhook receiver",
    `should_trigger: false`): delete this line. It encodes the old split, where a CSV import goes to a webhook.
  - Keep `semantius-importer/evals/trigger-eval.json:11` and `semantius-transfer/evals/trigger-eval.json:16`. In those, an
    ERP pushes rows continuously, so "not this skill" is correct.

  ## Leave unchanged

  These mention webhooks without making them an import path:
  - the lists of built-in tables in the analyst, modeler and optimizer (`webhook_receivers`, `webhook_receiver_logs`);
  - the architect's notification side effects (`trigger_event / webhook_receiver`);
  - the transfer's "webhook receivers do not travel";
  - the tool parameter docs in `crud-tools.md` §§ "Webhook Receiver Tools" / "Webhook Receiver Log Tools", apart from
    change 4;
  - `data-modeling.md:186` ("inbound HTTP intake").

  All CHANGELOGs stay as they are.

  ## Check

  Run from `semantius-plugin/skills/`:
  ```bash
  grep -rn "webhook-import" . | grep -v CHANGELOG      # nothing
  grep -rni "agent import\|aB3kP9mXqZ" .                # nothing
  grep -rniE "csv|xlsx|excel|python" use-semantius/references/webhooks.md   # nothing
  ```
  Then push. In semantius-cli, run `bun run sync-skills` and commit with the message it prints.
