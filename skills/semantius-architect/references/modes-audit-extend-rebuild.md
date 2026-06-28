*Reference for `semantius-architect`. Loaded on demand; the resident SKILL.md stage index points here.*

## Mode B — Audit (review an existing semantic model)

The goal is to give the user a clear, actionable quality report — not just a list of problems, but an explanation of why each issue matters and a suggested fix. Think of it as a peer-review from a senior analyst.

> **🔒 `initial_request` is immutable.** If the file's front-matter contains an `initial_request` key, preserve its value byte-for-byte in any fix-up write. Never rewrite, summarize, "clean up", or re-quote it — even if the wording is scrappy or the scope has since grown beyond it. It's a historical record of what the user originally asked for, not a live scope statement.

### How to run the audit

**Before checking anything else, read `../../use-semantius/references/data-modeling.md`**. This file is the authoritative source of Semantius platform constraints — entity naming rules, built-in tables, field format rules, relationship rules. It is updated independently of this skill. Any rule there about naming, formats, or relationships overrides or extends the audit checklist. **Note:** this skill no longer treats Semantius built-ins (`users`, `roles`, etc.) as forbidden in the model — the model is self-contained and the semantic-model-deployer skill deduplicates at deploy-time. The `data-modeling.md` reference is still the source of truth for other platform rules.

Read the file in full, then work through each check in the audit checklist (`audit-checklist.md`). Group your findings into three severity levels:

- **🔴 Blocker** — the downstream agent will fail or produce incorrect results (e.g., missing required front-matter, `id` field manually declared, `reference` field missing target table, enum field with no values)
- **🟡 Warning** — the model will work but is fragile or misleading (e.g., ambiguous field names, missing label_column, relationship in §3 but not in §4)
- **🟢 Suggestion** — improvements to clarity or long-term maintainability (e.g., a field that could be more descriptive, an open question that should be closed)

After listing findings, give an overall summary: how many issues of each severity, and a one-line verdict ("Ready to implement", "Needs minor fixes before implementation", "Significant rework needed").

> **The full audit checklist lives in [`audit-checklist.md`](audit-checklist.md)** (shared with the Extend and Rebuild self-audit passes).

### Output format

Present findings as a structured report directly in the conversation. Example:

> ## Audit report, `helpdesk-semantic-blueprint.md`
>
> **Overall:** 2 blockers, 3 warnings, 1 suggestion, *Needs fixes before implementation.*
>
> ### 🔴 Blockers
> 1. **`tickets.workflow_state`, enum values missing.** The field is typed `enum` but the Notes column is blank. The agent cannot create the field without knowing the allowed values. Add `enum_values: ["open", "in_progress", "resolved", "closed"]` (or whatever values apply).
> 2. **`comments.ticket_id`, target table missing.** The Notes column says `reference` but doesn't specify the target. Should be `→ tickets (N:1)`.
> 3. **Mermaid flowchart missing `tickets → comments` edge.** §4 declares the relationship but the §2 diagram omits it. Add `tickets -->|has| comments` (arrow = "many", since a ticket has many comments).
>
> ### 🟡 Warnings
> …
>
> ### 🟢 Suggestions
> …

After presenting the report, ask: *"Would you like me to apply these fixes and save an updated semantic-blueprint file?"* If yes, make the fixes (including regenerating the Mermaid diagram if any relationship changed) and save the corrected file to the convention folder (`semantius/blueprints/<same-filename>`) — if the input was a bare repo-root path, copy it there first (`cp`, never `mv`) and write the fixes to the copy, leaving the root original byte-for-byte untouched. Then share the path.

---

## Mode C: Extend (add to an existing semantic model)

The goal is to evolve the model without breaking what's already there. Existing entity names, field names, and the chosen `naming_mode` are fixed, new additions must be consistent with them.

> **🔒 `initial_request` is immutable.** When you rewrite the file in Step C4, copy the `initial_request` front-matter value over unchanged. The scope has almost certainly grown beyond what the user first asked for, that's fine, the field is the historical opening ask, not a running scope. Do not update it, expand it, or merge the new extension request into it.

### Step C1: Read and summarize the current model

Read the file. Present a compact summary to orient the user:

