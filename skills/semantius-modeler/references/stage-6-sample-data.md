# Stage 6: Sample data (modeler reference)

_Read this when the workflow reaches Stage 6. The stage map is in SKILL.md._

## Stage 6: Sample Data

> 🛑 **MUST-FIRE consent gate, sample data is NEVER written without an explicit, scoped "yes."** Seeding writes business records into the user's live model. It is the one accidental-write surface in this skill, so it is gated harder than anything else here. Three hard rules, no exceptions:
>
> 1. **Ask, then STOP.** Present the sample-data question as its own standalone question and END THE TURN. Do not generate the seed script, do not run anything, do not "prepare to seed" in the same turn. Wait for a fresh user reply that answers this question.
> 2. **Only an explicit, unambiguous "yes" to THIS question is consent.** The reply must clearly mean "yes, create the sample records" (e.g. "yes", "yes seed them", "go ahead and create the sample data"). The following are **NOT consent** and MUST lead to a re-ask or no action, NEVER to a seed:
>    - Continuation / acknowledgement words: `continue`, `ok`, `okay`, `go on`, `proceed`, `next`, `sure`, `go ahead`, `keep going`, `fine`, `k`, a thumbs-up, or silence.
>    - A "yes" that could be answering something else, or that arrives bundled with other instructions.
>    - Any reply where it is not *certain* the user is opting into sample-data writes.
> 3. **Default is NO.** On no answer, an ambiguous answer, a topic change, a request to do something else, a non-interactive run, or session close, **do not seed.** When in any doubt, re-ask the single question (*"Confirm: create 10 sample records in each new entity? (yes / no)"*) and wait. Treating ambiguous input as consent is the exact failure this gate exists to prevent: one wrong inference writes dozens of rows into a live model, and that is never acceptable.
>
> This gate governs every path into the seed script below. Wherever this section later says the user's "yes" authorizes the run, it means *this* yes and nothing weaker.

After verification, ask the sample-data question on its own (this is a gate, not a footer; see the consent gate above):

> The `<System Name>` model is live in Semantius ✅
>
> [Open `<System Name>` in Semantius →](<ui_baseurl>/<module_slug>)
>
> Would you like me to generate 10 realistic sample records for each newly-created entity?

### How many records (the count is not optional)

**The default is exactly 10 records per eligible entity. Seed that many unless the user names a different number.** The "10" in the question above is a commitment, not a loose suggestion: if the user says "yes" to that question, you have promised 10 per entity and must deliver 10 per entity. Seeding 2 or 3 "to show it populated" is a defect, not a shortcut — it under-delivers what the user agreed to and makes the model look empty in lists and reports.

