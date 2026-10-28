# Stage 6: Sample data (modeler reference)

_Read this when the workflow reaches Stage 6. The stage map is in SKILL.md._

## Stage 6: Sample Data

> 🛑 **MUST-FIRE consent gate, sample data is NEVER written without an explicit, scoped "yes."** Seeding writes business records into the user's live model. It is the one accidental-write surface in this skill, so it is gated harder than anything else here. Three hard rules, no exceptions:
>
> 1. **Ask, then STOP.** Present the sample-data question as its own standalone question and END THE TURN. Do not generate the seed script, do not run anything, do not "prepare to seed" in the same turn. Wait for a fresh user reply that answers this question.
> 2. **Only an explicit, unambiguous "yes" to THIS question is consent.** The reply must clearly mean "yes, create the sample records" (e.g. "yes", "yes seed them", "go ahead and create the sample data"). **A reply that specifies sample-data counts is also consent and sets those counts** (e.g. "10 each", "12 per table but 20 customers", "just 5 of everything"): it is a more specific yes, parsed into the global `COUNT` plus per-table `perEntity` overrides, and honored without re-asking. The following are **NOT consent** and MUST lead to a re-ask or no action, NEVER to a seed:
>    - Continuation / acknowledgement words: `continue`, `ok`, `okay`, `go on`, `proceed`, `next`, `sure`, `go ahead`, `keep going`, `fine`, `k`, a thumbs-up, or silence.
>    - A "yes" that could be answering something else, or that arrives bundled with **unrelated** instructions (a sample-data count is not "unrelated"; it refines this very answer).
>    - Any reply where it is not *certain* the user is opting into sample-data writes.
>
>    **Precedence — a count beats a continuation word.** When a reply carries BOTH a continuation/acknowledgement word AND a sample-data count (or an explicit "create the records" instruction), the **count wins**: it is an unambiguous opt-in that also sets the counts, so seed, do not re-ask. Examples: bare "ok" → re-ask; "ok, but 30 customers" → seed with `COUNT = 10` and `perEntity.customers = { target: 30 }`; "sure, 20 each" → seed with `COUNT = 20`. A continuation word disqualifies a reply ONLY when it carries no count and no explicit create intent.
> 3. **Default is NO.** On no answer, an ambiguous answer, a topic change, a request to do something else, a non-interactive run, or session close, **do not seed.** When in any doubt, re-ask the single question (*"Confirm: create 10 sample records in each new entity? (yes / no)"*) and wait. Treating ambiguous input as consent is the exact failure this gate exists to prevent: one wrong inference writes dozens of rows into a live model, and that is never acceptable.
>
> This gate governs every path into the seed script below. Wherever this section later says the user's "yes" authorizes the run, it means *this* yes and nothing weaker.
>
> **Task tracking.** The question itself is a standalone question, not a ledger task. No `Apply › Add sample data` task exists until the user says yes; on yes, the next response's first call is `TaskCreate` for it (`in_progress`), and it goes `completed` when the seed report is printed; on no or on a decline, nothing is created and no task changes. The `Apply › Verify what is live` task was already completed before the closing block was emitted (SKILL.md → Closing Contract → Task sequencing).

After verification, ask the sample-data question on its own (this is a gate, not a footer; see the consent gate above):

> **Fast flow, after the go-ahead:** asked in every flow, fast flow included ([fast-flow.md](../../semantius-admin/references/fast-flow.md), section 4.4): it is the one question a fast run asks, at the end, and it waits for the answer; the consent rules above are unchanged, and the go-ahead is never consent to sample data. A fast run shows the spec download line below before the question, a download link to the deployed spec in the form this agent's environment offers for downloads; guided and expert runs leave it out (SKILL.md → Closing Contract).

> The `<System Name>` model is live in Semantius ✅
>
> [Open `<System Name>` in Semantius →](<ui_baseurl>/<module_slug>)
>
> [Download the `<System Name>` spec](<download link to the deployed spec>) *(fast run only)*
>
> Would you like me to seed sample data? **10 records × \<N\> tables = \<M\> records**, across: \<Plural Labels of the newly-created tables\>. (yes / no)

(`\<N\>` = count of eligible (newly-created) tables; `\<M\>` = `COUNT × N`, the default offer. The user's reply may keep "yes" (every table = `COUNT`) or set counts ("12 each", "12 each but 20 customers"), which is itself consent (see the gate) and resolves to `COUNT` + per-table `perEntity` overrides. With overrides, the total is the **sum of each table's resolved target**, not `COUNT × N`, so state it that way and name the exceptions (e.g. "12 each across 8 tables, Customers at 20, 116 total"). Whatever they choose, the same numbers drive `assertSeedCounts`, so the offer, the reply, and the enforced count are one.)

### How many records (the count is not optional)

**The default is exactly 10 records per eligible entity. Seed that many unless the user names a different number.** The "10" in the question above is a commitment, not a loose suggestion: if the user says "yes" to that question, you have promised 10 per entity and must deliver 10 per entity. Seeding 2 or 3 "to show it populated" is a defect, not a shortcut — it under-delivers what the user agreed to and makes the model look empty in lists and reports.

