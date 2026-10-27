*Reference for `semantius-architect`. Read before this stage's first output in a run (mandatory load, SKILL.md stage index).*

### Stage 2: Offer a legacy vendor's design vs the modern design

**The choice is never saved.** The starting design belongs to one blueprint and lives only in its `naming_mode`; nothing is read from or written to `$CUSTOMIZATIONS_FILE` (a `.naming.mode` key there is ignored). A new blueprint asks the question below in every flow (fast flow: see the Fast flow note below); Customize, Extend and Audit keep the blueprint's own `naming_mode`; Rebuild re-asks it with the prior value as the default (`modes-audit-extend-rebuild.md`).

**Tool-call description discipline.** The Bash tool's `description` field is user-facing prose (the harness renders it as "Ran <description>" above the tool call). Don't leak internal vocabulary like `naming_mode`, `customizations.yaml`, or `yq insert at .naming` there. Use neutral, plain-English descriptions: *"Saving your choice"* on a write, *"Checking earlier choices"* on a read. Same rule for any other Bash call you fire (frontmatter peeks, file checks): the description is user-facing, hold it to Convention 8.

When the domain is a well-known SaaS category, there is almost always a handful of mature cloud vendors whose data models are the de-facto standard. Following one of them has a real benefit: **data migration from or to that vendor becomes trivial**, because the records, how they link, and their entity and field names line up. The trade-off is that those models and names were designed for humans clicking through a UI in the 2010s, not for LLM agents reasoning about the model in the 2020s. The choice therefore sets both the structure Stage 3 starts from and the names it uses (`stage-3-entities.md`), and the question presents it as that: a choice of design, never of names alone.

Draw on your general knowledge of the market to identify **the top 3 cloud platforms** for the domain, ordered by how widely adopted they are among the kind of organization the user seems to be (check Stage 1 for cues about size, sector, budget). Reuse Stage 1's product list; a product the user named in the Stage 1 interview as the thing this replaces ranks first. **In expert flow**, only products that passed Stage 1's four-object test qualify: don't invent vendors you're unsure about, and if only 2 pass, list 2. For each vendor, know three of its headline entity names (looked up on the web when your knowledge falls short, SKILL.md → Reference material, never guessed), use the vendor's own casing (e.g., Salesforce `Account`/`Opportunity`/`Case`, Zendesk `Ticket`/`User`/`Organization`, ServiceNow `Incident`/`Problem`/`Change`, Workday `Worker`/`Position`, Jira `Issue`/`Project`, HubSpot `Contact`/`Company`/`Deal`, Trello `Board`/`List`/`Card`, Notion `Page`/`Database`/`Block`), and how its core records link (e.g., Lever's opportunity is one candidate's run through the pipeline and can start before any posting). These go **inside the option descriptions** in the AskUserQuestion call below, do not list them in prose first.

> **Fast flow** (a fast run, before the go-ahead; `../../semantius-admin/references/fast-flow.md`, section 3). Ask this question as below, and map the answer as below: a followed product brings its records and names, as in guided flow. Four differences:
> 1. **Left out when the request names a product:** follow that product (`naming_mode: template:<product>`) without asking. With no meaningful incumbents it is left out too (last paragraph of this section), without the one-sentence reason.
> 2. **Fired in the same `AskUserQuestion` call as Stage 1's "Must-haves" question**, design question first, not alone.
> 3. **The modern option's description** cannot point to "the practices listed above", because fast flow shows no guidance aside before it: `"Built on current best practice, with names that explain themselves: {entity_1}, {entity_2}, {entity_3}. {structure}. {practice}."`, where `{practice}` is one sentence with the one or two Stage 1 best-practice points that most set it apart from the vendors' designs.
> 4. **After the answer,** no bold opening sentence of its own: the go-ahead summary names the design (`fast-flow.md`, section 3).
>
> A free-text answer runs the free-text-answer step below, as in guided flow.

**You MUST use the AskUserQuestion tool here** (new blueprints only). It is a standalone question (no `Q:` task); fire it alone in its own response. The answer goes only into this blueprint's `naming_mode`, never into `$CUSTOMIZATIONS_FILE`. Do not enumerate the vendors or describe the choices in prose before calling the tool, the option descriptions carry all the information the user needs. The only prose preceding the tool call should be the Stage 1 guidance aside, when this turn carries it (guided flow; `stage-1-capture.md`), then one short framing sentence (e.g. *"{Domain} is a well-established category, here's the choice that shapes the design for the rest of this session."*).

Construct exactly one question with **2 to 4 options**: the modern design first (the recommended default), followed by the named vendors, **at most 3** (so 4 options with 3 vendors, 3 with 2, 2 with 1; never a 5th). The runtime adds its own free-text slot; the question text says what it is for: another product to follow, or a structure of the user's own. Never list "Other" yourself. With zero confident vendors, skip the widget entirely (last paragraph of this section).

