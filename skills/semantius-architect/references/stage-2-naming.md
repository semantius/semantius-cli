*Reference for `semantius-architect`. Loaded on demand; the resident SKILL.md stage index points here.*

### Stage 2: Offer legacy-vendor compatibility vs agent-optimized

**Policy path:** `.naming.mode` in `$CUSTOMIZATIONS_FILE`. Pick once per org; every sibling blueprint and every future deploy reuses the choice silently.

**Customizations consultation.** Before firing the `AskUserQuestion` below, consult the policy file (see `../../semantius-admin/references/customizations-protocol.md` for the full protocol; overview in `../../semantius-admin/SKILL.md` Step 7):

```bash
DECISION_PATH=".naming.mode"
if [ -f "$CUSTOMIZATIONS_FILE" ]; then
  policy_match=$(yq -r "$DECISION_PATH" "$CUSTOMIZATIONS_FILE" 2>/dev/null)
  if [ -n "$policy_match" ] && [ "$policy_match" != "null" ]; then
    NAMING_MODE_VALUE="$policy_match"
    # Narrate one line: "Using your rule for naming: <plain-English summary of $NAMING_MODE_VALUE>."
    # Then skip AskUserQuestion and use $NAMING_MODE_VALUE for the rest of this stage.
  fi
fi
```

On cache miss, fire the prompt below. On answer (and only if the user did not pick an explicit cancel option), write the chosen value back atomically before continuing:

```bash
DATE=$(date +%Y-%m-%d)
PROV="decided ${DATE} during ${THIS_BLUEPRINT} deploy"
[ -f "$CUSTOMIZATIONS_FILE" ] || printf 'version: "1.0"\n' > "$CUSTOMIZATIONS_FILE"
yq -i ".naming.mode = \"${NAMING_MODE_VALUE}\" | .naming.mode lineComment = \"${PROV}\"" "$CUSTOMIZATIONS_FILE"
```

When `$CUSTOMIZATIONS_FILE` is unset (architect invoked from a context that never went through Preflight), fall back to firing the widget every time and skip the write. In normal use this never happens — Preflight runs unconditionally.

**Tool-call description discipline.** The Bash tool's `description` field is user-facing prose (the harness renders it as "Ran <description>" above the tool call). Don't leak internal vocabulary like `naming_mode`, `customizations.yaml`, or `yq insert at .naming` there. Use neutral, plain-English descriptions: *"Saving your choice"* on a write, *"Checking earlier choices"* on a read. Same rule for any other Bash call you fire (frontmatter peeks, file checks): the description is user-facing, hold it to Convention 8.

When the domain is a well-known SaaS category, there is almost always a handful of mature cloud vendors whose schemas are the de-facto standard. Mirroring one of their schemas has a real benefit: **data migration from or to that vendor becomes trivial**, because entity and field names line up. The trade-off is that those names were designed for humans clicking through a UI in the 2010s, not for LLM agents reasoning about the model in the 2020s.

Draw on your general knowledge of the market to identify **the top 3 cloud platforms** for the domain, ordered by how widely adopted they are among the kind of organization the user seems to be (check Stage 1 for cues about size, sector, budget). Don't invent vendors you're unsure about; if you only confidently know 2, list 2. For each vendor, know two or three of its headline entity names, use the vendor's own casing (e.g., Salesforce `Account`/`Opportunity`/`Case`, Zendesk `Ticket`/`User`/`Organization`, ServiceNow `Incident`/`Problem`/`Change`, Workday `Worker`/`Position`, Jira `Issue`/`Project`, HubSpot `Contact`/`Company`/`Deal`, Trello `Board`/`List`/`Card`, Notion `Page`/`Database`/`Block`). These names go **inside the option descriptions** in the AskUserQuestion call below, do not list them in prose first.

**You MUST use the AskUserQuestion tool here.** Do not enumerate the vendors or describe the choices in prose before calling the tool, the option descriptions carry all the information the user needs. The only prose preceding the tool call should be one short framing sentence (e.g. *"{Domain} is a well-established category, here's the choice that drives naming for the rest of this session."*).

Construct exactly one question with **4 options**: "Agent-optimized" first (the recommended default), followed by the 3 named vendors. The runtime auto-adds an "Other" option for free-text input, that's how a user picks a vendor outside your top 3.

Use this exact structure:

- **question**: `"How should we name things in this {domain} module?"`
- **header**: `"Naming style"`
- **multiSelect**: `false`
- **options** (in this order, recommended option first per AskUserQuestion convention):
  1. label `"Modern, self-describing names (Recommended)"`, description `"Names read clearly without vendor-specific knowledge. Example: customers, opportunities, support_requests. Best for new builds and teams not migrating from a specific vendor."`
  2. label `"{Vendor A}-style names"`, description `"Use {Vendor A}'s naming ({entity_a1}, {entity_a2}, {entity_a3}). Easy migration to/from {Vendor A} because the names line up."`
  3. label `"{Vendor B}-style names"`, description `"Use {Vendor B}'s naming ({entity_b1}, {entity_b2}, {entity_b3}). Easy migration to/from {Vendor B}."`
  4. label `"{Vendor C}-style names"`, description `"Use {Vendor C}'s naming ({entity_c1}, {entity_c2}, {entity_c3}). Easy migration to/from {Vendor C}."`