**From reply to script, in order:** (1) decide consent per the gate above — a count-bearing reply is consent (precedence rule). (2) **Parse the reply into `COUNT` (global) and `perEntity` (per-table overrides):** a number with NO table name sets the global `COUNT` (`"yes"` → 10; `"20 records"` / `"20 each"` / `"5 of everything"` → `COUNT = 20`/`5`); a number paired with a table or label sets ONLY that table's override and leaves `COUNT` unchanged (`"30 customers"` → `perEntity.customers = { target: 30 }`, `COUNT` still 10; `"12 each but 20 customers"` → `COUNT = 12` and `perEntity.customers = { target: 20 }`). (3) author the script with those exact values plus `eligibleTables` (every newly-created table). (4) the SAME `COUNT` / `perEntity` / `eligibleTables` go into `assertSeedCounts`, so the number the user agreed to is the number enforced.

- **Counts can vary per table, and that's expected.** There is a global default (`COUNT`, 10 unless the user names another global number) and an optional per-table override map (`perEntity`). The user's reply sets both: *"yes"* → every table = 10; *"12 each"* → `COUNT = 12`; *"12 each but 20 customers"* → `COUNT = 12` and `perEntity = { customers: { target: 20 } }`. Overrides go **up or down** — a per-table number the user named is just as valid above the default as below it.
- **FK-id scarcity is just a downward override with a reason.** When a **required** FK into an ineligible table can supply fewer than the target distinct real IDs, set `perEntity[table] = { target: <available>, reason: "<why>" }`. The guard accepts the lower count and the receipt surfaces the reason — never silently truncate.
- **Generate rows by looping to the target — do NOT hand-write a literal array of N rows.** The script pattern below loops `for (let i = 0; i < target(table); i++)` and builds each row as one plausible record from pools you fill from the domain, drawn by the table's seeded generator (`rng` in `deploy-lib.ts`), with every §5 enum dealt by `r.deal(values, n)` so each value appears (see "Records, not fields"). This makes the count **structural**: the loop cannot emit fewer than the target. Hand-written literal arrays are exactly where rows get dropped under volume (10 tables × 10 rows = 100 literals), which is why a plain "yes → 10 each" so often came back short.
- **The guard is the backstop, not the primary mechanism.** Declare `const COUNT` + `perEntity` + **`const eligibleTables = [...]`** (every newly-created table that must be seeded), tally `counts[table] = rows.length`, and END the script with `assertSeedCounts(counts, COUNT, perEntity, eligibleTables)` (from `deploy-lib.ts`). It prints a per-table receipt and **exits non-zero if any eligible table missed its resolved target — including a table you forgot to seed at all**: the check is driven by `eligibleTables`, so a silently-skipped table reads as 0 and fails, which a counts-only check could not catch. With loop-to-target generation it should never fire; it catches the residual mistakes (a wrong `target()`, an early FK-pool exhaustion, a whole forgotten table) and turns the old silent under-seed into a loud halt. This replaces the "count the inserts by hand" self-check that kept getting skipped (18 vs 50, 2-3 per entity). Tally from the array `postMany` returns (`counts[table] = rows.length`), not from the number of calls (one call per table).

### Data has to read plausibly, not just hit the count

The count is one contract; readability is the other. The user reviews the seeded rows in list views, and a field that is constant across every row reads as a defect even when the count is right. Guard the fields a person would notice first:
- human name components (a surname repeated across the whole table)
- a label column whose values are all one word when the entity is a person, an address or an order
- a company / city / product field that repeats where variety is implied
- a street name repeated on every address

`assertSeedDistinct(table, rows, fields)` (from `deploy-lib.ts`) is the mechanical form of this. Call it for every human-facing component you generated from a pool, right after `postMany` / `seedEnsureMany`. It sees columns only: when name parts exist only inside one combined field (`contact_name: "Jane Smith"`), the full names stay distinct even with one surname, so pass the parts instead: `assertSeedDistinct("contacts", people.map(([, ln]) => ({ last_name: ln })), ["last_name"])`. A street is the same case: `1432 Market Street` and `88 Market Street` are different strings, so the guard gets the street names without their house numbers (see the script pattern). It demands `min(rows, 8)` distinct values by default, so a pool for a guarded field holds at least 8 entries. For a label column or a `unique_value` field, pass `rows.length` as `minDistinct`: every row must differ.

### How sample data gets written (read this before any insert)

**The single Bun seed script is the ONLY way this stage writes records.** Generate it (see below), run it once with `bun run`, done. Do not insert records any other way.

