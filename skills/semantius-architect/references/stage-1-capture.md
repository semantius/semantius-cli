*Reference for `semantius-architect`. Loaded on demand; the resident SKILL.md stage index points here.*

### Stage 1: Capture the system

> **🛑 The deliverable is always a semantic-blueprint markdown file.** Once this skill is invoked, your job is to produce a `*-semantic-blueprint.md` file, full stop. Do **not** propose alternatives to modeling: no off-the-shelf SaaS products, no "just use a spreadsheet / Markdown checklist", no "keep it simple and skip the model". The user has already decided they want a data model; treat that as settled and move on to Stage 1. Product names appear in this flow only as **reference points**: in the Stage 1 guidance aside and interview below (how well-known products model this domain), and in Stage 2's naming options (whose names to mirror). They are never a recommendation to buy that product instead of building. If the user explicitly asks whether they should use a SaaS product instead, answer briefly and then return to the modeling track, evaluating external products is a different skill.

Ask the user what system they want to model. Two shapes are common:

1. **Named category only**, "I need a CRM", "a helpdesk", "an HRIS", "an LMS". The user has no detailed requirements and expects you to bring the domain knowledge.
2. **Detailed requirements**, the user describes what the system must do, what they track, maybe sketches a few entities. Extract the domain from their description; do not ask them to restate it as a category.

**Bring what you know about similar products.**

> **Interaction level** (the `.interaction_level` switch, read at Step 0; `../../semantius-admin/references/interaction-level.md`). **Advanced mode:** if the category is unclear (e.g., the user says "a system for my coaches"), ask one clarifying question to narrow it down; otherwise proceed. No guidance aside and no interview. **Standard mode (the default):** run the known-product check, then give the guidance aside (a product is known) or run the discovery interview (none is known); the interview's "Closest to" question replaces the one clarifying question. **Yolo mode:** find a baseline and run the yolo interview (the last part of this stage).

**Known-product check (the four-object test).** Think of the 1 to 3 well-known products (point solutions or cloud platforms) whose data model best fits the request. A product counts as **known** only when you can name at least four of its headline objects, spelled the way the product spells them. Keep the list of products that passed: Stage 2 uses it for its vendor options. Why an objective test: a product whose objects you can't name is a product whose model you would be guessing, and a guessed model presented as "how X does it" misleads the user and ends up in the design.

**Known: the guidance aside (standard mode).** No question. Three to five lines, before Stage 2:

- One line per product that passed the test: the modeling pattern it is known for, for example *"Salesforce keeps Leads apart from Contacts until they qualify"*. Describe how each models the domain; never rank them or suggest buying one.
- Two to four best-practice points for this domain's data model.

These points are the assumptions Stage 3 applies ("Make assumptions explicit", SKILL.md → Tone and collaboration style). The user can push back on any of them at the Stage 3 entity list.

**Not known: the discovery interview (standard mode).** One `AskUserQuestion` call, fired alone in its response, with 1 to 4 questions from the templates below, asking only what the request leaves open. It is a standalone question (no `Q:` task), and nothing is written to `$CUSTOMIZATIONS_FILE`: the answers describe this system, not a standing rule for the org. At most one follow-up, in prose. Then give the guidance aside built from the answers (the nearest products that pass the test, if any, plus the best-practice points). If the answers point to a known category, continue as if a product were known (Stage 2 may offer vendor naming); otherwise Stage 2's no-incumbents skip applies.

**Interview templates.** Every question holds 2 to 4 options (SKILL.md → AskUserQuestion mechanics); the tool adds its own free-text slot, so never list "Other".

