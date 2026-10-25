*Reference for `semantius-architect`. Loaded on demand; the resident SKILL.md stage index points here.*

### Stage 1: Capture the system

> **🛑 The deliverable is always a semantic-blueprint markdown file.** Once this skill is invoked, your job is to produce a `*-semantic-blueprint.md` file, full stop. Do **not** propose alternatives to modeling: no off-the-shelf SaaS products, no "just use a spreadsheet / Markdown checklist", no "keep it simple and skip the model". The user has already decided they want a data model; treat that as settled and move on to Stage 1. Product names appear in this flow only as **reference points**: in the Stage 1 guidance aside and interview below (how well-known products model this domain), and in Stage 2's design options (whose records and names to follow). They are never a recommendation to buy that product instead of building. If the user explicitly asks whether they should use a SaaS product instead, answer briefly and then return to the modeling track, evaluating external products is a different skill.

Ask the user what system they want to model. Two shapes are common:

1. **Named category only**, "I need a CRM", "a helpdesk", "an HRIS", "an LMS". The user has no detailed requirements and expects you to bring the domain knowledge.
2. **Detailed requirements**, the user describes what the system must do, what they track, maybe sketches a few entities. Extract the domain from their description; do not ask them to restate it as a category.

**Bring what you know about similar products.**

> **Interaction flow** (the `.interaction_flow` switch, read at Step 0; `../../semantius-admin/references/interaction-flow.md`). **Guided flow:** think of the products that fit, then give the guidance aside (a product fits) or run the discovery interview first (none fits). **Expert flow:** as in guided flow, plus one step: apply the four-object test before deciding whether a product fits. **Fast flow:** think of the products that fit, then run the fast-flow interview (the last part of this stage). In every flow, an unclear category (e.g., the user says "a system for my coaches") is settled by the interview's "Closest to" question; in fast flow, by Stage 2's design question (`stage-2-naming.md`).

**Products that fit.** Think of the 3 to 4 well-known products (point solutions or cloud platforms) whose data model best fits the request. When your knowledge names none, search the web for the category's leading products before deciding that none fits (SKILL.md → Reference material). Keep the list: Stage 2 uses it for its vendor options.