- **No probe, test, or "gate-check" inserts.** Never hand-run an individual `semantius call crud postgrestRequest` to "test the lifecycle gates", "see if the account can write", or "trip the ownership rules" before bulk-seeding. Writing a deliberately-bad or throwaway row into a live table is never a diagnostic step: it pollutes shared state if it lands, and there is nothing to learn that the real seed run won't tell you. If a record would violate a gate, fix the seed data, not the gate.
- **Only an explicit, scoped "yes" authorizes the seed run** (per the consent gate at the top of this stage). Once the user has unambiguously opted into sample data for THIS question, running the prescribed seed script is the in-scope, intended action, not a workaround. But a bare continuation word (`continue`, `ok`, `proceed`, `go on`, `next`, `sure`) or an off-topic / bundled reply is NOT that yes — though a reply that carries a sample-data count IS consent, per the precedence rule above; re-ask and wait only when neither a count nor an explicit create intent is present. The Bun-script form is prescribed for context-efficiency (one `bun run` instead of dozens of tool calls); it is not a trick to hide writes, and it is never a license to skip the consent gate.

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

**Key type decides who supplies `id`.** For an entity whose spec carries `**Key type:** bigint` or `**Key type:** text`, the database assigns no id: every sample row must carry its own unique `id` (a number, or a short text key), and FK values into it are those ids. For the default key and `uuid` / `typeid`, never send `id`; take it from the insert response. FK columns into a `uuid` / `typeid` / `text` entity hold that id as given, never a number.

**Generate a single Bun (TypeScript) script** for all sample data rather than making individual CLI calls. This avoids context bloat from dozens of sequential tool invocations. Write the script under `<cwd>/.tmp_deploy/seed_<short>.ts`, run it once with `bun run`, check the output, and delete it. **Never write generated scripts into the skill folder or the working directory root.** They are ephemeral one-shots; persisting them across runs accumulates as catalog drift, mixes throw-away artifacts with skill source, and survives session boundaries. See the "Generated artifacts" section above for the full rule.

A Bun script is preferred over a `.sh` script for seeding because it keeps JSON construction, response-envelope unwrapping, and FK-id capture in one cross-platform runtime — no `python3 -c` extractors, no shell-quoting puzzles for record bodies containing apostrophes or Unicode, no Windows-vs-Git-Bash subprocess-piping surprises. The script builds each table's rows in a loop and inserts them with **one `postgrestRequest` POST per table** (an array `body`; `postMany` / `seedEnsureMany` in `deploy-lib.ts`, ≤100 rows per call), capturing the inserted ids from the returned array for use in FK fields of the next table. Never one call per record: 10 rows × 6 tables is 6 calls, not 60.

### postgrestRequest response shape

By default `semantius call` **already unwraps to `response.data`** — stdout is the array PostgREST returned, not the `{"request":..., "response":...}` envelope. (Use `--diag` if you ever need the full envelope; you almost never do.) On top of that, `--single` asserts exactly one row and emits the single object directly:

- no flags → stdout is `[{...}, {...}, ...]` (array, possibly empty)
- `--single` → stdout is `{...}` (single object); exit 1 on 0 rows, exit 2 on 2+ rows
- `--diag` → stdout is `{"request":..., "response":{"data":..., ...}}` (full envelope)

For a `POST` that inserts a **single** row, use `--single` so you get the object directly and the CLI fails loudly if the insert returned the wrong cardinality. For a `GET` you expect to match one row, `--single` doubles as a sanity check. A bulk insert (array `body`, the seed default) **cannot** use `--single` — the CLI rejects the combination (exit 1, `SINGLE_ARRAY_INPUT`) because the response is always an array; read the ids off that array.

```bash
# Bulk insert (the seed default) — array body, no --single, stdout is the array of inserted rows WITH ids
IDS=$(semantius call crud postgrestRequest '{"method":"POST","path":"/campaigns","body":[{...},{...},{...}]}' \
  | bun -e 'console.log((await Bun.stdin.json()).map(r => r.id).join(","))')

# Single row — --single returns the inserted row as a bare object
ID=$(semantius --single call crud postgrestRequest '{"method":"POST","path":"/campaigns","body":{...}}' \
  | bun -e 'console.log((await Bun.stdin.json()).id)')

# WRONG — --single with an array body: rejected by the CLI (SINGLE_ARRAY_INPUT), nothing is sent
semantius --single call crud postgrestRequest '{"method":"POST","path":"/campaigns","body":[{...},{...}]}'

# WRONG — stdout is already unwrapped; there is no .response.data unless you passed --diag
ID=$(... | bun -e 'console.log((await Bun.stdin.json()).response.data[0].id)')
```

`GET` count via the unwrapped array:

```bash
COUNT=$(semantius call crud postgrestRequest '{"method":"GET","path":"/campaigns?select=id"}' \
  | bun -e 'console.log((await Bun.stdin.json()).length)')
```

A `GET` on the base of a family also returns every `is_a` descendant's records (and every base record a `has_a` insert created), so its live count is its own seeds **plus** its descendants'. Tally each level from its own inserts instead (see "Families" below).

`python3 -c "import json,sys; ..."` extractors are forbidden — they don't work reliably on Windows where `python3` may not be on `PATH`, and they pull a second runtime into a deploy that otherwise only needs Bun and `semantius`.

### Script pattern