| Question | Header | Options |
|---|---|---|
| `"Which of these is closest to what you need?"` | `"Closest to"` | 1 to 3 products or kinds of system that fit, each described with 2 or 3 of its headline objects, plus always `"None of these, design from scratch"` (description `"I'll design it from what you tell me, with clear, modern names."`) |
| `"Who will use it?"` | `"Users"` | `"One small team"`, `"Several teams or departments"`, `"Also people outside the company"` (description `"Customers or partners use it too."`) |
| `"What does this replace? If it's a product, type its name."` | `"Replaces"` | `"Spreadsheets or email"`, `"Nothing yet, it's new"`, `"A tool we built ourselves"` |
| `"Which of these do you need from the start?"` (yolo only, `multiSelect: true`) | `"Must-haves"` | 2 to 4 concepts that products in this space commonly track, drawn from the baseline's other objects, each described in one line plus `" Skip if you don't need this."`. Filter through `.optionals_decided` first and shape it by count, exactly like Stage 3's "Also track" (a saved verdict is applied silently and not offered; one concept left is asked as a 2-option single-select with "None, skip it"). |

**Where the answers go.**

- The scope line below, and the Stage 3 "Picked for you" line.
- Stage 2's vendor ranking: a product the user typed into "Replaces" is ranked first.
- Stage 11 personas: the "Users" answer names who acts.
- The §1 Overview: what is in and out of scope.

Identify the **domain category** (CRM, ITSM/helpdesk, HRIS, LMS, ERP, PIM, CMS, Project Management, Field Service, Subscription Billing, etc.). The next stage depends on this.

**Capture the initial request verbatim.** Record the user's opening ask (e.g. *"I need a basic lead tracker"*, *"spec out an HRIS for a 200-person company"*) exactly as they said it, no rewording, no tidying. This goes into the `initial_request` front-matter key in Stage 11 and is **never** modified afterwards; it's the historical record of what kicked the model off. If the user started with several messages before committing to a system, use the first message that clearly names the system they want. If a clarifying question in this stage changed the category, still keep the original wording, don't fold the clarification into it.

**Capture `system_name` and a rough scope line.**

> **Interaction level** (the `.interaction_level` switch, read at Step 0). **Advanced mode off:** take `system_name` and the scope line from the request (name the system after its category when the request gives no name, e.g. "Service Desk" for a helpdesk), ask nothing, and state what you picked in the Stage 3 "Picked for you" line. **Advanced mode on:** elicit them as below. **Yolo mode:** as with advanced mode off, and the name and scope are shown in the go-ahead summary instead of a "Picked for you" line.

`system_name` is the display name (and the module name); with advanced mode on, elicit it here. Then capture a **one-line scope statement** in the user's own words (e.g. *"everything a small team needs to hire, in one lightweight package"*). This line is working input, not marketing copy: it constrains the Stage 3 entity proposal (lean scope → lean entity list) and seeds the `tagline` draft in Stage 13. Do NOT elicit the polished catalog-surface strings here — `tagline`, `description`, `module_kind`, and `license` are settled in Stage 13 ("Finalize the catalog surface"), once the entity list they describe actually exists. Asking the user to write buyer-facing copy about a system whose contents haven't been decided yet produces copy that has to be rewritten.

The §1 Overview remains a **single analyst-voice block**: terse, scope-explicit (what's IN, what's OUT, upgrade path). Do NOT split §1 into sub-sections; do NOT mix marketing-voice into §1. The marketing surfaces live in frontmatter (`tagline`, `description`).

**Yolo mode: the baseline and the interview** (a yolo run only, before the go-ahead; `../../semantius-admin/references/yolo-mode.md`, section 3).

1. **Baseline.** Pick 1 to 3 products that fit the request and pass the four-object test. With none, there is no baseline: run the interview, then design from first principles with modern names.
2. **Interview.** Zero to four questions from the templates above, only what the request leaves open. Leave out "Closest to" when the user named a product (that product is the baseline). Add "Must-haves": it replaces Stage 3's "Also track", and its answers are saved to `.optionals_decided` exactly as "Also track" saves them (the user made these choices). When nothing is open, ask nothing. At most one follow-up, in prose.
3. **The baseline is settled** by the user's "Closest to" pick, or the product they named, or your single best fit. "None of these" means no baseline.
4. **No aside now.** The best-practice points go into the go-ahead summary, so the user reads them once, next to the design.
