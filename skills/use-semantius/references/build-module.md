# Building a module from a request

_Read this when the user asks you to build or set up something new that needs its own records, however it is phrased: a module, app, platform, system, tracker or tool, or "a way to see and manage X" ("build my SaaS management platform", "set up a vendor tracker", "I need a way to track renewals"). Adding a field, entity or permission to an existing module is not a build._

A build request means: create the module, its entities, fields, relationships, permissions and roles, then return the module's UI link. It does not mean a large sample dataset, a spec, a diagram, CSV exports or an analytics report. Deliver the smallest result that satisfies the request; the user asks for more when they want more.

## Default deliverable

1. The module with its entities, fields and relationships, modeled like the leading products when the domain is well known, and created in the order below.
2. The module's permissions, permission hierarchy, roles and default roles, created by `module-rbac-setup.ts`. They are part of every module, never an extra.
3. Sample data, only after the user says yes (next section).
4. Verification (see "Verify, then stop").
5. The final response (see "Final response").

## Model it like the leading products

When the request is similar to a well-known domain, the module follows how that domain is actually modeled, not an invented shape. When it is not (a one-off internal process, a niche tool no product category covers), skip this section and model from the user's description. Before the first write:

1. **Pick two or three leading products** for the domain (a CRM: Salesforce, HubSpot), from the market segment the request names: a company size, or a segment such as enterprise or small business. When it names none, take the leaders of the mid-market, the products that companies of about 100 to 1,000 people buy and set up without an implementation partner. A product the user names to mirror is always one of them. Take their shape from what you know of the category: the set of records, the fields a user expects on each, the lifecycle states and which role takes each step, and how the records relate. Do not search to confirm a shape you already hold. Search only when the domain is niche or vertical and your knowledge is thin, the category is newer than your knowledge, the user names a product to mirror, or the model depends on a regulated standard whose exact identifiers matter (control IDs, tax codes, statutory leave types; never invent these). When you search, make one pass per product, for its shape only (its API or data-model reference, not feature or pricing pages), and then stop.
2. **Keep what the products agree on, plus the mechanism the user's goal turns on.** To find what they agree on, work out, without showing it, each product's own list of records under that product's names for them, then match the lists: a record two or more of them keep is one they agree on, whatever each calls it (one CRM's Deals are another's Opportunities). Each such record is an entity of the outline or, when the user's goal does not need it, a next step in the final response with its reason. The mechanism is the one or two details that make the module better than a spreadsheet, even when only one product has it (a request to never miss a renewal needs a notice deadline computed from the auto-renew flag and the notice period). Skip what only one product has otherwise.
3. **Name things by our rules,** not the products' (`data-modeling.md` → "Entity Naming Rules" and "Field Naming Rules"). A product's own names are used only when the user asks to follow them.
4. **Build only what the user's goal needs.** The products are the benchmark for structure, not a feature checklist. Leave out modules of theirs the request does not touch.
5. **Tell the user what the module is based on.** Two or three lines that open the message confirming the entity list ("Confirm the entity list"), with no question of their own: whether its shape comes from your knowledge of the category or from a search, and the mechanism from step 2. Call a product verified only when a search in this session returned it; otherwise say the module follows common practice in the category. The final response repeats the mechanism and names the products used as the reference and any deliberate difference.

Each field, entity and permission is then created under the rules that already govern it (`SKILL.md` → Quick Decision Guide); this file adds no second set of rules for them.

## Order of a build

`preflight.md` runs first (`SKILL.md` → "Environment Setup"). Steps 1 to 4 need only this file, plus `entity-families.md` when the outline contains an `is_a` / `has_a` family, and `data-modeling.md` → "Choosing the key type" for step 1 and "Choosing the Right Format" for step 3; read nothing else before them, and do not run `lucide-icon-finder.ts`: icons are chosen in step 5, from the confirmed model.

