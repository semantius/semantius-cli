# Building a module from a request

_Read this when the user asks you to build or set up something new that needs its own records, however it is phrased: a module, app, platform, system, tracker or tool, or "a way to see and manage X" ("build my SaaS management platform", "set up a vendor tracker", "I need a way to track renewals"). Adding a field, entity or permission to an existing module is not a build._

A build request means: create the module, its entities, fields, relationships, permissions and roles, then return the UI links. It does not mean a large sample dataset, a spec, a diagram, CSV exports or an analytics report. Deliver the smallest result that satisfies the request; the user asks for more when they want more.

## Default deliverable

1. The module with its entities, fields and relationships, modeled like the leading products when the domain is well known, and created in the order below.
2. The module's permissions, permission hierarchy, roles and default roles, created by `module-rbac-setup.ts`. They are part of every module, never an extra.
3. Sample data, only after the user says yes (next section).
4. Verification (see "Verify, then stop").
5. The final response (see "Final response").

## Model it like the leading products

When the request is similar to a well-known domain, the module follows how that domain is actually modeled, not an invented shape. When it is not (a one-off internal process, a niche tool no product category covers), skip this section and model from the user's description. Before the first write:

1. **Pick two or three leading products** for the domain (a SaaS management platform: Zylo, Flexera, Productiv; a service desk: ServiceNow, Jira Service Management; a CRM: Salesforce, HubSpot) and take their shape from what you know of the category: the set of records, the fields a user expects on each, the lifecycle states and which role takes each step, and how the records relate. Do not search to confirm a shape you already hold. Search only when the domain is niche or vertical and your knowledge is thin, the category is newer than your knowledge, the user names a product to mirror, or the model depends on a regulated standard whose exact identifiers matter (control IDs, tax codes, statutory leave types; never invent these). When you search, make one pass per product, for its shape only (its API or data-model reference, not feature or pricing pages), and then stop.
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
5. Create the module, then what goes in it, in exactly this order:
   1. **Find the icons of the module and of every new entity on the confirmed list, in one call,** never from memory. Each label maps to an array of up to five queries of one or two words each, most specific first. Take the first hit that fits; when none fits, a module uses `box` and an entity has no icon.
      ```bash
      echo '{"Vendor Tracker":["handshake","store"],"Vendors":["store","building"],"Contracts":["file signature","file text"]}' | bun "<skill-folder>/references/lucide-icon-finder.ts" --batch -
      ```
   2. **Create the module with this command.** It also creates the viewer, manager and admin permissions, their hierarchy, roles, grants and default roles, and sets the color. Never create those with `create_*` calls. The script creates no gate and no role that takes gates: step 5.4 creates those, and step 5.7 writes the view access to a reused entity. These are a build's only `create_*` calls for access.
      ```bash
      bun "<skill-folder>/references/module-rbac-setup.ts" --name "<Module Name>" --slug <module-slug> --description "<at most 60 characters>" --icon <icon-name>
      ```
      Take `module_id` from the first line of its output. On a non-zero exit, do what the last line it prints says; exit 1 means stop and tell the user, and only exit 3, a write the platform keeps refusing, can end in manual calls, after telling the user.
   3. **Now read** `data-modeling.md`, `rbac.md` as far as the heading "Adding permissions and roles to an existing module", and any other reference whose condition in the Quick Decision Guide holds for the confirmed scope.
   4. **Run the pass** in `data-modeling.md` → "Fields that apply only to some enum or boolean values" on every entity with an enum or a boolean, and read `jsonlogic.md` when it finds one or when the confirmed list has a gate. Then create the gates, the roles that take them and the roles that do part of the work on the confirmed list, before the first `create_entity`, one call per kind for all of them (`rbac.md` → "Restricted steps (gates)", steps 1 to 3, "Roles that take gates" and "Roles that do part of the work"):
      1. the gate, bundle and `<slug>:write_<entity>` permissions, each with `module_id`, in one `create_permission`;
      2. every hierarchy row (`<slug>:admin` to each gate, each bundle of a role that takes gates to `<slug>:manage` and to its gates, `<slug>:manage` to each `<slug>:write_<entity>`, and each bundle of a role that does part of the work to `<slug>:read`, to its `<slug>:write_<entity>` permissions and to its gates) in one `create_permission_hierarchy`;
      3. the roles, each with `module_id`, in one `create_role`;
      4. one `read_role` filtered by their `slug`s for the ids, then their grants in one `create_role_permission`;
      5. `update_module` with `access_scope: gated`, only when the list has a gate.

      The entities a role that does part of the work writes take `edit_permission = <slug>:write_<entity>`, and its `select_rule`s and write and field rules go in the `create_entity` payload, written from the complete rules in `rbac.md` → "Roles that do part of the work"; its named field goes in the entity's `create_field` call.

      Each gate rule, its sequence rule when the gate has states after it, and its controls (`rbac.md` → "Controls on a gate": the requester stamp and check, the approval and recall rules, the rejection and "approved stays approved" rules, the locks, the approval stamps, a named person, and the `select_rule`s where the products limit the role to its own records) go in the `create_entity` payload of the entities they belong to, written from the complete rules there; their fields (`requested_by_user_id`, `approved_by_user_id` and `approved_at` or the step's own names, `<role_key>_user_id`) go in the entity's `create_field` call. An entity with a gate on the confirmed list is an `operational_workflow`, and no other new entity is.
   5. **Finish the icons.** An enum entry takes its icon from the "Enum icons" table (`data-modeling.md` → "Enum values and labels"). When the table does not cover some entries, make one more `--batch -` call with all of them. Then one call covers every entity, enum and field icon, and must exit 0 before the first `create_entity`: `bun "<skill-folder>/references/lucide-icon-checker.ts" <names>`.
   6. **Choose and test the relationship labels.** Before the first `create_entity`, run `mkdir -p .tmp_deploy` and write `.tmp_deploy/relationship-labels.txt` with one line for each sentence of every `reference` and `parent` field: `<table>.<field>: <sentence>`, such as `employees.manager_id: Manager manages Employee` (`data-modeling.md` → "Relationship labels"). Rewrite any label whose sentence is not true. The `create_field` calls use these labels.
   7. **Create the entities, fields and `label_parent`** in the order of `data-modeling.md` → "Mandatory Creation Order", from step 6. `entity-match-checker.ts` must exit 0 for the confirmed list before the first `create_entity`, and every `has_permission` and `require_permission` name in the entity payloads comes back from one `read_permission` with `permission_name=in.(…)` (`rbac.md` → "Restricted steps (gates)"): the platform saves a misspelled name and closes the step to everyone. A reused entity gets no `create_entity`: its view access is written with the permission hierarchy (`rbac.md` → "Viewing an entity of another module"), an approved field goes in a `create_field` call on that entity, and the relationship to it is a field of the new entity. Every `create_entity` and `create_field` goes through a file: write the JSON to `.tmp_deploy/<name>.json`, then `bun "<skill-folder>/references/call-file.ts" <tool> .tmp_deploy/<name>.json`. Do not run `semantius tools` for these tools: the payload shapes are in `data-modeling.md`.
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
- **Show which entities are reached only through a parent.** Work out each relationship's format without showing it. It is a `parent` only when all of these hold: the child never exists without its parent, the parent always exists before it, the people working on the parent create it as part of that work, and no role's main work is a list of these records across parents. Otherwise it is a `reference`. A leg of a connecting record (a junction or an association class) is a `parent` unless the record can lack it. The full tests are in `data-modeling.md` → "Choosing the Right Format", read in step 5.3; when they give another format, the final response says so. An entity with a `parent` has no menu entry, and its line says where people open it ("Order Lines: the items of an order; opened from its Order, no menu entry").
- **Show who takes each step.** This is the test in `rbac.md` → "Restricted steps (gates)":
  1. Work out, without showing it, each state of each new entity with the role that usually moves a record into it, taken from how the leading products split the work. The module's Manager role (`<slug with - as _>_manager`) does the everyday work.
  2. A state another role usually moves records into is a gate for that role (a Hiring Manager who approves offers, an Approver who approves purchase requests, a Buyer who issues orders). Each such role gets its own bundle.
  3. A step the request restricts ("only team leads close tickets") is a gate for the role it names.
  4. A record only some of the roles that do the everyday work may create is a gate for those roles.
  5. A module where one role does all the work has no gate.
  6. A role that does only part of the work (a requester, a technician, an interviewer: it writes only some entities and, where the products limit it, sees only the records that name it) is no gate role and never gets `<slug>:manage` (`rbac.md` → "Roles that do part of the work"). The lines of the entities it writes or is limited on name it, what it writes and the records it sees ("Scorecards: …; written by the interviewer named on the interview, who sees only the interviews they are on and no offers").
  7. `approved`, `signed`, `issued`, `released`, `posted`, `committed`, `hired`, and `void` or `terminated` on a financial or contractual record are where the role usually changes. They are examples, not the test: the test is who takes the step.
  8. Each gated entity's line names the step and its role. When the products assign the step to one person per record, it names that person too: while someone is named, only they (holding the gate) or an admin take it, and where the products limit the role to its own records, its holders see only those (`rbac.md` → "Controls on a gate"). For an approval gate (a move into `approved`, `signed`, `posted`, `released` or `verified`, where one person authorizes what someone else prepared) it names its controls: the requester may not take it, only a waiting record is approved, what it covers is locked from the waiting state on, only the requester recalls a waiting or rejected record, only the approver rejects it or moves it back once approved, and who approved it and when is recorded ("Purchase requests: …; only the named approver, or an Approver when none is named, can approve one, never the person who requested it, and its amounts are locked once it is submitted"; "Applications: …; only the job opening's hiring manager, or a Hiring Manager when none is named, can hire"). For a payout gate (a move into `paid`, `reimbursed` or `disbursed`) it says that the requester may not take it either.
  9. The list ends with one line on access (`rbac.md` → "The access line"): the access level, what each role of the module can do (viewer, manager, admin, each role that takes gates, with its steps, and each role that does part of the work, with what it writes and sees and the records above that stay visible to it), the entities only an admin can change (each gated step is already on its entity's line), and, for each entity with a `workflow_state` and no gate, "<Plural label>: no step is gated; anyone who can edit one can move it through every state."
- Then ask, as its own question: build all of them, or adjust the list. With more than 4 new entities, also offer to build only the core ones (name them in the question).
- The confirmed list is the build scope. Entities left out go under next steps in the final response.
- With no answer (a non-interactive run, or no reply), build the four most central entities, or all of them when there are fewer, and list the rest as next steps. An entity left out by an unanswered similar-name match stays out. The gates and roles shown for the entities built are created; a left-out entity's gate is listed with it.

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
- Each table is keyed on a column the seed sends, never on one the platform computes, a composed label included (`seedEnsureMany` refuses it).
- Where each chain of records stands is decided first: a parent's state and its children's states, checked with `assertStatesAgree` before the first write. Each row's dates and notes follow from its state. A terminal state never carries an ongoing note ("seat still billing").
- Every `computed` and `rollup` column of a seeded table is read back at the very end of the script (`assertComputedVary`): one value on every row halts the run, except a `$user_id`, `$now` or `$today` stamp, which the function leaves out and names. Such a column never goes in a row and is never patched, except an approval stamp on a row seeded past its step (`seed-data.md` → "Computed and rollup columns").
- An entity whose key type is `bigint` or `text` needs an `id` on every row.

## Verify, then stop

After the build, verify once. The checks catch the mistakes that matter: an entity left `unclassified`, a missing permission, a rule that checks a name that is not a permission, a seeded child that names the wrong parent, a seeded parent whose state its children contradict, a figure out of scale with its child rows, and a computed column with one value on every row.

- **The module's setup:** `bun "<skill-folder>/references/module-rbac-setup.ts" --slug <module-slug>` must end `Nothing created or changed.` If it filled anything, the build had missed it: it is repaired now, and the final response names it. Do what any `warning:` line says.
- **The module's entities:** one `read_entity` for all of them with `entity_type`, `view_permission`, `edit_permission`, `computed_fields`, `validation_rules` and `select_rule` (`data-modeling.md` → "Agent Workflow Tips" → "Verify the class and the permissions after creating entities"), one `read_permission_hierarchy` with `including_permission_name=ilike.<slug>:*`, and one `read_role` with `module_id=eq.<module_id>` and their `read_role_permission`. Each entity with a gate on the confirmed list is an `operational_workflow` and holds its gate rule, its sequence rule when the gate has states after it, and its controls (for an approval gate the `requested_by_user_id` and approval stamps, the requester check, the approval, recall, rejection and "approved stays approved" rules and the locks; for a narrowed role the `select_rule`s); `<slug>:admin` includes every gate; each role that takes gates holds its bundle, which includes `<slug>:manage` and that role's gates; each role that does part of the work holds its bundle, which includes `<slug>:read`, its `<slug>:write_<entity>` permissions and its gates and never `<slug>:manage`, each such write permission is included by `<slug>:manage` and is the `edit_permission` of its entity, and each entity it writes or is limited on holds its write rule, field rules and `select_rule`; the module is `gated`, or `advanced` when the list has no gate. Fix what it shows and read again.
- **Only when sample data was seeded:** the output of the real run. It ends `Seed finished: <n> write call(s) applied with no errors.`, shows every table at its count and a `✓ <table>.<fk>: all <n> row(s) name the intended parent` line for each child table that holds a relationship (`… name the intended parents` for a connecting record), a `✓ <name>: <n> parent(s) agree with their children` line for each parent table and child table that both carry `workflow_state`, a `✓ <table>: all <n> row(s) past the step carry …` line for each entity with an approval gate (or `no seeded row is in …` when none is past it), and a `✓ <table>.<column>: <n> distinct value(s)` line for each computed or rollup column; with rollups, also one parent row to show the computed values. A run that ends `CHECK RUN passed`, `SEED HALTED` or `Clear finished`, or that lacks one of those lines, is not verified: fix the cause and run it again. Two cases need no distinct-value line: a one-row table, which prints `one row, so … cannot be compared`, and a column left out as constant by design (`seed-data.md` → "Computed and rollup columns"), which the final response names. An empty module has no rows to check.

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
- One line on access, always, as `rbac.md` → "The access line" describes it: the access level, what each role of the module can do, the entities only an admin can change, each gated step with who takes it, any named person, an approval gate's controls and a payout gate's requester check, and, for each entity with a `workflow_state` and no gate, "<Plural label>: no step is gated; anyone who can edit one can move it through every state." When sample data was seeded and the module has an approval gate, say that the user who seeded is the requester of every sample record and cannot approve one, and, when no sample record could be seeded past the approval (the instance has only that one user, or that user is not the module's admin), that none was and why. The user can name another role for a step (`rbac.md` → "Restricted steps (gates)", step 6).
- When the verification run filled anything, or the setup was finished by hand after exit 3: one line naming it.
- When the full tests gave a relationship another format than the confirmed list showed: one line naming it and where its entity now opens.
- When sample data was seeded: one line with the row counts per table, naming any computed or rollup column left out of the check as constant by design.
- Two or three next steps, including any entities left out of the confirmed scope, such as "Add your first record", "Import a CSV", "Assign roles", "Ask me for a reminder when you want one".
- No "what the data says" section, unless the user asked for analytics.