Seed scripts reuse the committed [`deploy-lib.ts`](./deploy-lib.ts) for the loud Layer-2 transport — **`postMany(path, rows)` inserts a whole table's rows in ONE `postgrestRequest` POST (array `body`, ≤100 rows per call) and returns them WITH their ids**; `seedEnsureMany(path, rows, keyField)` is the re-run-safe variant. Copy that one file in first; a seed script needs **only** `deploy-lib.ts` — do NOT import `scaffold-lib.ts` (the scaffold is already deployed):

```bash
mkdir -p .tmp_deploy
# <skill-folder> = the directory this skill's SKILL.md was read from (absolute path; works for plugin and workspace installs alike)
cp "<skill-folder>/references/deploy-lib.ts" .tmp_deploy/deploy-lib.ts
```

```typescript
// <cwd>/.tmp_deploy/seed_<short>.ts — run with: bun run <path>
import { postMany, seedEnsureMany, pgRequest, assertSeedCounts, assertSeedDistinct, rng, uniq, slugify, exampleDomain } from "./deploy-lib";
// postMany("/campaigns", rows) inserts ALL of a table's rows in one call and returns them with their ids.
// The payload field is `body`, NOT `data` — postMany() owns that, so never hand-roll {method, path, data}.
// Build the rows in the loop, insert once per table; FK pools come from the returned array. For an FK-id
// pool from an existing table, GET an array:  await pgRequest("GET", "/users?select=id&limit=20").
// UNIFORM KEYS: postgrestRequest is the raw PostgREST path, so every row of one table must carry the SAME
// key set — `null` for a nullable column (reference / date / date-time), "" / 0 for a NOT NULL text /
// number; never omit a key on some rows and never a conditional spread. postMany asserts this up front.
// seedEnsureMany("/contacts", rows, "email") is the re-run-safe variant: it reads the keys first (`in.()`)
// and inserts only the missing rows. Use it over postMany() when the script might run more than once —
// see "Re-running the seed (idempotency)" below. post() / seedEnsure() remain for a genuine single row;
// a `for … await post()` loop over a table is the named anti-pattern.

const COUNT = 10;                              // global default (the user's number, else 10)
const counts: Record<string, number> = {};    // per-table tally, validated at the end
// per-table overrides (up OR down): user choice (e.g. customers: { target: 20 }) OR required-FK-id
// scarcity (e.g. approvals: { target: 4, reason: "only 4 users for required approver_id" })
const perEntity: Record<string, { target: number; reason?: string }> = {};
const eligibleTables = ["accounts", "contacts"];  // EVERY newly-created table that must be seeded (drives the guard's coverage check)
const target = (t: string) => perEntity[t]?.target ?? COUNT;

// GENERATE BY LOOPING TO THE TARGET — never hand-write a literal array of N rows. The literal array is
// where rows get silently dropped under volume (10 tables × 10 rows = 100 literals — this is why a plain
// "yes → 10 each" so often came back short). A `for i < target` loop makes the count STRUCTURAL: it cannot
// emit fewer. The DATA is still yours to author: each row is one plausible record, drawn by the table's
// seeded generator from pools YOU fill with real domain values, with every field that must agree with
// another derived from the same driver. See "Records, not fields" below the block.

// --- accounts ---
// No country field on accounts or on anything they belong to → US places. A place carries everything that
// must agree with its city; the street name comes from the country's pool (here US), the house number is drawn.
const places = [
  { city: "Springfield", state: "IL", postal: ["62701", "62703", "62704"], area: "217" },
  { city: "Riverside",   state: "CA", postal: ["92501", "92503", "92507"], area: "951" },
  { city: "Madison",     state: "WI", postal: ["53703", "53705", "53711"], area: "608" },
  { city: "Fairview",    state: "TN", postal: ["37062"],                   area: "615" },
  { city: "Salem",       state: "OR", postal: ["97301", "97302", "97304"], area: "503" },
  { city: "Arlington",   state: "TX", postal: ["76010", "76011", "76013"], area: "817" },
  { city: "Columbus",    state: "OH", postal: ["43201", "43206", "43215"], area: "614" },
  { city: "Burlington",  state: "VT", postal: ["05401", "05408"],          area: "802" },
];
const streets = ["Market Street", "Oak Avenue", "Maple Drive", "Cedar Lane", "Lincoln Road",
  "Elm Street", "Park Boulevard", "Washington Avenue", "Lakeview Drive", "Mill Road"];
// Invented names only, never real brands; the name also gives the email and web domain.
// Two pools combine into 144 distinct names, so a larger target still gets a name per row.
const nameRoots = ["Harbor", "Bluefin", "Cedar", "Northgate", "Beacon", "Ironline", "Sunset", "Metro",
  "Greenfield", "Lakeside", "Summit", "Copperleaf"];
const nameKinds = ["Medical Group", "Logistics", "Foods", "Manufacturing", "Hotels", "Dental", "Bakery",
  "Offices", "Clinics", "Supply", "Outfitters", "Builders"];
// §5 enum, dealt: every value appears once there are at least as many rows as entries; the repeated
// "active" weights the mix toward it
const accountStates = ["prospect", "active", "active", "active", "on_hold", "churned"];
console.log("=== Seeding accounts ===");
const ra = rng("accounts");
const n = target("accounts");
const names = ra.tuples(n, [nameRoots, nameKinds]).map(([root, kind]) => `${root} ${kind}`);
const states = ra.deal(accountStates, n);
const accountPlaces = ra.deal(places, n);    // cities spread before any repeats
const streetNames = ra.deal(streets, n);     // street names spread before any repeats
const accountRows = [];
for (let i = 0; i < n; i++) {
  const place = accountPlaces[i];
  const domain = exampleDomain(names[i]);    // harbormedicalgroup.example.com: reads real, never delivers
  accountRows.push({                         // build the row; every row carries the SAME keys
    account_name: names[i],
    workflow_state: states[i],
    phone: `(${place.area}) 555-01${String(ra.int(0, 99)).padStart(2, "0")}`,   // 555-0100..0199 is reserved for fiction
    email: `${ra.pick(["info", "contact", "hello", "office"])}@${domain}`,
    website: `https://${domain}`,
    street: `${ra.int(1, 2400)} ${streetNames[i]}`,
    city: place.city,
    state: place.state,
    postal_code: ra.pick(place.postal),      // from THIS city's codes, never a base + index
  });
}
const accounts = await postMany("/accounts", accountRows);   // ONE call; rows WITH ids
counts.accounts = accounts.length;
assertSeedDistinct("accounts", accountRows, ["account_name"], accountRows.length);   // label column: every row differs
assertSeedDistinct("accounts", accountRows, ["city"]);
assertSeedDistinct("accounts", streetNames.map((s) => ({ street_name: s })), ["street_name"]);   // the name, not the house number

