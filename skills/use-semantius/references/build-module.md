# Building a module from a request

_Read this when the user asks you to build or set up something new that needs its own records, however it is phrased: a module, app, platform, system, tracker or tool, or "a way to see and manage X" ("build my SaaS management platform", "set up a vendor tracker", "I need a way to track renewals"). Adding a field, entity or permission to an existing module is not a build._

A build request means: create the module, its entities, fields, relationships, permissions and roles, then return the UI links. It does not mean a large sample dataset, a spec, a diagram, CSV exports or an analytics report. Deliver the smallest result that satisfies the request; the user asks for more when they want more.

## Default deliverable

1. The module with its entities, fields and relationships, modeled like the leading products when the domain is well known, and created in the order below.
2. The module's permissions, permission hierarchy, roles and default-role wiring (`rbac.md`). They are part of every module, never an extra.
3. Sample data, only after the user says yes (next section).
4. Verification (see "Verify, then stop").
5. The final response (see "Final response").

## Model it like the leading products

When the request is similar to a well-known domain, the module follows how that domain is actually modeled, not an invented shape. When it is not (a one-off internal process, a niche tool no product category covers), skip this section and model from the user's description. Before the first write:

1. **Pick two or three leading products** for the domain (a SaaS management platform: Zylo, Flexera, Productiv; a service desk: ServiceNow, Jira Service Management; a CRM: Salesforce, HubSpot) and take their shape from what you know of the category: the set of records, the fields a user expects on each, the lifecycle states, and how the records relate. Do not search to confirm a shape you already hold. Search only when the domain is niche or vertical and your knowledge is thin, the category is newer than your knowledge, the user names a product to mirror, or the model depends on a regulated standard whose exact identifiers matter (control IDs, tax codes, statutory leave types; never invent these). When you search, make one pass per product, for its shape only (its API or data-model reference, not feature or pricing pages), and then stop.
2. **Keep what the products agree on, plus the mechanism the user's goal turns on.** The mechanism is the one or two details that make the module better than a spreadsheet, even when only one product has it (a request to never miss a renewal needs a notice deadline computed from the auto-renew flag and the notice period). Skip what only one product has otherwise.
3. **Name things by our rules,** not the products' (`data-modeling.md` → "Entity Naming Rules" and "Field Naming Rules"). A product's own names are used only when the user asks to follow them.
4. **Build only what the user's goal needs.** The products are the benchmark for structure, not a feature checklist. Leave out modules of theirs the request does not touch.
5. **Tell the user what the module is based on, then go on.** Two or three lines, shown before the first question and with no question of their own: whether its shape comes from your knowledge of the category or from a search, and the mechanism from step 2. Call a product verified only when a search in this session returned it; otherwise say the module follows common practice in the category. The final response repeats the mechanism and names the products used as the reference and any deliberate difference.

Each field, entity and permission is then created under the rules that already govern it (`SKILL.md` → Quick Decision Guide); this file adds no second set of rules for them.

## Order of a build

`preflight.md` runs first (`SKILL.md` → "Environment Setup"). Steps 1 to 4 need only this file, plus `entity-families.md` when the outline contains an `is_a` / `has_a` family; read nothing else before them, and run neither `lucide-icon-finder.ts` nor `lucide-icon-checker.ts`: icons are chosen in step 5, from the confirmed model.

1. Outline the entities, after taking the shape of the leading products when the domain is well known, tell the user what the module is based on (above), and compare the outline with the instance (`SKILL.md` → "Before any new entity: compare it with the instance").
2. Settle what the comparison found, then any choice locked at creation (next section).
3. Confirm the entity list (after that).
4. Ask the sample-data question, with the exact total for the confirmed scope. Every question is asked on its own, one at a time, and the build waits for each answer.
5. Now read `data-modeling.md` and `rbac.md`, and any other reference whose condition in the Quick Decision Guide holds for the confirmed scope. Then create the module in the order of `data-modeling.md` → "Mandatory Creation Order": module, permissions, module wiring, permission hierarchy, roles, grants, default-role wiring, entities, fields, `label_parent` where an entity has one.
   `entity-match-checker.ts` must exit 0 for the confirmed list before the first `create_entity`. A reused entity gets no `create_entity`: its view access is written with the permission hierarchy (`rbac.md` → "Viewing an entity of another module"), an approved field goes in a `create_field` call on that entity, and the relationship to it is a field of the new entity.
   Icons are found first, then checked, then written.
   Found: an enum entry takes its icon from the "Enum icons" table (`data-modeling.md` → "Enum values and labels"). The module, every entity and every enum entry the table does not cover take theirs from `lucide-icon-finder.ts` (`--batch -` answers every label in one call), never from memory (`data-modeling.md` → "Icons are Lucide icons").
   Checked: `bun "<skill-folder>/references/lucide-icon-checker.ts" <names>` must exit 0 before the write that carries them: the module's `icon_name` before `create_module`; every entity's `icon_name` together, in one call, before the first `create_entity`; every enum and field icon together, in one call, before the first `create_field`.
   Before the first `create_entity`, run the pass in `data-modeling.md` → "Fields that apply only to some enum or boolean values" on every entity with an enum or a boolean, and read `jsonlogic.md` when it finds one.
