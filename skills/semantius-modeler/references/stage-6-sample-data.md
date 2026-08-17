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

After verification, ask the sample-data question on its own (this is a gate, not a footer; see the consent gate above):

> The `<System Name>` model is live in Semantius ✅
>
> [Open `<System Name>` in Semantius →](<ui_baseurl>/<module_slug>)
>
> Would you like me to seed sample data? **10 records × \<N\> tables = \<M\> records**, across: \<Plural Labels of the newly-created tables\>. (yes / no)

(`\<N\>` = count of eligible (newly-created) tables; `\<M\>` = `COUNT × N`, the default offer. The user's reply may keep "yes" (every table = `COUNT`) or set counts ("12 each", "12 each but 20 customers"), which is itself consent (see the gate) and resolves to `COUNT` + per-table `perEntity` overrides. With overrides, the total is the **sum of each table's resolved target**, not `COUNT × N`, so state it that way and name the exceptions (e.g. "12 each across 8 tables, Customers at 20, 116 total"). Whatever they choose, the same numbers drive `assertSeedCounts`, so the offer, the reply, and the enforced count are one.)

### How many records (the count is not optional)

**The default is exactly 10 records per eligible entity. Seed that many unless the user names a different number.** The "10" in the question above is a commitment, not a loose suggestion: if the user says "yes" to that question, you have promised 10 per entity and must deliver 10 per entity. Seeding 2 or 3 "to show it populated" is a defect, not a shortcut — it under-delivers what the user agreed to and makes the model look empty in lists and reports.

**From reply to script, in order:** (1) decide consent per the gate above — a count-bearing reply is consent (precedence rule). (2) **Parse the reply into `COUNT` (global) and `perEntity` (per-table overrides):** a number with NO table name sets the global `COUNT` (`"yes"` → 10; `"20 records"` / `"20 each"` / `"5 of everything"` → `COUNT = 20`/`5`); a number paired with a table or label sets ONLY that table's override and leaves `COUNT` unchanged (`"30 customers"` → `perEntity.customers = { target: 30 }`, `COUNT` still 10; `"12 each but 20 customers"` → `COUNT = 12` and `perEntity.customers = { target: 20 }`). (3) author the script with those exact values plus `eligibleTables` (every newly-created table). (4) the SAME `COUNT` / `perEntity` / `eligibleTables` go into `assertSeedCounts`, so the number the user agreed to is the number enforced.

- **Counts can vary per table, and that's expected.** There is a global default (`COUNT`, 10 unless the user names another global number) and an optional per-table override map (`perEntity`). The user's reply sets both: *"yes"* → every table = 10; *"12 each"* → `COUNT = 12`; *"12 each but 20 customers"* → `COUNT = 12` and `perEntity = { customers: { target: 20 } }`. Overrides go **up or down** — a per-table number the user named is just as valid above the default as below it.
- **FK-id scarcity is just a downward override with a reason.** When a **required** FK into an ineligible table can supply fewer than the target distinct real IDs, set `perEntity[table] = { target: <available>, reason: "<why>" }`. The guard accepts the lower count and the receipt surfaces the reason — never silently truncate.
- **Generate rows by looping to the target — do NOT hand-write a literal array of N rows.** The script pattern below loops `for (let i = 0; i < target(table); i++)` and builds each row from curated value pools via `pick(pool, i)` (from `deploy-lib.ts`). This makes the count **structural**: the loop cannot emit fewer than the target, and `pick` cycles pools and §5 enum values by index so data stays realistic AND every enum value appears. Hand-written literal arrays are exactly where rows get dropped under volume (10 tables × 10 rows = 100 literals), which is why a plain "yes → 10 each" so often came back short. The pools are illustrative; size them to the target and fill from the domain.
- **The guard is the backstop, not the primary mechanism.** Declare `const COUNT` + `perEntity` + **`const eligibleTables = [...]`** (every newly-created table that must be seeded), tally `counts[table] = rows.length`, and END the script with `assertSeedCounts(counts, COUNT, perEntity, eligibleTables)` (from `deploy-lib.ts`). It prints a per-table receipt and **exits non-zero if any eligible table missed its resolved target — including a table you forgot to seed at all**: the check is driven by `eligibleTables`, so a silently-skipped table reads as 0 and fails, which a counts-only check could not catch. With loop-to-target generation it should never fire; it catches the residual mistakes (a wrong `target()`, an early FK-pool exhaustion, a whole forgotten table) and turns the old silent under-seed into a loud halt. This replaces the "count the inserts by hand" self-check that kept getting skipped (18 vs 50, 2-3 per entity). Tally from the array `postMany` returns (`counts[table] = rows.length`), not from the number of calls (one call per table).

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