// --- contacts (FK → accounts) ---
// A contact belongs to an account: its email domain comes from that account.
const firstNames = ["Jane", "Carlos", "Mei", "Tom", "Aisha", "Liam", "Sofia", "Raj", "Nina", "Omar", "Grace", "Daniel"];
const lastNames  = ["Smith", "Reyes", "Chen", "Becker", "Khan", "Murphy", "Rossi", "Patel", "Novak", "Haddad", "Okafor", "Lindqvist"];
const titles = ["Office Manager", "Operations Director", "Purchasing Lead", "CFO", "Facilities Coordinator", "IT Manager"];
console.log("=== Seeding contacts ===");
const rc = rng("contacts");
const people = rc.tuples(target("contacts"), [firstNames, lastNames]);   // distinct full names, both parts spread
const parents = rc.deal(accounts, people.length);   // FK: real ids from the array above, every account before any repeats
const contactRows = [];
for (let i = 0; i < people.length; i++) {
  const [fn, ln] = people[i];
  const account = parents[i];                // the driver for the email domain
  contactRows.push({
    contact_name: `${fn} ${ln}`,
    job_title: rc.pick(titles),
    // `email` carries unique_value: unique because every full name is
    email: `${slugify(fn)}.${slugify(ln)}@${exampleDomain(account.account_name)}`,
    account_id: account.id,
  });
}
const contacts = await postMany("/contacts", contactRows);   // ONE call (or seedEnsureMany("/contacts", contactRows, "email") when re-runs are plausible)
counts.contacts = contacts.length;
assertSeedDistinct("contacts", people.map(([, ln]) => ({ last_name: ln })), ["last_name"]);