> **Current model: `{system_name}`** (`{naming_mode}`, {N} entities)
>
> | # | Table | Purpose |
> |---|---|---|
> | 1 | `contacts` | People who interact with the company |
> | … | … | … |

### Step C2: Capture what to add

Ask the user what they want to add. They might say "I need to track invoices and line items" or "add a comments entity" or "the ticket needs a priority field". Extract:
- New entities needed (if any)
- New fields on existing entities (if any)
- New relationships (if any)

If it's not clear, ask one clarifying question.

### Step C3: Propose additions

For new entities: follow Stage 3 from Mode A — propose the entity rows (`role` / `mastered in` / `necessity`), confirm, then run Stage 8 (business-rule intents), Stage 9 (write tier), and Stage 10 (workflow gates) for them.

For changes to an existing entity (a new lifecycle state, a `write tier` change, or a new relationship): show the updated §3 row / §7 lifecycle sub-section / §5 edge for just the affected entity, clearly labeled so it's obvious what's changing. The blueprint is entity-level — field-level detail is added later by the analyst, not here.

For new relationships: add the row(s) to §5 (§5.1 intra-scope / §5.2 built-in / §5.3 cross-scope) with `from` / `verb` / `to` / `cardinality` / `kind` / `delete_mode` / `fk_format`, and add the matching edge to the §2 Mermaid using the §5 `verb` byte-for-byte. Propose a domain-specific verb in the parent's voice (the same rule the Create flow uses); do not introduce filler verbs (`"has"`, `"references"`). The verb shows up in UI breadcrumbs and ER docs once deployed.

Make sure every addition is consistent with the existing `naming_mode`. If the existing model is Zendesk-template, new entities should use Zendesk-style names where they exist; if agent-optimized, new names should be self-describing.