The example entity names inside the vendor descriptions must be in **lowercase plural snake_case**, not the vendor's UI casing, because that's the actual `table_name` form the user will end up with (per the naming rules table below). E.g. Zylo → `applications, subscriptions, contracts` (not `Application, Subscription, Contract`); Salesforce CRM → `accounts, opportunities, cases` (not `Account, Opportunity, Case`). This keeps the comparison apples-to-apples with the Agent-optimized example.

The "(Recommended)" suffix on Agent-optimized is intentional, it's the better default for new builds.

**After the AskUserQuestion tool returns**, your very first sentence MUST start with the chosen option name in **bold** so the transcript stays readable (the harness only records the answer ordinal like "A: 2"). Examples:
- *"**Greenhouse-style names**, I'll mirror Greenhouse's core object model..."*
- *"**Modern, self-describing names**, I'll use clear names from first principles..."*
- *"**Workday-style names**, I'll adopt their canonical entity names..."*

Then map the choice to a `naming_mode` value for the rest of the session (this value is internal — never shown to the user):
- Named vendor → `naming_mode: template:<vendor>`
- Modern / self-describing → `naming_mode: agent-optimized` (keeps the legacy slug for backward compatibility; do NOT use this phrase in any user-facing prose)
- "Other" + vendor name → `naming_mode: template:<that-vendor>`
- "Other" + something else (e.g. "blend Salesforce and HubSpot") → resolve in conversation, then commit to one `naming_mode` value before continuing.

If the domain has no meaningful SaaS incumbents (e.g., a niche internal tool), skip AskUserQuestion entirely and go straight to self-describing naming; tell the user in one sentence why.

**Naming rules by choice:**

| Choice | Entity naming | Field naming |
|--------|---------------|--------------|
| Template vendor | Adopt the vendor's canonical entity names exactly, lowercased to snake_case for `table_name`. E.g. Salesforce helpdesk → `case`, Zendesk → `ticket`, ServiceNow → `incident`. Keep the human-readable Singular/Plural labels in the vendor's own casing (`Case`, `Cases`). Use the vendor's canonical field names, snake_cased (`AccountName` → `account_name`, `CloseDate` → `close_date`). | Same snake_case rule. If the vendor has no name for a field the system needs, add it with an agent-optimized name and mark it as a non-vendor extension in the Notes column. |
| Agent-optimized | Self-describing, singular nouns, verbose over cryptic (`support_request` beats `ticket`, `sales_opportunity` beats `opp`). | Snake_case, descriptive, no abbreviations (`customer_email_address` beats `cust_email`). Include the noun the field describes (`invoice_total_amount` beats `total`). |

In either mode, `table_name` in the model is always **plural** snake_case (e.g., `campaigns`, `leads`, `campaign_members`, never singular). This is a hard Semantius platform requirement.

**The semantic model is self-contained, include every entity the domain needs.** If the domain requires users, roles, permissions, or anything else that happens to overlap with a Semantius built-in, model those entities *fully* in the semantic model with the fields the domain requires. Do **not** silently omit them. The downstream semantic-model-deployer skill is responsible for comparing each entity in the model against Semantius's built-in tables at deploy-time and deduplicating (skipping the create for built-ins, reusing them as `reference_table` targets). Your job is to produce a complete, platform-agnostic model; dedup is the deployer's concern, not yours.

**Field-level alignment with built-ins is your job, not the deployer's.** When you declare a built-in entity in §3, use the built-in's actual field names for concepts the built-in already covers, and only invent new field names for genuinely additive fields. Re-declaring a built-in concept under a different name (`user_name` when the built-in has `display_name`, `is_active` when the built-in has `is_disabled`, `username` when the built-in has `email`) produces a noisy deploy where the user has to confirm a list of skipped-as-equivalent fields. Worse, it pollutes the §3 prose with synonyms that diverge from the platform's vocabulary, making downstream agents reason about phantom fields.

The canonical built-in field shapes live in `use-semantius/references/data-modeling.md` under "Semantius built-in entities: shapes" — load that reference before writing §3 for any built-in entity. Quick cheat-sheet:

| Built-in | Use the existing field for… | …instead of inventing |
|---|---|---|
| `users.display_name` | the user's human-readable name | `name`, `full_name`, `user_name` |
| `users.is_disabled` | account suspension state (inverted) | `is_active`, `enabled`, `active` |
| `users.email` | login identifier | `username`, `login` |
| `users.settings` | per-user preferences blob | `preferences`, `config` |
| `roles.role_name` | role display name | `name`, `title` |
| `roles.slug` | stable snake_case handle | `code`, `role_code`, `key` |
| `permissions.permission_name` | permission code (`<slug>:<action>`) | `name`, `code` |

When the model legitimately needs an extra field on a built-in (e.g. `users.is_agent` to distinguish service accounts, `users.primary_team_id` to point at a domain entity, `users.job_title`), include it normally — the deployer adds these additively to the live built-in via `create_field`.

When in doubt about whether a concept is already covered by a built-in, **read the field-shape table in `data-modeling.md`** before writing §3. Don't guess and let the deployer's confirmation prompt sort it out later.