1. Outline the entities, after taking the shape of the leading products when the domain is well known, and compare the outline with the instance (`SKILL.md` → "Before any new entity: compare it with the instance"). Also take the key prefix of every new entity that takes `typeid` or `is_a`, its singular (`data-modeling.md` → "Choosing the key type"), and read the prefixes in use with one `read_entity` (`id_prefix=in.(<the chosen prefixes>)`); an entity with an `auto_increment` key has no prefix.
2. Settle what the comparison found, including a key prefix that is already taken (asked like a name clash), then any choice locked at creation (next section).
3. Confirm the entity list (after that), in a message that opens with what the module is based on (above).
4. Ask the sample-data question once the scope is settled, with the exact total for the confirmed scope ("The sample-data question"). Every question is asked on its own, one at a time, and the build waits for each answer.
5. Create the module, then what goes in it, in exactly this order:
   1. **Find the icons of the module and of every new entity on the confirmed list, in one call,** never from memory. Each label maps to an array of up to five queries of one or two words each, most specific first. Take the first hit that fits; when none fits, a module uses `box` and an entity has no icon.
      ```bash
      echo '{"Vendor Tracker":["handshake","store"],"Vendors":["store","building"],"Contracts":["file signature","file text"]}' | bun "<skill-folder>/references/lucide-icon-finder.ts" --batch -
      ```
   2. **Create the module with this command.** It also creates the viewer, manager and admin permissions, their hierarchy, roles, grants and default roles, and sets the color. Never create those with `create_*` calls. The script creates no gate and no role beyond those three here: step 5.8 writes them from the access record. Step 5.7 writes the view access to a reused entity, a build's only `create_*` calls for access.
      ```bash
      bun "<skill-folder>/references/module-rbac-setup.ts" --name "<Module Name>" --slug <module-slug> --description "<at most 60 characters>" --icon <icon-name>
      ```
      Take `module_id` from the first line of its output. On a non-zero exit, do what the last line it prints says; exit 1 means stop and tell the user, and only exit 3, a write the platform keeps refusing, can end in manual calls, after telling the user.
   3. **Now read** `data-modeling.md`, `rbac.md` as far as the heading "Adding permissions and roles to an existing module", and any other reference whose condition in the Quick Decision Guide holds for the confirmed scope.
   4. **Run the pass** in `data-modeling.md` → "Fields that apply only to some enum or boolean values" on every entity with an enum or a boolean, and read `jsonlogic.md` when it finds one. Then **write the access record** (`rbac.md` → "Restricted steps (gates)" → "The access record"): who does the everyday work, every other kind of person who uses the module in the leading products, for each new entity with a `workflow_state` the person who moves a record into each of its states, and whom each user field names. Its answers are the ones "Work out who takes each step" works out, on every build: before the list ("Confirm the entity list"), or, when no list was shown, now. It goes in the builder's `writeModel` call (step 7), which refuses a lifecycle the record does not cover, and so does `call-file.ts`.

      No gate, bundle, role, grant, gate rule, control, stamp, named-person field or `select_rule` of a role is written by hand, and no `create_entity` payload carries one: step 8 writes them from the record, with each affected entity's class and `edit_permission`. A new entity gets its class from `data-modeling.md` → "Classifying an entity"; step 8 makes an entity with a gate `operational_workflow`.
   5. **Finish the icons.** An enum entry takes its icon from the "Enum icons" table (`data-modeling.md` → "Enum values and labels"). When the table does not cover some entries, make one more `--batch -` call with all of them. Write no icon from memory: `call-file.ts` and `writeModel` refuse a name that is not a Lucide icon.
   6. **Write down every relationship field.** Before the first `create_entity`, write the relationship record: one entry for every `reference` and `parent` field, keyed `<table>.<field>`, with the facts the three questions of `data-modeling.md` → "Choosing the Right Format" turn on, taken from how the leading products handle these records. It goes in the builder's `writeModel` call as `relationships`, which writes `.tmp_deploy/relationships.json`; a build without a builder writes that file itself, beside its payloads. Each person is the everyday person, a role or a key of `people` in the access record of step 5.4:
      - `format` and `delete`: the field's format and delete mode, from the same section.
      - `savedWithout` (question 1): true when any way of saving the child (a form, a draft, an import, an integration) saves it without its parent, or when it must outlive its parent.
      - `createdBy` and `parentWorkedBy` (question 2): the people who create the child, and the people who work the parent.
      - `reachedBy` (question 3): for the everyday person and each role, how they find these records: `"parent"` when they open them only from the parent's page, `"list: <name>"` when they work or read them in a list across parents (a queue, a board, a calendar, a list of their own items), and `"never"` when they do not use them.
      - `citedByNumber` (question 3): true when people cite one by its own number.
      - `label`: the label sentence of "Relationship labels". Rewrite any label whose sentence is not true.

      The facts decide the format. A field is a `parent` only when `savedWithout` is false, everyone in `createdBy` is also in `parentWorkedBy`, every `reachedBy` is `"parent"` or `"never"`, and `citedByNumber` is false; otherwise it is a `reference`. `writeModel` and `call-file.ts` refuse a `parent` field with no entry, with an entry that leaves out the everyday person or a role, or with facts that make it a `reference`, and they refuse any field whose entry names another format or delete mode:
      ```json
      {
        "order_lines.order_id": { "format": "parent", "delete": "cascade", "savedWithout": false, "createdBy": ["sales_rep"], "parentWorkedBy": ["sales_rep"], "reachedBy": { "sales_rep": "parent" }, "citedByNumber": false, "label": "Order contains Order Line" },
        "issues.project_id": { "format": "reference", "delete": "restrict", "savedWithout": false, "createdBy": ["developer", "reporter"], "parentWorkedBy": ["developer", "project_lead"], "reachedBy": { "developer": "list: My Issues", "project_lead": "list: Board" }, "citedByNumber": true, "label": "Project tracks Issue" }
      }
      ```
      The `create_field` calls use these entries.
   7. **Create the entities, fields and `label_parent`** in the order of `data-modeling.md` → "Mandatory Creation Order", steps 6 to 8. `entity-match-checker.ts` must exit 0 for the confirmed list before the first `create_entity`, and every `has_permission` and `require_permission` name in the entity payloads comes back from one `read_permission` with `permission_name=in.(…)` (`rbac.md` → "Restricted steps (gates)"): the platform saves a misspelled name and closes the step to everyone. Every `view_permission` and `edit_permission` comes back from that read too, and is one of the module's tier permissions (`<slug>:read`, and `<slug>:manage` or `<slug>:admin`): step 8 creates `<slug>:write_<entity>` for an entity a role that does part of the work writes and switches the entity to it (`rbac.md` → "Choosing an entity's permissions"). A reused entity gets no `create_entity`: its view access is written with the permission hierarchy (`rbac.md` → "Viewing an entity of another module"), an approved field goes in a `create_field` call on that entity, and the relationship to it is a field of the new entity. Every `create_entity` and `create_field` goes through a file, and a payload with rules, or a model with a `workflow_state`, is written by one builder script on `jsonlogic-kit.ts` that holds the entities, their fields, the access record and the relationship record and writes them with `writeModel`, as `data-modeling.md` → "Mandatory Creation Order" says. The rules that the pass of step 5.4 found go in the `create_entity` payload; `writeModel` refuses a field required in some states with no validation rule that reads it, and a `workflow_state` the access record does not cover. Each entity's key type and label column follow `data-modeling.md` → "Choosing the key type" and "Choosing the label"; they are modeled, never asked.
   8. **Write the access** from the record: `bun "<skill-folder>/references/module-rbac-setup.ts" --slug <module-slug> --access .tmp_deploy/access.json` (`data-modeling.md` → "Mandatory Creation Order", step 9). It writes the gates, the roles, their fields, rules and `select_rule`s, and each lifecycle's class, and prints the access summary. On exit 2, fix the record as its lines say and run it again; nothing was written. On exit 4, do what each `warning:` says and run it again.
   9. **Verify the module**, before any sample row: run the command of step 8 once more, or `bun "<skill-folder>/references/module-rbac-setup.ts" --slug <module-slug>` when the build has no access record (no lifecycle and no role beyond viewer, manager and admin). This run is the module's verification ("Verify, then stop") and must end `Nothing created or changed.`; a run of step 8 that already ended so is this verification.