// Last line — the mechanized count guard (backstop). Driven by eligibleTables, so it ALSO fails if a whole
// table was never seeded (not just an under-count). With loop-to-target generation it should never fire.
assertSeedCounts(counts, COUNT, perEntity, eligibleTables);
```

### Records, not fields

The loop fixes only the *count*; it calls no LLM at runtime. Each row is one plausible record that you author through its pools and its loop body: start from a few drivers (a place, a company, a person, the enum state), derive every field that must agree with them, and draw the rest with the table's generator. Never pick fields that belong together independently.

- **The generator: `const r = rng("<table>")`, one per table** (from `deploy-lib.ts`). The seed is fixed (42) and the table name gives each table its own sequence, so a re-run of the unchanged script writes the same rows. Any edit to the script (a table's count, a pool, the order of draws) can change that table's rows and the rows of every table that draws parents from it, so `seedEnsureMany` converges only on a re-run of the same script. Never `Math.random()`.
  - `r.pick(pool)`: one random entry, repeats fine (job title, email local part).
  - `r.int(min, max)`: house number, quantity, amount, day offset.
  - `r.chance(p)`: booleans with a realistic mix.
  - `r.deal(pool, n)`: `n` entries, shuffled, every pool entry once before any repeats (enum values, FK parents, places, street names).
  - `r.distinct(pool, n)`: `n` different entries; it throws when the pool has fewer than `n`.
  - `r.tuples(n, [poolA, poolB])`: `n` distinct combinations with both parts spread (first + last name, two-word names). It throws when the pools cannot give `n`; add pool entries.
- **Every enum is dealt: `r.deal(values, n)`**, so every §5 value appears once there are at least as many rows as values, in shuffled order, and two enums of the same length never move in step. Repeat a value in the pool to weight the mix (`["active", "active", "active", "on_hold", "churned"]`). Fields that depend on the state are derived from it (example below).
- **FK parents are dealt too: `r.deal(parentRows, n)`**, so every parent gets a child before any gets a second, and fields a child takes from its parent (company, city) stay as varied as the parents.
- **No base + index in anything a person reads.** A house number, postal code, phone, suite, amount or date is never `100 + i`, `10000 + i`, `555-01${i}` or `days(-7 * i)`. Draw it (`r.int(1, 2400)`, the place's postal list, `555-01` + `r.int(0, 99)`). The row index shows only in code-like fields, through `uniq` (`account_code`, `sku`, `invoice_number`).
- **Addresses come from a place.** A place carries everything that must agree with its city: city, state or region, country, its postal codes, and the phone area code. Pick the place, take the postal code from its own list, the region and country from the place, and build the phone on its area code. The street name comes from a pool of at least 8 names for the place's country, dealt over the rows (`r.deal(streets, n)`) so the names spread before any repeats; one pool serves every city of that country. The house number is drawn (`r.int(1, 2400)`). When the model keeps the house number in its own field, it goes there and the street field holds the name only.
  - **US or international.** When neither the entity nor any record it belongs to has a country field, every place is in the US (five-digit ZIP, two-letter state). When there is a country field, the places span several countries, each in its own real format (Germany: `10115 Berlin`, Berlin; UK: `London EC1A 1BB`; France: `75008 Paris`), and the country written is a value the field allows: its §5 enum value, or a real id read from the countries table. The street follows the country too: each country has its own pool of street names, and the house number stands where that country puts it (US: `1432 Market Street`; UK: `12 High Street`; Germany: `Hauptstraße 12`; Netherlands: `Kerkstraat 5`; France: `12 rue Victor Hugo`). Deal each country's pool over that country's rows, and guard the street names across the whole table.
  - **A record that belongs to another takes its parent's place.** A contact under an account uses the account's city, country and phone area code, so a contact of a German account never gets a US ZIP.
  - **Phones use the ranges set aside for fiction** where a country has one: US and Canada `555-0100` to `555-0199` behind the place's area code; UK mobile `07700 900000` to `07700 900999`, London `020 7946 0000` to `020 7946 0999`; Australia `(02) 5550 xxxx`, `(03) 5550 xxxx`, `(07) 5550 xxxx`, `(08) 5550 xxxx`. A place in any other country leaves the phone empty (`""`): a made-up number in a real format can belong to a real person.
- **Companies, people and emails belong together.** Company names are invented, never real brands: a sample account called Walmart with made-up revenue and contacts reads as a claim about a real company. The name gives the domain, `exampleDomain(name)` → `beaconfoods.example.com`; subdomains of `example.com` are reserved and never receive mail. The company's website and generic email (`info@`, `contact@`) use that domain, and a person's email is `${slugify(first)}.${slugify(last)}@<their company's domain>`. A person with no company uses `mail.example.com`. `slugify` throws on a name with no Latin letters (`李伟`, `Иван Петров`), so a non-Latin name carries a Latin form for its email (`{ first: "伟", last: "李", latin: ["wei", "li"] }`). (Sample `users` keep `.invalid`; see "Scope" below.)
- **Correlated fields derive from the driver**, e.g. a subscription's dates from its state:
  ```typescript
  const days = (d: number) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
  const rs = rng("subscriptions");
  const states = rs.deal(["trialing", "active", "active", "churned"], target("subscriptions"));
  const subscriptionRows = [];
  for (let i = 0; i < states.length; i++) {
    const state = states[i];
    subscriptionRows.push({
      workflow_state: state,
      churned_at: state === "churned" ? days(-rs.int(7, 300)) : null,   // past, only when churned — null keeps the key present
      renews_at:  state === "churned" ? null : days(rs.int(5, 90)),    // future otherwise
      seat_code:  uniq("SEAT-", i),                                      // code-like unique_value → index-composed
    });
  }
  const subscriptions = await postMany("/subscriptions", subscriptionRows);   // one call, uniform keys
  ```