Use this exact structure, dropping the vendor rows you do not have (the option count follows the vendor count above):

- **question**: `"Which design should this {domain} module follow? To follow another product, or a structure of your own, type it in."`
- **header**: `"Design"`
- **multiSelect**: `false`
- **options** (in this order, recommended option first per AskUserQuestion convention):
  1. label `"Modern design (Recommended)"`, description `"Built on the practices listed above, with names that explain themselves: {entity_1}, {entity_2}, {entity_3}. {structure}. Best for new builds and teams not migrating from a specific product."`
  2. label `"Follow {Vendor A}"`, description `"{Vendor A}'s records and names: {entity_a1}, {entity_a2}, {entity_a3}. {structure_a}. Data moves to and from {Vendor A} easily because records and names line up."`
  3. label `"Follow {Vendor B}"`, description `"{Vendor B}'s records and names: {entity_b1}, {entity_b2}, {entity_b3}. {structure_b}. Data moves to and from {Vendor B} easily."`
  4. label `"Follow {Vendor C}"`, description `"{Vendor C}'s records and names: {entity_c1}, {entity_c2}, {entity_c3}. {structure_c}. Data moves to and from {Vendor C} easily."`

`{structure}` is one short sentence on how the core records link, in plain words (Convention 8). The modern sample is the design Stage 3 will propose, built on the Stage 1 best-practice points; each vendor sample is that vendor's own model. For an applicant tracker: modern *"Each application links one candidate to one job opening."*; Lever *"An opportunity is one candidate's run through the pipeline and can start before any posting."*