**The four-object test (expert flow; also Stage 2's free-text-answer step).** A product stays on the list only when you can name at least four of its headline objects, spelled the way the product spells them. When your knowledge names fewer than four, look them up in the product's own documentation before deciding (SKILL.md → Reference material); objects the pages confirm count. Run it before deciding whether a product fits: in expert flow, a product fits only when it passed. Why an objective test: a product whose objects you can't name is a product whose model you would be guessing, and a guessed model presented as "how X does it" misleads the user and ends up in the design. Guided and fast flow keep every product on the list. Stage 2's free-text-answer step runs the same test, in every flow, on a product the user writes in (`stage-2-naming.md`).

**None fits: the discovery interview (guided and expert flow).** Only when no product fits the request. One `AskUserQuestion` call, fired alone in its response, with the questions from the templates below that the request leaves open:

- "Closest to": the nearest products. In expert flow, only products that passed the four-object test; when none passed, it is left out.
- "Users": left out when the request says who uses the system.
- "Replaces": left out when the request says what the system replaces.

When nothing is open, ask nothing. It is a standalone question (no `Q:` task), and nothing is written to `$CUSTOMIZATIONS_FILE`: the answers describe this system, not a standing rule for the org. At most one follow-up, in prose; it also settles an unclear category when "Closest to" was left out. Then give the guidance aside built from the answers. If the answers point to a known category, continue as if a product fit (Stage 2 may offer a vendor's design); otherwise Stage 2's no-incumbents skip applies.

**The guidance aside (guided and expert flow).** Before Stage 2: right away when a product fits, after the interview when none fits. Three to eight lines total:

- One line per product on the list (the user's "Closest to" pick first): the modeling pattern it is known for, for example *"Salesforce keeps Leads apart from Contacts until they qualify"*. Describe how each models the domain; never rank them or suggest buying one. With no product on the list, leave these lines out.
- Two to four best-practice points for this domain's data model: the modern design that Stage 2 offers. Introduce them with one line, e.g. *"The modern design follows these:"*, then one point per bullet line. Never compress multiple points into a single line or sentence; each point gets its own line so the user can push back on them individually.

These points are the assumptions Stage 3 applies when the user picks the modern design ("Make assumptions explicit", SKILL.md → Tone and collaboration style); a vendor's design follows that vendor's structure, and a structure the user wrote in and confirmed in Stage 2 follows theirs. The aside is carried in the same turn as the next question: Stage 2's design question; in expert flow, the name and scope question below; when Stage 2 skips its question, the Stage 3 entity list. The user can push back on any point there, or at the entity list.

**Interview templates.** Every question holds 2 to 4 options (SKILL.md → AskUserQuestion mechanics); the tool adds its own free-text slot, so never list "Other".

| Question | Header | Options |
|---|---|---|
| `"Which of these is closest to what you need?"` (guided and expert flow) | `"Closest to"` | Up to 3 well-known products that best match the requirements provided, each described with 2 or 3 of its headline objects, plus always `"None of these, design from scratch"` (description `"I'll design it from what you tell me, with clear, modern names."`) |
| `"Who will use it?"` (guided and expert flow) | `"Users"` | `"One small team"`, `"Several teams or departments"`, `"Also people outside the company"` (description `"Customers or partners use it too."`) |
| `"What does this replace? If it's a product, type its name."` (guided and expert flow) | `"Replaces"` | `"Spreadsheets or email"`, `"Nothing yet, it's new"`, `"A tool we built ourselves"` |
| `"Which of these do you need from the start?"` (fast flow only, `multiSelect: true`) | `"Must-haves"` | 2 to 4 concepts that products in this space commonly track, drawn from the other objects of the products on the list (with none, from your knowledge of the domain), each described in one line plus `" Skip if you don't need this."`. Filter through `.optionals_decided` first and shape it by count, exactly like Stage 3's "Also track" (a saved verdict is applied silently and not offered; one concept left is asked as a 2-option single-select with "None, skip it"). |

**Where the answers go.**

- The scope line below.
- Stage 2's vendor ranking: a product the user wrote into the free-text slot of "Replaces" is ranked first.
- Stage 11 personas: the "Users" answer names who acts.
- The §1 Overview: what is in and out of scope.

Identify the **domain category** (CRM, ITSM/helpdesk, HRIS, LMS, ERP, PIM, CMS, Project Management, Field Service, Subscription Billing, etc.). The next stage depends on this.

**Capture the initial request verbatim.** Record the user's opening ask (e.g. *"I need a basic lead tracker"*, *"spec out an HRIS for a 200-person company"*) exactly as they said it, no rewording, no tidying. This goes into the `initial_request` front-matter key in Stage 11 and is **never** modified afterwards; it's the historical record of what kicked the model off. If the user started with several messages before committing to a system, use the first message that clearly names the system they want. If a clarifying question in this stage changed the category, still keep the original wording, don't fold the clarification into it.

**Capture `system_name` and a rough scope line.**

> **Interaction flow** (the `.interaction_flow` switch, read at Step 0). **Guided flow:** take `system_name` and the scope line from the request (name the system after its category when the request gives no name, e.g. "Service Desk" for a helpdesk) and ask nothing. **Expert flow:** elicit them as below, in the same turn as the Stage 1 guidance aside, after it. **Fast flow:** as in guided flow; the go-ahead summary does not show them either.

`system_name` is the display name (and the module name); in expert flow, elicit it here. Then capture a **one-line scope statement** in the user's own words (e.g. *"everything a small team needs to hire, in one lightweight package"*). This line is working input, not marketing copy: it constrains the Stage 3 entity proposal (lean scope → lean entity list) and seeds the `tagline` draft in Stage 13. Do NOT elicit the polished catalog-surface strings here — `tagline`, `description`, `module_kind`, and `license` are settled in Stage 13 ("Finalize the catalog surface"), once the entity list they describe actually exists. Asking the user to write buyer-facing copy about a system whose contents haven't been decided yet produces copy that has to be rewritten.

The §1 Overview remains a **single analyst-voice block**: terse, scope-explicit (what's IN, what's OUT, upgrade path). Do NOT split §1 into sub-sections; do NOT mix marketing-voice into §1. The marketing surfaces live in frontmatter (`tagline`, `description`).

**Fast flow: the design and the interview** (a fast run only, before the go-ahead; `../../semantius-admin/references/fast-flow.md`, section 3).

1. **Products.** Keep the list of 3 to 4 products that fit the request ("Products that fit", above). With none, the design is modern.
2. **Interview.** Zero to two questions, in one `AskUserQuestion` call: Stage 2's design question (`stage-2-naming.md`, its Fast flow note), left out when the user named a product or when no product fits, and "Must-haves" from the templates above. "Users" and "Replaces" are not asked: take what the request says, otherwise assume one small team and nothing replaced. "Must-haves" replaces Stage 3's "Also track", and its answers are saved to `.optionals_decided` exactly as "Also track" saves them (the user made these choices). When nothing is open, ask nothing. At most one follow-up, in prose.
3. **The design is settled** by the user's answer to the design question or the product they named; otherwise it is the modern design. A picked or named product is followed: its records and names, as in guided flow (`stage-2-naming.md`). For the modern design, Stage 3 drafts from first principles.
4. **No aside now.** The best-practice points go into the go-ahead summary, so the user reads them once, next to the design.