- **A parent's totals come from its children.** Build the children in memory first, compute each parent's totals from them, insert the parents, then insert the children with their parent's id, matched by the parent's natural key (the order `postMany` returns is not a promise):
  ```typescript
  const ri = rng("invoices");   // the lines are built with the invoices, so they share its generator
  const catalog = [{ name: "Pallet wrap", price: 24.5 }, { name: "Forklift service", price: 180 }, { name: "Safety gloves", price: 6.75 }];
  const numbers = Array.from({ length: target("invoices") }, (_, i) => uniq("INV-", 1001 + i));   // code-like
  const lineRows = ri.deal(numbers, target("invoice_lines")).map((invoice_number) => {   // lines dealt over the invoices
    const item = ri.pick(catalog);
    const quantity = ri.int(1, 12);
    return { invoice_number, description: item.name, quantity, unit_price: item.price,
      line_total: Math.round(quantity * item.price * 100) / 100 };
  });
  const invoiceRows = numbers.map((invoice_number) => ({
    invoice_number,
    total_amount: Math.round(lineRows.filter((l) => l.invoice_number === invoice_number)
      .reduce((sum, l) => sum + l.line_total, 0) * 100) / 100,
  }));
  const invoices = await postMany("/invoices", invoiceRows);
  const invoiceId = new Map(invoices.map((v) => [v.invoice_number, v.id]));   // by natural key, not by position
  const invoiceLines = await postMany("/invoice_lines",
    lineRows.map(({ invoice_number, ...line }) => ({ ...line, invoice_id: invoiceId.get(invoice_number) })));
  ```
  Fall back to a hand-authored array of complete rows only for cross-field logic that cannot be derived (it reintroduces N literals, so avoid it at large targets).

### Uniqueness (and `unique_value` safety)

- **`unique_value` / DB-UNIQUE fields are a hard rule (as load-bearing as Enum safety).** Identify every field with `unique_value: true` first (the model's field tables, or `read_field`). A repeat there makes the table's POST fail with **409** — and because `postMany` sends the whole table in one all-or-nothing call, **none of that table's rows land**, `postMany` throws, and the run aborts — **`assertSeedCounts` never runs, so the count guard cannot catch it.** Make these distinct by construction:
  - a name or label: `r.distinct(pool, n)` when the pool holds at least `n` entries (it throws otherwise); past that, `r.tuples(n, [roots, suffixes])` joined as two words, or a variant tag (`Northwind Freight (EU)`);
  - a value built from parts: unique when its parts are (a person's email from `r.tuples` names; a company's email from its unique name);
  - a code-like field: `uniq("ACCT-", i)`.
- **Never glue an index onto a name a person reads.** `uniq(\`${appName} \`, i)` renders as `"Slack 0"`, `"1Password 9"`: a bare trailing digit that reads like a garbled version number, visible in every list view. The index belongs only in code-like fields (`account_code`, `sku`, `invoice_number`).
- **Do not hand-author an N-entry pool to reach the target**; that brings back the literal volume the loop removed. Grow distinct values by combining two pools with `r.tuples`.
- Low-cardinality fields (status, category, boolean) repeat by nature: `r.deal(values, n)` for enums, `r.pick` or `r.chance` for the rest.

**Cardinality is asserted per call, not per row.** `postMany` sends N rows and checks that PostgREST returned N — if `RETURNING` ever produces fewer (RLS suppressed rows) or the insert failed, it throws and the script aborts, so nothing silently picks `data[0]` from an empty or surprising array. `--single` keeps that role only for a genuine single-row `post()`; it cannot be combined with an array body.

### Re-running the seed (idempotency)

The seed script is a **one-shot**: `postMany()` (like `post()`) is a bare INSERT, so running it twice inserts a second full set of rows. `assertSeedCounts` does NOT catch this — it tallies only the rows THIS run inserted, so it still passes while the table silently holds 2×target. (This is the opposite of the deploy script, whose every write is read-before-write and re-run-convergent.) A partial first run that halted partway (e.g. the `contacts` call failed after the `accounts` call landed) is the common way this bites: a blind re-run appends another set of accounts. Note that one bulk call is all-or-nothing, so a table is either fully seeded or untouched — the partial state is always "some tables done, later ones not".

Two ways to stay safe:

- **Run it exactly once.** The normal path. If a run is interrupted partway, do NOT blindly re-run — first inspect what landed (`await pgRequest("GET", "/<table>?select=id")` and count), then either finish the remaining tables by hand or clear the table and reseed.
- **Use `seedEnsureMany(path, rows, keyField)` instead of `postMany`** when a re-run is plausible. It reads the whole table's keys first (one `keyField=in.(…)` GET per ≤100 rows), inserts only the missing rows in one POST, and returns every row (existing or new) WITH its id in input order, so a re-run converges instead of duplicating — the same `ensure` contract the deploy script uses. The `keyField` must be unique per row, present on every row, and stable across runs: a `unique_value` column is ideal, because the fixed seed of each table's `rng` regenerates the same key on every run of the same script. FK capture is unchanged:

  ```typescript
  // contactRows built exactly as in the script pattern above
  const contacts = await seedEnsureMany("/contacts", contactRows, "email");   // re-run-safe: reads the keys, inserts only the missing rows
  ```

The script is invoked from any shell with:

```bash
bun run <cwd>/.tmp_deploy/seed_<short>.ts
```

**Important for FK fields:** Capture IDs directly from the array each table's POST returns (`postMany` / `seedEnsureMany` hand you the rows with ids), do not make a separate GET query to look them up by name. Filters with spaces (e.g. `?account_name=eq.Beacon Foods`) require URL encoding; capturing from the POST response avoids this entirely. (This is a Layer-2 rule: catalog writes via `create_*` still resolve ids by re-reading — see the deploy script's `ensureMany`.)