6. Seed the sample data, when the user said yes, as `seed-data.md` says.
7. Read the seed's report (below), then answer.

No write happens before step 5. From the first write of step 5 to the final response, every response carries the next tool call, unless a problem only the user can resolve stops the build: a line of text sent alone ends the turn and leaves the build half done (`SKILL.md` → Golden Rule 12).

## Settle matches and choices locked at creation

Each match from the comparison is settled first, as `SKILL.md` → "Before any new entity: compare it with the instance" says.

An `is_a` / `has_a` family, or a separate entity instead (`entity-families.md`), cannot be changed after creation. When the outline contains such a case, confirm it with the user as its own question before anything is written.

The fields of new entities, lifecycle states and classes are modeled from the request and the leading products, never asked about. Beyond the questions this file names, ask only what only the user can answer and where a wrong guess is costly to undo, each as its own question before the first write.

## Confirm the entity list

Every build confirms its entity list before the first write, whatever its size. List every entity this build would create, including the base of an `is_a` / `has_a` family, and every existing entity it will reuse, marked as existing.

The list and its choice go in one message with no tool call, which ends the turn. Never ask this with `AskUserQuestion` or a picker, on any host: text sent beside a tool call can be hidden from the user, and a dialog cannot show the list the user reads to choose.

- Show one bullet per entity, with its plural label, a one-line purpose and its key relationships, including those to entities of other modules ("Contracts: what each vendor has signed; each belongs to a Vendor"; "Vendors: existing, in Procurement; view only"). A reused entity that will get its own view permission says so on its line.
- **Work out who takes each step, without showing it.** This is the test in `rbac.md` → "Restricted steps (gates)":
  1. Work out the answers of the module's access record (step 5.4, `rbac.md` → "The access record"), taken from how the leading products split the work: who does the everyday work (they hold the module's Manager role, `<slug with - as _>_manager`), every other kind of person who uses the module, and, for each state of each new entity, the person who changes a record into it. A state another person moves records into is a gate for that person. Points 2 to 7 say what that means. The answers go in the access record, and the final response shows the access as built ("Final response").
  2. A state another role usually moves records into is a gate for that role (a Hiring Manager who approves offers, an Approver who approves purchase requests, a Buyer who issues orders). Each such role gets its own bundle.
  3. A step the request restricts ("only team leads close tickets") is a gate for the role it names.
  4. A record only some of the roles that do the everyday work may create is a gate for those roles.
  5. A module where one role does all the work has no gate.
  6. A role that does only part of the work (a requester, a technician, an interviewer: it writes only some entities and, where the products limit it, sees only the records that name it) is no gate role and never gets `<slug>:manage` (`rbac.md` → "Roles that do part of the work").
  7. `approved`, `signed`, `issued`, `released`, `posted`, `committed`, `hired`, and `void` or `terminated` on a financial or contractual record are where the role usually changes. They are examples, not the test: the test is who takes the step.