`python3 -c "import json,sys; ..."` extractors are forbidden — they don't work reliably on Windows where `python3` may not be on `PATH`, and they pull a second runtime into a deploy that otherwise only needs Bun and `semantius`.

### Script pattern

Seed scripts reuse the committed [`deploy-lib.ts`](./deploy-lib.ts) for the loud Layer-2 transport — **`postMany(path, rows)` inserts a whole table's rows in ONE `postgrestRequest` POST (array `body`, ≤100 rows per call) and returns them WITH their ids**; `seedEnsureMany(path, rows, keyField)` is the re-run-safe variant. Copy that one file in first; a seed script needs **only** `deploy-lib.ts` — do NOT import `scaffold-lib.ts` (the scaffold is already deployed):

```bash
mkdir -p .tmp_deploy
cp "${CLAUDE_PLUGIN_ROOT:-.claude/skills/semantius-modeler}/references/deploy-lib.ts" .tmp_deploy/deploy-lib.ts
```

```typescript
// <cwd>/.tmp_deploy/seed_<short>.ts — run with: bun run <path>
import { postMany, seedEnsureMany, pgRequest, assertSeedCounts, pick, combine, uniq } from "./deploy-lib";
// postMany("/campaigns", rows) inserts ALL of a table's rows in one call and returns them with their ids.
// The payload field is `body`, NOT `data` — postMany() owns that, so never hand-roll {method, path, data}.
// Build the rows in the loop, insert once per table; FK pools come from the returned array. For an FK-id
// pool from an existing table, GET an array:  await pgRequest("GET", "/users?select=id&limit=20").
// UNIFORM KEYS: postgrestRequest is the raw PostgREST path, so every row of one table must carry the SAME
// key set — `null` for a nullable column (reference / date / date-time), "" / 0 for a NOT NULL text /
// number; never omit a key on some rows and never a conditional spread. postMany asserts this up front.
// seedEnsureMany("/leads", rows, "email") is the re-run-safe variant: it reads the keys first (`in.()`)
// and inserts only the missing rows. Use it over postMany() when the script might run more than once —
// see "Re-running the seed (idempotency)" below. post() / seedEnsure() remain for a genuine single row;
// a `for … await post()` loop over a table is the named anti-pattern.

const COUNT = 10;                              // global default (the user's number, else 10)
const counts: Record<string, number> = {};    // per-table tally, validated at the end
// per-table overrides (up OR down): user choice (e.g. customers: { target: 20 }) OR required-FK-id
// scarcity (e.g. approvals: { target: 4, reason: "only 4 users for required approver_id" })
const perEntity: Record<string, { target: number; reason?: string }> = {};
const eligibleTables = ["campaigns", "leads"];  // EVERY newly-created table that must be seeded (drives the guard's coverage check)
const target = (t: string) => perEntity[t]?.target ?? COUNT;

// GENERATE BY LOOPING TO THE TARGET — never hand-write a literal array of N rows. The literal array is
// where rows get silently dropped under volume (10 tables × 10 rows = 100 literals — this is why a plain
// "yes → 10 each" so often came back short). A `for i < target` loop makes the count STRUCTURAL: it cannot
// emit fewer. The DATA is still yours to author — pick(pool, i) assembles each row from pools YOU fill with
// real domain values, so the loop guarantees the count and the pools carry the meaning. Two rules keep
// looped rows as rich as hand-authored ones (see the note below the block): size each pool >= the target so
// unique-ish fields don't repeat, and build correlated fields together rather than by independent picks.

// --- campaigns ---
const campaignNames = ["Spring Launch", "Fall Promo", "Black Friday", "Q1 Webinar", "Referral Drive",
  "Product Hunt Push", "Holiday Bundle", "Win-back Email", "Beta Invite", "EMEA Roadshow"];
const campaignStates = ["draft", "active", "paused", "completed"];   // §5 enum — cycled so each appears
console.log("=== Seeding campaigns ===");
const campaignRows = [];
for (let i = 0; i < target("campaigns"); i++) {
  campaignRows.push({                       // build the row; every row carries the SAME keys
    campaign_name: pick(campaignNames, i),
    workflow_state: pick(campaignStates, i),
  });
}
const campaigns = await postMany("/campaigns", campaignRows);   // ONE call; rows WITH ids
counts.campaigns = campaigns.length;

// --- leads (FK → campaigns) ---
// 10 first × 10 last = 100 DISTINCT names via combine() (mixed-radix), not 10 from a lockstep pick+pick.
const firstNames = ["Jane", "Carlos", "Mei", "Tom", "Aisha", "Liam", "Sofia", "Raj", "Nina", "Omar"];
const lastNames  = ["Smith", "Reyes", "Chen", "Becker", "Khan", "Murphy", "Rossi", "Patel", "Novak", "Haddad"];
console.log("=== Seeding leads ===");
const leadRows = [];
for (let i = 0; i < target("leads"); i++) {
  const [fn, ln] = combine(i, [firstNames, lastNames]);   // distinct for i < 100
  leadRows.push({
    lead_name: `${fn} ${ln}`,
    // `email` carries unique_value → MUST be collision-proof: append the row index (uniq), never a bare pick.
    email: uniq(`${fn}.${ln}`.toLowerCase(), i, "@example.com"),
    campaign_id: pick(campaigns, i).id,   // FK: cycle the real parent ids from the array above (never assume sequential)
  });
}
const leads = await postMany("/leads", leadRows);               // ONE call (or seedEnsureMany("/leads", leadRows, "email") when re-runs are plausible)
counts.leads = leads.length;

// Last line — the mechanized count guard (backstop). Driven by eligibleTables, so it ALSO fails if a whole
// table was never seeded (not just an under-count). With loop-to-target generation it should never fire.
assertSeedCounts(counts, COUNT, perEntity, eligibleTables);
```