The example entity names inside the descriptions must be in **lowercase plural snake_case**, not the vendor's UI casing, because that's the actual `table_name` form the user will end up with (per the naming rules table below; convert a vendor's names with `vendor-names.ts`, below the table). E.g. Zylo → `applications, subscriptions, contracts` (not `Application, Subscription, Contract`); Salesforce CRM → `accounts, opportunities, cases` (not `Account, Opportunity, Case`). This keeps the comparison apples-to-apples with the modern example.

The "(Recommended)" suffix on the modern design is intentional, it's the better default for new builds.

**A free-text answer: show the details, then confirm.** The user wrote in another product, a structure of their own (e.g. *"one record per candidate, no separate applications"*), or a mix (e.g. *"Lever's structure with modern names"*). Before Stage 3:

1. **Details**, in prose, 3 to 6 lines: the core records the design starts from, by display name, and how they link, one link per line.
   - Another product: its core records and names. When you cannot name at least four of its headline records, spelled the way it spells them (Stage 1's four-object test), look them up on the web first (SKILL.md → Reference material). When they still can't be named, say so in one sentence instead of guessing, and offer the modern design, or that the user pastes the product's list of records.
   - A structure of the user's own: its records with modern names, linked as described.
2. **Confirm**: one `AskUserQuestion`, fired alone in its response: question `"Build the design on this?"`, header `"Design"`, options `"Yes, use this"` (description `"The list of things to track starts from these records."`) and `"Use the modern design instead"`. A free-text correction updates the details: show them again and re-ask.

**After the user's answer arrives** (as a `<user_answers>` input block mapping each question text to the chosen label; there is no `user_answers` tool to call, and the widget must have been the only tool call of its response), your very first sentence MUST start with the chosen option name in **bold** so the transcript stays readable; after a confirmed free-text answer, the confirmed design in a few words. Examples:
- *"**Follow Greenhouse**, I'll start from Greenhouse's records and names..."*
- *"**Modern design**, I'll build from best practice with names that explain themselves..."*
- *"**Lever's structure, modern names**, I'll start from Lever's records under clear names..."*

Then map the choice to a `naming_mode` value for the rest of the session (this value is internal — never shown to the user):
- Follow a vendor → `naming_mode: template:<vendor>`
- Modern design, or "Use the modern design instead" → `naming_mode: agent-optimized` (internal token only; never use this phrase in user-facing prose)
- Free-text, another product, confirmed → `naming_mode: template:<that-product>`
- Free-text, a structure of the user's own or a product's structure under modern names, confirmed → `naming_mode: agent-optimized`; Stage 3 starts from the confirmed records instead of first principles.
- Anything else (e.g. "blend Salesforce and HubSpot") → settle it in the details step, then commit to one `naming_mode` value before continuing.

If the domain has no meaningful SaaS incumbents (e.g., a niche internal tool; when you know of none, after Stage 1's web search found none too; in expert flow, also when no product passed Stage 1's four-object test), skip AskUserQuestion entirely and go straight to the modern design; tell the user in one sentence why, in the same turn as the Stage 3 entity list (with the Stage 1 guidance aside before it, when this turn carries it).

**Naming rules by choice:**

| Choice | Entity naming | Field naming |
|--------|---------------|--------------|
| Template vendor | The vendor's canonical entity names, converted by `vendor-names.ts` (below): its `table_name` and Singular/Plural labels, as printed. E.g. Salesforce helpdesk `Case` → `cases` (Case, Cases), Zendesk `Ticket` → `tickets`, ServiceNow `incident` → `incidents`. The vendor's API name for the object goes in the §3 notes cell (`<Vendor> API object: <Name>`, Stage 3). | The vendor's canonical field names, converted by the same script (`FirstName` → `first_name`). The analyst drafts the fields (`semantius-analyst`, `stage-4-fields.md`, "Fields of a followed product"). |
| Agent-optimized | Self-describing, singular nouns, verbose over cryptic (`support_request` beats `ticket`, `sales_opportunity` beats `opp`). | Snake_case, descriptive, no abbreviations (`customer_email_address` beats `cust_email`). Include the noun the field describes (`invoice_total_amount` beats `total`). |

In either mode, `table_name` in the model is always **plural** snake_case (e.g., `campaigns`, `leads`, `campaign_members`, never singular). This is a hard Semantius platform requirement.

**Converting a product's names: always `vendor-names.ts`, never by hand.** Run `bun "<skill-folder>/../use-semantius/references/vendor-names.ts" entity:<Name>…` once, with every record name singular and spelled the way the product spells it (`entity:OpportunityLineItem entity:SLAPolicy`); the singular is only the script's input, and the **<Vendor> API object** cell keeps the vendor's API name unchanged (`stage-3-entities.md`), and take each `table_name` and label exactly as printed. Why: the same name must convert the same way in every run, and acronyms and plurals are where hand conversion drifts. The script treats a run of capitals as one word (`SLAPolicy` → `sla_policies`), keeps a name already in lowercase as written, and makes only the last word plural. Its result lines:
- `skip:` a custom record one company added (Salesforce `Invoice__c`), not part of the product: leave it out.
- `built-in: <table>`: the name lands on a platform built-in; apply the next paragraph.

The script settles the spelling only. Which records the product has, and their names, is your knowledge of the product.

A vendor object whose name collides with a platform built-in (users, roles, permissions) gets a self-describing name, recorded in §4 Aliases as a vendor alias and called out in the entity table (e.g. Productboard's "User", the customer's contact person, becomes `customers`).

**The semantic model is self-contained, include every entity the domain needs.** If the domain requires users, roles, permissions, or anything else that happens to overlap with a Semantius built-in, model those entities *fully* in the semantic model with the fields the domain requires. Do **not** silently omit them. The downstream semantius-modeler skill is responsible for comparing each entity in the model against Semantius's built-in tables at deploy-time and deduplicating (skipping the create for built-ins, reusing them as `reference_table` targets). Your job is to produce a complete, platform-agnostic model; dedup is the deployer's concern, not yours.

**Field-level alignment with built-ins is your job, not the deployer's.** When you declare a built-in entity in §3, use the built-in's actual field names for concepts the built-in already covers, and only invent new field names for genuinely additive fields. Re-declaring a built-in concept under a different name (`user_name` when the built-in has `display_name`, `is_active` when the built-in has `is_disabled`, `username` when the built-in has `email`) produces a noisy deploy where the user has to confirm a list of skipped-as-equivalent fields. Worse, it pollutes the §3 prose with synonyms that diverge from the platform's vocabulary, making downstream agents reason about phantom fields.

The canonical built-in field shapes live in `use-semantius/references/data-modeling.md` under "Semantius built-in entities: shapes" — load that reference before writing §3 for any built-in entity. Quick cheat-sheet:

| Built-in | Use the existing field for… | …instead of inventing |
|---|---|---|
| `users.display_name` | the user's human-readable name | `name`, `full_name`, `user_name` |
| `users.first_name` / `users.last_name` | given name / family name | `given_name`, `surname`, `family_name` |
| `users.is_disabled` | account suspension state (inverted) | `is_active`, `enabled`, `active` |
| `users.is_agent` | service principal / agent account (`true`) vs human | `is_service_account`, `is_bot`, `account_type` |
| `users.email` | login identifier | `username`, `login` |
| `users.settings` | per-user preferences blob | `preferences`, `config` |
| `roles.role_name` | role display name | `name`, `title` |
| `roles.slug` | stable snake_case handle | `code`, `role_code`, `key` |
| `permissions.permission_name` | permission code (`<slug>:<action>`) | `name`, `code` |

When the model legitimately needs an extra field on a built-in (e.g. `users.primary_team_id` to point at a domain entity, `users.job_title`), include it normally — the deployer adds these additively to the live built-in via `create_field`.

When in doubt about whether a concept is already covered by a built-in, **read the field-shape table in `data-modeling.md`** before writing §3. Don't guess and let the deployer's confirmation prompt sort it out later.