- **Close the message with the choice, as plain text.**
  - With more than 4 new entities: the line "How should I design the \<Module\>?", then two options, each its own paragraph with a blank line before it and each naming its entities by plural label: A, with all of them (recommended), and B, with only the core ones. Then the line "Reply with a letter, or tell me what to add, drop or rename." The count in each option is the number of entities it names.
  - With 4 or fewer: one line, "Build the \<Module\> with these \<N\> entities? Reply yes, or tell me what to add, drop or rename."

  > How should I design the Vendor Tracker?
  >
  > A. With all 5: Vendors, Vendor Contacts, Contracts, Renewals, Invoices (recommended).
  >
  > B. With the core 4: Vendors, Contracts, Renewals, Invoices.
  >
  > Reply with a letter, or tell me what to add, drop or rename.
- A reply that changes the list gets the changed list and its choice again, in the same kind of message.
- The confirmed list is the build scope. Entities left out go under next steps in the final response.
- With no answer (a non-interactive run, or no reply), the list is still shown before the first write. Build the four most central entities, or all of them when there are fewer, and list the rest as next steps. An entity left out by an unanswered similar-name match stays out. The gates and roles worked out for the entities built go in the access record; a left-out entity's gate is listed with it among the next steps.

## The sample-data question

Ask it on its own once the entity list is confirmed ("Confirm the entity list"), in the question format the preflight sets (`SKILL.md` → "Environment Setup"), with the exact total and the tables of the confirmed scope, so it needs nothing shown before it. It comes before the first write, and the consent rules below hold in every format. The total is the sum of the rows you plan for each table, counting each record of a family once.