> **Looping does not mean robotic data — you still author the content.** The loop calls no LLM at runtime; it fixes only the *count*. Uniqueness and meaning come from the pools and factory body you (the LLM) write with domain knowledge. Two rules so looped rows read as real as hand-authored ones:
> - **Distinct values come from composition, not from sizing a flat pool to N.** `pick(pool, i)` cycles, so a flat pool repeats past its length. Use `pick` for repeat-OK fields, `combine(i, [poolA, poolB, …])` for realistic distinct-at-scale fields (F×L×… distinct tuples from small pools), and `uniq(base, i, suffix)` for must-not-collide `unique_value` fields. Details, plus the `unique_value` 409 crash to avoid, are in **"Uniqueness that scales"** below.
> - **Construct correlated fields together, not by independent picks.** Independent `pick`s can yield incoherent rows (a `status: "churned"` subscription with a future `renews_at`). Derive dependent fields inside the loop body from the same `i` — pick the driver, compute the rest from it (a `churned` row gets a past `churned_at` and null `renews_at`; an `active` row the reverse). That keeps coherence and the structural count with no extra literals. Fall back to a hand-authored array of complete rows only for genuinely irreducible cross-field logic (it reintroduces N literals, so avoid it at large targets).

### Uniqueness that scales (and `unique_value` safety)

`pick(pool, i)` cycles (`pool[i % len]`), so a flat pool yields at most `pool.length` distinct values — above that it repeats. Do NOT fix that by hand-authoring an N-entry pool; that reintroduces the literal-volume problem the loop removed. Generate uniqueness **compositionally** or **by index**:

- **`combine` for multiplicative distinct values.** `combine(i, [firstNames, lastNames])` walks `i` in mixed radix, so two 10-pools give 100 distinct tuples (F×L), three give F×L×M. Size pools so the product ≥ target. Destructure: `const [fn, ln] = combine(i, [firstNames, lastNames]);`. (Picking both with the same `i` — `pick(first,i)` + `pick(last,i)` — is the lockstep bug: only `max(F,L)` distinct, not `F×L`.)
- **`unique_value` / DB-UNIQUE fields are a hard rule (as load-bearing as Enum safety).** Identify every field with `unique_value: true` first (the model's field tables, or `read_field`). A repeat there makes the table's POST fail with **409** — and because `postMany` sends the whole table in one all-or-nothing call, **none of that table's rows land**, `postMany` throws, and the run aborts — **`assertSeedCounts` never runs, so the count guard cannot catch it.** Make these distinct by construction: `account_code: uniq("ACCT-", i)`; `email: uniq(\`${fn}.${ln}\`.toLowerCase(), i, "@example.com")`; or `combine(...)` with product ≥ target. The strictly-increasing `i` guarantees no collision.
- **Check the pool size before reaching for `uniq()` — do not apply it reflexively to every `unique_value` field.** `uniq(base, i)` is for when the pool is *smaller* than the target and would otherwise repeat. When the pool already has **≥ target** distinct entries, `pick(pool, i)` alone is already collision-free for `i < target` — appending `uniq()`'s index anyway is not just redundant, it actively corrupts the value. This bites hardest on **human-facing label-column fields** (`application_name`, `product_name`, `vendor_name`, anything that is the record's display name): a naive `uniq(\`${pick(appNames, i)} \`, i)` renders as `"Slack 0"`, `"1Password 9"` — a bare trailing digit that reads like a garbled version number or serial, not a real product name, and is immediately visible to the user in every list view. Before adding a suffix to any label field, count the pool: pool.length >= target → drop `uniq()` entirely, use bare `pick(pool, i)`. Only fall through to a suffix when the pool is genuinely smaller than the target (see the next bullet), and even then prefer `combine()` over a bare index so the result still reads as a plausible name.
- **Plausible-but-distinct middle ground.** For medium-cardinality real-world fields (company / vendor / address) where the target *does* exceed any sensible pool, compose a base with a qualifier that still reads as a name, not a bare index glued onto one: `` `${pick(streets, i)} ${100 + i}` `` (a street address legitimately carries a number), `` `${pick(roots, i)} ${pick(suffixes, Math.floor(i / roots.length))}` `` (two words, no digit), or a parenthetical variant tag (`` `${pick(products, i)} (${pick(["EU", "US", "APAC"], Math.floor(i / products.length))})` ``). Reserve a bare numeric suffix (`uniq(name, i)`) for code-like or machine-facing fields (`account_code`, `email`, `sku`) where a trailing number is expected and normal; never glue a bare index onto a field that is a human display name / label column. Low-cardinality fields (status, category, boolean) stay on `pick` — repeats are fine.
- **Correlated fields: derive in-loop from one driver** (coherence without N literals):
  ```typescript
  const days = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  const subscriptionRows = [];
  for (let i = 0; i < target("subscriptions"); i++) {
    const state = pick(["trialing", "active", "churned"], i);
    subscriptionRows.push({
      workflow_state: state,
      churned_at: state === "churned" ? days(-7 * (i + 1)) : null,   // past, only when churned — null keeps the key present
      renews_at:  state === "churned" ? null : days(30),             // future otherwise
      seat_code:  uniq("SEAT-", i),                                  // unique_value → index-composed
    });
  }
  const subscriptions = await postMany("/subscriptions", subscriptionRows);   // one call, uniform keys
  ```