**Families (`is_a` / `has_a` entities).** Seed them with the rules of `../../use-semantius/references/entity-families.md` → Writing:

- **Seed level by level, bases first**, each level at its own path (`/business_partners`, then `/customers`; `/activities`, then `/emails`).
- **An `is_a` record is ONE insert at its own table**, carrying the base's fields too (`POST /emails` with `subject`, `occurred_at` and `from_address`). Never insert a base row and then a subtype row: that creates two records, and a record's type cannot change.
- **A `has_a` row without `id` creates its base record too** (send the base's fields in the same row). To attach to base records you seeded earlier, send only the extension's own fields plus `id`; a differing base value is refused (`90246`).
- **Never upsert** (`seedEnsureMany` never does; `on_conflict` / `merge-duplicates` fail with `42P10`). A changed row is a `patchById(table, id, body)` after the insert.
- **Tally each level from its own inserts** (`counts.emails = emails.length`), and list every level in `eligibleTables`.

**Enum safety, read the model, not your intuition:** Before writing any enum value into a seed record, look it up in the model's §5 enum tables for *that specific field*. Seeds always write the **value** (the backticked token), never a property sub-bullet under it (`label:`, `color:`, `icon:`, `description:`). Different fields on different entities may look similar but have different allowed values (e.g., `campaigns.type` includes `"Direct Mail"` but `leads.lead_source` does not, using the wrong one will fail with a check constraint error). Never guess or copy enum values across fields.

**Nullability safety, `""` not `null` for required text:** Most formats are `NOT NULL` — only `reference`, `date`, and `date-time` accept `null` (data-modeling.md → *`default_value`*). For a non-nullable TEXT column (`string`, `text`, `multiline`, `html`, `code`, `color`, `icon`) that a row should leave empty, send an **empty string `""`**, never `null`: a `null` fails with a NOT NULL violation and aborts the run before `assertSeedCounts`. Only omit a field or pass `null` when its format is `reference` / `date` / `date-time` *and* it is not `input_type: "required"`.

**Display formats:** a `rating` value is an integer from 0 to 5 (from 1 to 5 when the field is required; `0` means not rated); a `color` value is a lowercase hex color (`#3b82f6`); an `icon` value is a Lucide icon name in kebab-case (`circle-check`) that passes `bun "<skill-folder>/../use-semantius/references/lucide-icon-checker.ts" <name…>`, never a made-up name.

**String safety:** Inside the Bun script, `JSON.stringify` handles every character correctly — Unicode punctuation, apostrophes, backticks, multi-line strings, all pass through to `semantius` unchanged. This is exactly why the seed script is a `.ts` file and not a `.sh` file: a pure-shell seeder using `echo '{...}'` or `$PG '...'` would still break on apostrophes and embedded shell metacharacters, and "fixing" that by stripping characters from seed data is the same correctness bug as truncating descriptions. Generate realistic seed strings (including Unicode where the domain has it); do not pre-strip.

Generate realistic data (see "Records, not fields"):
- Real-sounding invented names (not "Test User 1"), emails at `example.com` subdomains
- Enums: deal all valid model §5 values for that specific field (`r.deal(values, n)`), so every value appears at least once when there are at least as many rows as values
- Dates: realistic mix of past and future, drawn with `r.int`
- Numbers: plausible domain ranges, drawn with `r.int`
- Booleans: realistic mix, drawn with `r.chance`

Run the complete script in one `bun run` call (the only write path; see "How sample data gets written" above, no probe inserts) and report the final output summary. If the `bun run` needs a permission approval, handle it plainly and once per that section, never by hand-running individual inserts and never by narrating the harness permission machinery.

**Report the per-entity count in the summary.** State how many records landed in each entity, e.g. `Asset Contracts: 10, SaaS Subscriptions: 10, ...`. This is both the user's receipt and your own honesty check: if any eligible entity shows fewer than 10 (or fewer than the user's chosen number), the line must carry the reason from "How many records" above (user-chosen count, or FK-id scarcity on a required field). An unexplained low count is a defect to fix, not a summary to ship.

**Sample the labels after the counts.** One line per seeded table with its first three composed labels:

```
Label samples:
  contacts:            Marta Klein, Daniel Okafor, Priya Sharma
  form_submissions:    Marta Klein › Question about pricing, Daniel Okafor › Looking for a demo
```

The seed script prints them at its end, after `assertSeedCounts`, with one `await pgRequest("GET", "/<table>?select=_label&limit=3")` per seeded table (`_label` is a read-time column, selected by name). For a table with a `label_parent`, `_label` already carries the parent chain, so the same line shows whether the spine reads right. This is the cheapest check that catches a one-word label, a repeated surname and a wrong `label_parent` spine at once, in the report the user already reads. It never fails the seed (sample data is not the model): surface it, and when a line looks wrong, say what in one clause.

---