> Should I add a small demo dataset so you can review the module, or leave the tables empty for your real data?
>
> - **Sample data (recommended)**: \<M\> records across \<N\> tables (\<Plural Labels\>)
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
- A parent's stored figure that its children itemize stays at the scale of the seeded records, between their number and twice it: 3 to 6 seats purchased over 3 seat records, never 120.
- Parents get different numbers of children (1 to 5), not exactly 3 each: a rollup that counts them would hold one value on every parent (`seed-data.md` → "Records that read as records").
- A larger dataset is created only when the user names a row count or asks for volume testing (a company size such as "500 people" is not a row count); state the number in the question.
- Realistic labels, not hundreds of synthetic records. Spread every enum across its values, vary names, companies and cities; a column that repeats one value on every row reads as a defect.

Which tables get rows:

- Only entities this build created. Never write sample rows into an existing entity.
- Never into built-in tables: `users`, `roles`, `permissions`, `permission_hierarchy`, `role_permissions`, `user_roles`, `modules`, `entities`, `fields`, `webhook_receivers`, `webhook_receiver_logs`. Sample users cannot sign in and pollute the audit trail.
- A required relationship into an existing entity takes a real record of that entity, named by its stored id; a user is named by the `external_id` that `seed-lib.ts --describe` lists. Never an invented record. When the entity has no records, skip the field if it is optional, or seed fewer records with a stated reason.

How to write them: read `seed-data.md` and follow it. In short:

- One records file, `.tmp_deploy/seed_<module_slug>.json`, loaded by the CLI's import, is the only write path. One command checks its email addresses, checks its records against the catalog and lists every problem in one answer, imports it, and reports. No probe or test inserts. If a record violates a rule, fix the record, not the rule, except for an approval stamp on a state the gate's `after` leaves out, which is fixed in the access record (`seed-data.md` → "Approval stamps"). The same problem on five runs in a row ends the seed (`seed-data.md` → "Run").
- A record of an entity with a TypeID key names itself `<prefix>_sr<n>` (`vendor_contract_sr1`), a record of an entity with an `auto_increment` key takes the number 1, 2, 3, …, and a relationship column holds the id of the record it means, as that record writes it. Tables go in any order: the import writes parents first.
- `bun "<skill-folder>/references/seed-lib.ts" --describe <tables>` prints the file's skeleton and what a record of each table carries. Never add a field to the schema to ease a seed.
- Where each chain of records stands is decided first: a parent's state and its children's states. `--describe` lists the tables whose states must agree. Each record's dates and notes follow from its state. A terminal state never carries an ongoing note ("seat still billing").
- A `computed` or `rollup` column is never written, except an approval stamp on a record seeded past its step. The report reads each of them back and names one that holds a single value on every record.
- An entity whose key type is `bigint` or `text` needs its own `id` on every record; the records of an entity with an `auto_increment` key take the numbers 1, 2, 3.

## Verify, then stop

Verify once: the module with the run of step 5.9, before any sample record, and the sample data with the seed's report. No `module-rbac-setup.ts` run follows the seed: seeding writes no schema, so a run after it repeats the report of step 5.9. The checks catch the mistakes that matter: an entity left `unclassified`, a missing permission, a rule that checks a name that is not a permission, and, in sample data, a record that names no record, a record of the file that is not on the host, and a computed column with one value on every record.