6. Seed the sample data, when the user said yes, as `seed-data.md` says.
7. Verify, then answer (below).

No write happens before step 5.

## Settle matches and choices locked at creation

Each match from the comparison is settled first, as `SKILL.md` → "Before any new entity: compare it with the instance" says.

An `is_a` / `has_a` family, or a separate entity instead (`entity-families.md`), cannot be changed after creation. When the outline contains such a case, confirm it with the user as its own question before anything is written.

The fields of new entities, lifecycle states and classes are modeled from the request and the leading products, never asked about. Beyond the questions this file names, ask only what only the user can answer and where a wrong guess is costly to undo, each as its own question before the first write.

## Confirm the entity list

Every build confirms its entity list before the first write, whatever its size. List every entity this build would create, including the base of an `is_a` / `has_a` family, and every existing entity it will reuse, marked as existing.

- Show the list in the message, one line per entity: its plural label, a one-line purpose and its key relationships, including those to entities of other modules ("Contracts: what each vendor has signed; each belongs to a Vendor"; "Vendors: existing, in Procurement; view only"). A reused entity that will get its own view permission says so on its line.
- Then ask, as its own question: build all of them, or adjust the list. With more than 4 new entities, also offer to build only the core ones (name them in the question).
- The confirmed list is the build scope. Entities left out go under next steps in the final response.
- With no answer (a non-interactive run, or no reply), build the four most central entities, or all of them when there are fewer, and list the rest as next steps. An entity left out by an unanswered similar-name match stays out.

## The sample-data question

Ask it with `AskUserQuestion`, in the question format the preflight sets (`SKILL.md` → "Environment Setup"). The consent rules below hold in every format.

Ask it as its own question, after the scope is settled and before the first write, and end the turn. Name the exact total for the confirmed scope: the sum of the rows you plan for each table, counting each record of a family once.

> Should I add a small demo dataset so you can review the module, or leave the tables empty for your real data?
>
> - **Sample data (recommended)**: about \<M\> records across \<N\> tables (\<Plural Labels\>)
> - **Empty tables**: nothing is seeded

Consent rules. Sample data is never written without an explicit yes to this question:

- **Ask, then stop.** Do not build the seed rows, run anything, or prepare to seed in the turn that asks.
- **A request that already asks for demo data** ("with a small demo", "with realistic data") does not skip the question: it is still asked, with the exact total, so the cap and the total are shown.
- **A clear yes is consent.** "yes", "sample data", "go ahead and create the sample data", and a plain "ok" or "sure" in answer to this question are consent. A reply that names counts ("10 each", "20 vendors") is consent and sets those counts.
- **Not consent:** `continue`, `proceed`, `next`, a thumbs-up, silence, or a yes that arrives bundled with an unrelated instruction. A count in the same reply beats a continuation word ("ok, but 30 vendors" seeds).
- **Default is no.** An ambiguous reply, a topic change or a non-interactive run seeds nothing. Re-ask the single question when in doubt.

## Sample-data size

| Entity kind | Rows |
|---|---|
| Parent, catalog and reference entities | 5 to 10 |
| Child entities (lines, seats, licenses, renewals) | about 3 per parent row, at most 20 per entity |
| Connecting records (junctions) | at most 20 |
| People rosters | at most 10 |

- Five parents give 15 to 20 children, not one child per real-world item. A 500-seat company still gets about 20 rows.
- A parent's stored figure that its children itemize stays at the scale of the seeded rows, between their number and twice it: 3 to 6 seats purchased over 3 seat rows, never 120 (`assertItemized`, before the first write).
- Parents get different numbers of children (1 to 5), not exactly 3 each: a rollup that counts them would be identical on every parent and halt the seed (`seed-data.md` → "Rows that read as records").
- A larger dataset is created only when the user names a row count or asks for volume testing (a company size such as "500 people" is not a row count); state the number in the question.
- Realistic labels, not hundreds of synthetic records. Spread every enum across its values, vary names, companies and cities; a column that repeats one value on every row reads as a defect.