> **🛑 MUST-FIRE gate — confirm before writing.** Show the user exactly what you plan to add or change and ask *"Here's what I'm planning to change, does this look right?"* **before** touching the file. Wait for an explicit yes; do not write on assumption. This gate is **not optional**, and the narration-restraint culture in this skill ("do not announce what you're about to do", "delete the message if the work still got done") does **NOT** override it — that culture is about not narrating internal *mechanics*, never about skipping a user *decision* gate. Writing the edit before the user confirms is a bug. (This mirrors the analyst's MUST-FIRE rule that protects its Stage 3 decision widgets from the same restraint culture.)

### Step C4: Write the updated file

Update the file in place:
- Add new entity rows to §3 (with `role` / `mastered in` / `necessity` / `write tier`)
- Add new rows to the §2 entity summary table (keeping numbering sequential)
- **Regenerate the §2 Mermaid diagram** — add nodes for any new entities and edges for any new relationships; do not leave a stale diagram behind
- Update §5 relationships (§5.1 / §5.2 / §5.3) with the new edges
- Add a §7 lifecycle sub-section for any new `master` entity that has lifecycle states
- Update `created_at` in the front-matter to today's date
- **Refresh the `entities` front-matter list** to match the new §2 entity summary (in §2 order, lowercase snake_case). A stale `entities` tag breaks discovery, never skip this step when entities are added, removed, or renamed.
- **Re-evaluate `departments` and `industries`** against the post-extension model, the new entities, fields, and any scope cues from the extension request can shift these tags (e.g. adding HR entities to a finance system → add `hr` to `departments`; adding patient-record entities to a generic CRM → add `healthcare` to `industries`). If the inference is now confident where it wasn't before, add the key; if a previously-valid value is no longer accurate, change or drop it. Mention any change in the summary so the user can push back. If the extension doesn't shift scope, leave the existing values as-is.
- **Re-run the Stage 6 shadowing walk for `related_modules`** against the post-extension entity list. Mandatory in every extension, never skipped, never collapsed into "leave as-is unless the extension shifts scope". This must run **before** the §6 re-evaluation below, because §6 walks the (post-extension-confirmed) `related_modules` list. The prior `related_modules` values are an input, not a substitute for the walk: a new entity may shadow a domain not previously listed (adding `objectives` exposes OKR; adding `vendors` exposes Vendor Management; adding `cost_centers` exposes Budgeting), and an entity removed by the extension may make a previously-listed domain stale. Build the post-extension list yourself first, then surface it as a standalone proposal block under a visibly labeled "Related modules" heading in the change summary so the user can confirm or edit, the same shape as the original Stage 6 proposal.
- **Re-evaluate §6 cross-model link suggestions** against the post-extension model using the Stage 7 rules and the just-confirmed `related_modules` list. New entities often introduce new cross-domain links: a CMDB extended with `software_installs` may now want a row pointing software installs at a SAM-owned product table; a CRM extended with `tickets` may now want a row linking tickets to ITSM incidents when both are deployed. Walk every non-overlap related domain × every entity (including new ones) per the Stage 7 completeness rule and emit outbound or inbound rows wherever an FK is plausible. Apply the same posture as Stage 7: err toward inclusion, the deployer silently skips rows whose target does not exist.
- **Re-run Stage 8 (business-rule emission)** for new entities: emit any §8.2 rule intents (`lifecycle` / `owner_edit` / `narrow_write`) the new entities imply. Row-scope and field-lock behavior is the analyst's, derived from field shapes the blueprint doesn't carry.
- **Classify every newly-added entity for permission tier** using Stage 9's mechanical rule. New operational entities (the common case for extensions) carry `write tier: :manage` (the default). New lookup/category/stage/type entities get `write tier: :admin`. If the prior file used the two-permission fallback (no admin tier) and the extension adds the first admin-tier entity, **upgrade the model to the three-permission baseline**: §8.1 grows to enumerate `<slug>:admin` and §9.1 gains the second hierarchy row, and the new entity carries `write tier: :admin`. Surface this upgrade in the change summary so the user can push back; do not flip silently. Pre-existing entities' classifications stay unchanged unless the extension genuinely reshapes one (e.g. promoting a free-form text field to a lookup table, in which case the spawned lookup is admin-tier and the original entity stays operational).
- **Run Stage 10 (W1 / W2 / W6 workflow-gate scan) against every entity touched by the extension AND every newly-added entity.** Walk the architect's three families (W1 lifecycle approval, W2 lifecycle closure, W6 high-weight create) against the new / reshaped entities' §7 lifecycle states and §3 descriptions; for each gated transition, mark `requires_permission? = ✓` in §7 and emit the matching `workflow-gate (lifecycle)` row in §8.1 plus the §9.1 hierarchy roll-up. Surface the result in the change summary even when nothing new fires. If the extension introduces the first workflow gate in a previously two-permission model, **promote to the three-permission baseline** with `<slug>:admin` as the broader includer (same shape rule as Stage 9's first-admin-tier upgrade); update §8.1 and the §9.1 hierarchy rows accordingly. (Field-driven gates — W3 submit-lock, W4 ownership, W5 reassignment — are the analyst's, once field shapes exist.)
- **Preserve §9 and `related_modules` by default; re-run Stage 11 only when the extension adds personas or processes.** If it does, update §9.1 (baseline roles, permission hierarchy, RACI realization) and §9.2 (functional ownership) and refresh the frontmatter `persona` list. **Otherwise carry the existing RACI realization, Processes wired catalog, §9.2, and `related_modules` forward byte-for-byte** — an extension never drops uber-model-derived governance it didn't touch. Preserve any `## Additional Requirements Specification` section the same way (carry it forward byte-for-byte unless the extension changes a requirement it states). (Always re-derive the §9.1 baseline roles + permission hierarchy from the post-extension §8.1, since new entities/gates change them.) The field-level passes (input-type rules, select rules, view/edit consistency) are the analyst's — they need field shapes the blueprint doesn't carry.

**Before saving, run a self-audit pass on the updated draft.** Work through every 🔴 Blocker check from the Audit checklist (`audit-checklist.md`), including the Mermaid diagram checks, and fix any issues before writing. Do not save a file that would fail its own audit.

**Then run the same pre-save verification** defined in the resident Pre-save verification section of SKILL.md ("Pre-save verification (silent on success, plain-English on failure)"). The verification runs silently in Extend mode too — do not narrate it in chat unless a check fails. Any failure blocks the save until fixed; on success, write the file and announce in one plain-English line.

**Write the edited file to the convention folder, never to a repo-root original.** If the `Input artifact:` path is already under `semantius/blueprints/` (the normal admin-orchestrated case — the admin resolves the working copy up front), edit that file in place. If the `Input artifact:` is a bare repo-root path (a direct invocation that bypassed the admin), do NOT edit it in place: copy it to `semantius/blueprints/<same-filename>` first (`mkdir -p semantius/blueprints` as needed, `cp` not `mv`), then apply all edits to the copy. The user's root file must be left byte-for-byte untouched. The post-save line follows the Mode A pattern: *"Updated `<path>`. <one short clause naming what changed, e.g. 'added two new lifecycle states to Candidate'>."* (use the convention-folder path in `<path>`). No counts breakdown, no section-number references, no platform-plumbing terms.

### Step C5: Loop back — do NOT auto-advance to deployment

> **🛑 MUST-FIRE gate — the customize pass is a loop and only the user ends it.** After the file is written and the one-line change summary is announced, the customize pass is **NOT over**. Immediately return to the user and ask, in plain language, whether they want another change or are done — e.g. *"Done, <change> is in. Anything else to adjust, or are you ready to move on?"*

- If the user names another change → go back to **Step C2** and repeat the full C2 → C3 (confirm) → C4 (write) → C5 (ask) loop for it. There is no limit on the number of passes.
- If the user explicitly signals completion ("done", "deploy", "that's all", "proceed", "nothing else") → only THEN return control to the caller.

**Never** treat the first change as the end of the customize pass, and **never** let the deploy pipeline (matching / deploy) advance while the user might still have changes. **When this skill is run by the admin orchestrator, the admin advances to the next pipeline step the instant this skill returns** — so returning early after a single edit is exactly what silently launches matching and deployment behind the user's back. Hold control here until the user's explicit "I'm done". This gate exists because that silent auto-advance is a real failure this loop is designed to prevent.

---

## Mode D: Rebuild (holistic reanalysis of an existing semantic model)

The goal is a fresh holistic pass over a model that has drifted across many iterations. Mode B (Audit) is conservative on purpose, it reports rule violations but never reconsiders entity choice or §1 framing; Mode C (Extend) is additive and preserves prior decisions. Mode D is for the case in between: every prior decision is back on the table (vendor template choice, entity granularity, field shapes, naming, scope boundaries), with the prior file treated as **archived knowledge** the same way the version-routing rule treats older-major files. The output is a brand-new file at `CURRENT_VERSION`; the prior file is left untouched so the user can diff in their editor and decide what to merge.

> **🔒 `initial_request` is immutable.** The original opening ask carries through the rebuild byte-for-byte, even when the rebuilt model has reframed the system. The field is the historical record of what kicked the model off, not a running scope statement.

### When to choose Mode D

Trigger phrases the user is likely to use:
- "We've iterated this 10 times, I want everything reconsidered."
- "Check if anything essential was lost during all the customizations."
- "Bring this up to current best practices, willing to restructure."
- "Reanalyze / re-author / rebuild / rethink / overhaul / modernize the `<slug>` model."

### When *not* to use Mode D

- The user only wants rule-conformance findings, route to **Mode B**. Audits stay conservative on purpose.
- The user wants to add specific entities, fields, or relationships, route to **Mode C**.
- The model is fine and the user just wants minor tweaks, route to **Customize**.
- The source of truth is the **live deployed module** in Semantius, not the `.md` file, route to the `semantic-model-optimizer` skill. If both have drifted from each other, the right call is usually optimizer first (snapshot live to `.md`), then Mode D on the snapshot.

### Step D1: Load the existing file as content, not as structure

Read the file in full. Extract:
- The original `initial_request` (immutable, byte-for-byte preserve into the new file)
- The domain category, vendor `naming_mode`, and `tagline`
- The entity list with one-line purposes (from §2)
- Business rules documented in §3 prose, computed/validation rule blocks, §7.1 decisions, and §7.2 future considerations
- Curated metadata: `departments`, `industries`, `related_modules`

Treat the §3 entities, §5 relationships, and §6 cross-domain rows as **proposals from a prior pass**, not as constraints. The point of Mode D is that any of them can change.

### Step D2: Drive a fresh Mode A pass with the prior model as input

Run the Mode A blueprint stages end-to-end, with the extracted content seeded as Stage 1 input. **The confirmation gates that MUST fire in Mode D, in order, with no collapsing or bundling:**

1. **Stage 1** — confirm the original `initial_request` still describes the system the rebuilt model should produce. If scope has shifted in ways the original ask doesn't cover, capture the shift in conversation as input for the rest of Mode D (it informs the Stage 3 entity walk and the Stage 6 neighborhood). Then **rewrite §1 cleanly to describe the *new* scope as if you were authoring fresh today** — the model file is a snapshot, not a diff log. Do **not** leave a trail like "this used to include cost tracking but doesn't anymore"; do not narrate the supplement in §1 Overview, §3 prose, or §7. The git diff is the changelog. The `initial_request` front-matter stays immutable as historical record; §1 reflects the present.
2. **Stage 2** — re-confirm vendor template vs agent-optimized using AskUserQuestion. The prior choice is the default but it is explicitly re-asked. Users learn the domain across iterations and the right answer can change. (Decision-log note: under admin-orchestrated runs, Mode D explicitly re-asks even when the log carries a `naming_mode` entry; do NOT short-circuit from cache here. After the user confirms, overwrite the log entry with the new choice so later bundle items see the latest answer.)
3. **Stage 3** — re-propose the entity list from first principles. Show the prior entities as "here's how we modeled this last time" so the user can accept, rename, split, merge, or drop each one. Net new entities welcome. **A rename of an entity that carries an inherited `catalog code` is a silo rename: pin the catalog code to the pre-rename concept and carry its `role` / `mastered in` forward (see the silo-rename rule under `catalog code` in §3); only `data_object` and labels change. Severing the lineage requires the user to declare it a new, distinct concept.**
4. **Stage 5** — regenerate the §2 Mermaid diagram against the rebuilt entities and §5 edges. *Render-only, not a confirmation gate — see the Stage 5 reference (`stage-5-mermaid.md`).* Show the diagram inline as a visualization, run the agent-side build-then-verify check, and proceed directly to Stage 6. Do not ask the user "look right?" about the diagram; they already approved the underlying §3 entities and §5 relationships.
6. **Stage 6** — re-run the `related_modules` shadowing walk against the rebuilt entity list. **This is its own gate, never bundled with Stage 7, never deferred to Step D3, never glossed as "X stays, Y stays" inside a different turn's prose.** Surface the full proposal block under a labeled "Related modules" heading even when the conversation is mid-flow on an unrelated scope change (cost deferral, vendor swap, entity rename). The list must be locked before Stage 7, because Stage 7 walks each non-overlap domain × every §3 entity to enumerate §6 rows.
7. **Stage 7** — re-run §6 cross-model link suggestions against the rebuilt entity list, walking the (Stage 6-confirmed) `related_modules` list per the §6 completeness rule.
8. **Stage 8** — re-run business-rule emission against the rebuilt entity list: emit the §8.2 rule intents (`lifecycle` / `owner_edit` / `narrow_write`) the rebuilt entities imply. Prior §8.2 rules are an input, not a substitute for the walk; renamed or split entities may have changed shape. (Row-scope and field-lock rules are the analyst's, derived from field shapes the blueprint doesn't carry.)
9. **Stage 9** — re-run the `entity_type` classification + write-tier derivation (Stage 9) against the rebuilt entity list. The prior `entity_type` and `write tier` columns (§3) are inputs, not a substitute for the walk; renamed or split entities may have changed shape, and a rebuild from older content (pre-3.0, which carried no `entity_type`) must derive the class fresh via the ladder. Surface the class+tier table as its own gate; do not bundle into the diff summary.
10. **Stage 10** — re-run the **mandatory W1 / W2 / W6 workflow-gate scan** against every rebuilt entity. Its own confirmation gate, never bundled with Stage 9 or with the Step D3 diff summary. Walk the architect's three families (W1 lifecycle approval, W2 lifecycle closure, W6 high-weight create) against each entity's §7 lifecycle states and §3 description; for each gated transition mark `requires_permission? = ✓` in §7 and emit the matching `workflow-gate (lifecycle)` row in §8.1 plus the §9.1 roll-up, or record why the transition stays open. Prior §7 gates and §8.1 workflow rows are an input, not a substitute for the walk. A rebuild that surfaces zero workflow gates must show that result to the user explicitly. **For a non-trivial domain (≥5 operational entities) zero gates is a smell; ask the user to confirm**, with the typical missed shapes in front of them (an `approved` / `signed` / `posted` lifecycle state, a high-weight `void` / `cancelled` closure, restricted creation). Field-driven gates — submit-lock, ownership, reassignment — are the analyst's, once field shapes exist.
11. **Stage 11** — re-derive the §9.1 **baseline roles** + **permission hierarchy** from the rebuilt §8.1. **Carry the prior file's RACI realization, Processes wired catalog, and §9.2 functional ownership forward** — these are uber-model-derived and the architect cannot reconstruct them from first principles; drop only the rows whose entities or processes the rebuild removed, and add RACI rows only for genuinely new processes the user confirmed. Preserve `related_modules` likewise, trimming only entries the rebuild made irrelevant. Refresh the frontmatter `persona` list to match the carried-forward §9.1 RACI actors; if the model carries no RACI realization, omit `persona`. The field-level passes (input-type rules, select rules, view/edit consistency) belong to the analyst — they need the field shapes the blueprint doesn't carry.

Skipping or collapsing any gate is an authoring bug. The user confirms at every gate. Mode D does not skip them.

### Step D3: Show what changed before saving

Before writing, present a one-screen diff summary:

> **Rebuild summary, `<slug>-semantic-blueprint.md`**
> - Entities **added**: `<list>`
> - Entities **removed**: `<list>`
> - Entities **renamed**: `<old → new>`
> - Entities **restructured** (split / merged): `<list>`
> - Field shape changes worth flagging (format changes, new/dropped FKs): `<list>`
> - Carry-over confirmed: `initial_request`, `<keys>`
> - Carry-over re-evaluated: `<keys with notes>`
> - **`related_modules` (re-walked):** add `<list>`, drop `<list>`, keep `<list>`

Ask: *"Does this rebuild look right, or anything to keep from the prior model?"* Loop until confirmed.

### Step D4: Write the rebuilt file

Default: write to `{system_slug}-semantic-blueprint.rebuild.md` so the prior file survives for diffing. Overwriting `{system_slug}-semantic-blueprint.md` directly is allowed **only after explicit user confirmation** at the Step D3 gate. A slug change is loud: system identity is keyed off `system_slug` and changing it breaks the deployer round-trip; flag any slug rename in the summary so the user can confirm.

Front-matter rules:
- `version`: stamped at `CURRENT_VERSION` (same as any Mode A write)
- `initial_request`: byte-for-byte from the prior file
- `created_at`: today's date
- `naming_mode`: Stage 2's confirmed choice (may differ from prior)
- `system_name`, `system_slug`: re-derived in Stages 1 and 5; the slug stays the same unless the user explicitly renames the system. `icon_name`: carried over from the prior file.
- `domain`: re-inferred from the rebuilt entity list
- `departments`, `industries`: preferentially carried over when the user-curated values still fit the rebuilt model, re-inferred when the rebuild has reframed the domain enough that the old tags no longer apply
- `related_modules`: must already have been confirmed at its own **Stage 6** gate during D2; Step D3 only echoes the confirmed list as part of the diff summary. The Stage 6 walk is never deferred to D3, never collapsed into the diff summary as the user's first sight of the list, and never carried over from the prior file unchanged. Prior values are an input to the walk (so a user-confirmed addition from the prior pass isn't silently dropped) but never a substitute for it.
- `entities`: rebuilt from the new §2 entity list

Run the same self-audit pass as Mode A Stage 13: every 🔴 Blocker check from the Mode B checklist (`audit-checklist.md`) must pass before save, including the §2 Mermaid diagram checks. A rebuild that fails its own audit is not saved.

**Then run the same pre-save verification** defined in the resident Pre-save verification section of SKILL.md. Run silently; on failure, halt and tell the user what blocked the save in plain English (no section numbers, no backticked identifiers, no platform-plumbing terms). Rebuilds regenerate the Mermaid diagram from scratch and are the highest-risk mode for verb-label drift, so verify carefully — but still silently.

After save, share a one-sentence plain-English summary including the prior-file path so the user can diff:

> Rebuilt `<slug>` from `<prior_path>`. New file at `<new_path>`, N entities (Δ +X / −Y / renamed Z), M fields. Run a diff in your editor before discarding the prior file.