- **The only ways to legitimately seed fewer than 10 for an entity:**
  1. The user explicitly asked for a different count (then use their number, for every entity).
  2. An FK into an ineligible table can supply fewer than 10 distinct real IDs and the field is **required** (so rows can't be created without it). In that case, seed as many as the available IDs allow and **say so in the summary** for that entity — never silently truncate.
- **Self-check before you run the script:** count the `post(...)` calls per entity in the generated script. If any eligible entity has fewer than 10 (or fewer than the user's chosen number) without a reason from the list above, the script is wrong — add rows until it hits the count before running it.
- The example in "Script pattern" below is **abbreviated to two rows for readability only**. Do not mirror its row count — generate the full 10.

### How sample data gets written (read this before any insert)

**The single Bun seed script is the ONLY way this stage writes records.** Generate it (see below), run it once with `bun run`, done. Do not insert records any other way.

- **No probe, test, or "gate-check" inserts.** Never hand-run an individual `semantius call crud postgrestRequest` to "test the lifecycle gates", "see if the account can write", or "trip the ownership rules" before bulk-seeding. Writing a deliberately-bad or throwaway row into a live table is never a diagnostic step: it pollutes shared state if it lands, and there is nothing to learn that the real seed run won't tell you. If a record would violate a gate, fix the seed data, not the gate.
- **Only an explicit, scoped "yes" authorizes the seed run** (per the consent gate at the top of this stage). Once the user has unambiguously opted into sample data for THIS question, running the prescribed seed script is the in-scope, intended action, not a workaround. But a continuation word (`continue`, `ok`, `proceed`, `go on`, `next`, `sure`) or an off-topic / bundled reply is NOT that yes; re-ask and wait, do not seed. The Bun-script form is prescribed for context-efficiency (one `bun run` instead of dozens of tool calls); it is not a trick to hide writes, and it is never a license to skip the consent gate.

**If running the seed script needs a permission approval**, say so once, in plain language, and let the user grant it or choose another option. For example: *"Seeding runs a script that inserts the sample rows; your setup will ask you to approve running it once. Approve it and I'll continue, or I can hand you the script to run yourself."* Then stop and wait.

- Do NOT name, quote, or describe the harness permission system, the Bash classifier, or any "guard" / "write-protection" machinery. The user does not need the agent's sandbox internals, and dramatizing a routine approval prompt as a "guard" with "intent" is confusing and alarming.
- Do NOT present an invented denial message as a verbatim quote.
- Keep every line here within the Writing Conventions above (US English, no em-dashes).

### Scope: whose tables get sample data

**Only entities this run created get sample records.** Everything else is off-limits. Writing seed data into an existing table pollutes live records, confuses reports, and can break referential integrity for users who are actively using the platform.

| Bucket | Eligible for sample data? |
|---|---|
| ✨ New entities created this run | ✅ Yes |
| 🛑 Resolved as "rename incoming" (a new table under the renamed name) | ✅ Yes, it's a new table |
| 🛑 Resolved as "rename both", the *incoming* side | ✅ Yes, new table |
| 🛑 Resolved as "rename existing" | ❌ **Never**, the table already has records |
| 🛑 Resolved as "merge", target existing entity | ❌ **Never**, existing table |
| ♻️ Same-module match (entity already existed) | ❌ **Never**, existing table |
| 🔒 Built-in `users` | ⚠️ Off by default, allowed only after explicit confirmed override (see below) |
| 🔒 Other Semantius built-ins (`roles`, `permissions`, `permission_hierarchy`, `role_permissions`, `user_roles`, `webhook_receivers`, `webhook_receiver_logs`, `modules`, `entities`, `fields`) | ❌ **Never, under any circumstances**, no override |

**Sample `users`, off by default, confirmed override allowed.** `users` is platform infrastructure, it controls authentication. Fake users cannot log in (no password, no real IdP identity), cannot receive meaningful role assignments, and will pollute audit trails. **Default behavior: decline and explain these limitations.** If after that explanation the user still wants sample users and explicitly confirms they understand the generated users cannot log in, you may proceed. When you do:

- Use clearly-synthetic identifiers: `email: "sample1@example.invalid"` (the `.invalid` TLD is reserved exactly for this), `full_name: "Sample User 1"`, etc.
- If the model has a `workflow_state` / `is_active` / similar field on users, seed to an inactive/test value so the rows can't be mistaken for real accounts.
- Never assign roles to sample users (no `user_roles` inserts, that's the absolute-never bucket below).
- Surface the override in the final summary: *"Created N sample users per your explicit request, none of them can log in."*

**Other built-in tables stay absolute, no override.** `roles`, `permissions`, `permission_hierarchy`, `role_permissions`, `user_roles`, `webhook_receivers`, `webhook_receiver_logs`, `modules`, `entities`, `fields`. These control RBAC, integrations, and the platform's own schema; seeding fake rows corrupts real users' access and the platform itself. Decline every request, even confirmed ones.

### FK fields that point at ineligible tables

A new entity often has FKs to built-ins or existing entities (e.g. `subscriptions.business_owner_id → users`, `subscriptions.primary_department_id → departments` when `departments` is pre-existing). For those fields:

- **Read existing records** from the target table (e.g. `GET /users?select=id&limit=20`) and **pick real IDs at random** to use as FK values.
- Never insert synthetic target records to satisfy the FK. If the target table has zero rows and seeding would require inventing one, skip the FK (leave it null if nullable) or skip the sample record entirely.
- For FKs into **other newly-created entities** in the same run, capture the inserted IDs from those earlier POSTs (see script pattern below) and reference them normally.

Create records in dependency order (entities with no parent FKs first, junction tables last, the model §4 order is usually correct), restricted to the eligible set defined above.

**Generate a single Bun (TypeScript) script** for all sample data rather than making individual CLI calls. This avoids context bloat from dozens of sequential tool invocations. Write the script under `<cwd>/.tmp_deploy/seed_<short>.ts`, run it once with `bun run`, check the output, and delete it. **Never write generated scripts into the skill folder or the working directory root.** They are ephemeral one-shots; persisting them across runs accumulates as catalog drift, mixes throw-away artifacts with skill source, and survives session boundaries. See the "Generated artifacts" section above for the full rule.

A Bun script is preferred over a `.sh` script for seeding because it keeps JSON construction, response-envelope unwrapping, and FK-id capture in one cross-platform runtime — no `python3 -c` extractors, no shell-quoting puzzles for record bodies containing apostrophes or Unicode, no Windows-vs-Git-Bash subprocess-piping surprises. The script consists of sequential `semantius call crud postgrestRequest` calls, one per record, capturing inserted IDs directly from the POST response for use in FK fields.

### postgrestRequest response shape

By default `semantius call` **already unwraps to `response.data`** — stdout is the array PostgREST returned, not the `{"request":..., "response":...}` envelope. (Use `--diag` if you ever need the full envelope; you almost never do.) On top of that, `--single` asserts exactly one row and emits the single object directly:

- no flags → stdout is `[{...}, {...}, ...]` (array, possibly empty)
- `--single` → stdout is `{...}` (single object); exit 1 on 0 rows, exit 2 on 2+ rows
- `--diag` → stdout is `{"request":..., "response":{"data":..., ...}}` (full envelope)

For a `POST` that inserts one row, **always use `--single`** so you get the object directly and the CLI fails loudly if the insert returned the wrong cardinality. For a `GET` you expect to match one row, `--single` doubles as a sanity check.

```bash
# Correct — --single returns the inserted row as a bare object
ID=$(semantius --single call crud postgrestRequest '{"method":"POST","path":"/campaigns","body":{...}}' \
  | bun -e 'console.log((await Bun.stdin.json()).id)')

# Also correct — no flag, stdout is the array, take [0]
ID=$(semantius call crud postgrestRequest '{"method":"POST","path":"/campaigns","body":{...}}' \
  | bun -e 'console.log((await Bun.stdin.json())[0].id)')

# WRONG — stdout is already unwrapped; there is no .response.data unless you passed --diag
ID=$(... | bun -e 'console.log((await Bun.stdin.json()).response.data[0].id)')
```

`GET` count via the unwrapped array:

```bash
COUNT=$(semantius call crud postgrestRequest '{"method":"GET","path":"/campaigns?select=id"}' \
  | bun -e 'console.log((await Bun.stdin.json()).length)')
```

`python3 -c "import json,sys; ..."` extractors are forbidden — they don't work reliably on Windows where `python3` may not be on `PATH`, and they pull a second runtime into a deploy that otherwise only needs Bun and `semantius`.

### Script pattern

```typescript
// <cwd>/.tmp_deploy/seed_<short>.ts — run with: bun run <path>
async function pgSingle(body: unknown): Promise<any> {
  const proc = Bun.spawn(["semantius", "--single", "call", "crud", "postgrestRequest"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(JSON.stringify(body));
  proc.stdin.end();
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0) throw new Error(`postgrestRequest failed (exit ${code}): ${stderr}`);
  return JSON.parse(stdout); // already a single object (--single enforces 1 row)
}

const post = (path: string, body: Record<string, unknown>) =>
  pgSingle({ method: "POST", path, body });

// NOTE: this example shows 2 rows per entity for READABILITY ONLY.
// A real seed run creates 10 per eligible entity (see "How many records" above) — expand each block to the full count.
console.log("=== Seeding campaigns ===");
const campaigns = [];
for (const row of [
  { campaign_name: "Spring Launch", workflow_state: "active" },
  { campaign_name: "Fall Promo", workflow_state: "draft" },
  // ... 8 more, 10 total — cycle §5 enum values so each appears at least once ...
]) {
  campaigns.push(await post("/campaigns", row));
}
console.log(`  seeded ${campaigns.length} campaigns`);

console.log("=== Seeding leads ===");
// Use captured IDs for FK fields — never assume sequential IDs
for (const row of [
  { lead_name: "Jane Smith", campaign_id: campaigns[0].id },
  // ... 9 more, 10 total ...
]) {
  await post("/leads", row);
}
```

`--single` is the right default for seed inserts because every row is created individually and the cardinality contract is "exactly one". If `RETURNING` ever produces 0 rows (RLS suppressed the result) or 2+ rows (PostgREST returned multiple), the CLI exits non-zero and the script aborts — much better than silently picking `data[0]` from an empty or surprising array.

The script is invoked from any shell with:

```bash
bun run <cwd>/.tmp_deploy/seed_<short>.ts
```

**Important for FK fields:** Capture IDs directly from each POST response, do not make a separate GET query to look them up by name. Filters with spaces (e.g. `?campaign_name=eq.Spring Launch`) require URL encoding; capturing from the POST response avoids this entirely.

**Enum safety, read the model, not your intuition:** Before writing any enum value into a seed record, look it up in the model's §5 enum tables for *that specific field*. Different fields on different entities may look similar but have different allowed values (e.g., `campaigns.type` includes `"Direct Mail"` but `leads.lead_source` does not, using the wrong one will fail with a check constraint error). Never guess or copy enum values across fields.

**String safety:** Inside the Bun script, `JSON.stringify` handles every character correctly — Unicode punctuation, apostrophes, backticks, multi-line strings, all pass through to `semantius` unchanged. This is exactly why the seed script is a `.ts` file and not a `.sh` file: a pure-shell seeder using `echo '{...}'` or `$PG '...'` would still break on apostrophes and embedded shell metacharacters, and "fixing" that by stripping characters from seed data is the same correctness bug as truncating descriptions. Generate realistic seed strings (including Unicode where the domain has it); do not pre-strip.

Generate realistic data:
- Real-sounding names and emails (not "Test User 1")
- Enums: cycle through all valid model §5 values for that specific field so every value appears at least once
- Dates: realistic mix of past and future
- Numbers: plausible domain ranges
- Booleans: realistic mix

Run the complete script in one `bun run` call (the only write path; see "How sample data gets written" above, no probe inserts) and report the final output summary. If the `bun run` needs a permission approval, handle it plainly and once per that section, never by hand-running individual inserts and never by narrating the harness permission machinery.

**Report the per-entity count in the summary.** State how many records landed in each entity, e.g. `Asset Contracts: 10, SaaS Subscriptions: 10, ...`. This is both the user's receipt and your own honesty check: if any eligible entity shows fewer than 10 (or fewer than the user's chosen number), the line must carry the reason from "How many records" above (user-chosen count, or FK-id scarcity on a required field). An unexplained low count is a defect to fix, not a summary to ship.

---