Which tables get rows:

- Only entities this build created. Never write sample rows into an existing entity.
- Never into built-in tables: `users`, `roles`, `permissions`, `permission_hierarchy`, `role_permissions`, `user_roles`, `modules`, `entities`, `fields`, `webhook_receivers`, `webhook_receiver_logs`. Sample users cannot sign in and pollute the audit trail.
- A required relationship into an existing entity takes a real record read from that entity (`GET /users?select=id,<label column>&limit=20`): a child uses a chosen row's own `id` and names that row's label, never a bare list of ids and never an invented record. When it has no rows, skip the field if it is optional, or seed fewer rows with a stated reason.

How to write them: read `seed-data.md` and follow it. In short:

- One seed script, built on `seed-lib.ts`, is the only write path: a check run (`--check`) first, then the real run, one POST per table (Golden Rule 7). No probe or test inserts. If a row violates a rule, fix the row, not the rule.
- Parents first, children after. A child names its parent by label and the script looks the id up by that label (`idsByKey`). Never type an id, map by array position or take an id from an insert response. `assertParents` reads every child back with its `<fk>_label` and halts on a wrong parent.
- A row's state is decided first; its dates and notes follow from it. A terminal state never carries an ongoing note ("seat still billing").
- Every `computed` and `rollup` column of a seeded table is read back at the very end of the script (`assertComputedVary`): one value on every row halts the run. Such a column never goes in a row and is never patched.
- An entity whose key type is `bigint` or `text` needs an `id` on every row.

## Verify, then stop

After the build, verify once. The checks catch the mistakes that matter: an entity left `unclassified`, a missing permission, a seeded child that names the wrong parent, a figure out of scale with its child rows, and a computed column with one value on every row.

- **The module's entities:** one `read_entity` for all of them with `entity_type`, `view_permission` and `edit_permission` (`data-modeling.md` → "Agent Workflow Tips" → "Verify the class and the permissions after creating entities"). Fix what it shows and read again.
- **Only when sample data was seeded:** the output of the real run. It ends `Seed finished: <n> write call(s) applied with no errors.`, shows every table at its count and a `✓ <table>.<fk>: all <n> row(s) name the intended parent` line for each child table that holds a relationship (`… name the intended parents` for a connecting record) and a `✓ <table>.<column>: <n> distinct value(s)` line for each computed or rollup column; with rollups, also one parent row to show the computed values. A run that ends `CHECK RUN passed`, `SEED HALTED` or `Clear finished`, or that lacks one of those lines, is not verified: fix the cause and run it again. Two cases need no distinct-value line: a one-row table, which prints `one row, so … cannot be compared`, and a column left out as constant by design (`seed-data.md` → "Computed and rollup columns"), which the final response names. An empty module has no rows to check.

Then stop adding value.

Verification is not analysis. Do not run cube or aggregate queries "to show value". Analytics is a separate request: run it when the user asks what the data says (trends, top-N, waste, spend, anything else about the contents).

## Only when the user asked

Do none of these in a build unless the user asked for that artifact:

- a spec, a diagram, an export, or any CSV or report file
- dashboards, saved views, email reminders or scripts
- an analytics narrative

When the user did ask for one, produce exactly that, with the built-in tool (`SKILL.md` → "Find the built-in tool before building"), and nothing beside it. The tool's output is the artifact (`SKILL.md` Golden Rule 10): use it unchanged, with no hand-drawn companion diagram and no re-rendering in another style. "Build X and show me spend by category" is a build plus analytics. "Build X, then generate the spec" is a build plus the spec, and no reports.

## Final response

- One line: what was built, the mechanism the user's goal turned on, and, when the module follows leading products, which ones (with any deliberate difference), saying a search verified them only when one did.
- The UI links: the module (`{ui_baseurl}/{module_slug}`), then each entity list (`{ui_baseurl}/{module_slug}/{table_name}`). Take `ui_baseurl` from `getCurrentUser`, never hardcode the host (`SKILL.md` → "Linking to the web UI").
- When the build reused entities from other modules: one line naming them, any view permission added to one and each rollup switched to show hidden rows (`rbac.md` → "Viewing an entity of another module"), and anything left out because a match or a field question went unanswered.
- When sample data was seeded: one line with the row counts per table, naming any computed or rollup column left out of the check as constant by design.
- Two or three next steps, including any entities left out of the confirmed scope, such as "Add your first record", "Import a CSV", "Assign roles", "Ask me for a reminder when you want one".
- No "what the data says" section, unless the user asked for analytics.