- **The module's setup and access:** the run of step 5.9, `bun "<skill-folder>/references/module-rbac-setup.ts" --slug <module-slug> --access .tmp_deploy/access.json`, must end `Nothing created or changed.` (without `--access` when the build has no access record: no lifecycle and no role beyond viewer, manager and admin). It compares the module with the record itself: if it filled anything, the build had missed it, it is repaired now, and the final response names it. A run that ends `Not verified` is not a verification: do what each `warning:` says and run it again. This one run is the whole read of the verification: send no other `read_entity`, `read_permission_hierarchy`, `read_role` or `read_role_permission` for it.
- **The module's entities:** the `report` lines of that same run: the module's `access_scope`, one per entity (its class, key type and prefix, view and edit permission, the names of its validation rules and computed fields, and whether it has a `select_rule`), one per hierarchy row whose including permission is `<slug>:*`, and one per role of the module with its grants. No entity is `unclassified`, and each class fits its write tier (`rbac.md` → "Choosing an entity's permissions"). Fix what it shows and run the same command again.
- **Only when sample data was seeded:** the output of the seed command, run through to its last step. It prints `Report finished: <n> record(s) in <k> table(s) on the host.`, and shows a `✓ <table>: <n> records` line for each table, a line for each computed or rollup column with its number of distinct values, and, for each parent table and child table that both carry `workflow_state`, each parent state with the states of its child records. Read those state lines: a parent state its children contradict is fixed in the file and imported again. A command that stopped before the report is not verified: fix what it named and run it again, or, when the same problem keeps coming back, end the seed (`seed-data.md` → "Run"). A `✗` line or a line under `Look at` goes in the final response. An empty module has no records to check.

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
- The module's UI link (`{ui_baseurl}/{module_slug}`), and no link to an entity list or a record. Take `ui_baseurl` from `getCurrentUser`, never hardcode the host (`SKILL.md` → "Linking to the web UI").
- When the build reused entities from other modules: one line naming them, any view permission added to one (`rbac.md` → "Viewing an entity of another module"), and anything left out because a match or a field question went unanswered.
- When the build set `include_hidden_rows` on a rollup (the `access rollups:` line of step 5.8, a reused entity's rollups, or a rollup created with it): one line naming each, saying that every reader of its entity sees its total, also over records they cannot open (`rollup-fields.md` → "Hidden child rows").
- The access summary, always: the lines the verification run prints between `access summary:` and `end of access summary`, unchanged, which say what was built, never what was planned. A build without an access record writes it in the form of `rbac.md` → "The access summary": the access level, the table of what each role does and sees, the entities only an admin can change, each restricted step with who takes it, any named person, an approval gate's controls and a payout gate's requester check, and the entities with a `workflow_state` and no restricted step. When sample data was seeded and the module has an approval gate, say that the user who seeded is the requester of every sample record and cannot approve one, and, when no sample record could be seeded past the approval (the instance has only that one user, or that user is not the module's admin), that none was and why. The user can name another role for a step (`rbac.md` → "Restricted steps (gates)" → "Another role for a step, or none").
- When the module has a role that takes gates or does part of the work: one line listing those roles by their `role_name`, to assign to people.
- When the verification run filled anything, or the setup was finished by hand after exit 3: one line naming it.
- When sample data was seeded: one line with the record counts per table, naming every line the report put under `Look at`.
- When the seed ended before its report: one line saying the module is built but its sample data is incomplete, which step stopped and what it named (or that the seed command stopped itself after ten runs, `SEED STOPPED`), in plain words, and which tables hold records, or that none was written; the user can ask to try again.
- Two or three next steps, including any entities left out of the confirmed scope and each record the products agree on that the outline left out, with its reason, such as "Add your first record", "Import a CSV", "Assign roles", "Ask me for a reminder when you want one".
- No "what the data says" section, unless the user asked for analytics.