Net: `pick` for repeat-OK fields, `combine` for realistic distinct-at-scale fields, `uniq` for must-not-collide fields, in-loop derivation for correlated fields. The count stays structural (the loop); uniqueness stays compositional (the helpers); neither needs hand-authoring N rows.

**Cardinality is asserted per call, not per row.** `postMany` sends N rows and checks that PostgREST returned N — if `RETURNING` ever produces fewer (RLS suppressed rows) or the insert failed, it throws and the script aborts, so nothing silently picks `data[0]` from an empty or surprising array. `--single` keeps that role only for a genuine single-row `post()`; it cannot be combined with an array body.

### Re-running the seed (idempotency)

The seed script is a **one-shot**: `postMany()` (like `post()`) is a bare INSERT, so running it twice inserts a second full set of rows. `assertSeedCounts` does NOT catch this — it tallies only the rows THIS run inserted, so it still passes while the table silently holds 2×target. (This is the opposite of the deploy script, whose every write is read-before-write and re-run-convergent.) A partial first run that halted partway (e.g. the `leads` call failed after the `campaigns` call landed) is the common way this bites: a blind re-run appends another set of campaigns. Note that one bulk call is all-or-nothing, so a table is either fully seeded or untouched — the partial state is always "some tables done, later ones not".

Two ways to stay safe:

- **Run it exactly once.** The normal path. If a run is interrupted partway, do NOT blindly re-run — first inspect what landed (`await pgRequest("GET", "/<table>?select=id")` and count), then either finish the remaining tables by hand or clear the table and reseed.
- **Use `seedEnsureMany(path, rows, keyField)` instead of `postMany`** when a re-run is plausible. It reads the whole table's keys first (one `keyField=in.(…)` GET per ≤100 rows), inserts only the missing rows in one POST, and returns every row (existing or new) WITH its id in input order, so a re-run converges instead of duplicating — the same `ensure` contract the deploy script uses. The `keyField` must be unique per row, present on every row, and stable across runs: a `unique_value` column built with `uniq(base, i)` is ideal, because the same `i` regenerates the same key. FK capture is unchanged:

  ```typescript
  const leadRows = [];
  for (let i = 0; i < target("leads"); i++) {
    const [fn, ln] = combine(i, [firstNames, lastNames]);
    leadRows.push({
      lead_name: `${fn} ${ln}`,
      email: uniq(`${fn}.${ln}`.toLowerCase(), i, "@example.com"),  // unique_value → the natural key
      campaign_id: pick(campaigns, i).id,
    });
  }
  const leads = await seedEnsureMany("/leads", leadRows, "email");   // re-run-safe: reads the keys, inserts only the missing rows
  ```

The script is invoked from any shell with:

```bash
bun run <cwd>/.tmp_deploy/seed_<short>.ts
```

**Important for FK fields:** Capture IDs directly from the array each table's POST returns (`postMany` / `seedEnsureMany` hand you the rows with ids), do not make a separate GET query to look them up by name. Filters with spaces (e.g. `?campaign_name=eq.Spring Launch`) require URL encoding; capturing from the POST response avoids this entirely. (This is a Layer-2 rule: catalog writes via `create_*` still resolve ids by re-reading — see the deploy script's `ensureMany`.)

**Enum safety, read the model, not your intuition:** Before writing any enum value into a seed record, look it up in the model's §5 enum tables for *that specific field*. Different fields on different entities may look similar but have different allowed values (e.g., `campaigns.type` includes `"Direct Mail"` but `leads.lead_source` does not, using the wrong one will fail with a check constraint error). Never guess or copy enum values across fields.

**Nullability safety, `""` not `null` for required text:** Most formats are `NOT NULL` — only `reference`, `date`, and `date-time` accept `null` (data-modeling.md → *`default_value`*). For a non-nullable TEXT column (`string`, `text`, `multiline`, `html`, `code`) that a row should leave empty, send an **empty string `""`**, never `null`: a `null` fails with a NOT NULL violation and aborts the run before `assertSeedCounts`. Only omit a field or pass `null` when its format is `reference` / `date` / `date-time` *and* it is not `input_type: "required"`.

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

